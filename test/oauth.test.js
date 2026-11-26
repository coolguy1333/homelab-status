'use strict';
// OAuth state (lib/oauth.js): PKCE, redirect URIs, expiry, revocation, refresh rotation, allowed accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./fixtures');
const { OAuthStore, OAuthError, ACCESS_TTL, REFRESH_TTL, REFRESH_GRACE } = require('../lib/oauth');

const CB = 'https://claude.ai/api/mcp/auth_callback';
const RES = ['https://status.example.com/mcp', 'https://status.example.com/mcp/', 'https://status.example.com', 'https://status.example.com/'];
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

function setup(opts = {}) {
  const clock = { t: Date.parse('2026-11-26T12:00:00Z') };
  const allowed = new Set(['owner@example.com']);
  const dir = tmpDir();
  const s = new OAuthStore(dir, { now: () => clock.t, isAllowed: e => allowed.has(e), ...opts });
  const client = s.register({ redirect_uris: [CB], client_name: 'Claude' });
  const authorize = (extra = {}) => {
    const { verifier, challenge } = pkce();
    const req = s.checkAuthorize(new URLSearchParams({ client_id: client.client_id, redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: RES[0], ...extra }), RES);
    const code = s.issueCode(req, { email: 'owner@example.com' });
    return { code, verifier };
  };
  const tokens = () => {
    const { code, verifier } = authorize();
    return s.exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB, resource: RES[0] }, RES);
  };
  const refresh = rt => s.exchange({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id }, RES);
  return { s, dir, clock, allowed, client, authorize, tokens, refresh };
}

const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof OAuthError, e.message); return e.code; } assert.fail('expected an OAuthError'); };

test('registration only accepts allowlisted redirect URIs and public clients', () => {
  const { s } = setup();
  assert.equal(code(() => s.register({ redirect_uris: ['https://evil.example.com/cb'] })), 'invalid_redirect_uri');
  assert.equal(code(() => s.register({ redirect_uris: [CB, 'http://localhost/cb'] })), 'invalid_redirect_uri');
  assert.equal(code(() => s.register({})), 'invalid_redirect_uri');
  assert.equal(code(() => s.register({ redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_basic' })), 'invalid_client_metadata');
  const c = s.register({ redirect_uris: ['https://claude.com/api/mcp/auth_callback'], client_name: 'x'.repeat(500) });
  assert.match(c.client_id, /^hsc_[a-f0-9]{32}$/);
  assert.equal(c.client_name.length, 100);
  assert.equal(c.token_endpoint_auth_method, 'none');
});

test('a custom MCP_REDIRECT_ALLOWLIST replaces the default', () => {
  const s = new OAuthStore(tmpDir(), { redirectAllowlist: ['https://my.example/cb'] });
  assert.equal(code(() => s.register({ redirect_uris: [CB] })), 'invalid_redirect_uri');
  assert.ok(s.register({ redirect_uris: ['https://my.example/cb'] }).client_id);
});

test('authorize: unknown client and bad redirect URI are not redirected', () => {
  const { s, client } = setup();
  const { challenge } = pkce();
  const base = { client_id: client.client_id, redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
  const err = q => { try { s.checkAuthorize(new URLSearchParams(q), RES); } catch (e) { return e; } assert.fail('no error'); };
  let e = err({ ...base, client_id: 'hsc_nope' });
  assert.equal(e.code, 'invalid_client'); assert.equal(e.redirect, false);
  e = err({ ...base, redirect_uri: 'https://claude.ai/api/mcp/other' });
  assert.equal(e.redirect, false);
  e = err({ ...base, redirect_uri: 'https://evil.example.com/cb' });
  assert.equal(e.redirect, false);
});

test('authorize: PKCE S256 is required', () => {
  const { s, client } = setup();
  const { challenge } = pkce();
  const base = { client_id: client.client_id, redirect_uri: CB, response_type: 'code', state: 'abc' };
  const err = q => { try { s.checkAuthorize(new URLSearchParams(q), RES); } catch (e) { return e; } assert.fail('no error'); };
  let e = err(base);
  assert.equal(e.code, 'invalid_request'); assert.equal(e.redirect, true); assert.equal(e.state, 'abc');
  assert.equal(err({ ...base, code_challenge: challenge }).code, 'invalid_request');                                 // method missing = plain
  assert.equal(err({ ...base, code_challenge: challenge, code_challenge_method: 'plain' }).code, 'invalid_request');
  assert.equal(err({ ...base, code_challenge: 'short', code_challenge_method: 'S256' }).code, 'invalid_request');
  assert.equal(err({ ...base, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'token' }).code, 'unsupported_response_type');
  assert.equal(err({ ...base, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' }).code, 'invalid_target');
});

test('token: wrong or missing verifier, wrong client, wrong redirect, reused code', () => {
  const { s, client, authorize } = setup();
  const other = s.register({ redirect_uris: [CB] });
  let { code: c, verifier } = authorize();
  const ex = p => s.exchange({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CB, code: c, ...p }, RES);
  assert.equal(code(() => ex({ code_verifier: undefined })), 'invalid_grant');
  assert.equal(code(() => ex({ code_verifier: pkce().verifier })), 'invalid_grant');
  assert.equal(code(() => ex({ code_verifier: verifier, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })), 'invalid_grant');
  assert.equal(code(() => ex({ code_verifier: verifier, client_id: other.client_id })), 'invalid_grant');
  const t = ex({ code_verifier: verifier });
  assert.match(t.access_token, /^hs_at_/);
  assert.equal(t.expires_in, 3600);
  assert.equal(t.token_type, 'Bearer');
  assert.ok(s.verify(t.access_token));
  // Second use of the same code: refused, and what the first use got is revoked.
  assert.equal(code(() => ex({ code_verifier: verifier })), 'invalid_grant');
  assert.equal(s.verify(t.access_token), null);
  assert.equal(code(() => s.exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id }, RES)), 'invalid_grant');
});

test('token: unknown client is invalid_client (401), unknown grant type refused', () => {
  const { s } = setup();
  let e;
  try { s.exchange({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'hsc_unknown' }, RES); } catch (x) { e = x; }
  assert.equal(e.code, 'invalid_client');
  assert.equal(e.status, 401);
  const { client } = setup();
  assert.equal(code(() => s.exchange({ grant_type: 'password', client_id: s.register({ redirect_uris: [CB] }).client_id }, RES)), 'unsupported_grant_type');
  assert.ok(client);
});

test('codes expire after 5 minutes', () => {
  const { s, client, clock, authorize } = setup();
  const { code: c, verifier } = authorize();
  clock.t += 5 * 60e3 + 1;
  assert.equal(code(() => s.exchange({ grant_type: 'authorization_code', code: c, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB }, RES)), 'invalid_grant');
});

test('access tokens expire after 1 hour', () => {
  const { s, clock, tokens } = setup();
  const t = tokens();
  clock.t += ACCESS_TTL - 1000;
  assert.ok(s.verify(t.access_token));
  clock.t += 2000;
  assert.equal(s.verify(t.access_token), null);
  assert.equal(s.verify('hs_at_garbage'), null);
  assert.equal(s.verify('admin-password'), null);
});

test('refresh rotates; the old token works for 2 minutes more, then invalid_grant', () => {
  const { s, clock, tokens, refresh } = setup();
  const t1 = tokens();
  const t2 = refresh(t1.refresh_token);
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.notEqual(t2.access_token, t1.access_token);
  assert.ok(s.verify(t2.access_token));
  assert.ok(s.verify(t1.access_token), 'the old access token still runs out on its own');
  clock.t += REFRESH_GRACE - 1000;
  const t3 = refresh(t1.refresh_token);           // e.g. the answer to the first refresh was lost in a failover
  assert.ok(t3.refresh_token);
  clock.t += 2000;
  assert.equal(code(() => refresh(t1.refresh_token)), 'invalid_grant');
  clock.t += REFRESH_GRACE;                         // t2 got its own grace when t1 was used again
  assert.equal(code(() => refresh(t2.refresh_token)), 'invalid_grant');
  const t4 = refresh(t3.refresh_token);
  assert.ok(s.verify(t4.access_token));
  assert.equal(code(() => refresh('hs_rt_bogus')), 'invalid_grant');
  assert.equal(code(() => refresh('')), 'invalid_grant');
});

test('refresh tokens expire after 30 days', () => {
  const { clock, tokens, refresh } = setup();
  const t = tokens();
  clock.t += REFRESH_TTL + 1;
  assert.equal(code(() => refresh(t.refresh_token)), 'invalid_grant');
});

test('revoking a client kills its tokens and removes it', () => {
  const { s, client, tokens, refresh } = setup();
  const t = tokens();
  assert.equal(s.connected().length, 1);
  assert.deepEqual(Object.keys(s.connected()[0]).sort(), ['accounts', 'connectedAt', 'id', 'lastUsedAt', 'name', 'redirectHost']);
  assert.equal(s.connected()[0].redirectHost, 'claude.ai');
  assert.ok(s.revokeClient(client.client_id));
  assert.equal(s.verify(t.access_token), null);
  assert.equal(code(() => refresh(t.refresh_token)), 'invalid_client');
  assert.equal(s.connected().length, 0);
  assert.equal(s.revokeClient(client.client_id), false);
});

test('an account removed from ADMIN_EMAILS loses access at once', () => {
  const { s, allowed, tokens, refresh, authorize, client } = setup();
  const t = tokens();
  const pending = authorize();
  allowed.delete('owner@example.com');
  assert.equal(s.verify(t.access_token), null);
  assert.equal(code(() => refresh(t.refresh_token)), 'invalid_grant');
  assert.equal(code(() => s.exchange({ grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, client_id: client.client_id, redirect_uri: CB }, RES)), 'invalid_grant');
});

test('only hashes are stored, the file survives a restart (failover)', () => {
  const { s, dir, tokens, client } = setup();
  const t = tokens();
  const raw = fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8');
  assert.ok(!raw.includes(t.access_token) && !raw.includes(t.refresh_token));
  assert.ok(!raw.includes(t.access_token.slice(6)) && !raw.includes(t.refresh_token.slice(6)));
  assert.equal((fs.statSync(path.join(dir, 'oauth.json')).mode & 0o777), 0o600);
  const again = new OAuthStore(dir, { isAllowed: () => true, now: s.now });
  assert.ok(again.verify(t.access_token));
  assert.ok(again.exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id }, RES).access_token);
});

test('clients that were never authorized are dropped after a day', () => {
  const { s, clock } = setup();
  const c = s.register({ redirect_uris: [CB] });
  clock.t += 25 * 3600e3;
  s.cleanup();
  assert.equal(s.client(c.client_id), null);
});
