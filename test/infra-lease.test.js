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
