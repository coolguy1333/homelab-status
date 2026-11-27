'use strict';
// Read-only MCP server for the Claude connector (/mcp). Tools only read what the dashboard already has
// (lib/store.js, lib/infra.js, um-ha's /role and /cluster); nothing here changes anything.
//
// Never returned: agent tokens, ADMIN_PASSWORD, PEER_TOKEN, webhook URLs, sessions or OAuth data, and the
// content of chats and tasks with the agents (each tool picks its fields one by one; nothing is spread in).
const { DAY } = require('./store');
const ov = require('./overview');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const HA_TIMEOUT = 1500;

const iso = t => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const round1 = n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const pctOf = n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 10 : null); // 0.123 -> 12.3

class ToolError extends Error {}

// ------------------------------------------------------------ argument checks (JSON Schema is advisory only)
function args(input, spec) {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    let v = a[k];
    if (v === undefined || v === null || v === '') {
      if (s.required) throw new ToolError(`${k} is required`);
      out[k] = s.default;
      continue;
    }
    if (s.type === 'integer') {
      v = Number(v);
      if (!Number.isInteger(v)) throw new ToolError(`${k} must be an integer`);
      if (v < s.min || v > s.max) throw new ToolError(`${k} must be between ${s.min} and ${s.max}`);
    } else if (s.type === 'string') {
      v = String(v).slice(0, 200);
      if (s.enum && !s.enum.includes(v)) throw new ToolError(`${k} must be one of: ${s.enum.join(', ')}`);
    } else if (s.type === 'datetime') {
      const t = Date.parse(String(v));
      if (!Number.isFinite(t)) throw new ToolError(`${k} must be an ISO 8601 date-time`);
      v = t;
    }
    out[k] = v;
  }
  for (const k of Object.keys(a)) if (!(k in spec)) throw new ToolError(`Unknown argument: ${k}`);
  return out;
}

const limitArg = (def = DEFAULT_LIMIT, max = MAX_LIMIT) => ({ type: 'integer', min: 1, max, default: def });
const offsetArg = { type: 'integer', min: 0, max: 1e6, default: 0 };
const schemaOf = spec => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(spec).map(([k, s]) => [k, {
    type: s.type === 'datetime' ? 'string' : s.type,
    ...(s.type === 'datetime' ? { format: 'date-time' } : {}),
    ...(s.enum ? { enum: s.enum } : {}),
    ...(s.type === 'integer' ? { minimum: s.min, maximum: s.max } : {}),
    ...(s.default !== undefined ? { default: s.default } : {}),
    ...(s.description ? { description: s.description } : {}),
  }])),
  ...(Object.values(spec).some(s => s.required) ? { required: Object.entries(spec).filter(([, s]) => s.required).map(([k]) => k) } : {}),
  additionalProperties: false,
});

function page(list, offset, limit) {
  const items = list.slice(offset, offset + limit);
  return { total: list.length, offset, items, ...(offset + items.length < list.length ? { next_offset: offset + items.length } : {}) };
}

// ------------------------------------------------------------ data views
function createTools(ctx) {
  const { store, infra } = ctx;
  const agentNames = () => infra.agentStates().map(a => a.name);
  const agentArg = (required = false) => ({ type: 'string', required, description: 'Agent name, e.g. connector1 (see list_agents)' });
  const checkAgent = name => {
    if (name != null && !agentNames().includes(name)) throw new ToolError(`Unknown agent "${name}". Agents: ${agentNames().join(', ') || 'none'}`);
    return name;
  };
  const states = agent => infra.agentStates().filter(a => !agent || a.name === agent);

  function monitorRow(m) {
    const h = store.history[m.id] || { raw: [], status: 'pending' };
    const last = h.raw[h.raw.length - 1];
    return {
      id: m.id, name: m.name, type: m.type,
      status: m.paused ? 'paused' : (h.status || 'pending'),
      uptime_24h: round2(store.uptime(m.id, DAY)),
      uptime_30d: round2(store.uptime(m.id, 30 * DAY)),
      last_check_at: last ? iso(last.t) : null,
      response_ms: last && typeof last.ms === 'number' ? round1(last.ms) : null,
      target: m.type === 'tcp' ? (String(m.target).includes(':') ? `[${m.target}]:${m.port}` : `${m.target}:${m.port}`) : m.target,
    };
  }

  function serviceRows(agent) {
    return infra.services().filter(s => !agent || s.agent === agent).map(s => ({
      agent: s.agent, container: s.container ?? null, vmid: s.vmid ?? null, ip: s.ip ?? null,
      port: s.port || null, check: s.port ? 'tcp' : 'ping', process: s.proc || null,
      status: s.stale ? 'stale' : s.status, since: iso(s.since), uptime_24h: s.uptime24h,
      last_check_at: s.last ? iso(s.last.t) : null, response_ms: s.last ? round1(s.last.ms) : null,
    }));
  }

  const cache = { t: 0, v: null };
  async function ha() {
    if (Date.now() - cache.t < 5000 && cache.v) return cache.v;
    const get = async p => {
      try {
        const r = await (ctx.fetch || fetch)(`${ctx.umHaUrl}${p}`, { signal: AbortSignal.timeout(HA_TIMEOUT) });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    };
    const [role, cluster] = await Promise.all([get('/role'), get('/cluster')]);
    cache.t = Date.now();
    cache.v = { role, cluster };
    return cache.v;
  }

  const tools = [];
  const tool = (name, description, spec, run) => tools.push({ name, description, spec, run });

  // ---- 1
  tool('get_overview', 'Homelab health at a glance: the Overview page\'s needs-attention list, key counts, app version and this server\'s HA role. Start here.', {}, async input => {
    args(input, {});
    const agents = infra.agentStates();
    const monitors = store.monitors.map(monitorRow);
    const services = infra.services();
    const { role, cluster } = await ha();
    const cts = ov.containersOf(agents);
    let backupProblems = 0;
    for (const a of agents) {
      const b = (a.report && a.report.backups) || {};
      backupProblems += (b.tasks || []).filter(t => Date.now() - t.t < DAY && ov.runState(t) === 'failed').length;
      backupProblems += (b.unreachableStorage || []).length;
    }
    for (const p of ov.pbsServers(agents)) backupProblems += (p.reachable ? 0 : 1) + (p.verifyFailed || 0);
    backupProblems += cts.filter(c => ['missing', 'stale'].includes(ov.backupState(c))).length;
    const configured = agents.filter(a => a.configured);
    return {
      needs_attention: ov.attention({ agents, services, core: infra.coreSummary(), servers: cluster, monitors }),
      counts: {
        monitors_up: monitors.filter(m => m.status === 'up').length,
        monitors_down: monitors.filter(m => m.status === 'down').length,
        agents_online: configured.filter(a => a.online).length,
        agents_total: configured.length,
        containers_stopped: cts.filter(c => c.status !== 'running').length,
        approvals_waiting: configured.reduce((n, a) => n + ov.waitingApprovals(a).length, 0),
        backup_problems: backupProblems,
      },
      version: ctx.version,
      ha_role: role && typeof role.role === 'string' ? role.role : null,
    };
  });

  // ---- 2
  const monSpec = { status: { type: 'string', enum: ['up', 'down', 'paused'] }, limit: limitArg(), offset: offsetArg };
  tool('list_monitors', 'Public uptime monitors (HTTP/TCP/ping) with status, 24 h and 30 d uptime %, last check and response time.', monSpec, async input => {
    const a = args(input, monSpec);
    const rows = store.monitors.map(monitorRow).filter(m => !a.status || m.status === a.status);
    return page(rows, a.offset, a.limit);
  });

  // ---- 3
  const getMonSpec = { id: { type: 'string', required: true, description: 'Monitor id from list_monitors' } };
  tool('get_monitor', 'One monitor: the list_monitors fields, the last 24 h as 48 half-hour points {t, up_pct, avg_ms} and the last 20 up/down events.', getMonSpec, async input => {
    const a = args(input, getMonSpec);
    const m = store.monitors.find(x => x.id === a.id);
    if (!m) throw new ToolError(`No monitor with id "${a.id}"`);
    const h = store.history[m.id] || { raw: [], events: [] };
    const now = Date.now();
    const step = DAY / 48;
    const points = [];
    for (let i = 0; i < 48; i++) {
      const from = now - DAY + i * step, to = from + step;
      const cs = h.raw.filter(c => c.t >= from && c.t < to);
      if (!cs.length) continue;
      const ok = cs.filter(c => c.ok && typeof c.ms === 'number');
      points.push({ t: iso(Math.round(to)), up_pct: pct(cs.filter(c => c.ok).length, cs.length), avg_ms: ok.length ? round1(ok.reduce((s, c) => s + c.ms, 0) / ok.length) : null });
    }
    return {
      ...monitorRow(m),
      last_24h: points,
      events: (h.events || []).slice(-20).reverse().map(e => ({ t: iso(e.t), status: e.status, message: e.msg ? String(e.msg).slice(0, 300) : null })),
    };
  });

  // ---- 4
  tool('list_agents', 'Connector agents (one per Proxmox host): online, last report, agent version, host CPU %, memory % and storage use.', {}, async input => {
    args(input, {});
    return {
      items: infra.agentStates().map(a => {
        const r = a.report || {};
        const h = r.host || {};
        return {
          name: a.name, online: a.online, last_report_at: iso(a.receivedAt), agent_version: r.agentVersion || null,
          host: {
            name: h.node || null,
            cpu_pct: pctOf(h.cpu),
            mem_pct: h.memory ? pct(h.memory.used, h.memory.total) : null,
            storage: (h.storage || []).map(s => ({ name: s.name, used_pct: pct(s.used, s.total) })),
          },
        };
      }),
    };
  });

  // ---- 5
  const ctSpec = { agent: agentArg(), status: { type: 'string', enum: ['running', 'stopped'] }, limit: limitArg(), offset: offsetArg };
  tool('list_containers', 'LXC containers on all hosts: status, CPU/memory/disk %, pending updates (total, security), last backup and internal services that are down.', ctSpec, async input => {
    const a = args(input, ctSpec);
    checkAgent(a.agent);
    const down = serviceRows(a.agent).filter(s => s.status === 'down');
    const rows = ov.containersOf(states(a.agent))
      .filter(c => !a.status || (a.status === 'running' ? c.status === 'running' : c.status !== 'running'))
      .map(c => ({
        agent: c.agent, vmid: c.vmid, name: c.name, status: c.status,
        cpu_pct: pctOf(c.cpu), mem_pct: pct(c.mem, c.maxmem), disk_pct: pct(c.disk, c.maxdisk),
        updates: c.updates ? { total: c.updates.count || 0, security: c.updates.security || 0 } : null,
        last_backup_at: c.backup && c.backup.last ? iso(c.backup.last.t) : null,
        failed_services: down.filter(s => s.agent === c.agent && s.vmid === c.vmid).map(s => (s.port ? `${s.port}${s.process ? ` (${s.process})` : ''}` : 'ping')),
      }));
    return page(rows, a.offset, a.limit);
  });

  // ---- 6
  const apSpec = { agent: agentArg() };
  tool('list_approvals', 'Items waiting for the owner\'s approval (host/backup-server updates and reboots, held-back container updates) with up to 50 packages each.', apSpec, async input => {
    const a = args(input, apSpec);
    checkAgent(a.agent);
    const items = [];
    for (const s of states(a.agent)) {
      for (const p of ov.waitingApprovals(s)) {
        const pk = Array.isArray(p.packages) ? p.packages : [];
        items.push({
          id: p.id, agent: s.name, kind: p.kind || null, title: p.summary || null,
          packages: pk.slice(0, 50).map(x => ({ name: x.name, from: x.old ?? null, to: x.new ?? null })),
          ...(pk.length > 50 ? { packages_total: pk.length } : {}),
          since: iso(p.t),
        });
      }
    }
    return { items };
  });

  // ---- 7
  const runResult = level => (level === 'error' ? 'problems' : level === 'warn' ? 'warnings' : 'ok');
  function outcomes(log) {
    const out = [];
    for (const l of log || []) {
      const m = /^→ (.+?) \((\d+)\): (.*)$/.exec(l.m || '');
      if (!m) continue;
      const r = m[3];
      const outcome = /ROLLED BACK/.test(r) ? 'rolled_back' : /BROKEN|failed|error/i.test(r) ? 'failed' : /held/.test(r) ? 'held'
        : /installed/.test(r) ? 'installed' : /up to date/.test(r) ? 'up_to_date' : 'skipped';
      out.push({ vmid: Number(m[2]), name: m[1], outcome, detail: r.slice(0, 300) });
    }
    return out;
  }
  const countOutcomes = list => {
    const c = { installed: 0, held: 0, rolled_back: 0, failed: 0 };
    for (const o of list) if (o.outcome in c) c[o.outcome]++;
    return c;
  };
  const runMeta = r => ({
    id: r.id, title: r.title || null, mode: r.mode || null, started_at: iso(r.t), finished_at: iso(r.end), result: runResult(r.level),
    containers: { done: r.done || 0, total: r.total || 0 },
  });
  const runsSpec = { agent: agentArg(true), limit: limitArg(20, 40) };
  tool('list_update_runs', 'Recent update runs on one agent\'s host (newest first) with result and how many containers got updates installed, held, rolled back or failed.', runsSpec, async input => {
    const a = args(input, runsSpec);
    checkAgent(a.agent);
    const runs = infra.runList(a.agent).slice(0, a.limit).map(r => {
      const full = infra.runLog(a.agent, r.id);
      return { ...runMeta(full), outcome: countOutcomes(outcomes(full.log)) };
    });
    return { items: runs };
  });
  const runSpec = { agent: agentArg(true), id: { type: 'string', required: true, description: 'Run id from list_update_runs' }, log_lines: limitArg(100, 200) };
  tool('get_update_run', 'One update run: summary, per-container outcome (installed, held, rolled back, failed, up to date) and the last log lines.', runSpec, async input => {
    const a = args(input, runSpec);
    checkAgent(a.agent);
    let r;
    try { r = infra.runLog(a.agent, a.id); } catch { throw new ToolError(`No update run "${a.id}" on ${a.agent}`); }
    const list = outcomes(r.log);
    return {
      ...runMeta(r), summary: r.summary || null, outcome: countOutcomes(list), containers_outcome: list,
      log: (r.log || []).slice(-a.log_lines).map(l => ({ t: iso(l.t), level: l.l, message: l.m })),
    };
  });

  // ---- 8
  const bkSpec = { agent: agentArg() };
  tool('get_backups', 'Backups: vzdump jobs, last backup per container, failed runs, containers whose backup is missing or older than 26 h, and unreachable backup storage.', bkSpec, async input => {
    const a = args(input, bkSpec);
    checkAgent(a.agent);
    const list = states(a.agent);
    const out = { jobs: [], last_backups: [], failed_runs: [], stale_backups: [], unreachable_storage: [] };
    for (const s of list) {
      const b = (s.report && s.report.backups) || {};
      for (const j of b.jobs || []) out.jobs.push({ agent: s.name, id: j.id, schedule: j.schedule || null, storage: j.storage || null, enabled: j.enabled !== false });
      for (const t of b.tasks || []) if (ov.runState(t) === 'failed') out.failed_runs.push({ agent: s.name, vmid: t.vmid ?? null, at: iso(t.t), status: String(t.status).slice(0, 200) });
      for (const st of b.unreachableStorage || []) out.unreachable_storage.push({ agent: s.name, storage: st });
    }
    for (const c of ov.containersOf(list)) {
      const last = c.backup && c.backup.last;
      out.last_backups.push({ agent: c.agent, vmid: c.vmid, name: c.name, at: last ? iso(last.t) : null, size: last ? last.size ?? null : null, verified: last ? last.verified || null : null });
      const st = ov.backupState(c);
      if (['missing', 'old', 'stale'].includes(st)) out.stale_backups.push({ agent: c.agent, vmid: c.vmid, name: c.name, state: st, last_at: last ? iso(last.t) : null });
    }
    for (const p of ov.pbsServers(list)) if (!p.reachable) out.unreachable_storage.push({ agent: p.seenBy, storage: p.storage, server: p.server || null });
    out.failed_runs.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return out;
  });

  // ---- 9
  const evSpec = { agent: agentArg(), level: { type: 'string', enum: ['info', 'warn', 'error'] }, since: { type: 'datetime', description: 'Only events after this ISO 8601 time' }, limit: limitArg(), offset: offsetArg };
  tool('list_events', 'Agent activity events (what the Activity page shows, 30 days), newest first.', evSpec, async input => {
    const a = args(input, evSpec);
    checkAgent(a.agent);
    const rows = [];
    for (const name of agentNames()) {
      if (a.agent && name !== a.agent) continue;
      for (const e of infra.agentEvents(name)) {
        if (a.level && e.level !== a.level) continue;
        if (a.since && !(e.t > a.since)) continue;
        rows.push({ t: e.t, agent: name, level: e.level, message: e.msg });
      }
    }
    rows.sort((x, y) => y.t - x.t);
    return page(rows.map(r => ({ ...r, t: iso(r.t) })), a.offset, a.limit);
  });

  // ---- 10
  const logSpec = { agent: agentArg(true), level: { type: 'string', enum: ['info', 'warn', 'error'] }, limit: limitArg(100, 200) };
  tool('get_agent_logs', 'The newest lines of one agent\'s own log (oldest first). Chat messages are hidden.', logSpec, async input => {
    const a = args(input, logSpec);
    checkAgent(a.agent);
    const lines = infra.agentLogs(a.agent).filter(l => !a.level || l.l === a.level).slice(-a.limit);
    return {
      agent: a.agent,
      lines: lines.map(l => ({ t: iso(l.t), process: l.p || null, level: l.l, message: hideChat(l.m) })),
    };
  });

  // ---- 11
  const usSpec = { agent: agentArg() };
  tool('get_claude_usage', 'Claude usage by the agents: runs, tokens and cost (USD at API prices) today, last 7 and 30 days, plus the last 15 runs.', usSpec, async input => {
    const a = args(input, usSpec);
    checkAgent(a.agent);
    const sum = key => {
      const o = { runs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
      for (const s of states(a.agent)) {
        const u = s.report && s.report.usage && s.report.usage[key];
        if (!u) continue;
        o.runs += u.runs || 0; o.input += u.input || 0; o.output += u.output || 0;
        o.cache_read += u.cacheRead || 0; o.cache_write += u.cacheWrite || 0; o.cost += u.cost || 0;
      }
      o.cost = Math.round(o.cost * 100) / 100;
      return o;
    };
    const recent = [];
    for (const s of states(a.agent)) for (const r of ((s.report && s.report.usage && s.report.usage.recent) || [])) recent.push({ ...r, agent: s.name });
    recent.sort((x, y) => (y.t || 0) - (x.t || 0));
    return {
      today: sum('today'), week: sum('week'), month: sum('month'),
      recent: recent.slice(0, 15).map(r => ({
        t: iso(r.t), agent: r.agent, kind: r.kind || 'task',
        // A chat task's label is the start of the message: never shown here.
        label: r.kind === 'review' ? String(r.label || '').slice(0, 120) : r.kind === 'autofix' ? 'auto-fix' : 'chat message',
        tokens: (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0),
        cost: Math.round((r.cost || 0) * 10000) / 10000,
      })),
    };
  });

  // ---- 12
  const svSpec = { agent: agentArg(), status: { type: 'string', enum: ['up', 'down', 'stale'] }, limit: limitArg(), offset: offsetArg };
  tool('list_services', 'Internal services the agents found in the containers (listening ports and container pings) and whether they answer from the LAN.', svSpec, async input => {
    const a = args(input, svSpec);
    checkAgent(a.agent);
    const rows = serviceRows(a.agent).filter(s => !a.status || s.status === a.status)
      .sort((x, y) => String(x.agent).localeCompare(String(y.agent)) || (x.vmid || 0) - (y.vmid || 0) || (x.port || 0) - (y.port || 0));
    return page(rows, a.offset, a.limit);
  });

  // ---- 13
  tool('get_ha_status', 'High availability of the status site (um-ha pair): this server\'s role, epoch, last data sync, and whether the other server is reachable and healthy. Fields are null when um-ha is not running here.', {}, async input => {
    args(input, {});
    const { role, cluster } = await ha();
    const peer = cluster && cluster.peer;
    const healthy = peer && peer.reachable
      ? (peer.role === 'primary' ? Boolean(peer.app) : peer.role === 'replica' ? Boolean(peer.syncedAt && peer.time - peer.syncedAt < 60e3) : false)
      : null;
    return {
      role: role && typeof role.role === 'string' ? role.role : null,
      epoch: role && typeof role.epoch === 'number' ? role.epoch : null,
      last_sync_at: role ? iso(role.syncedAt) : null,
      peer_reachable: peer ? Boolean(peer.reachable) : null,
      peer_healthy: peer ? (peer.reachable ? healthy : false) : null,
    };
  });

  for (const t of tools) t.inputSchema = schemaOf(t.spec);
  return tools;
}

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

// The agent logs the start of a chat message it answered with a script: keep the line, drop the message.
function hideChat(m) {
  return String(m || '').replace(/^(answered by script \(no Claude\):).*$/s, '$1 [chat message hidden]');
}

// ------------------------------------------------------------ MCP over Streamable HTTP (stateless, JSON responses)
let sdk = null;
function loadSdk() {
  if (sdk) return sdk;
  sdk = {
    Server: require('@modelcontextprotocol/sdk/server/index.js').Server,
    Transport: require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport,
    types: require('@modelcontextprotocol/sdk/types.js'),
  };
  return sdk;
}

const INSTRUCTIONS = 'Read-only view of a homelab: Proxmox hosts reported by connector agents, LXC containers, updates and approvals, ' +
  'backups, public uptime monitors, internal services and the status site\'s HA pair. Start with get_overview. ' +
  'Times are ISO 8601 (UTC), percentages are numbers 0-100. Nothing can be changed through these tools.';

// One request = one server + transport (stateless). auth: { clientId, clientName, email } from the access token.
async function handle(req, res, body, { tools, version, auth, log = console.log }) {
  const { Server, Transport, types } = loadSdk();
  const server = new Server({ name: 'homelab-status', title: 'Homelab Status', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const byName = new Map(tools.map(t => [t.name, t]));
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(types.CallToolRequestSchema, async request => {
    const t = byName.get(request.params.name);
    const started = Date.now();
    let result, failed = false;
    if (!t) { result = { content: [{ type: 'text', text: `Unknown tool: ${String(request.params.name).slice(0, 80)}` }], isError: true }; failed = true; }
    else {
      try {
        result = { content: [{ type: 'text', text: JSON.stringify(await t.run(request.params.arguments || {})) }] };
      } catch (err) {
        failed = true;
        if (!(err instanceof ToolError)) console.error(`[mcp] ${t.name}:`, err);
        result = { content: [{ type: 'text', text: err instanceof ToolError ? err.message : 'Internal error' }], isError: true };
      }
    }
    log(`[mcp] ${t ? t.name : 'unknown tool'} by ${auth.clientName} (${auth.email}) ${Date.now() - started} ms${failed ? ' error' : ''}`);
    return result;
  });
  const transport = new Transport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function sdkAvailable() {
  try { loadSdk(); return true; } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; sdk = null; return false; }
}

module.exports = { createTools, handle, sdkAvailable, ToolError, DEFAULT_LIMIT, MAX_LIMIT };
