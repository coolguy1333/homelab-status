'use strict';
// Who may control (send agents work, approve, run container/server actions, change settings) versus only view.
// Starts the real server with Cloudflare Access pointed at a local key server, and signs Access JWTs with a test key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('./fixtures');

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-control-tests';
const TOKEN = 'api-token-control-tests';
const AGENT_TOKEN = 'agent-token-control-tests';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const c = b64({ iss: TEAM, aud: [AUD], email, exp: now + 600, iat: now });
  return `${h}.${c}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), privateKey).toString('base64url')}`;
}

// Every route that changes more than the monitors, with a body that gets past validation far enough to show
// whether the auth check let it through.
const HEX12 = 'a1b2c3d4e5f6';
const CONTROL_ROUTES = [
  ['POST', '/api/infra/connector1/tasks', { text: 'uptime' }],
  ['POST', '/api/infra/_all/tasks', { text: 'uptime' }],
  ['POST', '/api/infra/connector1/decision', { id: 'nope', decision: 'approve' }],
  ['POST', '/api/infra/connector1/actions', { type: 'start', vmid: 101 }],
  ['POST', '/api/infra/connector1/policy', { securityOnly: true }],
  ['POST', `/api/infra/connector1/tasks/${HEX12}/cancel`, {}],
  ['POST', '/api/infra/chats', { scope: '_all', title: 'x' }],
  ['POST', '/api/infra/chats/cabc123/rename', { title: 'y' }],
  ['DELETE', '/api/infra/chats/cabc123'],
  ['DELETE', `/api/infra/connector1/tasks/${HEX12}`],
  ['DELETE', '/api/infra/_all/groups/g0123456789'],
  ['POST', '/api/servers/control', { action: 'check' }],
  ['PUT', '/api/settings', { title: 'Changed' }],
  ['POST', '/api/settings/test-notification', {}],
  ['DELETE', `/api/oauth/clients/hsc_${'0'.repeat(32)}`],
  ['POST', '/api/import', { monitors: [] }],
];

let certServer, certsUrl;
test.before(async () => {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  certServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(r => certServer.listen(0, '127.0.0.1', r));
  certsUrl = `http://127.0.0.1:${certServer.address().port}/certs`;
});
test.after(() => certServer.close());

const freePort = () => new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startServer(extraEnv) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmpDir('hs-control-'),
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: AUD, CF_ACCESS_CERTS_URL: certsUrl,
    ADMIN_PASSWORD: TOKEN, AGENT_TOKENS: `connector1:${AGENT_TOKEN}`,
    UM_HA_URL: 'http://127.0.0.1:9', // nothing listens: /api/servers/control answers 502 once past the auth check
    ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const call = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  // Up, and the Access keys loaded (a signed-in request works).
  for (let i = 0; i < 100; i++) {
    try {
      const r = await call('GET', '/api/status', { headers: { 'cf-access-jwt-assertion': jwt('probe@example.com') } });
      if (r.status === 200) break;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return { call, log: () => log, stop: () => new Promise(r => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

const asUser = email => ({ 'cf-access-jwt-assertion': jwt(email) });
const asToken = { authorization: `Bearer ${TOKEN}` };

test('ADMIN_EMAILS set: listed people control; the API token and unlisted people do not', async t => {
  const s = await startServer({ ADMIN_EMAILS: 'owner@example.com,@family.example' });
  t.after(() => s.stop());

  for (const email of ['owner@example.com', 'kid@family.example']) {
    const st = await s.call('GET', '/api/status', { headers: asUser(email) });
    assert.equal(st.body.authed, true);
    assert.equal(st.body.canControl, true, email);
    for (const [method, p, body] of CONTROL_ROUTES) {
      const r = await s.call(method, p, { body, headers: asUser(email) });
      assert.ok(![401, 403].includes(r.status), `${email} ${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // Not in ADMIN_EMAILS: with a list set, that is not a sign-in at all (as before).
  for (const [method, p, body] of CONTROL_ROUTES) {
    const r = await s.call(method, p, { body, headers: asUser('stranger@example.com') });
    assert.equal(r.status, 401, `${method} ${p}`);
  }

  // The API token can view, but not control.
  const st = await s.call('GET', '/api/status', { headers: asToken });
  assert.equal(st.body.authed, true);
  assert.equal(st.body.canControl, false);
  assert.equal((await s.call('GET', '/api/infra', { headers: asToken })).status, 200);
  for (const [method, p, body] of CONTROL_ROUTES) {
    const r = await s.call(method, p, { body, headers: asToken });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match(r.body.error, /CONTROL_API_TOKEN=1/);
  }

  // Nobody signed in: 401, never 403.
  for (const [method, p, body] of CONTROL_ROUTES) assert.equal((await s.call(method, p, { body })).status, 401, `${method} ${p}`);

  // Monitors stay at "signed in" (the token may still add one).
  const add = await s.call('POST', '/api/monitors', { body: { name: 'x', type: 'http', target: 'https://example.com/' }, headers: asToken });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.doesNotMatch(s.log(), /CONTROL_API_TOKEN is on/);
});

test('CONTROL_API_TOKEN=1 lets the API token control, with a warning at startup', async t => {
  const s = await startServer({ ADMIN_EMAILS: 'owner@example.com', CONTROL_API_TOKEN: '1' });
  t.after(() => s.stop());
  assert.equal((await s.call('GET', '/api/status', { headers: asToken })).body.canControl, true);
  for (const [method, p, body] of CONTROL_ROUTES) {
    const r = await s.call(method, p, { body, headers: asToken });
    assert.ok(![401, 403].includes(r.status), `${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.match(s.log(), /CONTROL_API_TOKEN is on/);
});

test('ADMIN_EMAILS empty: everyone Access lets in can view, nobody can control', async t => {
  const s = await startServer({ ADMIN_EMAILS: '' });
  t.after(() => s.stop());
  const st = await s.call('GET', '/api/status', { headers: asUser('anyone@example.com') });
  assert.equal(st.body.authed, true);
  assert.equal(st.body.canControl, false);
  assert.equal((await s.call('GET', '/api/infra', { headers: asUser('anyone@example.com') })).status, 200);
  assert.equal((await s.call('GET', '/api/settings', { headers: asUser('anyone@example.com') })).status, 200);
  for (const [method, p, body] of CONTROL_ROUTES) {
    const r = await s.call(method, p, { body, headers: asUser('anyone@example.com') });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.body.error, 'Only the emails in ADMIN_EMAILS can do this. Set ADMIN_EMAILS on the server.');
  }
  // The token too (CONTROL_API_TOKEN is off).
  for (const [method, p, body] of CONTROL_ROUTES) assert.equal((await s.call(method, p, { body, headers: asToken })).status, 403, `${method} ${p}`);
  // Nothing was queued for the agents.
  const infra = (await s.call('GET', '/api/infra', { headers: asToken })).body;
  assert.equal(infra.agents.flatMap(a => a.tasks || []).length, 0);
  assert.match(s.log(), /Nobody can send agents work until ADMIN_EMAILS is set/);
});
