# Configuration

- [Environment variables](#environment-variables)
- [Monitor types](#monitor-types)
- [Monitor options](#monitor-options)
- [Status meanings](#status-meanings)
- [Notifications](#notifications)
- [Self-monitoring](#self-monitoring)
- [Peer servers (multi-server / federation)](#peer-servers-multi-server--federation)
- [Dashboard settings](#dashboard-settings)
- [Claude connector (MCP)](#claude-connector-mcp)
- [Data files and retention](#data-files-and-retention)

## Environment variables

Set them in your shell, in Docker/Compose, in `/etc/uptime-monitor.env` (systemd install), or in a `.env` file next to `server.js`. Real environment variables win over `.env`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind to. `127.0.0.1` = only reachable from the same machine (e.g. via a reverse proxy). |
| `CF_ACCESS_TEAM_DOMAIN` | | Your Cloudflare Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com`. Sign-in is Cloudflare Access: see [CLOUDFLARE_ACCESS.md](CLOUDFLARE_ACCESS.md). |
| `CF_ACCESS_AUD` | | The Access application's *Application Audience (AUD) Tag* (several, comma-separated). Without both variables nobody is signed in. |
| `ADMIN_EMAILS` | | Optional. Comma-separated emails (`@example.com` = a whole domain) that count as admins, checked on top of the Access policy. Empty = whoever Access lets in. |
| `ADMIN_PASSWORD` | *(generated)* | API token for scripts (`Authorization: Bearer ...`). When unset, the one in `DATA_DIR/admin-password.txt` is used; that file is created with a random token on first start. |
| `PUBLIC_URL` | | Public base URL (e.g. `https://status.example.com`). Required for the [Claude connector](#claude-connector-mcp) (OAuth issuer, `/mcp` address). |
| `MCP_ENABLED` | `true` | The Claude connector (`/mcp`, `/oauth/*`, `/.well-known/oauth-*`). `false` turns all of it off. |
| `MCP_REDIRECT_ALLOWLIST` | Claude's callbacks | Comma-separated OAuth redirect URIs clients may register. Default: `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`. |
| `DATA_DIR` | `./data` | Storage folder. Relative paths are relative to the app folder. Docker image default: `/data`. systemd install: `/var/lib/uptime-monitor`. |
| `SITE_TITLE` | `Uptime Monitor` | Site title used on first start. After that, change it in Settings. |
| `SERVER_NAME` | site title | Name other servers show for this one when you run several ([peer servers](#peer-servers-multi-server--federation)). After the first start, change it in Settings. |
| `PUBLIC_DASHBOARD` | `true` | Initial "public dashboard" setting used on first start (`false` = login required to see anything). After that, change it in Settings. |
| `NOTIFY_WEBHOOK_URL` | | One or more webhook URLs, comma-separated. Always used, in addition to the webhooks entered in Settings. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` headers. Enable only behind a reverse proxy. The client IP (used for login rate limits) is the last `X-Forwarded-For` entry, i.e. the one your proxy added. |
| `ALLOW_EMBED` | `false` | Allow embedding the dashboard in an iframe (removes `X-Frame-Options: DENY`). |
| `PEERS` | | Comma-separated base URLs of other Uptime Monitor instances to federate with. See [Peer servers](#peer-servers-multi-server--federation). |
| `PEER_TOKEN` | | Shared secret sent as `Authorization: Bearer <PEER_TOKEN>` between peers. Recommended whenever `PEERS` is set; use the same value on every server in the group. |

**Changing the API token:** set `ADMIN_PASSWORD` and restart, or edit `admin-password.txt` and restart.

## Monitor types

### Website (HTTP/HTTPS)

Requests the URL and checks the response.

- **Up** when the final status code (after redirects) is in *Accepted status codes* and, if set, the *keyword* check passes.
- Reports response time (whole request including redirects), HTTP status and, for HTTPS, **days until the TLS certificate expires** (highlighted under 30 and 14 days).
- If you type a URL without `http://` or `https://`, `https://` is added.
- Compressed responses (gzip, deflate, brotli) are decompressed before the keyword check.

### IP / host (ping)

Sends one ICMP echo request using the system `ping` command and reports round-trip time. Works with IPv4, IPv6 and hostnames. Useful for routers, switches, servers, Proxmox hosts, VMs, printers, etc.

Requires the `ping` command on the machine running the monitor (included in the Docker image and installed by `deploy/install.sh`). If the environment forbids ICMP (for example WebManager apps), the check falls back to TCP connects on ports 443/80/53; see [Troubleshooting](TROUBLESHOOTING.md#ping-checks-fail).

### TCP port

Opens a TCP connection to `host:port` and closes it again. You can type `192.168.1.10:22` in the target box; the port is filled in for you. Good for anything that listens on a port but has no web page: SSH (22), databases (3306, 5432), Minecraft (25565), SMB (445), RDP (3389), the Proxmox web UI (8006), DNS over TCP (53), etc.

## Monitor options

| Option | Default | Applies to | Description |
|---|---|---|---|
| Name | | all | Display name. |
| Target | | all | URL for websites; IP address or hostname for ping/TCP. |
| Port | | TCP | 1–65535. |
| Check every | 60 s | all | Interval between checks (10 s – 24 h). |
| Timeout | 10 s | all | How long to wait before a check fails (1–120 s). |
| Retries before "down" | 1 | all | Consecutive failures tolerated before the monitor is marked down and an alert is sent. `0` = alert on the first failure. With `1` and a 60 s interval, a site must fail twice in a row (about a minute) to be marked down. |
| Method | GET | HTTP | `GET` or `HEAD`. `HEAD` is lighter but ignores the keyword check. |
| Accepted status codes | `200-399` | HTTP | Comma-separated codes and ranges: `200`, `200-299`, `2xx`, `200-299,401`. |
| Keyword | | HTTP | Text that must appear in the response body (case-insensitive). |
| Keyword must be absent | off | HTTP | Invert: the check fails if the keyword **is** found (e.g. "maintenance"). |
| Follow redirects | on | HTTP | Follow up to 10 redirects. When off, a 301/302 is judged by *Accepted status codes*. |
| Ignore TLS/SSL errors | off | HTTP | Accept self-signed or expired certificates — handy for internal services like Proxmox (`https://192.168.1.10:8006`). |
| Paused | off | all | Stop checking without deleting history. |

## Status meanings

| Status | Meaning |
|---|---|
| 🟢 **Up** | Last check passed. |
| 🟠 **Pending** | Waiting for the first check, or failing but still within the allowed retries. |
| 🔴 **Down** | Failed more times in a row than *Retries* allows. An alert was sent. |
| ⚪ **Paused** | Not being checked. |

Uptime percentages count every individual check: `successful checks ÷ total checks`. The 90-day bars are rolling 24-hour windows ending now: green ≥ 99.9 %, amber ≥ 95 %, red below that, grey = no data.

## Notifications

Add webhook URLs in **Settings → Notification webhooks** (one per line) or with `NOTIFY_WEBHOOK_URL`. Use **Send test notification** to verify.

Alerts are sent when:

- a monitor goes **down** (after its retries),
- a monitor comes back **up** (includes how long it was down),
- an HTTPS certificate is about to expire (once each at 14, 7, 3 and 1 days left; resets when the certificate is renewed),
- the monitor server **restarts after an outage** (includes how long it was offline).

The format is chosen from the URL:

| Service | URL looks like | Sent as |
|---|---|---|
| Discord | `https://discord.com/api/webhooks/...` | `{"content": "..."}` |
| Slack | `https://hooks.slack.com/services/...` | `{"text": "..."}` |
| ntfy | `https://ntfy.sh/your-topic` (or your own ntfy server, URL containing `ntfy`) | plain text with Title / Priority / Tags headers |
| Anything else | any URL | JSON (below) |

Generic JSON payload:

```json
{
  "event": "monitor_down",
  "status": "down",
  "title": "🔴 NAS is DOWN",
  "text": "🔴 NAS is DOWN\nConnection refused",
  "monitor": { "id": "a1b2c3d4e5f6", "name": "NAS", "type": "tcp", "target": "192.168.1.20", "port": 445 },
  "message": "Connection refused",
  "time": "2026-09-25T03:54:55.852Z"
}
```

`event` is one of `monitor_down`, `monitor_up` (adds `downForMs`), `cert_expiring` (adds `cert`), `self_recovered` (adds `downForMs`), `test`. This works with Home Assistant webhooks, n8n, Node-RED, Gotify-style relays, etc.

## Self-monitoring

The **This server** card tracks the monitor's own availability:

- While running, it writes a heartbeat to `self.json` every **15 seconds**.
- On startup, if the last heartbeat is more than **45 seconds** old, the gap is recorded as an outage — whether the app was stopped, crashed, the machine rebooted, lost power, or the VM/container was paused. Quick restarts under 45 s are logged as "restart" but not counted as downtime.
- While running, if the process is frozen for more than 45 s (host suspended, VM paused), that gap is also recorded.
- Shown: current process uptime (live counter), start time, uptime % for 24 h/7 d/30 d/90 d, 90-day bars, restart and outage counts, and an event log. When logged in you also see host name, OS, Node version, host uptime, load and memory.

Because it can't alert while it is itself down, see [Monitoring the monitor](DEPLOYMENT.md#monitoring-the-monitor) for instant alerts.

## Peer servers (multi-server / federation)

Run Uptime Monitor on more than one machine and have every instance show all of them on one dashboard, each with its own uptime record. There's no central server and no single point of failure: every instance independently polls the others, so any one instance's dashboard shows the whole group even if some of the others are down.

**Setup**, on each server:

```ini
PEERS=https://status-eu.example.com,https://status-us.example.com   # the *other* servers, not itself
PEER_TOKEN=some-long-shared-secret                                   # same value on every server
```

- `PEERS` is the list of the *other* servers in the group (each one lists everyone else). Don't include a server's own address.
- `PEER_TOKEN` is a shared secret, the same on every server, sent as `Authorization: Bearer <PEER_TOKEN>`. Without it, `/api/peer-status` (what peers poll) is public and unauthenticated — it never exposes monitors or targets, only this server's own uptime numbers, but setting a token is still recommended.

Each instance polls every URL in `PEERS` every 20 seconds and shows the result in an **Other servers** panel: online/unreachable, uptime % (24h/7d/30d/90d) and 90-day bars, using the peer's own self-reported uptime record when it's reachable, and the last one it reported plus "last seen" when it isn't.

### Monitor sync

With `PEER_TOKEN` set on every server, the **monitor list is synced both ways** as well:

- Add, edit, pause or delete a monitor on any server and the others pick it up within about 20 seconds. The newest edit wins, so keep the servers' clocks accurate (NTP). Deletions are remembered for 90 days so a deleted monitor doesn't come back.
- Each server runs the checks itself and keeps its own history, so you see each monitor from every server's location. Check results are not shared.
- A monitor with the same type, target and port on two servers is treated as one monitor, and the two servers settle on the same id (history is kept).
- A new server with sync on starts empty instead of creating the three example monitors, and receives the group's monitors from its peers.
- Every server that checks a monitor sends its own alerts, so a monitor going down notifies once per server.
- Settings, webhooks and admin logins are **not** synced; each server keeps its own.

Without `PEER_TOKEN`, servers only exchange uptime and monitors are never shared (monitor targets are only sent to servers that present the token). The list travels between servers on every poll, so use `https://` peer URLs or a trusted network.

## Dashboard settings

In **Settings** (admin only):

- **Site title**
- **Public dashboard** — when off, visitors must log in to see anything. `/api/health` always stays public.
- **Show URLs / IP addresses to public visitors** — off by default, so a public status page doesn't reveal your internal IPs. Logged-in admins always see them.
- **Export / Import monitors** — JSON file with your monitor definitions (not history). Import adds to the existing list.

## Claude connector (MCP)

Claude can read everything the dashboard shows through a **read-only** MCP server at `$PUBLIC_URL/mcp`
(Streamable HTTP, stateless, JSON responses). In Claude: **Settings → Connectors → Add custom connector**, URL
`https://<your-domain>/mcp`. Claude registers itself, sends you to the **Approve / Deny** page (behind Cloudflare
Access, naming the client and the host it returns to), and connects.

**Needs:** `PUBLIC_URL`, Cloudflare Access with the bypasses in [CLOUDFLARE_ACCESS.md](CLOUDFLARE_ACCESS.md#2-let-the-machines-through-bypass)
(`/mcp`, `/oauth/token`, `/oauth/register`, `/.well-known/`; **not** `/oauth/authorize`), and the npm dependency
installed (`npm ci --omit=dev`; um-update does it, it needs `npm` on the container). Cloudflare's **Block AI Bots**
and **Bot Fight Mode** block Claude's connector: turn them off for the zone, or add IP Access rules allowing
Anthropic's outbound ranges **160.79.104.0/21** and **153.61.208.0/20**.

**What it can see** (14 tools, all `readOnlyHint`): `get_overview` (the Overview's needs-attention list and counts,
version, HA role), `list_monitors`, `get_monitor`, `list_agents`, `list_containers`, `list_approvals`,
`list_update_runs`, `get_update_run`, `get_backups`, `list_events`, `get_agent_logs`, `get_claude_usage`,
`list_services`, `get_ha_status`. Details in [API.md](API.md#claude-connector-mcp). There are no write tools: it
can't approve, update, restart or ask the agents anything.

**What it never sees:** agent tokens, `ADMIN_PASSWORD`, `PEER_TOKEN`, webhook URLs, sign-in or OAuth data, and the
content of your chats and tasks with the agents (usage rows of chat questions are labelled "chat message", and the
agent log line that quotes a chat question is cut).

**Auth:** OAuth 2.1 run by this app: dynamic client registration, authorization code with PKCE (S256 only),
redirect URIs limited to `MCP_REDIRECT_ALLOWLIST`. Access tokens last 1 hour, refresh tokens 30 days and rotate on
every use; the previous refresh token keeps working for 2 minutes, so a failover right after a refresh doesn't
disconnect Claude. Only SHA-256 hashes are stored, in `oauth.json`, which um-ha copies to the replica like the other
files. Cloudflare Access cookies and `ADMIN_PASSWORD` are **not** accepted on `/mcp`.

**Limits and logs:** 60 calls per minute per client; lists return 50 items by default (at most 200) with `offset`
paging. Every tool call is logged as `[mcp] <tool> by <client> (<email>) <ms> ms`, never with arguments or results.

**Disconnect:** Settings → **Connected clients** → Revoke. That kills its tokens at once; Claude has to be
connected again. Removing an email from `ADMIN_EMAILS` also cuts its connector off. Removing someone from the
Access policy does **not** (the connector doesn't go through Access): revoke it here too.

## Data files and retention

| File | Contents | Written |
|---|---|---|
| `monitors.json` | monitor definitions | on change |
| `settings.json` | dashboard settings, webhooks | on change |
| `history.json` | check results and events | every 30 s and on shutdown |
| `self.json` | heartbeat, outages, server events | every 15 s |
| `oauth.json` | Claude connector: registered clients, grants, SHA-256 hashes of codes and tokens | on connect, refresh, revoke |
| `admin-password.txt` | generated API token | first start |

Retention: individual check results are kept for **24 hours**; hourly summaries for **90 days**; the last 100 status events per monitor. A monitor checked every 60 s uses roughly 200 KB of history (every 20 s, the default since 2.14: about 600 KB). Files are written atomically (temp file + rename), so a crash mid-write won't corrupt them. If a file is unreadable on startup it is renamed to `*.corrupt-<timestamp>` and a fresh one is started.

You can edit `monitors.json` by hand while the app is stopped.
