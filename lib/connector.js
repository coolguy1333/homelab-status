'use strict';
// The Claude connector's HTTP side: OAuth discovery, registration, authorization (the person signed in through
// Cloudflare Access sees an Approve/Deny page), the token endpoint, and /mcp itself. State lives in lib/oauth.js, tools in lib/mcp.js.
//
// /mcp only accepts access tokens issued here. Cloudflare Access cookies/headers and the ADMIN_PASSWORD bearer
// token are not credentials for it.
//
// Cloudflare Access must protect /oauth/authorize (that is how we know who approves) and let /mcp, /oauth/token,
// /oauth/register and /.well-known/* through (Claude's servers call those, and cannot sign in to Access).
const crypto = require('crypto');
const { OAuthError, SCOPES } = require('./oauth');
const { RateLimiter } = require('./ratelimit');
const mcp = require('./mcp');

const CONSENT_TTL = 10 * 60e3;
const MAX_PENDING = 500;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class Connector {
  // opts: { publicUrl, auth, oauth, tools, version, clientIp(req), isSecure(req) }
  constructor(opts) {
    Object.assign(this, opts);
    this.resource = `${this.publicUrl}/mcp`;
    // What a client may send as RFC 8707 `resource`: the /mcp URL (the canonical one) or the site itself.
    this.resourceIds = [this.resource, `${this.resource}/`, this.publicUrl, `${this.publicUrl}/`];
    this.consents = new Map();  // id -> { request, email, exp }
    this.limits = { register: new RateLimiter(20), token: new RateLimiter(60), authorize: new RateLimiter(60), mcp: new RateLimiter(60) };
    this.sdk = mcp.sdkAvailable();
    if (!this.sdk) console.warn('[mcp] @modelcontextprotocol/sdk is not installed (run "npm ci --omit=dev"): /mcp answers 503 until it is.');
  }

  // Handles the request if it is one of ours. Returns true when it did.
  async handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
      if (m !== 'GET' && m !== 'HEAD') return this.json(res, 405, { error: 'method_not_allowed' }), true;
      return this.json(res, 200, this.resourceMetadata(), { 'Access-Control-Allow-Origin': '*' }), true;
    }
    if (p === '/.well-known/oauth-authorization-server') {
      if (m !== 'GET' && m !== 'HEAD') return this.json(res, 405, { error: 'method_not_allowed' }), true;
      return this.json(res, 200, this.serverMetadata(), { 'Access-Control-Allow-Origin': '*' }), true;
    }
    if (p === '/oauth/register') { await this.register(req, res); return true; }
    if (p === '/oauth/token') { await this.token(req, res); return true; }
    if (p === '/oauth/authorize') {
      if (m === 'GET') { await this.authorize(req, res, url); return true; }
      if (m === 'POST') { await this.decide(req, res); return true; }
      return this.json(res, 405, { error: 'method_not_allowed' }), true;
    }
    if (p === '/mcp' || p === '/mcp/') { await this.mcp(req, res); return true; }
    return false;
  }

  // ------------------------------------------------------------ discovery
  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.publicUrl],
      scopes_supported: ['read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Homelab Status',
    };
  }

  serverMetadata() {
    const u = this.publicUrl;
    return {
      issuer: u,
      authorization_endpoint: `${u}/oauth/authorize`,
      token_endpoint: `${u}/oauth/token`,
      registration_endpoint: `${u}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ------------------------------------------------------------ registration
  async register(req, res) {
    if (req.method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed' });
    const ip = this.clientIp(req);
    if (this.limits.register.blocked(ip)) return this.json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '60' });
    this.limits.register.hit(ip);
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return this.json(res, 400, { error: 'invalid_client_metadata', error_description: 'Content-Type must be application/json' });
    let body;
    try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || 'null'); } catch (err) {
      return this.json(res, err.status || 400, { error: 'invalid_client_metadata', error_description: err.status ? err.message : 'Invalid JSON' });
    }
    try {
      const out = this.oauth.register(body);
      console.log(`[oauth] Registered client "${out.client_name}" (${out.client_id.slice(0, 12)}…)`);
      return this.json(res, 201, out);
    } catch (err) { return this.oauthError(res, err); }
  }

  // ------------------------------------------------------------ token
  async token(req, res) {
    if (req.method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed' });
    const ip = this.clientIp(req);
    if (this.limits.token.blocked(ip)) return this.json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '60' });
    this.limits.token.hit(ip);
    let params;
    try {
      const raw = (await readRaw(req, 16 * 1024)).toString('utf8');
      const type = req.headers['content-type'] || '';
      if (/^application\/x-www-form-urlencoded/i.test(type)) params = Object.fromEntries(new URLSearchParams(raw));
      else if (/^application\/json/i.test(type)) { params = JSON.parse(raw || '{}'); if (!params || typeof params !== 'object') throw new Error('bad'); }
      else return this.json(res, 400, { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' });
    } catch (err) {
      return this.json(res, err.status || 400, { error: 'invalid_request', error_description: err.status ? err.message : 'Malformed body' });
    }
    for (const k of Object.keys(params)) if (typeof params[k] !== 'string') params[k] = String(params[k]);
    try {
      const out = this.oauth.exchange(params, this.resourceIds);
      return this.json(res, 200, out, { Pragma: 'no-cache' });
    } catch (err) { return this.oauthError(res, err); }
  }

  // ------------------------------------------------------------ authorize
  async authorize(req, res, url) {
    const ip = this.clientIp(req);
    if (this.limits.authorize.blocked(ip)) return this.page(res, 429, 'Too many requests', '<p>Wait a minute and try again.</p>');
    this.limits.authorize.hit(ip);
    let request;
    try { request = this.oauth.checkAuthorize(url.searchParams, this.resourceIds); } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.redirect) return this.back(res, err.redirectUri, { error: err.code, error_description: err.message, state: err.state });
      return this.page(res, 400, 'Connection request not valid', `<p>${esc(err.message)}</p>`);
    }
    const user = this.signedIn(req);
    if (!user) {
      if (!this.auth.access) return this.page(res, 503, 'Sign-in not set up', '<p>Connecting Claude needs Cloudflare Access in front of this site (CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD).</p>');
      // An Access sign-in that came through but was refused here (e.g. not in ADMIN_EMAILS) needs another fix than a missing one.
      if (this.auth.jwtFrom(req)) return this.page(res, 403, 'This account can\'t connect Claude', '<p>Cloudflare Access signed you in, but this site did not accept that sign-in: the account is not in <code>ADMIN_EMAILS</code>, or the sign-in has expired. Sign in with an allowed account, then connect again from Claude.</p>');
      return this.page(res, 403, 'Sign in through Cloudflare Access', '<p>This page has to be opened through Cloudflare Access, and it did not get an Access sign-in. Make sure the Access application covers <code>/oauth/authorize</code> and that it is not in the bypass application, then connect again from Claude.</p>');
    }
    this.prune(this.consents);
    const consent = crypto.randomBytes(24).toString('base64url');
    this.consents.set(consent, { request, email: user.email, exp: Date.now() + CONSENT_TTL });
    const host = new URL(request.redirectUri).host;
    return this.page(res, 200, 'Connect to Homelab Status', `
      <p class="lead"><b>${esc(request.client.name)}</b> wants <b>read-only</b> access to this homelab dashboard.</p>
      <dl>
        <dt>Sends you back to</dt><dd><code>${esc(host)}</code></dd>
        <dt>Signed in as</dt><dd>${esc(user.email)}</dd>
      </dl>
      <p class="muted">It can read monitors, hosts, containers, updates and approvals, backups, services, events, agent logs and Claude usage.
        It cannot change anything, and it never sees passwords, tokens, webhooks or your chats with the agents.
        You can disconnect it any time in Settings → Connected clients.</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="consent" value="${esc(consent)}">
        <button name="decision" value="deny" class="ghost">Deny</button>
        <button name="decision" value="approve" class="primary">Approve</button>
      </form>`, { formTarget: new URL(request.redirectUri).origin });
  }

  async decide(req, res) {
    let form;
    try { form = new URLSearchParams((await readRaw(req, 8 * 1024)).toString('utf8')); } catch { return this.page(res, 400, 'Bad request', '<p>Try connecting again.</p>'); }
    const id = form.get('consent') || '';
    const c = this.consents.get(id);
    this.consents.delete(id);
    const user = this.signedIn(req);
    if (!c || c.exp < Date.now() || !user || user.email !== c.email) {
      return this.page(res, 400, 'This request expired', '<p>Start connecting again from Claude.</p>');
    }
    const r = c.request;
    if (form.get('decision') !== 'approve') {
      console.log(`[oauth] ${user.email} denied access to "${r.client.name}"`);
      return this.back(res, r.redirectUri, { error: 'access_denied', state: r.state });
    }
    const code = this.oauth.issueCode(r, user);
    console.log(`[oauth] ${user.email} approved "${r.client.name}" (${r.clientId.slice(0, 12)}…)`);
    return this.back(res, r.redirectUri, { code, state: r.state, iss: this.publicUrl });
  }

  // The person signed in through Cloudflare Access (an Authorization header is not a sign-in here).
  signedIn(req) { return this.auth.accessUser(req); }

  // ------------------------------------------------------------ /mcp
  async mcp(req, res) {
    const header = String(req.headers.authorization || '');
    const auth = header.startsWith('Bearer ') ? this.oauth.verify(header.slice(7).trim()) : null;
    if (!auth) {
      const challenge = `Bearer realm="homelab-status", resource_metadata="${this.publicUrl}/.well-known/oauth-protected-resource", scope="read"` +
        (header.startsWith('Bearer ') ? ', error="invalid_token", error_description="The access token is invalid or expired"' : '');
      return this.json(res, 401, { error: header ? 'invalid_token' : 'unauthorized', error_description: 'Connect through OAuth: this endpoint needs an access token issued by this server' },
        { 'WWW-Authenticate': challenge });
    }
    if (!this.resourceIds.includes(auth.resource)) return this.json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    if (req.method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed', error_description: 'This server is stateless: POST JSON-RPC to /mcp' }, { Allow: 'POST' });
    if (this.limits.mcp.blocked(auth.clientId)) return this.json(res, 429, { error: 'too_many_requests', error_description: 'Limit is 60 calls per minute' }, { 'Retry-After': '60' });
    this.limits.mcp.hit(auth.clientId);
    if (!this.sdk) return this.json(res, 503, { error: 'unavailable', error_description: 'The MCP SDK is not installed on this server (npm ci --omit=dev)' });
    let body;
    try { body = JSON.parse((await readRaw(req, 1024 * 1024)).toString('utf8')); } catch (err) {
      return this.json(res, err.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.status ? err.message : 'Parse error' } });
    }
    await mcp.handle(req, res, body, { tools: this.tools, version: this.version, auth });
  }

  // ------------------------------------------------------------ helpers
  json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  }

  oauthError(res, err) {
    if (!(err instanceof OAuthError)) throw err;
    return this.json(res, err.status || 400, { error: err.code, error_description: err.message }, err.status === 401 ? { 'WWW-Authenticate': 'Bearer error="invalid_client"' } : {});
  }

  redirect(res, location, headers = {}) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end();
  }

  back(res, redirectUri, params) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    return this.redirect(res, u.href);
  }

  // A small self-contained page. Never framed, whatever ALLOW_EMBED says (it holds an Approve button).
  page(res, status, title, body, { formTarget = '' } = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      // form-action covers the redirect after submitting too, so the client's callback origin must be listed.
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e6e8eb;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px 32px;max-width:460px;margin:16px}
h1{font-size:20px;margin:0 0 12px}.lead{font-size:16px}.muted{color:#9aa3b2;font-size:13px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:16px 0}dt{color:#9aa3b2}dd{margin:0}
code{background:#0f1115;padding:1px 6px;border-radius:4px}
form{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #333a48;cursor:pointer}
.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}.ghost{background:transparent;color:#e6e8eb}
@media (prefers-color-scheme: light){body{background:#f4f5f7;color:#1c1f24}main{background:#fff;border-color:#e2e5ea}code{background:#f0f2f5}.ghost{color:#1c1f24}}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
  }

  prune(map) {
    const now = Date.now();
    for (const [k, v] of map) if (v.exp < now) map.delete(k);
    while (map.size >= MAX_PENDING) map.delete(map.keys().next().value);
  }
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) { tooBig = true; reject(Object.assign(new Error('Request too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

module.exports = { Connector };
