#!/usr/bin/env node
'use strict';
/*
 * Homelab Status - hosts, containers, updates, backups and uptime (based on Uptime Monitor).
 * Zero dependencies: needs only Node.js 18+.
 *   node server.js
 * See README.md for configuration.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Load .env before anything reads process.env.
loadDotEnv(path.join(__dirname, '.env'));

const { Store, DAY } = require('./lib/store');
const { Notifier } = require('./lib/notify');
const { Scheduler } = require('./lib/scheduler');
const { SelfTracker } = require('./lib/self');
const { Auth, AuthError } = require('./lib/auth');
const { HOST_RE } = require('./lib/checks');
const { PeerHub } = require('./lib/peers');
const { mergeMonitors } = require('./lib/sync');
const { Infra } = require('./lib/infra');

const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());

const VERSION = require('./package.json').version;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
// Relative DATA_DIR values are relative to this folder, not to wherever the app was started from.
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const TRUST_PROXY = truthy(process.env.TRUST_PROXY);
const ALLOW_EMBED = truthy(process.env.ALLOW_EMBED);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Other Uptime Monitor instances to federate with (see docs/CONFIGURATION.md#peer-servers).
// A URL matching our own PUBLIC_URL is dropped so a copy-pasted PEERS list can't make an
// instance poll itself.
const PEER_URLS = (process.env.PEERS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean).filter(u => {
  if (u === PUBLIC_URL) return false;
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) { console.warn(`[peers] Ignoring invalid PEERS entry "${u}" (expected e.g. https://status.example.com)`); return false; }
  return true;
});
if (PUBLIC_URL && !/^https?:\/\/[^\s/]+$/i.test(PUBLIC_URL)) {
  console.warn(`[config] PUBLIC_URL "${PUBLIC_URL}" should look like https://status.example.com (scheme and host, no path).`);
}
const PEER_TOKEN = (process.env.PEER_TOKEN || '').trim();

const settingsDefaults = {};
if (process.env.SITE_TITLE) settingsDefaults.title = process.env.SITE_TITLE;
if (process.env.SERVER_NAME) settingsDefaults.serverName = process.env.SERVER_NAME.trim().slice(0, 100);
if (process.env.PUBLIC_DASHBOARD) settingsDefaults.publicDashboard = !/^(0|false|no|off)$/i.test(process.env.PUBLIC_DASHBOARD.trim());

const store = new Store(DATA_DIR, { settings: settingsDefaults });
const notifier = new Notifier(store);
const scheduler = new Scheduler(store, notifier);
const selfTracker = new SelfTracker(store, notifier);
const auth = new Auth(DATA_DIR);
const infra = new Infra(DATA_DIR, notifier);
auth.revokeDisallowed();
const peerHub = new PeerHub(store, {
  urls: PEER_URLS,
  token: PEER_TOKEN,
  onSync: (monitors, deleted) => {
    if (mergeMonitors({ store, scheduler, validate: r => validateMonitor(r, newMonitor({})) }, monitors, deleted)) statusCache.clear();
  },
});
// How this server is labelled to its peers (and on its own dashboard when it has peers).
const serverName = () => store.settings.serverName || store.settings.title;
const SYNC_MONITORS = PEER_URLS.length > 0 && Boolean(PEER_TOKEN);
if (PEER_URLS.length && !PEER_TOKEN) {
  console.warn('[peers] PEERS is set without PEER_TOKEN - /api/peer-status is public and unauthenticated, and monitors are NOT synced between servers. Set the same PEER_TOKEN on every server to protect it and turn on monitor sync.');
}
// The token and the monitor list travel on every poll: warn if that would cross the internet unencrypted.
function isPrivateHost(h) {
  h = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes('.') && !h.includes(':')) return true; // single-label name such as "raspberrypi"
  if (/\.(local|lan|home|internal|localdomain)$/.test(h)) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return h === '::1' || /^(fc|fd|fe80)/.test(h);
}
if (PEER_TOKEN) {
  for (const u of PEER_URLS) {
    let host = '';
    try { host = new URL(u).hostname; } catch { /* already validated above */ }
    if (/^http:\/\//i.test(u) && host && !isPrivateHost(host)) {
      console.warn(`[peers] ${u} is plain http:// over a public address: the peer token and your monitor list would be sent unencrypted. Use https:// instead.`);
    }
  }
}
// Public hostnames served by the agents' Cloudflare tunnels become HTTP monitors automatically.
// Deleting one of those monitors remembers the hostname so it isn't added back.
infra.onPublic = (list, agent) => {
  const dismissed = new Set(store.settings.autoDismissed || []);
  const norm = u => String(u || '').toLowerCase().replace(/\/+$/, '');
  let added = 0;
  for (const item of list.slice(0, 200)) {
    const host = String(item && item.host || '').toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || dismissed.has(host)) continue;
    const target = /^https?:\/\//.test(item.url || '') ? String(item.url) : `https://${host}/`;
    const existing = store.monitors.find(m => m.autoHost === host || norm(m.target) === norm(target));
    if (existing) {
      // A tunnel hostname that turns out to be a WebManager site: give it the site's name.
      if (existing.autoHost && item.name && existing.name === host) { existing.name = `${String(item.name).slice(0, 80)} (${host})`; store.saveMonitors(); }
      continue;
    }
    if (store.monitors.length >= 1000) break;
    const name = item.name ? `${String(item.name).slice(0, 80)} (${host})` : host;
    const m = newMonitor({ name, type: 'http', target, acceptedStatus: '200-499', interval: 120, timeout: 15, retries: 2, autoHost: host, autoBy: agent });
    store.monitors.push(m);
    scheduler.schedule(m, 1000 + added * 400);
    added++;
  }
  if (added) { store.saveMonitors(); statusCache.clear(); console.log(`[infra] Added ${added} monitor(s) for tunnel hostnames reported by ${agent}`); }
};

// Drop history left behind by deleted monitors or peers removed from PEERS.
{
  const keep = new Set([...store.monitors.map(m => m.id), ...PEER_URLS.map(u => peerHub.peerId(u))]);
  const stale = Object.keys(store.history).filter(k => !keep.has(k));
  if (stale.length) { stale.forEach(k => delete store.history[k]); store.historyDirty = true; }
}

if (store.firstRun) {
  // With monitor sync on, a new server gets its monitors from its peers instead of example ones.
  // No example monitors: the agents add your tunnel hostnames and WebManager sites on their own.
  store.monitors = [];
  store.saveMonitors();
  store.saveSettings();
}

// ---------------------------------------------------------------- helpers

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // inline comment on an unquoted value
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function newMonitor(fields) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: '', type: 'http', target: '', port: null,
    interval: 60, timeout: 10, retries: 1,
    method: 'GET', acceptedStatus: '200-399', keyword: '', invertKeyword: false,
    ignoreTls: false, followRedirects: true, paused: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...fields,
  };
}

const int = (v, min, max, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const bool = v => (typeof v === 'string' ? truthy(v) : Boolean(v));

function validateMonitor(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { monitor: base, errors: ['Expected a JSON object'] };
  const m = { ...base };
  const errors = [];
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  if ('name' in input) m.name = str(input.name, 100);
  if (!m.name) errors.push('Name is required');

  if ('type' in input) m.type = String(input.type);
  if (!['http', 'tcp', 'ping'].includes(m.type)) errors.push('Type must be http, tcp or ping');

  if ('port' in input) m.port = input.port === '' || input.port == null ? null : Number(input.port);
  if ('target' in input) m.target = str(input.target, 2000);

  if (!m.target) errors.push('Target is required');
  else if (m.type === 'http') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(m.target) && !/^https?:\/\//i.test(m.target)) errors.push('Only http:// and https:// URLs are supported');
    else {
      if (!/^https?:\/\//i.test(m.target)) m.target = 'https://' + m.target;
      try { new URL(m.target); } catch { errors.push('Target must be a valid URL'); }
    }
  } else {
    // Be forgiving: accept "https://host/path", "host:port" and "[::1]" and reduce them to a host.
    let t = m.target;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        t = u.hostname;
        if (m.type === 'tcp' && m.port == null) m.port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null);
      } catch { /* validated below */ }
    }
    const hostPort = t.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
    if (hostPort && !/:.*:/.test(t.replace(/^\[.*\]/, ''))) {
      t = hostPort[1];
      if (m.type === 'tcp' && m.port == null) m.port = Number(hostPort[2]);
    }
    t = t.replace(/^\[(.*)\]$/, '$1');
    m.target = t;
    if (!HOST_RE.test(t) || t.startsWith('-')) errors.push('Target must be a hostname or IP address (no spaces)');
  }

  if (m.type === 'tcp' && !(Number.isInteger(m.port) && m.port >= 1 && m.port <= 65535)) errors.push('TCP monitors need a port between 1 and 65535');
  if (m.type !== 'tcp') m.port = null;

  m.interval = 'interval' in input ? int(input.interval, 10, 86400, 60) : m.interval;
  m.timeout = 'timeout' in input ? int(input.timeout, 1, 120, 10) : m.timeout;
  m.retries = 'retries' in input ? int(input.retries, 0, 10, 1) : m.retries;
  for (const k of ['interval', 'timeout', 'retries']) if (Number.isNaN(m[k])) errors.push(`${k} must be a number`);

  if ('method' in input) m.method = String(input.method).toUpperCase();
  if (!['GET', 'HEAD'].includes(m.method)) errors.push('Method must be GET or HEAD');

  if ('acceptedStatus' in input) m.acceptedStatus = str(input.acceptedStatus, 100) || '200-399';
  if (!/^\s*(\d{3}(\s*-\s*\d{3})?|\dxx)(\s*,\s*(\d{3}(\s*-\s*\d{3})?|\dxx))*\s*,?\s*$/i.test(m.acceptedStatus)) errors.push('Accepted status codes look like "200-299, 301" or "2xx"');

  if ('keyword' in input) m.keyword = str(input.keyword, 200);
  for (const k of ['invertKeyword', 'ignoreTls', 'followRedirects', 'paused']) if (k in input) m[k] = bool(input[k]);

  return { monitor: m, errors };
}

function round(n, d = 2) { return n == null ? null : Math.round(n * 10 ** d) / 10 ** d; }

function uptimeSet(fn) {
  return { '24h': round(fn(DAY)), '7d': round(fn(7 * DAY)), '30d': round(fn(30 * DAY)), '90d': round(fn(90 * DAY)) };
}

function showTargets(authed) { return authed || store.settings.publicShowTargets; }

// The dashboard asks for /api/status every few seconds from every open tab, and building it walks all
// the check history. Compute it at most every 2 seconds (per visitor type); anything changed through
// the API clears the cache so the UI never shows stale data after its own actions.
const statusCache = new Map();
function statusParts(authed) {
  const key = authed ? 'admin' : 'public';
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.t < 2000) return hit.data;
  const monitors = store.monitors.map(m => monitorSummary(m, authed));
  const counts = { up: 0, down: 0, pending: 0, paused: 0 };
  for (const m of monitors) counts[m.status] = (counts[m.status] || 0) + 1;
  const data = { self: selfSummary(authed), counts, monitors, peers: peerSummaries(authed) };
  statusCache.set(key, { t: Date.now(), data });
  return data;
}

function monitorSummary(m, authed) {
  const h = store.history[m.id] || { raw: [], status: 'pending' };
  const last = h.raw[h.raw.length - 1];
  const cutoff = Date.now() - DAY;
  const dayChecks = h.raw.filter(c => c.t >= cutoff && c.ok && typeof c.ms === 'number');
  const avg = dayChecks.length ? dayChecks.reduce((a, c) => a + c.ms, 0) / dayChecks.length : null;
  const out = {
    id: m.id,
    name: m.name,
    type: m.type,
    interval: m.interval,
    paused: m.paused,
    status: m.paused ? 'paused' : (h.status || 'pending'),
    downSince: !m.paused && h.status === 'down' ? h.downSince : null,
    last: last ? { t: last.t, ok: last.ok, ms: last.ms, msg: last.msg } : null,
    avgMs24h: round(avg, 1),
    uptime: uptimeSet(w => store.uptime(m.id, w)),
    recent: h.raw.slice(-60).map(c => ({ t: c.t, ok: c.ok, ms: c.ms, msg: c.msg })),
    cert: h.cert || null,
    auto: m.autoHost ? { host: m.autoHost, by: m.autoBy || null } : null,
  };
  if (showTargets(authed)) { out.target = m.target; out.port = m.port; }
  if (authed) out.config = m;
  return out;
}

function downsample(checks, maxPoints) {
  if (checks.length <= maxPoints) return checks.map(c => ({ t: c.t, ok: c.ok, ms: c.ms }));
  const size = Math.ceil(checks.length / maxPoints);
  const out = [];
  for (let i = 0; i < checks.length; i += size) {
    const group = checks.slice(i, i + size);
    const okOnes = group.filter(c => c.ok && typeof c.ms === 'number');
    out.push({
      t: group[group.length - 1].t,
      ok: group.every(c => c.ok),
      ms: okOnes.length ? round(okOnes.reduce((a, c) => a + c.ms, 0) / okOnes.length, 1) : null,
    });
  }
  return out;
}

function selfSummary(authed) {
  const s = store.self;
  const now = Date.now();
  const out = {
    status: 'up',
    startedAt: s.startedAt,
    firstStart: s.firstStart,
    processUptime: Math.round(process.uptime()),
    restarts: s.restarts,
    uptime: uptimeSet(w => store.selfUptime(w, now)),
    daily: store.selfDaily(90, now),
    lastDowntime: s.downtimes.length ? s.downtimes[s.downtimes.length - 1] : null,
    downtimeCount30d: s.downtimes.filter(d => d.end > now - 30 * DAY).length,
    events: s.events.slice(-20).reverse(),
    version: VERSION,
  };
  if (authed) {
    const mem = process.memoryUsage();
    out.host = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${process.arch})`,
      node: process.version,
      osUptime: Math.round(os.uptime()),
      loadavg: process.platform === 'win32' ? null : os.loadavg().map(n => round(n)),
      memoryRss: mem.rss,
      systemMemory: { total: os.totalmem(), free: os.freemem() },
      cpus: os.cpus().length,
      dataDir: DATA_DIR,
    };
  }
  return out;
}

// One entry per configured peer: what it last reported about itself (`self`, absent until the
// first successful poll, kept around afterwards even if the peer later goes unreachable), plus
// the uptime of that peer as observed from here (`observedUptime` - what fraction of our polls
// reached it), which keeps working even if the peer's own self-tracking data can't be reached.
// Peer addresses follow the same rule as monitor targets: hidden from public visitors unless allowed.
function peerSummaries(authed) {
  return peerHub.entries().map((p, i) => ({
    ...(showTargets(authed) ? { url: p.url } : {}),
    name: p.named ? p.name : (showTargets(authed) ? p.name : `Server ${i + 1}`),
    reachable: p.reachable,
    error: p.error,
    checkedAt: p.checkedAt,
    lastSeen: p.lastSeen,
    version: p.version,
    self: p.self,
    observedUptime: uptimeSet(w => store.uptime(p.id, w)),
  }));
}

// ---------------------------------------------------------------- http plumbing

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self'; form-action 'self'; base-uri 'none'" +
    (ALLOW_EMBED ? '' : "; frame-ancestors 'none'"),
  ...(ALLOW_EMBED ? {} : { 'X-Frame-Options': 'DENY' }),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', c => {
      if (tooBig) return; // keep draining so the client still gets our 413 instead of a dropped connection
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error(`Request too large (limit ${Math.round(limit / 1024)} KB)`), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      if (!data || typeof data !== 'object') return reject(Object.assign(new Error('Expected a JSON object'), { status: 400 }));
      resolve(data);
    });
    req.on('error', reject);
  });
}

// Behind a proxy, use the LAST X-Forwarded-For entry: that's the one our own proxy appended.
// The first entry is whatever the client sent, so trusting it would let anyone dodge the rate limits.
function clientIp(req) {
  const xff = TRUST_PROXY && req.headers['x-forwarded-for'];
  if (xff) {
    const last = String(xff).split(',').pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress;
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  if (PUBLIC_URL.startsWith('https://')) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Base URL of this site as seen by the browser (used for the Google redirect URI).
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${PORT}`;
  return `${isSecure(req) ? 'https' : 'http'}://${String(host).split(',')[0].trim()}`;
}

// CDNs/proxies in front of the app (e.g. WebManager's Cloudflare) can cache app.js and style.css for
// hours regardless of our Cache-Control, so updates would not show. Referencing them as
// app.js?v=<content hash> from index.html makes every release a new URL.
const ASSET_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'dashboard.js', 'style.css']) { try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch { /* missing file: served as 404 later */ } }
  return h.digest('hex').slice(0, 10);
})();

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    if (file === path.join(PUBLIC_DIR, 'index.html')) {
      data = Buffer.from(data.toString('utf8').replace(/((?:src|href)="(?:app\.js|dashboard\.js|style\.css))"/g, `$1?v=${ASSET_VERSION}"`));
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Always revalidate so updates show up immediately (the files are tiny).
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  // /api/peer-status has its own token. Its Authorization header is not an admin credential, so it
  // must not be tried as one (that would count every peer poll as a failed admin-password guess).
  // Agent reports carry an agent token, not an admin credential: don't try it as one either.
  const user = p === '/api/peer-status' || p.startsWith('/api/agent/') ? null : auth.user(req, clientIp(req));
  const authed = Boolean(user);
  const needAuth = () => { if (!authed) { send(res, 401, { error: 'Login required' }); return true; } return false; };
  const needJson = () => {
    // Cheap CSRF protection: browsers cannot send application/json cross-site without a CORS preflight.
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) { send(res, 415, { error: 'Content-Type must be application/json' }); return true; }
    return false;
  };
  const canView = authed || store.settings.publicDashboard;
  if (method !== 'GET' && method !== 'HEAD') res.on('finish', () => statusCache.clear());

  // Health check for Docker / external monitors. Always public.
  if (p === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    return send(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), version: VERSION, time: new Date().toISOString() });
  }

  // What sibling instances poll to federate with this one. Public unless PEER_TOKEN is set;
  // never includes monitors, targets or host details - only this server's own uptime record.
  if (p === '/api/peer-status' && (method === 'GET' || method === 'HEAD')) {
    if (!peerHub.authorizeIncoming(req, clientIp(req))) return send(res, 401, { error: 'Invalid or missing peer token' });
    const payload = { name: serverName(), version: VERSION, time: Date.now(), self: selfSummary(false) };
    // Monitor definitions (with their targets) only go to peers that proved they hold the shared token.
    if (PEER_TOKEN) { payload.monitors = store.monitors; payload.deleted = store.tombstones; }
    return send(res, 200, payload);
  }

  if (p === '/api/status' && method === 'GET') {
    const base = {
      title: store.settings.title,
      authed,
      user: user ? { name: user.name, email: user.email || null, picture: user.picture || null, method: user.method } : null,
      auth: auth.methods(),
      publicDashboard: store.settings.publicDashboard,
      serverName: serverName(),
      sync: SYNC_MONITORS,
      infra: infra.enabled,
      version: VERSION,
      serverTime: Date.now(),
    };
    if (!canView) return send(res, 200, { ...base, locked: true });
    return send(res, 200, { ...base, ...statusParts(authed) });
  }

  // ---- password login
  if (p === '/api/login' && method === 'POST') {
    if (needJson()) return;
    if (!auth.passwordLogin) return send(res, 403, { error: 'Password login is disabled. Sign in with Google.' });
    const ip = clientIp(req);
    if (auth.loginBlocked(ip)) return send(res, 429, { error: 'Too many wrong passwords - wait a minute and try again' });
    const body = await readBody(req);
    if (!auth.check(body.password)) { auth.loginFailed(ip); return send(res, 401, { error: 'Wrong password' }); }
    auth.loginSucceeded(ip);
    const token = auth.createSession({ method: 'password', name: 'Admin' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(token, isSecure(req)) });
  }

  // ---- Google sign-in
  if (p === '/api/auth/google' && method === 'GET') {
    const home = PUBLIC_URL ? `${PUBLIC_URL}/` : '../../';
    if (!auth.google) return redirect(res, `${home}?login_error=google_disabled`);
    const ip = clientIp(req);
    if (auth.starts.blocked(ip)) return redirect(res, `${home}?login_error=rate_limited`);
    auth.starts.hit(ip);
    const { url: googleUrl, cookie } = auth.googleStart(`${baseUrl(req)}/api/auth/google/callback`, isSecure(req));
    return redirect(res, googleUrl, { 'Set-Cookie': cookie });
  }

  if (p === '/api/auth/google/callback' && method === 'GET') {
    const home = PUBLIC_URL ? `${PUBLIC_URL}/` : '../../../';
    const clear = auth.clearStateCookie(isSecure(req));
    try {
      const u = await auth.googleCallback(req, url.searchParams);
      const token = auth.createSession(u);
      return redirect(res, home, { 'Set-Cookie': [clear, auth.cookie(token, isSecure(req))] });
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'google_error';
      if (!(err instanceof AuthError)) console.error('[auth]', err);
      return redirect(res, `${home}?login_error=${encodeURIComponent(code)}`, { 'Set-Cookie': clear });
    }
  }

  if (p === '/api/logout' && method === 'POST') {
    if (needJson()) return;
    const token = auth.tokenFrom(req);
    if (token) auth.destroySession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(null, isSecure(req)) });
  }

  // ---- settings
  if (p === '/api/settings') {
    if (needAuth()) return;
    if (method === 'GET') {
      return send(res, 200, {
        ...store.settings,
        envWebhooks: Boolean(process.env.NOTIFY_WEBHOOK_URL),
        peers: { count: PEER_URLS.length, sync: SYNC_MONITORS },
        auth: { ...auth.methods(), adminEmails: auth.google ? auth.google.admins : [], passwordSource: auth.source },
      });
    }
    if (method === 'PUT') {
      if (needJson()) return;
      const body = await readBody(req);
      const s = store.settings;
      if ('webhooks' in body) {
        const list = (Array.isArray(body.webhooks) ? body.webhooks : String(body.webhooks ?? '').split(/\r?\n/)).map(u => String(u).trim()).filter(Boolean);
        for (const u of list) {
          let ok = /^https?:\/\//i.test(u);
          try { new URL(u); } catch { ok = false; }
          if (!ok) return send(res, 400, { error: `Invalid webhook URL: ${u}` });
        }
        s.webhooks = list.slice(0, 20);
      }
      if ('title' in body) s.title = String(body.title ?? '').trim().slice(0, 100) || 'Homelab Status';
      if ('serverName' in body) s.serverName = String(body.serverName ?? '').trim().slice(0, 100);
      if ('publicShowTargets' in body) s.publicShowTargets = bool(body.publicShowTargets);
      if ('publicDashboard' in body) s.publicDashboard = bool(body.publicDashboard);
      store.saveSettings();
      return send(res, 200, s);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (p === '/api/settings/test-notification' && method === 'POST') {
    if (needAuth() || needJson()) return;
    if (!notifier.urls().length) return send(res, 400, { error: 'No webhooks configured' });
    return send(res, 200, { results: await notifier.test() });
  }

  if (p === '/api/export' && method === 'GET') {
    if (needAuth()) return;
    return send(res, 200, { version: VERSION, exportedAt: new Date().toISOString(), settings: store.settings, monitors: store.monitors },
      { 'Content-Disposition': 'attachment; filename="uptime-monitor-export.json"' });
  }

  if (p === '/api/import' && method === 'POST') {
    if (needAuth() || needJson()) return;
    const body = await readBody(req, 2 * 1024 * 1024);
    const list = Array.isArray(body) ? body : body.monitors;
    if (!Array.isArray(list)) return send(res, 400, { error: 'Expected { "monitors": [...] }' });
    if (list.length > 500) return send(res, 400, { error: 'Too many monitors in one import (max 500)' });
    if (store.monitors.length + list.length > 1000) return send(res, 400, { error: 'Too many monitors (max 1000 in total)' });
    const added = [];
    for (const [i, item] of list.entries()) {
      const { monitor, errors } = validateMonitor(item, newMonitor({}));
      if (errors.length) return send(res, 400, { error: `Monitor #${i + 1}${item && item.name ? ` (${item.name})` : ''}: ${errors.join(', ')}` });
      added.push(monitor);
    }
    store.monitors.push(...added);
    store.saveMonitors();
    added.forEach((m, i) => scheduler.schedule(m, 500 + i * 250));
    return send(res, 200, { imported: added.length });
  }

  // ---- monitors
  if (p === '/api/monitors') {
    if (method === 'GET') {
      if (!canView) return send(res, 401, { error: 'Login required' });
      return send(res, 200, store.monitors.map(m => monitorSummary(m, authed)));
    }
    if (method === 'POST') {
      if (needAuth() || needJson()) return;
      const body = await readBody(req);
      const { monitor, errors } = validateMonitor(body, newMonitor({}));
      if (errors.length) return send(res, 400, { error: errors.join('. ') });
      store.monitors.push(monitor);
      store.saveMonitors();
      scheduler.schedule(monitor, 100);
      return send(res, 201, monitorSummary(monitor, true));
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const match = p.match(/^\/api\/monitors\/([a-f0-9]+)(\/check)?$/);
  if (match) {
    const id = match[1];
    const idx = store.monitors.findIndex(m => m.id === id);
    if (idx === -1) return send(res, canView ? 404 : 401, { error: canView ? 'Monitor not found' : 'Login required' });
    const m = store.monitors[idx];

    if (match[2]) {
      if (method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (needAuth() || needJson()) return;
      await scheduler.run(id);
      return send(res, 200, monitorSummary(store.monitors.find(x => x.id === id) || m, true));
    }

    if (method === 'GET') {
      if (!canView) return send(res, 401, { error: 'Login required' });
      const h = store.history[id] || { raw: [], events: [] };
      return send(res, 200, {
        ...monitorSummary(m, authed),
        checks24h: downsample(h.raw.filter(c => c.t >= Date.now() - DAY), 288),
        daily: store.daily(id, 90),
        events: (h.events || []).slice(-30).reverse(),
      });
    }
    if (method === 'PUT') {
      if (needAuth() || needJson()) return;
      const body = await readBody(req);
      // Look the monitor up again: while the body was arriving, a peer sync or another request may
      // have changed, moved or deleted it, and the position found earlier could now be a different one.
      const at = store.monitors.findIndex(x => x.id === id);
      if (at === -1) return send(res, 404, { error: 'Monitor not found (it was deleted)' });
      const current = store.monitors[at];
      const { monitor, errors } = validateMonitor(body, current);
      if (errors.length) return send(res, 400, { error: errors.join('. ') });
      monitor.updatedAt = Date.now();
      const targetChanged = monitor.type !== current.type || monitor.target !== current.target || monitor.port !== current.port;
      const pausedNow = monitor.paused && !current.paused;
      store.monitors[at] = monitor;
      store.saveMonitors();
      if (targetChanged || pausedNow) scheduler.reset(id);
      scheduler.schedule(monitor, 200);
      return send(res, 200, monitorSummary(monitor, true));
    }
    if (method === 'DELETE') {
      if (needAuth()) return;
      if (m.autoHost) {
        store.settings.autoDismissed = [...new Set([...(store.settings.autoDismissed || []), m.autoHost])].slice(-500);
        store.saveSettings();
      }
      store.monitors.splice(idx, 1);
      scheduler.remove(id);
      store.deleteHistory(id);
      store.saveMonitors();
      store.tombstones[id] = Date.now();
      store.saveTombstones();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  // ---- infrastructure agents
  // Agents POST their report here every few minutes and get back approvals and tasks to act on.
  if (p === '/api/agent/report' && method === 'POST') {
    const name = infra.agentFrom(req);
    if (!name) return send(res, 401, { error: 'Invalid or missing agent token' });
    if (needJson()) return;
    const body = await readBody(req, 2 * 1024 * 1024);
    return send(res, 200, { ok: true, ...infra.receive(name, body) });
  }

  // Quick channel: the agent posts task progress and waits (up to 25 s) for new work, so requests from
  // the dashboard reach it within a second instead of at its next 5-minute report.
  if (p === '/api/agent/sync' && method === 'POST') {
    const name = infra.agentFrom(req);
    if (!name) return send(res, 401, { error: 'Invalid or missing agent token' });
    if (needJson()) return;
    const body = await readBody(req, 512 * 1024);
    infra.applyResults(name, body);
    const wait = Math.max(0, Math.min(25, Number(body.wait) || 0)) * 1000;
    let closed = false;
    req.on('close', () => { closed = true; });
    const out = await infra.waitFor(name, wait);
    if (closed) return;
    return send(res, 200, { ok: true, ...out });
  }

  // Everything else about the infrastructure is for signed-in admins only, even on a public dashboard:
  // it names hosts, containers and IPs, and lets you send the agents work.
  if (p === '/api/infra' && method === 'GET') {
    if (needAuth()) return;
    return send(res, 200, { agents: infra.summary(), services: infra.services(), core: infra.coreSummary(), chats: infra.chatList(), serverTime: Date.now() });
  }

  // ---- chats with the agents
  if (p === '/api/infra/chats' && method === 'POST') {
    if (needAuth() || needJson()) return;
    const body = await readBody(req, 16 * 1024);
    return send(res, 201, infra.createChat(String(body.scope || ''), body.title, user.email || user.name || 'admin'));
  }
  const cm = p.match(/^\/api\/infra\/chats\/([a-z0-9_-]{1,40})(\/rename)?$/i);
  if (cm) {
    if (needAuth()) return;
    if (method === 'DELETE' && !cm[2]) { infra.deleteChat(cm[1]); return send(res, 200, { ok: true }); }
    if (method === 'POST' && cm[2]) { if (needJson()) return; const body = await readBody(req, 16 * 1024); return send(res, 200, infra.renameChat(cm[1], body.title)); }
    return send(res, 405, { error: 'Method not allowed' });
  }
  const gm = p.match(/^\/api\/infra\/_all\/groups\/(g[a-f0-9]{10})$/);
  if (gm && method === 'DELETE') { if (needAuth()) return; infra.deleteGroup(gm[1]); return send(res, 200, { ok: true }); }
  const dm = p.match(/^\/api\/infra\/([A-Za-z0-9_-]{1,40})\/tasks\/([a-f0-9]{12})$/);
  if (dm && method === 'DELETE') { if (needAuth()) return; infra.deleteMessage(dm[1], dm[2]); return send(res, 200, { ok: true }); }

  const im = p.match(/^\/api\/infra\/([A-Za-z0-9_-]{1,40})\/(decision|tasks|actions)(?:\/([a-f0-9]{12})\/cancel)?$/);
  if (im) {
    if (method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (needAuth() || needJson()) return;
    const who = user.email || user.name || 'admin';
    const body = await readBody(req, 64 * 1024);
    if (im[2] === 'decision') {
      infra.decide(im[1], String(body.id || ''), String(body.decision || ''), who, Array.isArray(body.packages) ? body.packages.slice(0, 1000) : null);
      return send(res, 200, { ok: true });
    }
    if (im[3]) { infra.cancelTask(im[1], im[3]); return send(res, 200, { ok: true }); }
    if (im[2] === 'actions') return send(res, 201, infra.addAction(im[1], String(body.type || ''), body.vmid, who));
    if (!String(body.text || '').trim()) return send(res, 400, { error: 'Write a message first' });
    const chatId = body.chat ? String(body.chat).slice(0, 40) : null;
    if (im[1] === '_all') return send(res, 201, { tasks: infra.addGroupTask(body.text, who, chatId) });
    if (!infra.tokens.has(im[1])) return send(res, 404, { error: 'Unknown agent' });
    const chat = infra.chatFor(im[1], chatId, String(body.text || ''), who);
    return send(res, 201, infra.addTask(im[1], body.text, who, null, null, chat.id));
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!err.status) console.error('[http]', err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Internal server error' }, err.status === 413 ? { Connection: 'close' } : {});
  }
});

// ---------------------------------------------------------------- lifecycle

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT to a different value.`);
  else if (err.code === 'EACCES') console.error(`No permission to listen on port ${PORT}. Use a port above 1024.`);
  else console.error(err);
  process.exit(1);
});

// Longer than typical reverse-proxy idle timeouts (nginx, Cloudflare, load balancers), so a proxy
// reusing an idle connection doesn't hit one we just closed and answer 502.
server.keepAliveTimeout = 65e3;
server.headersTimeout = 66e3;

server.listen(PORT, HOST, () => {
  // Start monitoring only once the web server is up.
  selfTracker.start();
  scheduler.start();
  if (PEER_URLS.length) peerHub.start();
  infra.start();
  setInterval(() => store.saveHistory(), 30e3).unref();

  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Homelab Status v${VERSION} running at http://${shown}:${PORT}`);
  if (PUBLIC_URL) console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Monitoring ${store.monitors.length} target(s).`);
  console.log(infra.enabled ? `Infrastructure agents: ${[...infra.tokens.keys()].join(', ')}` : 'Infrastructure agents: none (set AGENT_TOKENS)');
  if (PEER_URLS.length) console.log(`Federated with ${PEER_URLS.length} peer server(s): ${PEER_URLS.join(', ')} (monitor sync ${SYNC_MONITORS ? 'on' : 'off - set PEER_TOKEN'})`);
  const m = auth.methods();
  if (m.google) {
    console.log(`Google sign-in: enabled for ${auth.google.admins.join(', ') || '(nobody - set ADMIN_EMAILS)'}`);
    console.log(`  Authorized redirect URI to register in Google Cloud: ${PUBLIC_URL || `http://localhost:${PORT}`}/api/auth/google/callback`);
  }
  console.log(`Password login: ${m.password ? 'enabled' : 'disabled'} (API bearer token still works)`);
  if (auth.generated) {
    console.log('');
    console.log('  An admin password / API token was generated for you:');
    console.log(`    ${auth.password}`);
    console.log(`  It is saved in ${auth.source}. Set ADMIN_PASSWORD to use your own.`);
    console.log('');
  } else {
    console.log(`Admin password source: ${auth.source}`);
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, saving data and shutting down...`);
  scheduler.stop();
  peerHub.stop();
  infra.stop();
  store.saveHistory(true);
  selfTracker.shutdown();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', err => console.error('[uncaught]', err));
process.on('unhandledRejection', err => console.error('[unhandled]', err));
