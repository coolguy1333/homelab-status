'use strict';
// Infrastructure agents (connector1, connector2, ...): each one monitors and updates the Proxmox host
// it lives on and POSTs a report here every few minutes. The dashboard shows those reports, and
// signed-in admins can approve/deny actions the agents are waiting on (host updates and reboots,
// risky container updates) and send them tasks ("why is X down?", "fix Y"). Decisions and tasks
// travel back to the agent in the response to its next report, so agents never need to be reachable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OFFLINE_AFTER = 15 * 60e3;     // no report for this long = agent offline
const MAX_TASKS = 400;               // tasks (chat messages + actions) kept per agent; oldest finished ones dropped first
const MAX_TASK_TEXT = 4000;
const MAX_OUTPUT = 20000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();

class Infra {
  constructor(dataDir, notifier) {
    this.file = path.join(dataDir, 'infra.json');
    this.notifier = notifier;
    // AGENT_TOKENS="connector1:secret1,connector2:secret2"
    this.tokens = new Map();
    for (const part of String(process.env.AGENT_TOKENS || '').split(',')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      const name = part.slice(0, i).trim(), token = part.slice(i + 1).trim();
      if (/^[a-z0-9_-]{1,40}$/i.test(name) && token.length >= 16) this.tokens.set(name, sha256(token));
      else console.warn(`[infra] Ignoring AGENT_TOKENS entry for "${name}" (name must be letters/digits/-/_, token at least 16 characters)`);
    }
    this.data = { agents: {}, decisions: {}, tasks: {}, svc: {}, chats: {}, core: {} };
    this.onPublic = null; // set by server.js: (publicServices, agentName) => void
    this.waiters = new Map(); // agent name -> Set of callbacks waiting in a long-poll
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    this.data.svc ||= {};
    this.data.chats ||= {};
    this.data.core ||= {};
    this.migrateChats();
    this.saveTimer = null;
  }

  get enabled() { return this.tokens.size > 0; }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
    this.saveTimer.unref?.();
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error('[infra] save failed:', err.message); }
  }

  // Returns the agent name for a valid "Authorization: Bearer <token>", else null.
  agentFrom(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    const h = sha256(header.slice(7).trim());
    for (const [name, hash] of this.tokens) if (crypto.timingSafeEqual(h, hash)) return name;
    return null;
  }

  // An agent's report arrives. Store it, raise notifications for anything new, and answer with the
  // decisions and tasks it should act on.
  receive(name, report) {
    const now = Date.now();
    const prev = this.data.agents[name];
    const wasOffline = prev && prev.offlineNotified;
    this.data.agents[name] = { report: sanitizeReport(report), receivedAt: now, offlineNotified: false };

    if (wasOffline) this.notify('up', `✅ ${name} is reporting again`, `Agent ${name} is back online.`);

    // New warnings/errors since the last report.
    const seen = new Set(((prev && prev.report && prev.report.events) || []).map(e => e.id));
    for (const e of (report.events || [])) {
      if (!e || seen.has(e.id) || !prev) continue;
      if (e.level === 'error') this.notify('down', `🚨 ${name}: ${e.msg}`.slice(0, 200), `${name}: ${e.msg}`);
      else if (e.level === 'warn') this.notify('warning', `⚠️ ${name}: ${e.msg}`.slice(0, 200), `${name}: ${e.msg}`);
    }
    // New items waiting for approval.
    const had = new Set(((prev && prev.report && prev.report.pending) || []).map(p => p.id));
    for (const p of (report.pending || [])) {
      if (p && !had.has(p.id) && prev) this.notify('warning', `🟡 ${name} needs approval: ${p.summary}`.slice(0, 200), `${name} is waiting for approval: ${p.summary}\nApprove or deny it on the dashboard.`);
    }

    this.trackCore(name, Array.isArray(report.core) ? report.core : [], now);
    this.trackServices(name, report.services || [], now, Array.isArray(report.containers) ? new Set(report.containers.map(c => c.vmid)) : null);
    if (this.onPublic && Array.isArray(report.public)) {
      try { this.onPublic(report.public, name); } catch (err) { console.error('[infra] auto monitors:', err.message); }
    }

    this.applyResults(name, report);
    // Forget decisions about items the agent no longer reports, once acknowledged.
    const decisions = this.data.decisions[name] || {};
    const pendingIds = new Set((report.pending || []).map(p => p.id));
    for (const [id, d] of Object.entries(decisions)) if (d.acked && !pendingIds.has(id) && now - d.at > 86400e3) delete decisions[id];

    this.save();
    return this.outbox(name);
  }

  // Task progress/results and decision acknowledgements from the agent (full report or quick sync).
  applyResults(name, body) {
    const now = Date.now();
    const tasks = this.data.tasks[name] || [];
    for (const r of (Array.isArray(body.taskResults) ? body.taskResults : [])) {
      const t = tasks.find(x => x.id === r.id);
      if (!t || t.status === 'cancelled') continue;
      if (['running', 'done', 'failed'].includes(r.status)) t.status = r.status;
      if (typeof r.output === 'string') t.output = r.output.slice(-MAX_OUTPUT);
      if (r.usage && typeof r.usage === 'object') t.usage = r.usage;
      if (r.status === 'running' && !t.startedAt) t.startedAt = now;
      if (r.status === 'done' || r.status === 'failed') t.finishedAt = t.finishedAt || now;
    }
    const decisions = this.data.decisions[name] || {};
    for (const id of (Array.isArray(body.acked) ? body.acked : [])) if (decisions[id]) decisions[id].acked = true;
    if (this.data.agents[name]) this.data.agents[name].lastSync = now;
    this.save();
  }

  // What the agent should act on now.
  outbox(name) {
    const tasks = this.data.tasks[name] || [];
    const decisions = this.data.decisions[name] || {};
    return {
      decisions: Object.entries(decisions).filter(([, d]) => !d.acked).map(([id, d]) => ({ id, decision: d.decision, by: d.by, at: d.at, ...(d.packages ? { packages: d.packages } : {}) })),
      tasks: tasks.filter(t => t.status === 'queued').map(t => ({
        id: t.id, by: t.by, at: t.createdAt, ...(t.action ? { action: t.action } : {}), ...(t.chat ? { chat: t.chat } : {}),
        text: t.group ? `[Datacenter-wide request: the same message went to the agent on every Proxmox host. Answer and act for YOUR host only; the other agents handle theirs.]\n\n${t.text}` : t.text,
      })),
    };
  }

  // Internal services the agent discovered and checked from the LAN: keep 24 h of results plus daily
  // totals for 90 days, and alert when one goes down (two failed checks in a row) or comes back.
  trackServices(agent, services, now, vmids = null) {
    const day = new Date(now).toISOString().slice(0, 10);
    const seen = new Set();
    for (const sv of services) {
      if (!sv || typeof sv.key !== 'string') continue;
      const id = `${agent}|${sv.key}`;
      seen.add(id);
      const h = (this.data.svc[id] ||= { agent, key: sv.key, r: [], d: {}, status: 'up', since: now, fails: 0 });
      h.info = { container: sv.container, vmid: sv.vmid, ip: sv.ip, port: sv.port, proc: sv.proc };
      h.lastSeen = now;
      h.r.push([now, sv.ok ? 1 : 0, sv.ms ?? null]);
      while (h.r.length && h.r[0][0] < now - 86400e3) h.r.shift();
      const dd = (h.d[day] ||= [0, 0]);
      dd[1]++; if (sv.ok) dd[0]++;
      for (const k of Object.keys(h.d)) if (k < new Date(now - 90 * 86400e3).toISOString().slice(0, 10)) delete h.d[k];
      h.fails = sv.ok ? 0 : h.fails + 1;
      const label = sv.port ? `${sv.container} :${sv.port}${sv.proc ? ` (${sv.proc})` : ''}` : `${sv.container} (${sv.ip}, ping)`;
      if (h.status === 'up' && h.fails >= 2) {
        h.status = 'down'; h.since = now;
        this.notify('down', `🔴 ${label} is down`, `${label} at ${sv.ip}:${sv.port} stopped answering (checked by ${agent}). ${sv.err || ''}`);
      } else if (h.status === 'down' && sv.ok) {
        const mins = Math.round((now - h.since) / 60e3);
        h.status = 'up'; h.since = now;
        this.notify('up', `🟢 ${label} is back up`, `${label} is answering again after ${mins} min.`);
      }
    }
    // Forget services of containers that no longer exist right away; a port that merely went quiet is kept
    // for a week (it may come back).
    for (const [id, h] of Object.entries(this.data.svc)) {
      if (h.agent !== agent || seen.has(id)) continue;
      const vmid = h.info && h.info.vmid;
      if ((vmids && vmids.size && vmid != null && !vmids.has(vmid)) || now - (h.lastSeen || 0) > 7 * 86400e3) delete this.data.svc[id];
    }
  }

  // Core servers (Proxmox hosts + backup server), checked from the LAN by every agent. A server counts as up
  // if any agent with a fresh result reaches it, so a dead host is still reported by the agent on the other one.
  trackCore(agent, results, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    for (const r of results.slice(0, 20)) {
      if (!r || typeof r.name !== 'string') continue;
      const c = (this.data.core[r.name] ||= { name: r.name, by: {}, r: [], d: {}, status: 'unknown', since: now });
      c.ip = r.ip; c.role = r.role;
      c.by[agent] = { t: now, ok: Boolean(r.ok), serviceOk: Boolean(r.serviceOk), ping: Boolean(r.ping), ms: r.ms ?? null, ports: r.ports || {} };
      const fresh = Object.values(c.by).filter(x => now - x.t < 15 * 60e3);
      const up = fresh.some(x => x.ok);
      const svcUp = fresh.some(x => x.serviceOk);
      c.r.push([now, up ? 1 : 0, svcUp ? 1 : 0]);
      while (c.r.length && c.r[0][0] < now - 86400e3) c.r.shift();
      const dd = (c.d[day] ||= [0, 0]);
      dd[1]++; if (up) dd[0]++;
      for (const k of Object.keys(c.d)) if (k < new Date(now - 90 * 86400e3).toISOString().slice(0, 10)) delete c.d[k];
      const status = !up ? 'down' : svcUp ? 'up' : 'degraded';
      if (status !== c.status) {
        const was = c.status, mins = Math.round((now - c.since) / 60e3);
        c.status = status; c.since = now;
        const label = `${c.name} (${c.role || 'server'}, ${c.ip})`;
        if (status === 'down') this.notify('down', `🚨 ${c.name} is DOWN`, `${label} does not answer ping or any of its ports (checked from ${fresh.length} agent(s)).`);
        else if (status === 'degraded') this.notify('warning', `⚠️ ${c.name}: main service not answering`, `${label} answers, but its main service port does not.`);
        else if (was !== 'unknown') this.notify('up', `✅ ${c.name} is back up`, `${label} is answering again after ${mins} min.`);
      }
    }
  }

  coreSummary() {
    const now = Date.now();
    return Object.values(this.data.core).map(c => {
      const total = c.r.length, ok = c.r.reduce((a, x) => a + x[1], 0);
      const days = [];
      for (let i = 89; i >= 0; i--) {
        const k = new Date(now - i * 86400e3).toISOString().slice(0, 10);
        const v = c.d[k];
        days.push({ t: Date.parse(k), pct: v && v[1] ? (v[0] / v[1]) * 100 : null });
      }
      const fresh = Object.entries(c.by).filter(([, x]) => now - x.t < 15 * 60e3);
      return {
        name: c.name, ip: c.ip, role: c.role, status: fresh.length ? c.status : 'unknown', since: c.since,
        uptime24h: total ? Math.round((ok / total) * 10000) / 100 : null,
        recent: c.r.slice(-48).map(x => ({ t: x[0], ok: Boolean(x[1]) })),
        daily: days,
        by: Object.fromEntries(Object.entries(c.by).map(([a, x]) => [a, { ...x, fresh: now - x.t < 15 * 60e3 }])),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  services() {
    const now = Date.now();
    return Object.entries(this.data.svc).map(([id, h]) => {
      const total = h.r.length, ok = h.r.reduce((a, x) => a + x[1], 0);
      const last = h.r[h.r.length - 1];
      const days = [];
      for (let i = 89; i >= 0; i--) {
        const k = new Date(now - i * 86400e3).toISOString().slice(0, 10);
        const v = h.d[k];
        days.push({ t: Date.parse(k), pct: v && v[1] ? (v[0] / v[1]) * 100 : null });
      }
      return {
        id, agent: h.agent, key: h.key, ...h.info, status: h.status, since: h.since,
        stale: now - (h.lastSeen || 0) > 20 * 60e3,
        uptime24h: total ? Math.round((ok / total) * 10000) / 100 : null,
        last: last ? { t: last[0], ok: Boolean(last[1]), ms: last[2] } : null,
        recent: h.r.slice(-48).map(x => ({ t: x[0], ok: Boolean(x[1]), ms: x[2] })),
        daily: days,
      };
    });
  }

  // Long-poll: resolve as soon as there is work for this agent, or after `ms`.
  waitFor(name, ms) {
    const has = () => { const o = this.outbox(name); return o.tasks.length || o.decisions.length ? o : null; };
    const now = has();
    if (now || ms <= 0) return Promise.resolve(now || this.outbox(name));
    return new Promise(resolve => {
      const set = this.waiters.get(name) || new Set();
      this.waiters.set(name, set);
      const done = () => { clearTimeout(timer); set.delete(wake); resolve(this.outbox(name)); };
      const wake = () => { if (has()) done(); };
      const timer = setTimeout(done, ms);
      set.add(wake);
    });
  }

  wake(name) { for (const fn of [...(this.waiters.get(name) || [])]) fn(); }

  decide(name, id, decision, by, packages = null) {
    if (!this.data.agents[name]) throw httpError(404, 'Unknown agent');
    const pending = (this.data.agents[name].report.pending || []).find(p => p.id === id);
    if (!pending) throw httpError(404, 'That item is no longer waiting for approval');
    if (!['approve', 'deny'].includes(decision)) throw httpError(400, 'decision must be approve or deny');
    let sel = null;
    if (decision === 'approve' && Array.isArray(packages)) {
      const known = new Set((pending.packages || []).map(p => p.name));
      sel = [...new Set(packages.map(String))].filter(n => known.has(n));
      if (!sel.length) throw httpError(400, 'Select at least one package');
      if (sel.length === known.size) sel = null; // everything = a plain approval
    }
    (this.data.decisions[name] ||= {})[id] = { decision, by, at: Date.now(), acked: false, ...(sel ? { packages: sel } : {}) };
    this.save();
    this.wake(name);
  }

  // Older messages (from before chats existed) go into one "Earlier messages" chat per agent / datacenter.
  migrateChats() {
    let changed = false;
    for (const [agent, list] of Object.entries(this.data.tasks)) {
      for (const t of list) {
        if (t.chat || t.action) continue;
        const scope = t.group ? '_all' : agent;
        const id = `old-${scope}`;
        this.data.chats[id] ||= { id, scope, title: 'Earlier messages', createdAt: t.createdAt, updatedAt: t.createdAt };
        t.chat = id;
        this.data.chats[id].updatedAt = Math.max(this.data.chats[id].updatedAt, t.createdAt);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  createChat(scope, title, by) {
    if (scope !== '_all' && !this.tokens.has(scope)) throw httpError(404, 'Unknown agent');
    const id = 'c' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    this.data.chats[id] = { id, scope, title: String(title || '').trim().slice(0, 120) || 'New chat', by, createdAt: now, updatedAt: now };
    this.save();
    return this.data.chats[id];
  }

  chatFor(scope, chatId, text, by) {
    let chat = chatId && this.data.chats[chatId];
    if (chatId && !chat) throw httpError(404, 'That chat was deleted');
    if (chat && chat.scope !== scope) throw httpError(400, 'That chat belongs to another agent');
    if (!chat) chat = this.createChat(scope, '', by);
    if (chat.title === 'New chat') chat.title = String(text).replace(/\s+/g, ' ').trim().slice(0, 70);
    chat.updatedAt = Date.now();
    return chat;
  }

  renameChat(id, title) {
    const c = this.data.chats[id];
    if (!c) throw httpError(404, 'Chat not found');
    c.title = String(title || '').trim().slice(0, 120) || c.title;
    this.save();
    return c;
  }

  // Deleting a chat removes its messages everywhere. Anything still running finishes on the agent, but its
  // answer is dropped because the message no longer exists.
  deleteChat(id) {
    if (!this.data.chats[id]) throw httpError(404, 'Chat not found');
    delete this.data.chats[id];
    for (const list of Object.values(this.data.tasks)) for (let i = list.length - 1; i >= 0; i--) if (list[i].chat === id) list.splice(i, 1);
    this.save();
  }

  deleteMessage(agent, id) {
    const list = this.data.tasks[agent] || [];
    const i = list.findIndex(t => t.id === id);
    if (i === -1) throw httpError(404, 'Message not found');
    list.splice(i, 1);
    this.save();
  }

  deleteGroup(group) {
    let n = 0;
    for (const list of Object.values(this.data.tasks)) for (let i = list.length - 1; i >= 0; i--) if (list[i].group === group) { list.splice(i, 1); n++; }
    if (!n) throw httpError(404, 'Message not found');
    this.save();
  }

  chatList() {
    const counts = {};
    for (const list of Object.values(this.data.tasks)) for (const t of list) if (t.chat) counts[t.chat] = (counts[t.chat] || 0) + 1;
    return Object.values(this.data.chats).map(c => ({ ...c, messages: counts[c.id] || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addTask(name, text, by, group = null, action = null, chat = null) {
    if (!this.tokens.has(name)) throw httpError(404, 'Unknown agent');
    text = String(text || '').trim().slice(0, MAX_TASK_TEXT);
    if (!text) throw httpError(400, 'Write what you want the agent to do');
    const list = (this.data.tasks[name] ||= []);
    if (!action && !chat) chat = this.chatFor(name, null, text, by).id;
    const task = { id: crypto.randomBytes(6).toString('hex'), text, by, createdAt: Date.now(), status: 'queued', output: '', ...(group ? { group } : {}), ...(action ? { action } : {}), ...(chat ? { chat } : {}) };
    list.push(task);
    while (list.length > MAX_TASKS) {
      const i = list.findIndex(t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
      if (i === -1) break;
      list.splice(i, 1);
    }
    this.save();
    this.wake(name);
    return task;
  }

  // Direct container/host actions (no Claude): validated here against the agent's own last report.
  addAction(name, type, vmid, by) {
    const ACTIONS = { start: 'Start', shutdown: 'Shut down', reboot: 'Reboot', snapshot: 'Snapshot', backup: 'Back up now', check: 'Check for updates', update: 'Update now', 'update-all': 'Run the nightly update now', 'check-updates': 'Check host updates now' };
    if (!ACTIONS[type]) throw httpError(400, 'Unknown action');
    const a = this.data.agents[name];
    if (!a || !this.tokens.has(name)) throw httpError(404, 'Unknown agent');
    let label = ACTIONS[type];
    if (!['update-all', 'check-updates'].includes(type)) {
      const c = ((a.report && a.report.containers) || []).find(x => x.vmid === Number(vmid));
      if (!c) throw httpError(404, 'That container is not on this agent\'s host');
      if (c.self && ['shutdown'].includes(type)) throw httpError(400, 'The agent cannot shut down its own container');
      label = `${label}: ${c.name} (${c.vmid})`;
      vmid = c.vmid;
    } else vmid = null;
    const busy = (this.data.tasks[name] || []).find(t => t.action && t.action.type === type && t.action.vmid === vmid && ['queued', 'running'].includes(t.status));
    if (busy) throw httpError(409, 'That is already queued');
    return this.addTask(name, label, by, null, { type, vmid });
  }

  // One request to every agent (the "Datacenter" box). Returns the tasks created.
  addGroupTask(text, by, chatId = null) {
    const group = 'g' + crypto.randomBytes(5).toString('hex');
    const chat = this.chatFor('_all', chatId, text, by);
    return [...this.tokens.keys()].map(name => ({ agent: name, ...this.addTask(name, text, by, group, null, chat.id) }));
  }

  cancelTask(name, id) {
    const t = (this.data.tasks[name] || []).find(x => x.id === id);
    if (!t) throw httpError(404, 'Task not found');
    if (t.status !== 'queued') throw httpError(409, 'Only tasks that have not started can be cancelled');
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    this.save();
  }

  // What the dashboard shows (admins only).
  summary() {
    const now = Date.now();
    const names = [...new Set([...this.tokens.keys(), ...Object.keys(this.data.agents)])].sort();
    return names.map(name => {
      const a = this.data.agents[name];
      const decisions = this.data.decisions[name] || {};
      return {
        name,
        configured: this.tokens.has(name),
        receivedAt: a ? a.receivedAt : null,
        online: Boolean(a && now - Math.max(a.receivedAt, a.lastSync || 0) < OFFLINE_AFTER),
        live: Boolean(a && a.lastSync && now - a.lastSync < 90e3),
        report: a ? a.report : null,
        decisions,
        tasks: (this.data.tasks[name] || []).slice().reverse(),
      };
    });
  }

  // Called every minute: tell someone when an agent stops reporting.
  checkOffline() {
    const now = Date.now();
    for (const [name, a] of Object.entries(this.data.agents)) {
      if (!a.offlineNotified && now - a.receivedAt >= OFFLINE_AFTER) {
        a.offlineNotified = true;
        this.save();
        this.notify('down', `🚨 ${name} stopped reporting`, `Agent ${name} has not reported for ${Math.round((now - a.receivedAt) / 60e3)} minutes. Its container or Proxmox host may be down.`);
      }
    }
  }

  notify(status, title, text) {
    if (!this.notifier) return;
    this.notifier.emit({ status, title, text: `${title}\n${text}`, time: new Date().toISOString() }).catch(() => {});
  }

  start() {
    this.timer = setInterval(() => this.checkOffline(), 60e3);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.saveNow(); }
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Reports come from our own agents, but keep them bounded and plain so a bug can't bloat the store.
function sanitizeReport(r) {
  const out = { ...r };
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);
  out.events = cap(r.events, 100);
  out.pending = cap(r.pending, 50);
  out.containers = cap(r.containers, 200);
  out.updateRuns = cap(r.updateRuns, 20);
  delete out.taskResults;
  delete out.acked;
  return out;
}

module.exports = { Infra, OFFLINE_AFTER };
