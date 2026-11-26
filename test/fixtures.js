'use strict';
// Test data: a DATA_DIR with two agents, containers, backups, update runs, logs, monitors and secrets that
// must never show up in anything the connector returns.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETS = {
  agentToken: 'agent-token-SECRET-0123456789abcdef',
  adminPassword: 'admin-password-SECRET-42',
  peerToken: 'peer-token-SECRET-xyz',
  webhook: 'https://discord.com/api/webhooks/SECRET-WEBHOOK/abc',
  envWebhook: 'https://ntfy.sh/SECRET-ENV-WEBHOOK',
  chatText: 'SECRET-CHAT-MESSAGE please check nginx',
  chatTitle: 'SECRET-CHAT-TITLE',
  taskOutput: 'SECRET-TASK-OUTPUT the answer',
  sessionToken: 'SECRET-SESSION-TOKEN',
};

const env = () => ({
  AGENT_TOKENS: `connector1:${SECRETS.agentToken},connector2:${SECRETS.agentToken}2`,
  ADMIN_PASSWORD: SECRETS.adminPassword,
  PEER_TOKEN: SECRETS.peerToken,
  NOTIFY_WEBHOOK_URL: SECRETS.envWebhook,
});

function tmpDir(prefix = 'hs-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function writeFixtures(dir, { monitors = 3, events = 30, logLines = 300, now = Date.now() } = {}) {
  const H = 3600e3;
  const w = (f, d) => fs.writeFileSync(path.join(dir, f), JSON.stringify(d));
  const mons = [];
  const history = {};
  for (let i = 0; i < monitors; i++) {
    const id = `m${String(i).padStart(4, '0')}`;
    mons.push({ id, name: `Site ${i}`, type: i % 3 === 1 ? 'tcp' : 'http', target: i % 3 === 1 ? '10.0.0.5' : `https://site${i}.example.com/`, port: i % 3 === 1 ? 443 : null, interval: 20, timeout: 10, retries: 1, method: 'GET', acceptedStatus: '200-399', keyword: '', paused: i % 7 === 6, createdAt: now - 40 * 24 * H, updatedAt: now });
    const raw = [];
    for (let t = now - 24 * H + 60e3; t <= now; t += 20 * 60e3) raw.push({ t, ok: i % 5 !== 4 || t < now - 2 * H, ms: 40 + (t % 7) });
    history[id] = {
      raw, hourly: [{ h: Math.floor((now - 2 * H) / H) * H, n: 10, up: 9, ms: 400, msn: 9 }],
      events: Array.from({ length: 25 }, (_, k) => ({ t: now - (24 - k) * H, status: k % 2 ? 'up' : 'down', msg: `event ${k}` })),
      status: i % 5 === 4 ? 'down' : 'up', downSince: null,
    };
  }
  w('monitors.json', mons);
  w('history.json', history);
  w('settings.json', { title: 'Test Lab', webhooks: [SECRETS.webhook], publicDashboard: false });
  w('sessions.json', { abc: { exp: now + 1e9, user: { method: 'google', email: 'x@example.com', token: SECRETS.sessionToken } } });

  const pkgs = Array.from({ length: 80 }, (_, k) => ({ name: `pkg${k}`, old: '1.0', new: '1.1', security: k % 4 === 0 }));
  const containers = Array.from({ length: 6 }, (_, k) => ({
    vmid: 200 + k, name: `ct${k}`, status: k === 5 ? 'stopped' : 'running', onboot: true, cpu: 0.05 * k, mem: 512e6, maxmem: 1024e6,
    disk: 5e9, maxdisk: k === 2 ? 5.2e9 : 10e9, updates: { count: k, security: k > 3 ? 1 : 0 },
    lastUpdate: k === 3 ? { t: now - H, result: 'rolled-back', msg: 'x' } : null,
    backup: k === 4 ? { covered: true } : { covered: true, last: { t: now - (k === 1 ? 100 : 2) * H, size: 1e9, storage: 'pbs', verified: 'ok' } },
  }));
  const report = (node) => ({
    agent: node, agentVersion: '1.14.0', generatedAt: now,
    host: { node, ip: '192.168.10.23', cpu: 0.123, memory: { total: 64e9, used: 32e9 }, storage: [{ name: 'local', total: 100, used: 95 }, { name: 'data', total: 100, used: 10 }], rebootRequired: true },
    containers,
    pending: [
      { id: 'p1', kind: 'host-update', summary: 'Update the Proxmox host (80 packages)', packages: pkgs, t: now - 3 * H, details: SECRETS.chatText },
      { id: 'p2', kind: 'host-reboot', summary: 'Reboot', t: now - H },
    ],
    events: [],
    backups: {
      jobs: [{ id: 'backup-1', schedule: '02:00', storage: 'pbs', enabled: true, covers: [200, 201] }],
      tasks: [{ upid: 'u1', t: now - 2 * H, status: 'job errors', vmid: 201 }, { upid: 'u2', t: now - 3 * H, status: 'OK', vmid: 200 }],
      pbs: [{ storage: 'pbs', server: '192.168.10.50', datastore: 'main', reachable: true, total: 100, used: 50, checkedAt: now }],
      backupStale: false, unreachableStorage: ['nfs-old'],
    },
    usage: {
      today: { runs: 2, input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.12, scripted: 1 },
      week: { runs: 5, input: 500, output: 200, cacheRead: 30, cacheWrite: 10, cost: 0.5 },
      month: { runs: 9, input: 900, output: 400, cacheRead: 60, cacheWrite: 20, cost: 1.25 },
      recent: Array.from({ length: 20 }, (_, k) => ({ t: now - k * H, kind: ['task', 'review', 'autofix'][k % 3], label: k % 3 === 1 ? 'update review: ct1' : SECRETS.chatText, input: 10, output: 5, cacheRead: 1, cacheWrite: 1, cost: 0.01 })),
    },
  });
  w('infra.json', {
    agents: { connector1: { report: report('GOD'), receivedAt: now - 60e3, lastSync: now - 10e3 }, connector2: { report: report('HELP'), receivedAt: now - 60 * 60e3 } },
    decisions: { connector1: { p2: { decision: 'approve', by: 'x', at: now, acked: false } } },
    tasks: { connector1: [{ id: 'aaaaaaaaaaaa', text: SECRETS.chatText, output: SECRETS.taskOutput, by: 'x', createdAt: now, status: 'done', chat: 'c1' }] },
    chats: { c1: { id: 'c1', scope: 'connector1', title: SECRETS.chatTitle, createdAt: now, updatedAt: now } },
    policy: {},
  });
  const ev = {};
  for (const a of ['connector1', 'connector2']) ev[a] = Array.from({ length: events }, (_, k) => ({ id: `${a}-e${k}`, t: now - k * 60e3, level: ['info', 'warn', 'error'][k % 3], msg: `${a} event ${k}` }));
  w('events.json', ev);
  w('agentlogs.json', {
    connector1: Array.from({ length: logLines }, (_, k) => ({ t: now - (logLines - k) * 1000, p: 'report', l: k % 10 === 0 ? 'error' : 'info', m: k === logLines - 1 ? `answered by script (no Claude): ${SECRETS.chatText}` : `line ${k}` })),
  });
  const log = [
    { t: now - 2 * H, l: 'info', m: 'Nightly update run started (auto, 3 container(s))' },
    ...Array.from({ length: 250 }, (_, k) => ({ t: now - 2 * H + k, l: 'info', m: `apt line ${k}` })),
    { t: now - H, l: 'info', m: '→ ct0 (200): 3 update(s) installed' },
    { t: now - H, l: 'info', m: '→ ct1 (201): 2 update(s) held for approval' },
    { t: now - H, l: 'error', m: '→ ct3 (203): ROLLED BACK (services failed: nginx.service)' },
    { t: now - H, l: 'info', m: '→ ct4 (204): up to date' },
  ];
  w('runlogs.json', { connector1: { abc123: { id: 'abc123', t: now - 2 * H, end: now - H, kind: 'run', mode: 'auto', title: 'Nightly update run', level: 'error', summary: 'ct3 ROLLED BACK', done: 4, total: 4, log } } });
  w('checks.json', {
    svc: {
      'connector1|200:80': { agent: 'connector1', key: '200:80', info: { container: 'ct0', vmid: 200, ip: '192.168.10.100', port: 80, proc: 'nginx' }, r: [[now - 20e3, 0, null]], d: {}, status: 'down', since: now - 600e3, fails: 3, lastSeen: now - 20e3 },
      'connector1|200:ping': { agent: 'connector1', key: '200:ping', info: { container: 'ct0', vmid: 200, ip: '192.168.10.100', port: 0, proc: 'ping' }, r: [[now - 20e3, 1, 0.4]], d: {}, status: 'up', since: now - 9e6, fails: 0, lastSeen: now - 20e3 },
    },
    core: { HOLY: { name: 'HOLY', ip: '192.168.10.50', role: 'PBS', by: { connector1: { t: now - 20e3, ok: false } }, r: [[now - 20e3, 0, 0]], d: {}, status: 'down', since: now - 900e3 } },
  });
}

// What um-ha answers on 127.0.0.1:8099.
const haRole = now => ({ role: 'primary', epoch: now - 86400e3, preferred: true, app: true, syncedAt: null, self: '192.168.10.214', time: now });
const haCluster = now => ({
  self: { hostname: 'um1', label: 'GOD · CT 214', role: 'primary', app: true, update: { state: 'current' }, time: now },
  peer: { hostname: 'um2', label: 'HELP · CT 215', ip: '192.168.10.215', role: 'replica', app: false, syncedAt: now - 3000, time: now, reachable: true, update: { state: 'current' } },
});

module.exports = { SECRETS, env, tmpDir, writeFixtures, haRole, haCluster };
