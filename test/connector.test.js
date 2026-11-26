'use strict';
// End to end: the real server.js behind a fake Cloudflare Access and with a fake um-ha, driven the way Claude's
// connector does it.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const fx = require('./fixtures');

const CB = 'https://claude.ai/api/mcp/auth_callback';
const OWNER = 'owner@example.com';

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

// Fake Cloudflare Access: publishes its public key and signs JWTs like the ones Access adds to each request.
const TEAM = 'https://homelab-test.cloudflareaccess.com';
const AUD = 'test-aud-tag';
async function fakeAccess() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const a = { privateKey };
  a.server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  });
  a.port = await freePort();
  await new Promise(r => a.server.listen(a.port, '127.0.0.1', r));
  a.jwt = (email, claims = {}) => {
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = enc({ iss: TEAM, aud: [AUD], email, sub: 'u1', iat: now, nbf: now, exp: now + 3600, type: 'app', ...claims });
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  return a;
}

async function fakeUmHa() {
  const s = http.createServer((req, res) => {
    const now = Date.now();
    const body = req.url === '/role' ? fx.haRole(now) : req.url === '/cluster' ? fx.haCluster(now) : null;
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body || {}));
  });
  const port = await freePort();
  await new Promise(r => s.listen(port, '127.0.0.1', r));
  return { server: s, port };
}

async function startApp(extraEnv = {}) {
  const port = await freePort();
  const dir = fx.tmpDir();
  fx.writeFixtures(dir);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, PUBLIC_URL: base,
      CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ADMIN_EMAILS: OWNER,
      ...fx.env(), ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, dir, child, log: () => out, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

// A tiny browser behind Cloudflare Access: keeps cookies, never follows redirects, and (like Access) adds the
// signed-in person's JWT to every request when `jwt` is set.
function browser(base, jwt = null) {
  const jar = new Map();
  return {
    jar,
    async go(url, opts = {}) {
      const u = new URL(url, base);
      const headers = { ...(opts.headers || {}) };
      if (u.origin === new URL(base).origin && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (u.origin === new URL(base).origin && jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
      const r = await fetch(u, { ...opts, headers, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) {
        const [kv, ...attrs] = c.split(';');
        const [k, ...v] = kv.split('=');
        if (attrs.some(a => /max-age=0\b/i.test(a.trim()))) jar.delete(k.trim()); else jar.set(k.trim(), v.join('='));
      }
      return r;
    },
  };
}

// Discovery + registration, as Claude does it after its first 401.
async function register(base) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(r.status, 201);
  return r.json();
}

// Authorize as the person Cloudflare Access signed in, through the Approve page. Returns what Claude would receive.
async function authorize(app, b, clientId, { approve = true, challenge } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'claude-state', scope: 'read offline_access', resource: `${app.base}/mcp` });
  let r = await b.go(`/oauth/authorize?${q}`);
  if (r.status !== 200) return { status: r.status, html: await r.text() };
  const html = await r.text();
  assert.match(html, /Claude/);
  assert.match(html, /<code>claude\.ai<\/code>/, 'redirect host shown');
  assert.match(html, /owner@example\.com/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);
  const consent = /name="consent" value="([^"]+)"/.exec(html)[1];
  r = await b.go('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ consent, decision: approve ? 'approve' : 'deny' }) });
  assert.equal(r.status, 302);
  return { callback: new URL(r.headers.get('location')) };
}

const form = (base, p) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p) });

async function connect(app) {
  const client = await register(app.base);
  const { verifier, challenge } = pkce();
  const b = browser(app.base, access.jwt(OWNER));
  const { callback } = await authorize(app, b, client.client_id, { challenge });
  const r = await form(app.base, { grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: CB, client_id: client.client_id, code_verifier: verifier, resource: `${app.base}/mcp` });
  assert.equal(r.status, 200);
  return { client, tokens: await r.json(), browser: b };
}

let rpcId = 0;
async function rpc(base, token, method, params, extra = {}) {
  const isNote = method.startsWith('notifications/');
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'MCP-Protocol-Version': '2025-06-18', ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(isNote ? {} : { id: ++rpcId }) }),
  });
  return r;
}

let app, access, umha;
test.before(async () => {
  access = await fakeAccess();
  umha = await fakeUmHa();
  app = await startApp({ CF_ACCESS_CERTS_URL: `http://127.0.0.1:${access.port}/certs`, UM_HA_URL: `http://127.0.0.1:${umha.port}` });
});
test.after(async () => {
  await app.stop();
  access.server.close();
  umha.server.close();
});

test('the full flow, the way Claude does it', async () => {
  // 1. Unauthenticated call: 401 pointing at the protected resource metadata.
  let r = await rpc(app.base, null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(r.status, 401);
  const wa = r.headers.get('www-authenticate');
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wa)[1];
  assert.equal(prmUrl, `${app.base}/.well-known/oauth-protected-resource`);

  // 2. Discovery (fast).
  let t0 = Date.now();
  r = await fetch(prmUrl);
  const prm = await r.json();
  assert.deepEqual(prm.authorization_servers, [app.base]);
  assert.equal(prm.resource, `${app.base}/mcp`);
  assert.deepEqual(await (await fetch(`${app.base}/.well-known/oauth-protected-resource/mcp`)).json(), prm);
  const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, app.base);
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(asm.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(asm.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(asm.response_types_supported, ['code']);
  assert.ok(asm.scopes_supported.includes('offline_access'));
  assert.ok(Date.now() - t0 < 500, 'discovery under 500 ms');

  // 3. Registration.
  t0 = Date.now();
  const client = await register(app.base);
  assert.ok(Date.now() - t0 < 500);

  // 4. Authorize: the browser comes through Cloudflare Access (signed in there), sees the Approve page, gets a code.
  const { verifier, challenge } = pkce();
  const b = browser(app.base, access.jwt(OWNER));
  const { callback } = await authorize(app, b, client.client_id, { challenge });
  assert.equal(callback.origin + callback.pathname, CB);
  assert.equal(callback.searchParams.get('state'), 'claude-state');
  assert.equal(callback.searchParams.get('iss'), app.base);
  const code = callback.searchParams.get('code');
  assert.ok(code);

  // 5. Token.
  t0 = Date.now();
  r = await form(app.base, { grant_type: 'authorization_code', code, redirect_uri: CB, client_id: client.client_id, code_verifier: verifier, resource: `${app.base}/mcp` });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const tok = await r.json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 3600);
  assert.ok(tok.refresh_token);

  // 6. MCP: initialize, initialized, tools/list, a tool call.
  r = await rpc(app.base, tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('mcp-session-id'), null, 'stateless');
  const init = await r.json();
  assert.equal(init.result.serverInfo.name, 'homelab-status');
  assert.ok(init.result.capabilities.tools);
  r = await rpc(app.base, tok.access_token, 'notifications/initialized');
  assert.equal(r.status, 202);
  r = await rpc(app.base, tok.access_token, 'tools/list', {});
  const list = (await r.json()).result.tools;
  assert.equal(list.length, 14);
  assert.ok(list.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));
  r = await rpc(app.base, tok.access_token, 'tools/call', { name: 'get_overview', arguments: {} });
  const call = (await r.json()).result;
  assert.ok(!call.isError);
  const overview = JSON.parse(call.content[0].text);
  assert.equal(overview.ha_role, 'primary');
  assert.equal(overview.counts.agents_total, 2);
  assert.match(app.log(), /\[mcp\] get_overview by Claude \(owner@example.com\) \d+ ms/);
  assert.ok(!app.log().includes('"arguments"'));

  // 7. Refresh: rotates, the new access token works.
  r = await form(app.base, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id });
  assert.equal(r.status, 200);
  const tok2 = await r.json();
  assert.notEqual(tok2.refresh_token, tok.refresh_token);
  r = await rpc(app.base, tok2.access_token, 'tools/call', { name: 'get_ha_status', arguments: {} });
  assert.equal(JSON.parse((await r.json()).result.content[0].text).peer_healthy, true);
});

test('/mcp rejects the Cloudflare Access sign-in and ADMIN_PASSWORD', async () => {
  const { tokens } = await connect(app);
  const jwt = access.jwt(OWNER);
  // The Access JWT signs you in to the dashboard...
  assert.equal((await fetch(`${app.base}/api/settings`, { headers: { 'Cf-Access-Jwt-Assertion': jwt } })).status, 200);
  assert.equal((await fetch(`${app.base}/api/settings`, { headers: { Cookie: `CF_Authorization=${jwt}` } })).status, 200);
  // ...but is no credential for /mcp, neither as header, cookie nor bearer.
  assert.equal((await rpc(app.base, null, 'tools/list', {}, { 'Cf-Access-Jwt-Assertion': jwt })).status, 401);
  assert.equal((await rpc(app.base, null, 'tools/list', {}, { Cookie: `CF_Authorization=${jwt}` })).status, 401);
  assert.equal((await rpc(app.base, jwt, 'tools/list', {})).status, 401);
  let r = await rpc(app.base, fx.SECRETS.adminPassword, 'tools/list', {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.equal((await fetch(`${app.base}/api/settings`, { headers: { Authorization: `Bearer ${fx.SECRETS.adminPassword}` } })).status, 200);
  r = await rpc(app.base, tokens.access_token, 'tools/list', {});
  assert.equal(r.status, 200);
  // GET (SSE) is not offered by this stateless server.
  r = await fetch(`${app.base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'text/event-stream' } });
  assert.equal(r.status, 405);
});

test('the dashboard has no sign-in of its own: only a valid Access JWT signs you in', async () => {
  const st = async h => (await (await fetch(`${app.base}/api/status`, { headers: h })).json());
  assert.equal((await st({})).authed, false);
  assert.equal((await st({ 'Cf-Access-Jwt-Assertion': access.jwt(OWNER) })).authed, true);
  assert.equal((await st({ 'Cf-Access-Jwt-Assertion': access.jwt(OWNER, { aud: ['other-app'] }) })).authed, false);
  assert.equal((await st({ 'Cf-Access-Jwt-Assertion': access.jwt(OWNER, { exp: Math.floor(Date.now() / 1000) - 600 }) })).authed, false);
  assert.equal((await st({ 'Cf-Access-Jwt-Assertion': access.jwt('stranger@example.com') })).authed, false);
  const forged = access.jwt(OWNER).split('.');
  forged[1] = Buffer.from(JSON.stringify({ iss: TEAM, aud: [AUD], email: OWNER, exp: 9e9 })).toString('base64url');
  assert.equal((await st({ 'Cf-Access-Jwt-Assertion': forged.join('.') })).authed, false);
  for (const p of ['/api/login', '/api/auth/google', '/api/auth/google/callback']) assert.equal((await fetch(`${app.base}${p}`, { method: p === '/api/login' ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: p === '/api/login' ? JSON.stringify({ password: fx.SECRETS.adminPassword }) : undefined })).status, 404, p);
});

test('authorize without an Access sign-in, or with an email not in ADMIN_EMAILS, gets no code', async () => {
  const client = await register(app.base);
  let res = await authorize(app, browser(app.base), client.client_id, { challenge: pkce().challenge });
  assert.equal(res.status, 403);
  assert.match(res.html, /Cloudflare Access/);
  res = await authorize(app, browser(app.base, access.jwt('stranger@example.com')), client.client_id, { challenge: pkce().challenge });
  assert.equal(res.status, 403);
  // An Approve form can't be submitted by someone else.
  const b = browser(app.base, access.jwt(OWNER));
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CB, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const consent = /name="consent" value="([^"]+)"/.exec(await (await b.go(`/oauth/authorize?${q}`)).text())[1];
  const other = browser(app.base, access.jwt('owner@example.com', { email: 'second@example.com' }));
  const r = await other.go('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ consent, decision: 'approve' }) });
  assert.equal(r.status, 400);
});

test('bad redirect URIs are refused, without redirecting', async () => {
  let r = await fetch(`${app.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example.com/callback'] }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid_redirect_uri');
  const client = await register(app.base);
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example.com/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  r = await fetch(`${app.base}/oauth/authorize?${q}`, { redirect: 'manual' });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('location'), null);
  q.set('client_id', 'hsc_00000000000000000000000000000000');
  q.set('redirect_uri', CB);
  r = await fetch(`${app.base}/oauth/authorize?${q}`, { redirect: 'manual' });
  assert.equal(r.status, 400);
});

test('PKCE is required at authorize', async () => {
  const client = await register(app.base);
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CB, state: 's1' });
  const r = await fetch(`${app.base}/oauth/authorize?${q}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, CB);
  assert.equal(loc.searchParams.get('error'), 'invalid_request');
  assert.equal(loc.searchParams.get('state'), 's1');
});

test('token endpoint errors', async () => {
  let r = await form(app.base, { grant_type: 'refresh_token', refresh_token: 'hs_rt_x', client_id: 'hsc_00000000000000000000000000000000' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'invalid_client');
  const { client, tokens } = await connect(app);
  r = await form(app.base, { grant_type: 'refresh_token', refresh_token: 'hs_rt_bogus', client_id: client.client_id });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid_grant');
  r = await fetch(`${app.base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 400);
  // The refresh token from connect() rotates once; reusing it after the grace period is covered in oauth.test.js.
  r = await form(app.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r.status, 200);
});

test('Deny sends access_denied back', async () => {
  const client = await register(app.base);
  const { callback } = await authorize(app, browser(app.base, access.jwt(OWNER)), client.client_id, { challenge: pkce().challenge, approve: false });
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('code'), null);
});

test('Settings lists connected clients and revoking one cuts it off', async () => {
  const { client, tokens } = await connect(app);
  const admin = { Authorization: `Bearer ${fx.SECRETS.adminPassword}` };
  let r = await fetch(`${app.base}/api/oauth/clients`, { headers: admin });
  const body = await r.json();
  assert.equal(body.enabled, true);
  assert.equal(body.url, `${app.base}/mcp`);
  const mine = body.clients.find(c => c.id === client.client_id);
  assert.deepEqual(mine.accounts, [OWNER]);
  assert.equal(mine.redirectHost, 'claude.ai');
  assert.ok(!JSON.stringify(body).includes('hs_'), 'no token material');
  assert.equal((await fetch(`${app.base}/api/oauth/clients`)).status, 401);
  r = await fetch(`${app.base}/api/oauth/clients/${client.client_id}`, { method: 'DELETE', headers: admin });
  assert.equal(r.status, 200);
  assert.equal((await rpc(app.base, tokens.access_token, 'tools/list', {})).status, 401);
  r = await form(app.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r.status, 401);
});

test('secrets never appear in any MCP response', async () => {
  const { tokens } = await connect(app);
  const r = await rpc(app.base, tokens.access_token, 'tools/list', {});
  const tools = (await r.json()).result.tools;
  let all = '';
  for (const t of tools) {
    const a = {};
    if (t.inputSchema.required?.includes('agent')) a.agent = 'connector1';
    if (t.name === 'get_monitor') a.id = 'm0000';
    if (t.name === 'get_update_run') a.id = 'abc123';
    const res = await rpc(app.base, tokens.access_token, 'tools/call', { name: t.name, arguments: a });
    const text = await res.text();
    assert.ok(!JSON.parse(text).result.isError, `${t.name}: ${text}`);
    all += text;
  }
  for (const [name, s] of Object.entries(fx.SECRETS)) assert.ok(!all.includes(s), `${name} leaked`);
  assert.ok(!all.includes(tokens.access_token) && !all.includes(tokens.refresh_token));
});

test('60 calls per minute per client', async () => {
  const { tokens } = await connect(app);
  const codes = [];
  for (let i = 0; i < 61; i++) codes.push((await rpc(app.base, tokens.access_token, 'tools/list', {})).status);
  assert.deepEqual(codes.slice(0, 60), Array(60).fill(200));
  assert.equal(codes[60], 429);
});

test('MCP_ENABLED=false turns the whole thing off', async () => {
  const off = await startApp({ MCP_ENABLED: 'false', CF_ACCESS_CERTS_URL: `http://127.0.0.1:${access.port}/certs` });
  try {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth/authorize']) {
      assert.equal((await fetch(`${off.base}${p}`)).status, 404, p);
    }
    assert.notEqual((await fetch(`${off.base}/mcp`, { method: 'POST' })).status, 200);
    assert.notEqual((await fetch(`${off.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    const s = await (await fetch(`${off.base}/api/oauth/clients`, { headers: { Authorization: `Bearer ${fx.SECRETS.adminPassword}` } })).json();
    assert.equal(s.enabled, false);
  } finally { await off.stop(); }
});
