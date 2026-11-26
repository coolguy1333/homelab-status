# API

Everything the dashboard does goes through a small JSON API, so you can script it too.

## Authentication

Admin endpoints accept either:

- a Cloudflare Access sign-in: the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie) that Access adds to every request it lets through (what the browser uses; see [CLOUDFLARE_ACCESS.md](CLOUDFLARE_ACCESS.md)), or
- an `Authorization: Bearer <ADMIN_PASSWORD>` header (handy for scripts).

The site has no login or logout endpoints: Cloudflare Access does that (`/cdn-cgi/access/logout`).

Requests that change data must send `Content-Type: application/json` (this also protects against cross-site request forgery).

Read endpoints (`/api/status`, `GET /api/monitors/:id`) are public when *Public dashboard* is on; otherwise they need auth. Targets (URLs/IPs) are only included for admins, or when *Show URLs / IP addresses to public visitors* is on.

`/api/peer-status` uses a separate `Authorization: Bearer <PEER_TOKEN>` (not the admin password) — see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | Liveness check. Always public. |
| GET | `/api/peer-status` | peer token | What a federated peer polls (see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation)): this server's own name, version and self-uptime. Public if `PEER_TOKEN` is unset, otherwise needs `Authorization: Bearer <PEER_TOKEN>` and also returns `monitors` and `deleted` (used for monitor sync). |
| GET | `/api/status` | view | Everything the dashboard shows: self uptime, counts, all monitors, peers. |
| GET | `/api/monitors` | view | All monitors (same objects as in `/api/status`). |
| GET | `/api/monitors/:id` | view | One monitor with 24 h response-time series, 90 daily buckets and recent events. |
| POST | `/api/monitors` | admin | Create a monitor. |
| PUT | `/api/monitors/:id` | admin | Update a monitor (send only the fields to change). |
| DELETE | `/api/monitors/:id` | admin | Delete a monitor and its history. |
| POST | `/api/monitors/:id/check` | admin | Run a check now; returns the updated monitor. |
| GET | `/api/settings` | admin | Current settings. |
| PUT | `/api/settings` | admin | Update `title`, `webhooks` (array or newline-separated string), `publicDashboard`, `publicShowTargets`. |
| POST | `/api/settings/test-notification` | admin | Send a test message to all webhooks. |
| GET | `/api/oauth/clients` | admin | Claude connector: `{ enabled, url, reason, clients: [{ id, name, redirectHost, accounts, connectedAt, lastUsedAt }] }`. |
| DELETE | `/api/oauth/clients/:id` | admin | Revoke a connected client (all its tokens stop working). |
| GET | `/api/export` | admin | Download monitors and settings as JSON. |
| POST | `/api/import` | admin | `{"monitors": [...]}` — adds monitors (same fields as create). |
| GET | `/api/infra` | admin | Agents (reports, tasks, decisions, nightly `policy`, live update `progress`), internal services and chats. |
| POST | `/api/infra/:agent/actions` | admin | `{"type", "vmid"}`. Container types: `start`, `shutdown`, `reboot`, `snapshot`, `backup`, `check`, `update`, `update-security`. Host types (no `vmid`): `update-all`, `update-all-security`, `check-updates`. |
| GET | `/api/infra/:agent/logs` | admin | The newest lines (up to 1000) of that agent's `~/agent/logs/agent.log`: `{ "lines": [{ "t", "p" (process), "l" (info/warn/error), "m" }] }` (agent 1.9+). |
| GET | `/api/infra/:agent/events` | admin | The agent's event history kept by the dashboard (what Activity shows): up to 3000 events, 30 days. |
| GET | `/api/infra/:agent/runs/:id` | admin | One update run's full log (`/api/infra` lists the runs under each agent's `runs`). |
| POST | `/api/infra/:agent/policy` | admin | `{"securityOnly": true}` makes that host's nightly run install security updates only (agent 1.9+). |
| POST | `/api/infra/:agent/decision` | admin | `{"id", "decision": "approve" \| "deny", "packages"?: [...]}` for an item waiting for approval. |
| POST | `/api/infra/:agent/tasks` | admin | `{"text", "chat"?}` asks one agent (`:agent` = `_all` asks every agent). |
| POST | `/api/infra/:agent/tasks/:id/cancel` | admin | Cancel a message the agent has not picked up yet. |
| DELETE | `/api/infra/:agent/tasks/:id` | admin | Delete a message and its answer (`/api/infra/_all/groups/:group` for a datacenter message). |
| POST / DELETE | `/api/infra/chats`, `/api/infra/chats/:id`, `/api/infra/chats/:id/rename` | admin | Create (`{"scope", "title"?}`), delete and rename (`{"title"}`) chats. |
| POST | `/api/agent/report`, `/api/agent/sync` | agent token | Used by the agents (report every 5 min; quick sync / long-poll for new work and live progress). |

## Monitor fields

```json
{
  "name": "Proxmox UI",
  "type": "http",               // "http" | "ping" | "tcp"
  "target": "https://192.168.1.10:8006",
  "port": null,                 // required for tcp
  "interval": 60,               // seconds, 10–86400
  "timeout": 10,                // seconds, 1–120
  "retries": 1,                 // 0–10
  "method": "GET",              // http: GET | HEAD
  "acceptedStatus": "200-399",  // http
  "keyword": "",                // http
  "invertKeyword": false,       // http
  "followRedirects": true,      // http
  "ignoreTls": true,            // http
  "paused": false
}
```

Validation errors return `400 {"error": "..."}`.

## Examples

```bash
PW='your-admin-password'
URL=http://localhost:3000

# health
curl -s $URL/api/health

# add a ping monitor
curl -s -X POST $URL/api/monitors \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"name":"Router","type":"ping","target":"192.168.1.1","interval":30}'

# add a TCP monitor
curl -s -X POST $URL/api/monitors \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"name":"SSH on server","type":"tcp","target":"192.168.1.10","port":22}'

# pause a monitor
curl -s -X PUT $URL/api/monitors/<id> \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"paused":true}'

# list names and statuses (needs jq)
curl -s $URL/api/status | jq -r '.monitors[] | "\(.status)\t\(.name)"'
```

## `/api/status` response (abridged)

```json
{
  "title": "Uptime Monitor",
  "authed": false,
  "user": null,
  "auth": { "cloudflare": true, "team": "https://yourteam.cloudflareaccess.com" },
  "version": "1.0.0",
  "counts": { "up": 4, "down": 1, "pending": 0, "paused": 0 },
  "self": {
    "status": "up",
    "startedAt": 1790308523589,
    "processUptime": 86400,
    "uptime": { "24h": 100, "7d": 99.93, "30d": 99.98, "90d": 99.99 },
    "restarts": 3,
    "lastDowntime": { "start": 1790200000000, "end": 1790200300000, "reason": "Stopped" },
    "daily": [{ "t": 1782532523589, "pct": 100 }, "..."],
    "events": [{ "t": 1790308523589, "status": "up", "msg": "Started again" }]
  },
  "monitors": [
    {
      "id": "a1b2c3d4e5f6",
      "name": "Website",
      "type": "http",
      "status": "up",
      "last": { "t": 1790308523589, "ok": true, "ms": 84.2, "msg": "HTTP 200" },
      "avgMs24h": 91.3,
      "uptime": { "24h": 100, "7d": 99.9, "30d": 99.95, "90d": null },
      "recent": [{ "t": 1790308523589, "ok": true, "ms": 84.2, "msg": "HTTP 200" }],
      "cert": { "validTo": "2026-12-01T00:00:00.000Z", "daysLeft": 67, "issuer": "Let's Encrypt" }
    }
  ],
  "peers": [
    {
      "url": "https://status-eu.example.com",
      "name": "EU",
      "reachable": true,
      "error": null,
      "checkedAt": 1790308523589,
      "version": "1.2.0",
      "self": { "status": "up", "uptime": { "24h": 100, "7d": 99.97, "30d": 100, "90d": 100 }, "...": "same shape as the top-level self" },
      "observedUptime": { "24h": 100, "7d": 100, "30d": 99.9, "90d": null }
    }
  ]
}
```

Times are Unix milliseconds. Uptime values are percentages, or `null` when there is no data for that window. `peers` is only present when `PEERS` is configured (see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation)); `self` inside a peer entry is that peer's own last-reported self-uptime (kept even if `reachable` is currently `false`; only `uptime`, `daily`, `processUptime`, `restarts` and `downtimeCount30d` are kept, as plain numbers), and `observedUptime` is that peer's uptime as seen from this server's own polling. Like monitor targets, `url` is only included for admins or when *Show URLs / IP addresses to public visitors* is on; otherwise unnamed peers appear as "Server 1", "Server 2", ….

## Claude connector (MCP)

Read-only MCP server for Claude (see [Configuration](CONFIGURATION.md#claude-connector-mcp)). These endpoints are
off when `MCP_ENABLED=false` or `PUBLIC_URL` is unset.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/.well-known/oauth-protected-resource` (also `/mcp` suffix) | — | `{ resource: "$PUBLIC_URL/mcp", authorization_servers: ["$PUBLIC_URL"], ... }` |
| GET | `/.well-known/oauth-authorization-server` | — | Issuer `$PUBLIC_URL`, `code_challenge_methods_supported: ["S256"]`, grants `authorization_code` + `refresh_token`, `token_endpoint_auth_methods_supported: ["none"]`, scopes `read`, `offline_access`. |
| POST | `/oauth/register` | — | Dynamic client registration (JSON). `redirect_uris` must be in `MCP_REDIRECT_ALLOWLIST`; returns `201` with `client_id`. |
| GET | `/oauth/authorize` | Cloudflare Access | Authorization code + PKCE (S256 required). Shows the Approve / Deny page; then redirects to `redirect_uri` with `code`, `state`, `iss`. |
| POST | `/oauth/token` | — | `application/x-www-form-urlencoded`. `grant_type=authorization_code` (`code`, `redirect_uri`, `client_id`, `code_verifier`) or `refresh_token` (`refresh_token`, `client_id`). Errors: `401 invalid_client` (unknown client), `400 invalid_grant` (bad, expired or reused code/refresh token). |
| POST | `/mcp` | OAuth access token | MCP Streamable HTTP, stateless, JSON responses. Without a valid token: `401` with `WWW-Authenticate: Bearer resource_metadata="$PUBLIC_URL/.well-known/oauth-protected-resource"`. `GET`/`DELETE` answer `405`. 60 calls/minute per client (`429`). |

Tools (arguments in brackets are optional; lists take `limit` (default 50, max 200) and `offset`, and answer
`{ total, offset, items, next_offset? }`). Times are ISO 8601, percentages numbers 0–100.

| Tool | Arguments | Returns |
|---|---|---|
| `get_overview` | — | `needs_attention` [{level, area, text}] (the Overview logic), `counts` {monitors_up, monitors_down, agents_online, agents_total, containers_stopped, approvals_waiting, backup_problems}, `version`, `ha_role` |
| `list_monitors` | [status: up\|down\|paused] | id, name, type, status, uptime_24h, uptime_30d, last_check_at, response_ms, target |
| `get_monitor` | id | the above + `last_24h` (≤ 48 points {t, up_pct, avg_ms}) + last 20 `events` |
| `list_agents` | — | name, online, last_report_at, agent_version, host {name, cpu_pct, mem_pct, storage [{name, used_pct}]} |
| `list_containers` | [agent], [status: running\|stopped] | agent, vmid, name, status, cpu_pct, mem_pct, disk_pct, updates {total, security}, last_backup_at, failed_services (internal service checks of that container that are down) |
| `list_approvals` | [agent] | id, agent, kind, title, packages (≤ 50 {name, from, to}; `packages_total` when cut), since |
| `list_update_runs` | agent, [limit ≤ 40] | id, title, mode, started_at, finished_at, result (ok\|warnings\|problems), containers {done, total}, outcome {installed, held, rolled_back, failed} |
| `get_update_run` | agent, id, [log_lines: 100, ≤ 200] | the above + summary, containers_outcome [{vmid, name, outcome, detail}], log tail |
| `get_backups` | [agent] | jobs {id, schedule, storage, enabled}, last_backups per container {vmid, at, size, verified}, failed_runs, stale_backups (missing or > 26 h), unreachable_storage |
| `list_events` | [agent], [level], [since] | t, agent, level, message (newest first) |
| `get_agent_logs` | agent, [level], [limit: 100, ≤ 200] | lines {t, process, level, message} (oldest first) |
| `get_claude_usage` | [agent] | today / week / month {runs, input, output, cache_read, cache_write, cost} + last 15 runs {t, agent, kind, label, tokens, cost} |
| `list_services` | [agent], [status: up\|down\|stale] | agent, container, vmid, ip, port, check, process, status, since, uptime_24h, last_check_at, response_ms |
| `get_ha_status` | — | role, epoch, last_sync_at, peer_reachable, peer_healthy (all `null` without um-ha) |
