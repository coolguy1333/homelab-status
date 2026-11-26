'use strict';
// OAuth 2.1 authorization server for the Claude connector (/mcp): dynamic client registration, authorization
// code + PKCE (S256 only), refresh tokens that rotate on use. No HTTP here (see lib/connector.js), only state.
//
// Everything lives in DATA_DIR/oauth.json, written atomically like the other files so um-ha copies it to the
// replica and a connected Claude keeps working after a failover. Codes and tokens are stored as SHA-256 hashes
// only: the file (or a backup of it) is not enough to use the connector.
//
//   clients  id -> { name, redirectUris, createdAt, lastUsedAt }
//   codes    sha256(code) -> { client, email, hd, redirectUri, challenge, scope, resource, exp, used? }
//   grants   id -> { client, email, hd, scope, resource, createdAt, refresh: { sha256(token) -> { exp, until? } } }
//   access   sha256(token) -> { grant, client, exp }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACCESS_TTL = 3600e3;               // 1 hour
const REFRESH_TTL = 30 * 24 * 3600e3;    // 30 days
const CODE_TTL = 5 * 60e3;
// A rotated-out refresh token keeps working this long. um-ha copies DATA_DIR every 5 s, and the answer to a
// refresh can be lost (failover, network): the client then retries with the token it still has.
const REFRESH_GRACE = 2 * 60e3;
const MAX_CLIENTS = 200;
const UNUSED_CLIENT_TTL = 24 * 3600e3;   // registered but never authorized: dropped after a day
const SCOPES = ['read', 'offline_access'];
const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = prefix => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

class OAuthError extends Error {
  // code: an RFC 6749 error code (invalid_request, invalid_client, invalid_grant, ...). status: HTTP status.
  constructor(code, description, status = 400) { super(description || code); this.code = code; this.status = status; }
}

class OAuthStore {
  // isAllowed(email): is this account still allowed (ADMIN_EMAILS, when set)? Checked on every use,
  // so removing someone from ADMIN_EMAILS cuts off their connector at once.
  constructor(dataDir, { redirectAllowlist = DEFAULT_REDIRECTS, isAllowed = () => true, now = Date.now } = {}) {
    this.file = path.join(dataDir, 'oauth.json');
    this.allowlist = redirectAllowlist;
    this.isAllowed = isAllowed;
    this.now = now;
    this.data = { clients: {}, codes: {}, grants: {}, access: {} };
    this.load();
    this.timer = setInterval(() => this.cleanup(), 10 * 60e3);
    this.timer.unref();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of Object.keys(this.data)) if (d && d[k] && typeof d[k] === 'object') this.data[k] = d[k];
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[oauth] Could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    const json = JSON.stringify(this.data);
    try {
      fs.writeFileSync(`${this.file}.tmp`, json, { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      try { fs.writeFileSync(this.file, json, { mode: 0o600 }); } catch (e) { console.error(`[oauth] Could not save ${this.file}: ${e.message}`); }
    }
  }

  stop() { clearInterval(this.timer); }

  redirectAllowed(uri) { return typeof uri === 'string' && this.allowlist.includes(uri); }

  // ------------------------------------------------------------ registration (RFC 7591)
  register(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'Expected a JSON object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
    for (const u of uris) {
      if (!this.redirectAllowed(u)) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${String(u).slice(0, 200)} (see MCP_REDIRECT_ALLOWLIST)`);
    }
    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none")');
    for (const g of body.grant_types || []) {
      if (!['authorization_code', 'refresh_token'].includes(g)) throw new OAuthError('invalid_client_metadata', `Unsupported grant type: ${String(g).slice(0, 50)}`);
    }
    this.cleanup();
    if (Object.keys(this.data.clients).length >= MAX_CLIENTS) throw new OAuthError('invalid_client_metadata', 'Too many registered clients', 429);
    const id = `hsc_${crypto.randomBytes(16).toString('hex')}`;
    const now = this.now();
    const name = String(body.client_name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Unnamed client';
    this.data.clients[id] = { name, redirectUris: [...new Set(uris)], createdAt: now, lastUsedAt: null };
    this.save();
    return {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: this.data.clients[id].redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPES.join(' '),
    };
  }

  client(id) { return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.data.clients, id) && this.data.clients[id]) || null; }

  // ------------------------------------------------------------ authorization request
  // Checks the parameters of GET /oauth/authorize. Errors with `redirect: false` must be shown to the user
  // (the client or redirect URI can't be trusted); the others go back to the redirect URI.
  checkAuthorize(q, resourceIds) {
    const get = k => (typeof q.get === 'function' ? q.get(k) : q[k]) ?? null;
    const clientId = get('client_id');
    const redirectUri = get('redirect_uri');
    const client = this.client(clientId);
    if (!client) throw Object.assign(new OAuthError('invalid_client', 'Unknown client. Remove the connector in Claude and add it again.'), { redirect: false });
    if (!redirectUri || !client.redirectUris.includes(redirectUri) || !this.redirectAllowed(redirectUri)) {
      throw Object.assign(new OAuthError('invalid_request', 'This redirect URI is not registered for the client or not in MCP_REDIRECT_ALLOWLIST.'), { redirect: false });
    }
    const fail = (code, msg) => { throw Object.assign(new OAuthError(code, msg), { redirect: true, redirectUri, state: get('state') }); };
    if (get('response_type') !== 'code') fail('unsupported_response_type', 'response_type must be code');
    const challenge = get('code_challenge');
    if (!challenge) fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256');
    if (get('code_challenge_method') !== 'S256') fail('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) fail('invalid_request', 'Malformed code_challenge');
    const resource = get('resource');
    if (resource && !resourceIds.includes(resource)) fail('invalid_target', 'Unknown resource');
    const state = get('state');
    if (state && state.length > 1000) fail('invalid_request', 'state is too long');
    return { clientId, client, redirectUri, challenge, state, scope: grantScope(get('scope')), resource: resource || resourceIds[0] };
  }

  issueCode(req, user) {
    const code = token('hs_code');
    this.data.codes[sha256hex(code)] = {
      client: req.clientId, email: user.email, hd: user.hd || null, redirectUri: req.redirectUri,
      challenge: req.challenge, scope: req.scope, resource: req.resource, exp: this.now() + CODE_TTL,
    };
    this.save();
    return code;
  }

  // ------------------------------------------------------------ token endpoint
  exchange(params, resourceIds) {
    const grantType = params.grant_type;
    const client = this.client(params.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (grantType === 'authorization_code') return this.exchangeCode(params, resourceIds);
    if (grantType === 'refresh_token') return this.refresh(params);
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  exchangeCode(p, resourceIds) {
    const now = this.now();
    const key = sha256hex(p.code || '');
    const c = p.code && this.data.codes[key];
    if (!c || c.exp < now) throw new OAuthError('invalid_grant', 'Invalid or expired authorization code');
    if (c.used) {
      // A code used twice may have been stolen: revoke what the first use got (RFC 6819 4.4.1.1).
      this.revokeGrant(c.used);
      delete this.data.codes[key];
      this.save();
      throw new OAuthError('invalid_grant', 'Authorization code was already used');
    }
    if (c.client !== p.client_id) throw new OAuthError('invalid_grant', 'Code was issued to another client');
    if (c.redirectUri !== p.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    const verifier = p.code_verifier || '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'Missing or malformed code_verifier (PKCE)');
    const expect = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!safeEqual(expect, c.challenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match code_challenge');
    if (p.resource && p.resource !== c.resource && !(resourceIds.includes(p.resource) && resourceIds.includes(c.resource))) {
      throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    }
    if (!this.isAllowed(c.email, c.hd)) throw new OAuthError('invalid_grant', 'This account is no longer allowed (ADMIN_EMAILS)');
    const gid = `g${crypto.randomBytes(8).toString('hex')}`;
    this.data.grants[gid] = { client: c.client, email: c.email, hd: c.hd, scope: c.scope, resource: c.resource, createdAt: now, refresh: {} };
    c.used = gid;
    return this.issueTokens(gid);
  }

  refresh(p) {
    const now = this.now();
    const key = sha256hex(p.refresh_token || '');
    let gid = null, entry = null;
    if (p.refresh_token) {
      for (const [id, g] of Object.entries(this.data.grants)) if (g.refresh[key]) { gid = id; entry = g.refresh[key]; break; }
    }
    const g = gid && this.data.grants[gid];
    if (!g || entry.exp < now || (entry.until && entry.until < now)) throw new OAuthError('invalid_grant', 'Invalid, expired or already used refresh token');
    if (g.client !== p.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    if (!this.isAllowed(g.email, g.hd)) { this.revokeGrant(gid); this.save(); throw new OAuthError('invalid_grant', 'This account is no longer allowed (ADMIN_EMAILS)'); }
    // Rotate: every token still valid now stays valid for REFRESH_GRACE more, then only the new one works.
    for (const r of Object.values(g.refresh)) if (!r.until) r.until = now + REFRESH_GRACE;
    return this.issueTokens(gid);
  }

  issueTokens(gid) {
    const now = this.now();
    const g = this.data.grants[gid];
    for (const [h, r] of Object.entries(g.refresh)) if (r.exp < now || (r.until && r.until < now)) delete g.refresh[h];
    const access = token('hs_at');
    const refresh = token('hs_rt');
    this.data.access[sha256hex(access)] = { grant: gid, client: g.client, exp: now + ACCESS_TTL };
    g.refresh[sha256hex(refresh)] = { exp: now + REFRESH_TTL };
    const client = this.client(g.client);
    if (client) client.lastUsedAt = now;
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: g.scope };
  }

  // The grant behind a Bearer access token for /mcp, or null.
  verify(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.startsWith('hs_at_')) return null;
    const key = sha256hex(accessToken);
    const a = this.data.access[key];
    if (!a) return null;
    const g = this.data.grants[a.grant];
    const client = this.client(a.client);
    if (a.exp < this.now() || !g || !client) { delete this.data.access[key]; return null; }
    if (!this.isAllowed(g.email, g.hd)) return null;
    client.lastUsedAt = this.now(); // in memory only; saved with the next token write
    return { clientId: a.client, clientName: client.name, email: g.email, scope: g.scope, resource: g.resource, grant: a.grant, expiresAt: a.exp };
  }

  // ------------------------------------------------------------ Settings: connected clients
  connected() {
    const now = this.now();
    const out = [];
    for (const [id, c] of Object.entries(this.data.clients)) {
      const grants = Object.values(this.data.grants).filter(g => g.client === id && Object.values(g.refresh).some(r => r.exp > now && !(r.until && r.until < now)));
      if (!grants.length) continue;
      let host = null;
      try { host = new URL(c.redirectUris[0]).host; } catch { /* listed without */ }
      out.push({
        id, name: c.name, redirectHost: host,
        accounts: [...new Set(grants.map(g => g.email))],
        connectedAt: Math.min(...grants.map(g => g.createdAt)),
        lastUsedAt: c.lastUsedAt,
      });
    }
    return out.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  }

  // Removes the client with every grant, code and token it has. Claude has to be connected again.
  revokeClient(id) {
    if (!this.client(id)) return false;
    delete this.data.clients[id];
    for (const [gid, g] of Object.entries(this.data.grants)) if (g.client === id) this.revokeGrant(gid);
    for (const [h, c] of Object.entries(this.data.codes)) if (c.client === id) delete this.data.codes[h];
    this.save();
    return true;
  }

  revokeGrant(gid) {
    delete this.data.grants[gid];
    for (const [h, a] of Object.entries(this.data.access)) if (a.grant === gid) delete this.data.access[h];
  }

  cleanup() {
    const now = this.now();
    const d = this.data;
    let changed = false;
    for (const [h, c] of Object.entries(d.codes)) if (c.exp < now) { delete d.codes[h]; changed = true; }
    for (const [h, a] of Object.entries(d.access)) if (a.exp < now || !d.grants[a.grant]) { delete d.access[h]; changed = true; }
    for (const [gid, g] of Object.entries(d.grants)) {
      for (const [h, r] of Object.entries(g.refresh)) if (r.exp < now || (r.until && r.until < now)) { delete g.refresh[h]; changed = true; }
      if (!Object.keys(g.refresh).length || !d.clients[g.client]) { this.revokeGrant(gid); changed = true; }
    }
    const inUse = new Set([...Object.values(d.grants).map(g => g.client), ...Object.values(d.codes).map(c => c.client)]);
    for (const [id, c] of Object.entries(d.clients)) if (!inUse.has(id) && now - c.createdAt > UNUSED_CLIENT_TTL) { delete d.clients[id]; changed = true; }
    if (changed) this.save();
  }
}

// Scopes granted: what was asked for and exists; read access always (it's the only kind there is).
function grantScope(requested) {
  const asked = String(requested || '').split(/\s+/).filter(s => SCOPES.includes(s));
  return [...new Set(['read', ...asked])].join(' ');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { OAuthStore, OAuthError, SCOPES, DEFAULT_REDIRECTS, ACCESS_TTL, REFRESH_TTL, REFRESH_GRACE, CODE_TTL };
