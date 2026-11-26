'use strict';
// Infrastructure agents (connector1, connector2, ...): each one monitors and updates the Proxmox host
// it lives on and POSTs a report here every few minutes. The dashboard shows those reports, and
// signed-in admins can approve/deny actions the agents are waiting on (host updates and reboots,
// risky container updates) and send them tasks ("why is X down?", "fix Y"). Decisions and tasks
// travel back to the agent in the response to its next report, so agents never need to be reachable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OFFLINE_AFTER = 15 * 60e3;
const MAX_LOG_LINES = 5000;          // agent log lines kept per agent
const MAX_EVENTS = 3000;             // events kept per agent (and at most 30 days)     // no report for this long = agent offline
const MAX_TASKS = 400;               // tasks (chat messages + actions) kept per agent; oldest finished ones dropped first
const MAX_TASK_TEXT = 4000;
const MAX_OUTPUT = 20000;

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

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
    this.data = { agents: {}, decisions: {}, tasks: {}, svc: {}, chats: {}, core: {}, policy: {} };
    this.onPublic = null; // set by server.js: (publicServices, agentName) => void
    this.waiters = new Map(); // agent name -> Set of callbacks waiting in a long-poll
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    this.data.svc ||= {};
    this.data.chats ||= {};
    this.data.core ||= {};
    this.data.policy ||= {};
    this.migrateChats();
    this.saveTimer = null;
    // Agent logs (lines of each agent's ~/agent/logs/agent.log) and the agents' events (what Activity shows) are
    // kept here and saved to disk, so they survive restarts and redeploys. Agents only ever resend their newest
    // lines/events, so anything older would otherwise be gone after a restart.
    this.logFile = path.join(dataDir, 'agentlogs.json');
    this.eventFile = path.join(dataDir, 'events.json');
    this.logs = new Map(Object.entries(readJsonFile(this.logFile) || {}).filter(([, v]) => Array.isArray(v)));
    this.events = readJsonFile(this.eventFile) || {};
    this.logsDirty = false;
    this.eventsDirty = false;
    // Logs of finished update runs, per agent (saved: agents only resend recent ones in full).
    this.runLogFile = path.join(dataDir, 'runlogs.json');
    this.runLogs = {};
    try { this.runLogs = JSON.parse(fs.readFileSync(this.runLogFile, 'utf8')) || {}; } catch { /* none yet */ }
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
    if (Array.isArray(report.runLogs)) this.storeRunLogs(name, report.runLogs);

    if (wasOffline) this.notify('up', `✅ ${name} is reporting again`, `Agent ${name} is back online.`);

    // New warnings/errors since the last report.
    // Compared with the saved history (not only the previous report), so a restart doesn't re-alert old events.
    const history = this.events[name] || [];
    const seen = new Set([...history.map(e => e.id), ...((prev && prev.report && prev.report.events) || []).map(e => e.id)]);
    const fresh = Boolean(prev || history.length); // the very first report ever: don't alert its backlog
    for (const e of (Array.isArray(report.events) ? report.events : [])) {
      if (!e || seen.has(e.id) || !fresh) continue;
      if (e.level === 'error') this.notify('down', `🚨 ${name}: ${e.msg}`.slice(0, 200), `${name}: ${e.msg}`);
      else if (e.level === 'warn') this.notify('warning', `⚠️ ${name}: ${e.msg}`.slice(0, 200), `${name}: ${e.msg}`);
    }
    this.mergeEvents(name, report.events); // after the alert check above, which compares against the history
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
    const agent = this.data.agents[name];
    if (agent) {
      agent.lastSync = now;
      // Live progress of an update run (null when none is running; absent from agents older than 1.7).
      if ('progress' in body) { agent.progress = cleanProgress(body.progress); agent.progressAt = now; }
    }
    if (Array.isArray(body.logs)) this.mergeLogs(name, body.logs);
    this.save();
  }

  mergeLogs(name, lines) {
    const list = this.logs.get(name) || [];
    const key = l => `${l.t}|${l.p}|${l.m}`;
    const have = new Set(list.map(key));
    for (const raw of lines.slice(-1000)) {
      const l = cleanLine(raw);
      if (l && !have.has(key(l))) { list.push(l); have.add(key(l)); this.logsDirty = true; }
    }
    list.sort((a, b) => a.t - b.t);
    this.logs.set(name, list.slice(-MAX_LOG_LINES));
  }

  // Events from reports (each report carries only the agent's newest ones), merged by id and kept for 30 days.
  mergeEvents(name, events) {
    if (!Array.isArray(events)) return;
    const list = (this.events[name] ||= []);
    const have = new Set(list.map(e => e.id));
    const cutoff = Date.now() - 30 * 86400e3;
    for (const e of events) {
      if (!e || typeof e.id !== 'string' || have.has(e.id) || !(num(e.t) > cutoff)) continue;
      list.push({ id: e.id.slice(0, 40), t: num(e.t), level: ['info', 'warn', 'error'].includes(e.level) ? e.level : 'info', msg: str(e.msg, 1000) });
      have.add(e.id);
      this.eventsDirty = true;
    }
    if (!this.eventsDirty) return;
    list.sort((a, b) => a.t - b.t);
    this.events[name] = list.filter(e => e.t > cutoff).slice(-MAX_EVENTS);
  }

  agentEvents(name) {
    if (!this.tokens.has(name) && !this.data.agents[name]) throw httpError(404, 'Unknown agent');
    return this.events[name] || [];
  }

  flushLogs() {
    const write = (file, data) => {
      try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data)); fs.renameSync(`${file}.tmp`, file); } catch (err) { console.error(`[infra] saving ${path.basename(file)} failed:`, err.message); }
    };
    if (this.logsDirty) { this.logsDirty = false; write(this.logFile, Object.fromEntries(this.logs)); }
    if (this.eventsDirty) { this.eventsDirty = false; write(this.eventFile, this.events); }
  }

  agentLogs(name) {
    if (!this.tokens.has(name) && !this.data.agents[name]) throw httpError(404, 'Unknown agent');
    return this.logs.get(name) || [];
  }

  storeRunLogs(name, runs) {
    const mine = (this.runLogs[name] ||= {});
    let changed = false;
    for (const r of runs.slice(-20)) {
      if (!r || typeof r.id !== 'string' || !/^[a-f0-9]{6,32}$/.test(r.id)) continue;
      const prev = mine[r.id];
      const log = Array.isArray(r.log) ? r.log.slice(-800).map(cleanLine).filter(Boolean) : (prev && prev.log) || null;
      const next = {
        id: r.id, t: num(r.t), end: num(r.end), kind: str(r.kind, 20), mode: str(r.mode, 20), title: str(r.title, 200) || 'Update',
        level: str(r.level, 10), summary: str(r.summary, 600), done: num(r.done), total: num(r.total), log,
      };
      if (!prev || (log && (!prev.log || prev.log.length !== log.length)) || prev.end !== next.end) { mine[r.id] = next; changed = true; }
    }
    const ids = Object.keys(mine).sort((a, b) => (mine[b].t || 0) - (mine[a].t || 0));
    for (const id of ids.slice(40)) { delete mine[id]; changed = true; }
    if (changed) {
      try { fs.writeFileSync(`${this.runLogFile}.tmp`, JSON.stringify(this.runLogs)); fs.renameSync(`${this.runLogFile}.tmp`, this.runLogFile); } catch (err) { console.error('[infra] run log save failed:', err.message); }
    }
  }

  runList(name) {
    return Object.values(this.runLogs[name] || {}).map(({ log, ...meta }) => ({ ...meta, lines: log ? log.length : 0 })).sort((a, b) => (b.t || 0) - (a.t || 0));
  }

  runLog(name, id) {
    const r = (this.runLogs[name] || {})[id];
    if (!r) throw httpError(404, 'Log not found');
    return r;
  }

  // What the agent should act on now.
  // The nightly-update policy rides along on every answer (it does not wake a long-poll, so an older agent that
  // ignores it can't end up in a busy loop); the agent applies it and echoes it back in its report.
  outbox(name) {
    const tasks = this.data.tasks[name] || [];
    const decisions = this.data.decisions[name] || {};
    const policy = this.data.policy[name];
    return {
      ...(policy ? { policy: { securityOnly: policy.securityOnly, at: policy.at, by: policy.by } } : {}),
      runLogsHave: Object.values(this.runLogs[name] || {}).filter(r => r.log).map(r => r.id),
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
      // Going down or degraded needs two results in a row (like internal services), so one lost ping or a slow
      // port doesn't send a DOWN alert followed by a "back up" five minutes later. Recovery counts at once.
      if (status === c.status) c.pending = null;
      else if (status !== 'up' && c.status !== 'unknown') {
        c.pending = c.pending && c.pending.status === status ? { status, n: c.pending.n + 1 } : { status, n: 1 };
        if (c.pending.n < 2) continue;
      }
      if (status !== c.status) {
        c.pending = null;
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

  // Nightly update policy per agent: full (risk-checked, the default) or security updates only.
  setPolicy(name, securityOnly, by) {
    if (!this.tokens.has(name)) throw httpError(404, 'Unknown agent');
    this.data.policy[name] = { securityOnly: Boolean(securityOnly), by, at: Date.now() };
    this.save();
    return this.data.policy[name];
  }

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
    if (chat.title === 'New chat') chat.title = String(text).replace(/^\s*(\/ai|\/claude)\s+/i, '').replace(/\s+/g, ' ').trim().slice(0, 70);
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
    const ACTIONS = {
      start: 'Start', shutdown: 'Shut down', reboot: 'Reboot', snapshot: 'Snapshot', backup: 'Back up now', check: 'Check for updates',
      update: 'Update now', 'update-security': 'Install security updates',
      'update-all': 'Run the nightly update now', 'update-all-security': 'Install security updates on every container', 'check-updates': 'Check host updates now',
    };
    const HOST_ACTIONS = ['update-all', 'update-all-security', 'check-updates'];
    if (!ACTIONS[type]) throw httpError(400, 'Unknown action');
    const a = this.data.agents[name];
    if (!a || !this.tokens.has(name)) throw httpError(404, 'Unknown agent');
    let label = ACTIONS[type];
    if (!HOST_ACTIONS.includes(type)) {
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
        policy: this.data.policy[name] || null,
        progress: a && a.progress ? { ...a.progress, at: a.progressAt } : null,
        runs: this.runList(name).slice(0, 15),
        logCount: (this.logs.get(name) || []).length,
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
    this.logTimer = setInterval(() => this.flushLogs(), 20e3); // logs and events: saved at most every 20 s
    this.logTimer.unref?.();
  }

  stop() { clearInterval(this.timer); clearInterval(this.logTimer); this.saveNow(); this.flushLogs(); }
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
function cleanLine(l) {
  if (!l || typeof l !== 'object') return null;
  return { t: num(l.t), p: str(l.p, 20), l: ['info', 'warn', 'error'].includes(l.l) ? l.l : 'info', m: str(l.m, 2000) };
}

// Bounded copy of an agent's update progress record.
function cleanProgress(p) {
  if (!p || typeof p !== 'object') return null;
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const str = (v, max) => (v == null ? null : String(v).slice(0, max));
  const cur = p.current && typeof p.current === 'object' ? { vmid: n(p.current.vmid), name: str(p.current.name, 80) } : null;
  return {
    kind: str(p.kind, 20), mode: str(p.mode, 20), total: n(p.total), done: n(p.done), startedAt: n(p.startedAt), u: n(p.u),
    current: cur, step: str(p.step, 30), what: str(p.what, 80), pkgs: p.pkgs == null ? null : n(p.pkgs), title: str(p.title, 200),
    log: (Array.isArray(p.log) ? p.log : []).slice(-150).map(cleanLine).filter(Boolean),
    results: (Array.isArray(p.results) ? p.results : []).slice(-60).map(r => ({ vmid: n(r && r.vmid), name: str(r && r.name, 80), r: str(r && r.r, 300) })),
  };
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Reports come from our own agents, but keep them bounded and plain so a bug can't bloat the store.
function sanitizeReport(r) {
  const out = { ...r };
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);
  out.events = cap(r.events, 500);
  out.pending = cap(r.pending, 50);
  out.containers = cap(r.containers, 200);
  out.updateRuns = cap(r.updateRuns, 20);
  delete out.taskResults;
  delete out.acked;
  delete out.progress; // kept on the agent record instead (see applyResults)
  delete out.logs;     // kept in memory (Infra.logs)
  delete out.runLogs;  // kept in runlogs.json (Infra.runLogs)
  return out;
}

module.exports = { Infra, OFFLINE_AFTER };
