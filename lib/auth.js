'use strict';
// Authentication: Cloudflare Access in front of the domain. The site has no sign-in of its own.
//
// Cloudflare Access signs every request it lets through with a JWT (the Cf-Access-Jwt-Assertion header, and the
// CF_Authorization cookie). We verify it here: RS256 signature against the team's public keys, issuer, audience
// (the Access application's AUD tag) and expiry. A request without a valid one is not signed in, so going
// around Cloudflare (e.g. straight to :3000 on the LAN) never counts as signed in.
//
// ADMIN_PASSWORD still works as an "Authorization: Bearer" API token for scripts (it is not a sign-in form).
//
// Viewing and controlling are separate. Anyone signed in can view. Only people who can control (canControl) may
// send the agents work (which runs as root on the Proxmox hosts), approve updates, run container actions, install
// versions on the status servers, or change settings: a Cloudflare Access user whose email is in ADMIN_EMAILS.
// With ADMIN_EMAILS empty nobody can. The API token is read-only for those unless CONTROL_API_TOKEN=1.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RateLimiter } = require('./ratelimit');

const CERT_REFRESH = 3600e3;     // re-read the team's keys hourly (Cloudflare rotates them every 6 weeks)
const CERT_RETRY = 60e3;         // at most one extra fetch a minute for an unknown key id
const LEEWAY = 60;               // seconds of clock skew allowed on exp/nbf

const sha256 = s => crypto.createHash('sha256').update(s).digest();

class AuthError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function teamUrl(v) {
  v = String(v || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

class Auth {
  constructor(dataDir) {
    // Failed Bearer-token guesses per IP.
    this.failures = new RateLimiter(10);

    // --- admin password: "Authorization: Bearer" API access for scripts
    let password = process.env.ADMIN_PASSWORD;
    this.source = 'ADMIN_PASSWORD environment variable';
    if (!password) {
      const file = path.join(dataDir, 'admin-password.txt');
      this.source = file;
      try {
        password = fs.readFileSync(file, 'utf8').trim();
      } catch {
        password = crypto.randomBytes(12).toString('base64url');
        fs.writeFileSync(file, password + '\n', { mode: 0o600 });
        this.generated = true;
      }
    }
    this.hash = sha256(password);
    this.password = password;

    // --- Cloudflare Access
    const team = teamUrl(process.env.CF_ACCESS_TEAM_DOMAIN);
    const auds = String(process.env.CF_ACCESS_AUD || '').split(',').map(s => s.trim()).filter(Boolean);
    this.admins = String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    this.access = team && auds.length ? { team, auds, certsUrl: process.env.CF_ACCESS_CERTS_URL || `${team}/cdn-cgi/access/certs` } : null;
    this.controlToken = /^(1|true|yes|on)$/i.test(String(process.env.CONTROL_API_TOKEN || '').trim());
    if (this.controlToken) console.warn('[auth] CONTROL_API_TOKEN is on: the ADMIN_PASSWORD API token can send agents work (root on the Proxmox hosts), approve updates and change the servers. Keep it secret, or turn this off.');
    if (this.access && !this.admins.length) console.warn('[auth] ADMIN_EMAILS is empty: Nobody can send agents work until ADMIN_EMAILS is set. Everyone Cloudflare Access lets in can still view.');
    if ((team && !auds.length) || (!team && auds.length)) console.warn('[auth] Cloudflare Access needs both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD - nobody can sign in until both are set.');
    else if (!this.access) console.warn('[auth] Cloudflare Access is not configured (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD): nobody is signed in (only the ADMIN_PASSWORD API token works) until it is.');
    this.keys = new Map();  // kid -> KeyObject
    this.certsAt = 0;
    this.certsTried = 0;
    this.verified = new Map(); // sha256(jwt) -> { exp, user }: a JWT is checked once, not on every poll
    if (this.access) {
      this.refreshCerts().catch(() => {});
      setInterval(() => this.refreshCerts().catch(() => {}), CERT_REFRESH).unref();
    }
    setInterval(() => { const now = Date.now(); for (const [k, v] of this.verified) if (v.exp < now) this.verified.delete(k); }, 10 * 60e3).unref();
  }

  methods() { return { cloudflare: Boolean(this.access), team: this.access ? this.access.team : null }; }

  // ------------------------------------------------------------ API token
  check(password) {
    return crypto.timingSafeEqual(sha256(String(password || '')), this.hash);
  }

  loginBlocked(ip) { return this.failures.blocked(ip); }
  loginFailed(ip) { this.failures.hit(ip); }

  // ------------------------------------------------------------ Cloudflare Access keys
  async refreshCerts() {
    if (!this.access) return;
    this.certsTried = Date.now();
    try {
      const r = await fetch(this.access.certsUrl, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const keys = new Map();
      for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
        if (jwk && jwk.kid && jwk.kty === 'RSA') { try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip a bad key */ } }
      }
      if (!keys.size) throw new Error('no RSA keys in the answer');
      this.keys = keys;
      this.certsAt = Date.now();
    } catch (err) {
      console.error(`[auth] Could not load Cloudflare Access keys from ${this.access.certsUrl}: ${err.message}`);
      throw err;
    }
  }

  // The Access JWT of a request: the header Cloudflare adds, else its cookie.
  jwtFrom(req) {
    const h = req.headers['cf-access-jwt-assertion'];
    if (h) return String(h).trim();
    return this.cookieValue(req, 'CF_Authorization');
  }

  // Checks a Cloudflare Access JWT. Returns the user or throws AuthError.
  verifyJwt(jwt) {
    if (!this.access) throw new AuthError('not_configured');
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) throw new AuthError('malformed');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw new AuthError('malformed'); }
    if (header.alg !== 'RS256') throw new AuthError('bad_alg');
    const key = this.keys.get(header.kid);
    if (!key) {
      // A new key Cloudflare just rotated in: fetch again (at most once a minute). This request fails; the next works.
      if (Date.now() - this.certsTried > CERT_RETRY) this.refreshCerts().catch(() => {});
      throw new AuthError('unknown_key');
    }
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AuthError('bad_signature');
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.access.team) throw new AuthError('bad_issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some(a => this.access.auds.includes(a))) throw new AuthError('bad_audience');
    if (!(claims.exp + LEEWAY > now) || (claims.nbf && claims.nbf - LEEWAY > now)) throw new AuthError('expired');
    // Service tokens have no email: they are not people, and only people sign in here.
    if (!claims.email) throw new AuthError('no_email');
    if (!this.isAllowedEmail(claims.email)) throw new AuthError('not_allowed', claims.email);
    return { user: { method: 'cloudflare', email: String(claims.email), name: String(claims.email) }, exp: claims.exp * 1000 };
  }

  // The person signed in through Cloudflare Access, or null.
  accessUser(req) {
    if (!this.access) return null;
    const jwt = this.jwtFrom(req);
    if (!jwt) return null;
    const k = sha256(jwt).toString('hex');
    const hit = this.verified.get(k);
    if (hit && hit.exp > Date.now() && this.isAllowedEmail(hit.user.email)) return hit.user;
    try {
      const v = this.verifyJwt(jwt);
      while (this.verified.size >= 1000) this.verified.delete(this.verified.keys().next().value);
      this.verified.set(k, v);
      return v.user;
    } catch (err) {
      if (err.code === 'not_allowed') console.warn(`[auth] Cloudflare Access let ${err.message} through, but they are not in ADMIN_EMAILS`);
      return null;
    }
  }

  // ADMIN_EMAILS is optional with Cloudflare Access (the Access policy decides who gets in). When set, it is a
  // second check: only these addresses (or @domain entries) count as signed in.
  isAllowedEmail(email) {
    if (!email) return false;
    if (!this.admins.length) return true;
    email = String(email).toLowerCase();
    const domain = email.slice(email.lastIndexOf('@'));
    return this.admins.some(entry => (entry.startsWith('@') ? domain === entry : entry === email));
  }

  // May this user change things beyond the monitors (agent tasks, approvals, container actions, the status servers,
  // settings)? Only a Cloudflare Access user listed in ADMIN_EMAILS (an exact address or an @domain entry); nobody
  // when ADMIN_EMAILS is empty. The API token only when CONTROL_API_TOKEN=1.
  canControl(user) {
    if (!user) return false;
    if (user.method === 'token') return this.controlToken;
    return user.method === 'cloudflare' && this.admins.length > 0 && this.isAllowedEmail(user.email);
  }

  cookieValue(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  // Returns the signed-in user, or null. `ip` rate-limits Bearer token guesses.
  user(req, ip) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      if (ip && this.loginBlocked(ip)) return null;
      const ok = this.check(header.slice(7));
      if (!ok && ip) this.loginFailed(ip);
      return ok ? { name: 'API token', method: 'token' } : null;
    }
    return this.accessUser(req);
  }

  isAuthed(req) { return Boolean(this.user(req)); }
}

module.exports = { Auth, AuthError, teamUrl };
