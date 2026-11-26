'use strict';
// Output shape and limits of every MCP tool, and that no secret ever appears in what they return.
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures');

Object.assign(process.env, fx.env());
const { Store } = require('../lib/store');
const { Infra } = require('../lib/infra');
const { createTools, ToolError } = require('../lib/mcp');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const keys = o => Object.keys(o).sort();
const isoOrNull = v => v === null || ISO.test(v);

function setup({ ha = true, ...opts } = {}) {
  const dir = fx.tmpDir();
  fx.writeFixtures(dir, opts);
  const store = new Store(dir);
  const infra = new Infra(dir, null);
  const now = Date.now();
  const fakeFetch = async u => {
    if (!ha) throw new Error('ECONNREFUSED');
    const body = u.endsWith('/role') ? fx.haRole(now) : fx.haCluster(now);
    return { ok: true, json: async () => body };
  };
  const tools = createTools({ store, infra, version: '9.9.9', umHaUrl: 'http://127.0.0.1:1', fetch: fakeFetch });
  const run = (name, a = {}) => tools.find(t => t.name === name).run(a);
  return { tools, run, store, infra };
}

test('13 tools, all read-only, with short descriptions and closed schemas', () => {
  const { tools } = setup();
  assert.deepEqual(tools.map(t => t.name), ['get_overview', 'list_monitors', 'get_monitor', 'list_agents', 'list_containers', 'list_approvals',
    'list_update_runs', 'get_update_run', 'get_backups', 'list_events', 'get_agent_logs', 'get_claude_usage', 'list_services', 'get_ha_status']);
  for (const t of tools) {
    assert.ok(t.description.length > 20 && t.description.length < 260, t.name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('get_overview', async () => {
  const { run } = setup();
  const o = await run('get_overview');
  assert.deepEqual(keys(o), ['counts', 'ha_role', 'needs_attention', 'version']);
  assert.deepEqual(keys(o.counts), ['agents_online', 'agents_total', 'approvals_waiting', 'backup_problems', 'containers_stopped', 'monitors_down', 'monitors_up']);
  assert.equal(o.version, '9.9.9');
  assert.equal(o.ha_role, 'primary');
  assert.equal(o.counts.agents_total, 2);
  assert.equal(o.counts.agents_online, 1);           // connector2 reported an hour ago
  assert.equal(o.counts.approvals_waiting, 3);       // p1 on both, p2 only on connector2 (decided on connector1)
  assert.equal(o.counts.containers_stopped, 2);
  assert.equal(o.counts.monitors_down, 0);
  for (const i of o.needs_attention) {
    assert.deepEqual(keys(i), ['area', 'level', 'text']);
    assert.ok(['error', 'warn', 'info'].includes(i.level));
  }
  const texts = o.needs_attention.map(i => i.text).join('\n');
  assert.match(texts, /Agent connector2 \(HELP\) offline/);
  assert.match(texts, /HOLY \(PBS\) is DOWN/);
  assert.match(texts, /ct3: last update rolled-back/);
  assert.match(texts, /1 internal service down: ct0:80/);
  assert.match(texts, /GOD storage local is 95% full/);
  assert.equal(o.needs_attention[0].level, 'error');
  assert.equal(o.needs_attention[o.needs_attention.length - 1].level, 'info');
});

test('get_overview and get_ha_status without um-ha', async () => {
  const { run } = setup({ ha: false });
  assert.equal((await run('get_overview')).ha_role, null);
  assert.deepEqual(await run('get_ha_status'), { role: null, epoch: null, last_sync_at: null, peer_reachable: null, peer_healthy: null });
});

test('get_ha_status', async () => {
  const { run } = setup();
  const h = await run('get_ha_status');
  assert.deepEqual(keys(h), ['epoch', 'last_sync_at', 'peer_healthy', 'peer_reachable', 'role']);
  assert.equal(h.role, 'primary');
  assert.equal(typeof h.epoch, 'number');
  assert.equal(h.peer_reachable, true);
  assert.equal(h.peer_healthy, true);
});

test('list_monitors: fields, filter, default limit 50, max 200, offset', async () => {
  const { run } = setup({ monitors: 260 });
  const p = await run('list_monitors');
  assert.equal(p.total, 260);
  assert.equal(p.items.length, 50);
  assert.equal(p.next_offset, 50);
  const m = p.items[0];
  assert.deepEqual(keys(m), ['id', 'last_check_at', 'name', 'response_ms', 'status', 'target', 'type', 'uptime_24h', 'uptime_30d']);
  assert.ok(ISO.test(m.last_check_at));
  assert.equal(typeof m.uptime_24h, 'number');
  assert.equal((await run('list_monitors', { limit: 200 })).items.length, 200);
  await assert.rejects(run('list_monitors', { limit: 201 }), ToolError);
  await assert.rejects(run('list_monitors', { limit: 0 }), ToolError);
  const last = await run('list_monitors', { limit: 200, offset: 200 });
  assert.equal(last.items.length, 60);
  assert.equal(last.next_offset, undefined);
  const down = await run('list_monitors', { status: 'down', limit: 200 });
  assert.ok(down.items.length > 0 && down.items.every(x => x.status === 'down'));
  assert.ok((await run('list_monitors', { status: 'paused', limit: 200 })).items.every(x => x.status === 'paused'));
  await assert.rejects(run('list_monitors', { status: 'sideways' }), ToolError);
  await assert.rejects(run('list_monitors', { nope: 1 }), /Unknown argument/);
  const tcp = (await run('list_monitors')).items.find(x => x.type === 'tcp');
  assert.equal(tcp.target, '10.0.0.5:443');
});

test('get_monitor: at most 48 points and the last 20 events', async () => {
  const { run } = setup();
  const m = await run('get_monitor', { id: 'm0000' });
  assert.deepEqual(keys(m), ['events', 'id', 'last_24h', 'last_check_at', 'name', 'response_ms', 'status', 'target', 'type', 'uptime_24h', 'uptime_30d']);
  assert.ok(m.last_24h.length > 0 && m.last_24h.length <= 48);
  for (const pt of m.last_24h) {
    assert.deepEqual(keys(pt), ['avg_ms', 't', 'up_pct']);
    assert.ok(ISO.test(pt.t));
    assert.ok(pt.up_pct >= 0 && pt.up_pct <= 100);
  }
  assert.equal(m.events.length, 20);
  assert.deepEqual(keys(m.events[0]), ['message', 'status', 't']);
  assert.ok(m.events[0].t > m.events[1].t, 'newest first');
  await assert.rejects(run('get_monitor', { id: 'nope' }), /No monitor/);
  await assert.rejects(run('get_monitor', {}), /id is required/);
});

test('list_agents', async () => {
  const { run } = setup();
  const { items } = await run('list_agents');
  assert.equal(items.length, 2);
  const a = items[0];
  assert.deepEqual(keys(a), ['agent_version', 'host', 'last_report_at', 'name', 'online']);
  assert.deepEqual(keys(a.host), ['cpu_pct', 'mem_pct', 'name', 'storage']);
  assert.equal(a.host.cpu_pct, 12.3);
  assert.equal(a.host.mem_pct, 50);
  assert.deepEqual(a.host.storage[0], { name: 'local', used_pct: 95 });
  assert.ok(ISO.test(a.last_report_at));
});

test('list_containers', async () => {
  const { run } = setup();
  const p = await run('list_containers');
  assert.equal(p.total, 12);
  const c = p.items.find(x => x.vmid === 200 && x.agent === 'connector1');
  assert.deepEqual(keys(c), ['agent', 'cpu_pct', 'disk_pct', 'failed_services', 'last_backup_at', 'mem_pct', 'name', 'status', 'updates', 'vmid']);
  assert.deepEqual(c.updates, { total: 0, security: 0 });
  assert.equal(c.mem_pct, 50);
  assert.equal(c.disk_pct, 50);
  assert.deepEqual(c.failed_services, ['80 (nginx)']);
  assert.ok(ISO.test(c.last_backup_at));
  assert.equal((await run('list_containers', { agent: 'connector2' })).total, 6);
  assert.equal((await run('list_containers', { status: 'stopped' })).total, 2);
  assert.equal((await run('list_containers', { limit: 5, offset: 10 })).items.length, 2);
  await assert.rejects(run('list_containers', { agent: 'connector9' }), /Unknown agent/);
});

test('list_approvals: waiting items only, at most 50 packages', async () => {
  const { run } = setup();
  const { items } = await run('list_approvals');
  assert.equal(items.length, 3);
  const p1 = items.find(x => x.id === 'p1');
  assert.deepEqual(keys(p1), ['agent', 'id', 'kind', 'packages', 'packages_total', 'since', 'title']);
  assert.equal(p1.packages.length, 50);
  assert.equal(p1.packages_total, 80);
  assert.deepEqual(p1.packages[0], { name: 'pkg0', from: '1.0', to: '1.1' });
  assert.ok(ISO.test(p1.since));
  assert.equal((await run('list_approvals', { agent: 'connector1' })).items.length, 1);
});

test('list_update_runs and get_update_run', async () => {
  const { run } = setup();
  const { items } = await run('list_update_runs', { agent: 'connector1' });
  assert.equal(items.length, 1);
  const r = items[0];
  assert.deepEqual(keys(r), ['containers', 'finished_at', 'id', 'mode', 'outcome', 'result', 'started_at', 'title']);
  assert.deepEqual(r.outcome, { installed: 1, held: 1, rolled_back: 1, failed: 0 });
  assert.equal(r.result, 'problems');
  assert.ok(ISO.test(r.started_at) && ISO.test(r.finished_at));
  const full = await run('get_update_run', { agent: 'connector1', id: 'abc123' });
  assert.equal(full.log.length, 100);
  assert.deepEqual(keys(full.log[0]), ['level', 'message', 't']);
  assert.deepEqual(full.containers_outcome.map(o => o.outcome), ['installed', 'held', 'rolled_back', 'up_to_date']);
  assert.deepEqual(keys(full.containers_outcome[0]), ['detail', 'name', 'outcome', 'vmid']);
  assert.equal((await run('get_update_run', { agent: 'connector1', id: 'abc123', log_lines: 200 })).log.length, 200);
  await assert.rejects(run('get_update_run', { agent: 'connector1', id: 'abc123', log_lines: 201 }), ToolError);
  await assert.rejects(run('get_update_run', { agent: 'connector1', id: 'ffffff' }), /No update run/);
  await assert.rejects(run('list_update_runs', {}), /agent is required/);
  assert.deepEqual((await run('list_update_runs', { agent: 'connector2' })).items, []);
});

test('get_backups', async () => {
  const { run } = setup();
  const b = await run('get_backups', { agent: 'connector1' });
  assert.deepEqual(keys(b), ['failed_runs', 'jobs', 'last_backups', 'stale_backups', 'unreachable_storage']);
  assert.deepEqual(b.jobs, [{ agent: 'connector1', id: 'backup-1', schedule: '02:00', storage: 'pbs', enabled: true }]);
  assert.equal(b.last_backups.length, 6);
  assert.deepEqual(keys(b.last_backups[0]), ['agent', 'at', 'name', 'size', 'verified', 'vmid']);
  assert.deepEqual(b.failed_runs.map(r => r.vmid), [201]);
  assert.deepEqual(b.stale_backups.map(s => [s.vmid, s.state]).sort(), [[201, 'stale'], [204, 'missing']]);
  assert.deepEqual(b.unreachable_storage, [{ agent: 'connector1', storage: 'nfs-old' }]);
});

test('list_events: filters, newest first, limits', async () => {
  const { run } = setup({ events: 150 });
  const p = await run('list_events');
  assert.equal(p.total, 300);
  assert.equal(p.items.length, 50);
  assert.deepEqual(keys(p.items[0]), ['agent', 'level', 'message', 't']);
  assert.ok(p.items[0].t >= p.items[1].t);
  assert.equal((await run('list_events', { limit: 200 })).items.length, 200);
  await assert.rejects(run('list_events', { limit: 500 }), ToolError);
  assert.ok((await run('list_events', { level: 'error', limit: 200 })).items.every(e => e.level === 'error'));
  assert.equal((await run('list_events', { agent: 'connector2' })).total, 150);
  const since = new Date(Date.now() - 10.5 * 60e3).toISOString();
  assert.equal((await run('list_events', { since })).total, 22);
  await assert.rejects(run('list_events', { since: 'yesterday-ish' }), /ISO 8601/);
});

test('get_agent_logs: default 100, max 200, oldest first, chat hidden', async () => {
  const { run } = setup();
  const l = await run('get_agent_logs', { agent: 'connector1' });
  assert.deepEqual(keys(l), ['agent', 'lines']);
  assert.equal(l.lines.length, 100);
  assert.deepEqual(keys(l.lines[0]), ['level', 'message', 'process', 't']);
  assert.ok(l.lines[0].t < l.lines[99].t);
  assert.equal(l.lines[99].message, 'answered by script (no Claude): [chat message hidden]');
  assert.equal((await run('get_agent_logs', { agent: 'connector1', limit: 200 })).lines.length, 200);
  await assert.rejects(run('get_agent_logs', { agent: 'connector1', limit: 201 }), ToolError);
  assert.ok((await run('get_agent_logs', { agent: 'connector1', level: 'error' })).lines.every(x => x.level === 'error'));
  assert.deepEqual((await run('get_agent_logs', { agent: 'connector2' })).lines, []);
});

test('get_claude_usage', async () => {
  const { run } = setup();
  const u = await run('get_claude_usage');
  assert.deepEqual(keys(u), ['month', 'recent', 'today', 'week']);
  assert.deepEqual(u.today, { runs: 4, input: 200, output: 100, cache_read: 20, cache_write: 10, cost: 0.24 });
  assert.equal(u.recent.length, 15);
  assert.deepEqual(keys(u.recent[0]), ['agent', 'cost', 'kind', 'label', 't', 'tokens']);
  assert.equal(u.recent[0].tokens, 17);
  assert.equal(u.recent.find(r => r.kind === 'review').label, 'update review: ct1');
  assert.equal(u.recent.find(r => r.kind === 'task').label, 'chat message');
  assert.equal((await run('get_claude_usage', { agent: 'connector1' })).today.runs, 2);
});

test('list_services', async () => {
  const { run } = setup();
  const p = await run('list_services');
  assert.equal(p.total, 2);
  assert.deepEqual(keys(p.items[0]), ['agent', 'check', 'container', 'ip', 'last_check_at', 'port', 'process', 'response_ms', 'since', 'status', 'uptime_24h', 'vmid']);
  assert.deepEqual((await run('list_services', { status: 'down' })).items.map(s => s.port), [80]);
  assert.equal((await run('list_services', { agent: 'connector2' })).total, 0);
});

test('every time field is ISO 8601 or null', async () => {
  const { tools, run } = setup();
  const timeKeys = /(^t$|_at$|^since$)/;
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (timeKeys.test(k) && typeof x !== 'object') assert.ok(isoOrNull(x), `${where}.${k} = ${x}`); walk(x, `${where}.${k}`); }
  };
  for (const t of tools) {
    const want = { agent: 'connector1', id: t.name === 'get_monitor' ? 'm0000' : 'abc123' };
    const a = Object.fromEntries((t.inputSchema.required || []).map(k => [k, want[k]]));
    walk(await run(t.name, a), t.name);
  }
});

test('no secret appears in any tool output', async () => {
  const { tools, run } = setup();
  const outputs = [];
  for (const t of tools) {
    const variants = [{}, { agent: 'connector1' }, { agent: 'connector2' }, { limit: 200 }];
    for (const v of variants) {
      const a = { ...v };
      if (t.name === 'get_monitor') { a.id = 'm0000'; delete a.agent; delete a.limit; }
      if (t.name === 'get_update_run') { a.agent = 'connector1'; a.id = 'abc123'; a.log_lines = 200; delete a.limit; }
      for (const k of Object.keys(a)) if (!(k in t.inputSchema.properties)) delete a[k];
      try { outputs.push(JSON.stringify(await run(t.name, a))); } catch (err) { assert.ok(err instanceof ToolError, `${t.name}: ${err.message}`); }
    }
  }
  const all = outputs.join('\n');
  assert.ok(all.length > 10000);
  for (const [name, s] of Object.entries(fx.SECRETS)) assert.ok(!all.includes(s), `${name} leaked`);
  assert.ok(!/SECRET/.test(all), 'something marked SECRET leaked');
  assert.ok(!/hs_(at|rt|code)_/.test(all));
});
