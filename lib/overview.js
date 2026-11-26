'use strict';
// The Overview page's "Needs attention" list and counts, computed on the server for the MCP connector.
// Mirrors attention() in public/dashboard.js: change both together.
const HOUR = 3600e3;
const PROGRESS_STALE = 20 * 60e3;

function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const hostOf = a => (a.report && a.report.host && a.report.host.node) || a.name;
// A vzdump run that ended with "WARNINGS: n" backed everything up: a warning, not a failure.
const runState = t => (t.status === 'OK' ? 'ok' : t.status === 'running' ? 'running' : /^WARNINGS?:/i.test(t.status || '') ? 'warn' : 'failed');

function backupState(c, now = Date.now()) {
  const b = c.backup || {};
  if (!b.covered) return b.last ? 'uncovered' : 'none';
  if (!b.last) return 'missing';
  const age = now - b.last.t;
  return age < 26 * HOUR ? 'ok' : age < 72 * HOUR ? 'old' : 'stale';
}

function containersOf(agents) {
  const out = [];
  for (const a of agents) for (const c of ((a.report || {}).containers || [])) out.push({ ...c, host: hostOf(a), agent: a.name });
  return out;
}

// Backup servers (PBS) as the agents see them; both agents see the same one, keep the freshest.
function pbsServers(agents) {
  const m = new Map();
  for (const a of agents) for (const p of ((a.report && a.report.backups && a.report.backups.pbs) || [])) {
    const k = `${p.server}/${p.datastore}`;
    if (!m.has(k) || (m.get(k).checkedAt || 0) < (p.checkedAt || 0)) m.set(k, { ...p, seenBy: a.name });
  }
  return [...m.values()];
}

const waitingApprovals = a => ((a.report && a.report.pending) || []).filter(p => !(a.decisions || {})[p.id]);

// servers: um-ha's /cluster answer ({ self, peer }) or null when um-ha isn't running here.
function serverProblems(servers) {
  if (!servers) return [];
  const out = [];
  const peer = servers.peer || {};
  const name = x => x.label || x.hostname || x.ip || 'the other server';
  if (!peer.reachable) out.push({ level: 'error', text: `Standby status server ${name(peer)} is not answering — no failover until it is back` });
  else if (peer.role === 'replica' && (!peer.syncedAt || peer.time - peer.syncedAt > 60e3)) out.push({ level: 'warn', text: `${name(peer)} has not copied this server's data for a while` });
  for (const x of [servers.self || {}, peer.reachable ? peer : null].filter(Boolean)) {
    if (x.update && x.update.state === 'error') out.push({ level: 'warn', text: `Status site update on ${name(x)}: ${x.update.message || 'failed'}` });
  }
  return out;
}

// { level: error|warn|info, area, text }, most severe first.
function attention({ agents, services, core, servers, monitors, now = Date.now() }) {
  const items = [];
  const push = (level, text, area) => items.push({ level, area, text });
  for (const a of agents) {
    if (!a.configured) continue;
    if (!a.receivedAt) push('error', `Agent ${a.name} has never reported`, 'agents');
    else if (!a.online) push('error', `Agent ${a.name} (${hostOf(a)}) offline — last report ${ago(a.receivedAt, now)}`, 'agents');
    const r = a.report || {};
    if (r.host && r.host.unreachable) push('error', `${a.name} cannot reach Proxmox host ${r.host.ip}`, 'agents');
    const waiting = waitingApprovals(a);
    if (waiting.length) push('warn', `${waiting.length} item${waiting.length > 1 ? 's' : ''} waiting for your approval on ${hostOf(a)}`, 'updates');
    const p = a.progress;
    if (p) {
      const stale = now - Math.max(p.u || 0, p.at || 0) > PROGRESS_STALE;
      push(stale ? 'warn' : 'info', stale ? `Update run on ${hostOf(a)} has not reported progress for a while`
        : `Updating on ${hostOf(a)}${p.kind === 'run' ? `: ${p.done}/${p.total} containers` : ''}`, 'updates');
    }
    if (r.host && r.host.rebootRequired) push('info', `${hostOf(a)} needs a reboot to finish updates`, 'updates');
    if (r.pbsHost && r.pbsHost.rebootRequired) push('info', `Backup server ${r.pbsHost.name} needs a reboot to finish updates`, 'updates');
    for (const s of (r.host && r.host.storage) || []) if (s.total && s.used / s.total >= 0.9) push('warn', `${hostOf(a)} storage ${s.name} is ${Math.round(s.used / s.total * 100)}% full`, 'agents');
    const recent = ((r.backups && r.backups.tasks) || []).filter(t => now - t.t < 24 * HOUR);
    const failed = recent.filter(t => runState(t) === 'failed');
    const warned = recent.filter(t => runState(t) === 'warn');
    if (failed.length) push('error', `${failed.length} backup run${failed.length > 1 ? 's' : ''} failed on ${hostOf(a)} in the last 24 h`, 'backups');
    if (warned.length) push('warn', `${warned.length} backup run${warned.length > 1 ? 's' : ''} on ${hostOf(a)} finished with warnings in the last 24 h`, 'backups');
  }
  for (const it of serverProblems(servers)) push(it.level, it.text, 'servers');
  for (const c of core) {
    if (c.status === 'down') push('error', `${c.name} (${c.role || 'server'}) is DOWN — no ping, no ports — since ${ago(c.since, now).replace(' ago', '')}`, 'core');
    else if (c.status === 'degraded') push('error', `${c.name}: answers ping but its main service (${/PBS|backup/i.test(c.role || '') ? 'PBS :8007' : 'Proxmox :8006'}) does not`, 'core');
  }
  for (const p of pbsServers(agents)) {
    if (!p.reachable) push('error', `Backup server ${p.storage} (${p.server}) is not reachable`, 'backups');
    if (p.verifyFailed) push('error', `${p.verifyFailed} backup(s) on ${p.storage} failed verification`, 'backups');
    if (p.total && p.used / p.total >= 0.85) push('warn', `Backup datastore ${p.datastore} is ${Math.round(p.used / p.total * 100)}% full`, 'backups');
    const dd = p.details;
    if (dd) {
      for (const g of dd.gc || []) if (g.state && !/^ok$/i.test(g.state)) push('warn', `Backup server garbage collection on ${g.store}: ${g.state}`, 'backups');
      for (const j of dd.jobs || []) if (j.state && !/^ok$/i.test(j.state)) push('warn', `Backup server ${j.type} job ${j.id}: ${j.state}`, 'backups');
    }
  }
  for (const c of containersOf(agents)) {
    if (c.onboot && c.status !== 'running') push('error', `${c.name} (${c.vmid}) on ${c.host} is ${c.status}`, 'containers');
    const rep = (agents.find(x => x.name === c.agent) || {}).report || {};
    const bstale = rep.backups && (rep.backups.backupStale || (rep.backups.unreachableStorage || []).length);
    const lu = c.lastUpdate;
    if (lu && (lu.result === 'rolled-back' || lu.result === 'failed') && now - lu.t < 48 * HOUR) push('error', `${c.name}: last update ${lu.result}`, 'updates');
    const bs = backupState(c, now);
    if (!bstale && (bs === 'missing' || bs === 'stale')) push('warn', `${c.name}: ${bs === 'missing' ? 'no backup yet' : `last backup ${ago(c.backup.last.t, now)}`}`, 'backups');
    if (c.maxdisk && c.disk / c.maxdisk >= 0.9) push('warn', `${c.name} disk is ${Math.round(c.disk / c.maxdisk * 100)}% full`, 'containers');
  }
  const mDown = monitors.filter(m => m.status === 'down');
  if (mDown.length) push('error', `${mDown.length} public site${mDown.length > 1 ? 's' : ''} down: ${mDown.slice(0, 3).map(m => m.name).join(', ')}${mDown.length > 3 ? '…' : ''}`, 'monitors');
  const sDown = services.filter(s => s.status === 'down' && !s.stale);
  if (sDown.length) push('error', `${sDown.length} internal service${sDown.length > 1 ? 's' : ''} down: ${sDown.slice(0, 3).map(s => `${s.container}${s.port ? `:${s.port}` : ' (no ping)'}`).join(', ')}`, 'services');
  const order = { error: 0, warn: 1, info: 2 };
  return items.sort((x, y) => order[x.level] - order[y.level]);
}

module.exports = { attention, backupState, runState, containersOf, pbsServers, waitingApprovals, hostOf, ago };
