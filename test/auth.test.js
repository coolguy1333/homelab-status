'use strict';
// Cloudflare Access sign-in (lib/auth.js): the JWT check that decides who is signed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { tmpDir } = require('./fixtures');

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-1';
Object.assign(process.env, {
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: AUD,
  CF_ACCESS_CERTS_URL: 'http://127.0.0.1:9/certs', // never fetched for real: the test puts the key in
  ADMIN_EMAILS: 'owner@example.com,@family.example', ADMIN_PASSWORD: 'api-token-for-tests',
});
const { Auth } = require('../lib/auth');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function jwt(claims = {}, { header = {}, key = privateKey } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', ...header });
  const c = b64({ iss: TEAM, aud: [AUD], email: 'owner@example.com', exp: now() + 600, iat: now(), ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), key).toString('base64url');
  return `${h}.${c}.${sig}`;
}

let auth;
test.before(() => {
  auth = new Auth(tmpDir());
  auth.keys = new Map([['k1', publicKey]]);
  auth.certsTried = Date.now(); // no refetch for an unknown kid during the test
});

const req = headers => ({ headers });
const code = fn => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

test('a valid Access JWT signs the person in, from the header or the cookie', () => {
  assert.equal(auth.user(req({ 'cf-access-jwt-assertion': jwt() })).email, 'owner@example.com');
  assert.equal(auth.user(req({ cookie: `x=1; CF_Authorization=${jwt()}` })).method, 'cloudflare');
  assert.equal(auth.user(req({ 'cf-access-jwt-assertion': jwt({ email: 'kid@family.example' }) })).email, 'kid@family.example');
});

test('forged, foreign and expired JWTs are refused', () => {
  assert.equal(code(() => auth.verifyJwt(jwt({}, { key: other.privateKey }))), 'bad_signature');
  assert.equal(code(() => auth.verifyJwt(jwt({ iss: 'https://evil.cloudflareaccess.com' }))), 'bad_issuer');
  assert.equal(code(() => auth.verifyJwt(jwt({ aud: ['another-app'] }))), 'bad_audience');
  assert.equal(code(() => auth.verifyJwt(jwt({ exp: now() - 120 }))), 'expired');
  assert.equal(code(() => auth.verifyJwt(jwt({ exp: undefined }))), 'expired');
  assert.equal(code(() => auth.verifyJwt(jwt({ nbf: now() + 600 }))), 'expired');
  assert.equal(code(() => auth.verifyJwt(jwt({}, { header: { kid: 'nope' } }))), 'unknown_key');
  assert.equal(code(() => auth.verifyJwt('a.b')), 'malformed');
  assert.equal(code(() => auth.verifyJwt(jwt({ email: undefined }))), 'no_email');       // service tokens
  assert.equal(code(() => auth.verifyJwt(jwt({ email: 'stranger@example.com' }))), 'not_allowed');
  // alg "none" / HS256 with the public key as secret: classic JWT downgrades
  const [, c] = jwt().split('.');
  assert.equal(code(() => auth.verifyJwt(`${b64({ alg: 'none', kid: 'k1' })}.${c}.`)), 'bad_alg');
  assert.equal(code(() => auth.verifyJwt(`${b64({ alg: 'HS256', kid: 'k1' })}.${c}.${'x'.repeat(43)}`)), 'bad_alg');
  // a signed token whose claims were edited afterwards
  const [h, , s] = jwt().split('.');
  assert.equal(code(() => auth.verifyJwt(`${h}.${b64({ iss: TEAM, aud: [AUD], email: 'owner@example.com', exp: now() + 99999 })}.${s}`)), 'bad_signature');
});

test('none of those count as signed in', () => {
  for (const t of [jwt({}, { key: other.privateKey }), jwt({ exp: now() - 120 }), jwt({ email: 'stranger@example.com' }), 'garbage']) {
    assert.equal(auth.user(req({ 'cf-access-jwt-assertion': t })), null);
  }
  assert.equal(auth.user(req({})), null);
});

test('a cached JWT stops working when the account leaves ADMIN_EMAILS', () => {
  const t = jwt({ email: 'kid@family.example' });
  assert.ok(auth.user(req({ 'cf-access-jwt-assertion': t })));
  const before = auth.admins;
  auth.admins = ['owner@example.com'];
  try { assert.equal(auth.user(req({ 'cf-access-jwt-assertion': t })), null); } finally { auth.admins = before; }
});

test('the API token works as a Bearer header, wrong guesses get rate-limited per IP', () => {
  assert.equal(auth.user(req({ authorization: 'Bearer api-token-for-tests' }), '10.0.0.1').method, 'token');
  for (let i = 0; i < 12; i++) assert.equal(auth.user(req({ authorization: 'Bearer wrong' }), '10.0.0.2'), null);
  assert.equal(auth.user(req({ authorization: 'Bearer api-token-for-tests' }), '10.0.0.2'), null);
  assert.ok(auth.user(req({ authorization: 'Bearer api-token-for-tests' }), '10.0.0.3'));
});
