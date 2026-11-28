'use strict';
// The datacenter-wide update lease (one host updates at a time) and Datacenter answers marked "not mine".
const test = require('node:test');
const assert = require('node:assert');
const { tmpDir, env } = require('./fixtures');

Object.assign(process.env, env());
const { Infra } = require('../lib/infra');

const fresh = () => new Infra(tmpDir(), null);

test('only one agent holds the update lease; the other is told who has it', () => {
  const infra = fresh();
  assert.deepStrictEqual(infra.lease('connector1', { op: 'acquire', id: 'a1', what: 'run' }).granted, true);
  const r = infra.lease('connector2', { op: 'acquire', id: 'b1', what: 'run' });
  assert.strictEqual(r.granted, false);
  assert.strictEqual(r.holder, 'connector1');
  assert.strictEqual(r.what, 'run');
  assert.strictEqual(infra.leaseInfo().holder, 'connector1');
});

test('the holder can renew; a release with the wrong id does nothing; the right id frees it', () => {
  const infra = fresh();
  infra.lease('connector1', { op: 'acquire', id: 'a1' });
  assert.strictEqual(infra.lease('connector1', { op: 'acquire', id: 'a1' }).granted, true);
  infra.lease('connector1', { op: 'release', id: 'nope' });
  assert.strictEqual(infra.lease('connector2', { op: 'acquire', id: 'b1' }).granted, false);
  infra.lease('connector2', { op: 'release', id: 'a1' }); // not the holder
  assert.strictEqual(infra.lease('connector2', { op: 'acquire', id: 'b1' }).granted, false);
  infra.lease('connector1', { op: 'release', id: 'a1' });
  assert.strictEqual(infra.leaseInfo(), null);
  assert.strictEqual(infra.lease('connector2', { op: 'acquire', id: 'b1' }).granted, true);
});

test('an expired lease can be taken by the other agent', () => {
  const infra = fresh();
  infra.lease('connector1', { op: 'acquire', id: 'a1', ttl: 60e3 });
  infra.data.leases.updates.until = Date.now() - 1;
  assert.strictEqual(infra.leaseInfo(), null);
  assert.strictEqual(infra.lease('connector2', { op: 'acquire', id: 'b1' }).granted, true);
});

test('ttl is clamped and bad requests are refused', () => {
  const infra = fresh();
  const r = infra.lease('connector1', { op: 'acquire', id: 'a1', ttl: 1 });
  assert.ok(r.until - Date.now() >= 59e3);
  infra.lease('connector1', { op: 'release', id: 'a1' });
  const r2 = infra.lease('connector1', { op: 'acquire', id: 'a2', ttl: 1e12 });
  assert.ok(r2.until - Date.now() <= 60 * 60e3 + 1000);
  assert.throws(() => infra.lease('connector1', { op: 'grab', id: 'x' }), /op must be/);
  assert.throws(() => infra.lease('connector1', { op: 'acquire' }), /op must be/);
});

test('a Datacenter answer marked notMine is stored on the task', () => {
  const infra = fresh();
  const [t1, t2] = infra.addGroupTask('status of 212', 'admin');
  infra.applyResults('connector1', { taskResults: [{ id: t1.id, status: 'done', output: 'running', usage: { script: true } }] });
  infra.applyResults('connector2', { taskResults: [{ id: t2.id, status: 'done', output: 'No container called `212` on this host.', notMine: true }] });
  const get = (agent, id) => infra.data.tasks[agent].find(t => t.id === id);
  assert.strictEqual(get('connector1', t1.id).notMine, undefined);
  assert.strictEqual(get('connector2', t2.id).notMine, true);
});

// ---- Datacenter answers: ONE reply (agent 1.16+ writes it from every host's part)
const online = (infra, versions = { connector1: '1.16.0', connector2: '1.16.0' }) => {
  infra.data.agents = {};
  for (const [name, v] of Object.entries(versions)) {
    infra.data.agents[name] = { receivedAt: Date.now(), report: { agentVersion: v, host: { node: name === 'connector1' ? 'GOD' : 'HELP' } } };
  }
};
const merges = infra => Object.entries(infra.data.tasks).flatMap(([agent, l]) => l.filter(t => t.merge).map(t => ({ agent, t })));

test('when both hosts answered, one merge task goes to one agent with both parts', () => {
  const infra = fresh();
  online(infra);
  const [t1, t2] = infra.addGroupTask('what needs updating?', 'admin');
  infra.applyResults('connector2', { taskResults: [{ id: t2.id, status: 'done', output: 'HELP: 2 updates' }] });
  assert.strictEqual(merges(infra).length, 0, 'waits for every host');
  infra.applyResults('connector1', { taskResults: [{ id: t1.id, status: 'done', output: 'GOD: 1 update' }] });
  const m = merges(infra);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].agent, 'connector1');
  assert.strictEqual(m[0].t.group, t1.group);
  assert.strictEqual(m[0].t.chat, t1.chat);
  assert.deepStrictEqual(m[0].t.merge.map(p => [p.host, p.output, p.failed]), [['GOD', 'GOD: 1 update', false], ['HELP', 'HELP: 2 updates', false]]);
  // The agent gets the parts and the plain question, no chat (no session to resume).
  const out = infra.outbox('connector1').tasks.find(t => t.id === m[0].t.id);
  assert.strictEqual(out.text, 'what needs updating?');
  assert.strictEqual(out.chat, undefined);
  assert.strictEqual(out.merge.length, 2);
  // A merge task finishing doesn't start another one, and it doesn't count as a chat message.
  infra.applyResults('connector1', { taskResults: [{ id: m[0].t.id, status: 'done', output: 'One answer' }] });
  assert.strictEqual(merges(infra).length, 1);
  assert.strictEqual(infra.chatList().find(c => c.id === t1.chat).messages, 2);
});

test('no merge when only one host had something (the other said notMine)', () => {
  const infra = fresh();
  online(infra);
  const [t1, t2] = infra.addGroupTask('restart nginx', 'admin');
  infra.applyResults('connector1', { taskResults: [{ id: t1.id, status: 'done', output: 'restarted' }] });
  infra.applyResults('connector2', { taskResults: [{ id: t2.id, status: 'done', output: 'Nothing on this host for that.', notMine: true }] });
  assert.strictEqual(merges(infra).length, 0);
});

test('a failed part is still merged; an older or offline agent never gets a merge task', () => {
  const infra = fresh();
  online(infra, { connector1: '1.15.2', connector2: '1.16.0' });
  const [t1, t2] = infra.addGroupTask('status', 'admin');
  infra.applyResults('connector1', { taskResults: [{ id: t1.id, status: 'done', output: 'fine' }] });
  infra.applyResults('connector2', { taskResults: [{ id: t2.id, status: 'failed', output: 'Claude stopped' }] });
  const m = merges(infra);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].agent, 'connector2', 'connector1 is too old');
  assert.strictEqual(m[0].t.merge.find(p => p.host === 'HELP').failed, true);

  const infra2 = fresh();
  online(infra2, { connector1: '1.15.2', connector2: '1.16.0' });
  const [u1, u2] = infra2.addGroupTask('status', 'admin');
  infra2.applyResults('connector2', { taskResults: [{ id: u2.id, status: 'done', output: 'b' }] });
  Object.assign(infra2.data.agents.connector2, { receivedAt: Date.now() - 60 * 60e3, lastSync: Date.now() - 60 * 60e3 }); // then went offline
  infra2.applyResults('connector1', { taskResults: [{ id: u1.id, status: 'done', output: 'a' }] });
  assert.strictEqual(merges(infra2).length, 0, 'falls back to the per-host answers');
});

// ---- the backup server card (agent 1.17+): its own nightly setting and update buttons
test('policy: pbs and securityOnly are set independently and reach the agent', () => {
  const infra = fresh();
  infra.setPolicy('connector1', { securityOnly: true }, 'admin');
  infra.setPolicy('connector1', { pbs: 'security' }, 'admin');
  assert.deepStrictEqual([infra.data.policy.connector1.securityOnly, infra.data.policy.connector1.pbs], [true, 'security']);
  infra.setPolicy('connector1', { securityOnly: false }, 'admin');
  assert.strictEqual(infra.data.policy.connector1.pbs, 'security', 'kept');
  assert.strictEqual(infra.outbox('connector1').policy.pbs, 'security');
  assert.throws(() => infra.setPolicy('connector1', { pbs: 'everything' }, 'admin'), /pbs must be/);
  infra.setPolicy('connector2', true, 'admin'); // old call shape
  assert.deepStrictEqual([infra.data.policy.connector2.securityOnly, infra.data.policy.connector2.pbs], [true, 'ask']);
});

test('backup server update actions only go to the agent that manages it', () => {
  const infra = fresh();
  infra.data.agents = {
    connector1: { receivedAt: Date.now(), report: { containers: [], pbsHost: { name: 'HOLY' } } },
    connector2: { receivedAt: Date.now(), report: { containers: [] } },
  };
  const t = infra.addAction('connector1', 'pbs-update-security', null, 'admin');
  assert.deepStrictEqual(t.action, { type: 'pbs-update-security', vmid: null });
  assert.ok(infra.addAction('connector1', 'pbs-update-all', null, 'admin'));
  assert.throws(() => infra.addAction('connector2', 'pbs-update-all', null, 'admin'), /does not manage the backup server/);
  assert.throws(() => infra.addAction('connector1', 'pbs-update-all', null, 'admin'), /already queued/);
});
