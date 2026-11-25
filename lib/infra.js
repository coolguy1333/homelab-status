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
const MAX_TASKS = 50;                // tasks kept per agent (oldest finished ones dropped)
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
    this.data = { agents: {}, decisions: {}, tasks: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
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

    // Task results reported back by the agent.
    const tasks = this.data.tasks[name] || [];
    for (const r of (report.taskResults || [])) {
      const t = tasks.find(x => x.id === r.id);
      if (!t) continue;
      if (['running', 'done', 'failed'].includes(r.status)) t.status = r.status;
      if (typeof r.output === 'string') t.output = r.output.slice(-MAX_OUTPUT);
      if (r.status === 'running' && !t.startedAt) t.startedAt = now;
      if (r.status === 'done' || r.status === 'failed') t.finishedAt = t.finishedAt || now;
    }

    // Decisions the agent hasn't confirmed yet. It confirms by listing the id in report.acked.
    const decisions = this.data.decisions[name] || {};
    for (const id of (report.acked || [])) if (decisions[id]) decisions[id].acked = true;
    // Forget decisions about items the agent no longer reports, once acknowledged.
    const pendingIds = new Set((report.pending || []).map(p => p.id));
    for (const [id, d] of Object.entries(decisions)) if (d.acked && !pendingIds.has(id) && now - d.at > 86400e3) delete decisions[id];

    this.save();
    return {
      decisions: Object.entries(decisions).filter(([, d]) => !d.acked).map(([id, d]) => ({ id, decision: d.decision, by: d.by, at: d.at })),
      tasks: tasks.filter(t => t.status === 'queued').map(t => ({ id: t.id, text: t.text, by: t.by, at: t.createdAt })),
    };
  }

  decide(name, id, decision, by) {
    if (!this.data.agents[name]) throw httpError(404, 'Unknown agent');
    const pending = (this.data.agents[name].report.pending || []).find(p => p.id === id);
    if (!pending) throw httpError(404, 'That item is no longer waiting for approval');
    if (!['approve', 'deny'].includes(decision)) throw httpError(400, 'decision must be approve or deny');
    (this.data.decisions[name] ||= {})[id] = { decision, by, at: Date.now(), acked: false };
    this.save();
  }

  addTask(name, text, by) {
    if (!this.tokens.has(name)) throw httpError(404, 'Unknown agent');
    text = String(text || '').trim().slice(0, MAX_TASK_TEXT);
    if (!text) throw httpError(400, 'Write what you want the agent to do');
    const list = (this.data.tasks[name] ||= []);
    const task = { id: crypto.randomBytes(6).toString('hex'), text, by, createdAt: Date.now(), status: 'queued', output: '' };
    list.push(task);
    while (list.length > MAX_TASKS) {
      const i = list.findIndex(t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
      if (i === -1) break;
      list.splice(i, 1);
    }
    this.save();
    return task;
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
        online: Boolean(a && now - a.receivedAt < OFFLINE_AFTER),
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
