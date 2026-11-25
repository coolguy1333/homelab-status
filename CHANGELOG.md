# Changelog

## 2.6.0

- Agent 1.8: snapshot cleanup, about every 30 minutes. Only the agents' own snapshots are deleted:
  - `hlauto…` (before updates): keep the newest 2 per container; older ones go.
  - `hlfix…` (an agent's snapshot before a fix; older ones named `hlmanual…`): deleted after 7 days.
  - `hlmanual…` from the dashboard's Snapshot button: deleted after 30 days.
  - Snapshots with any other name (the ones you make yourself) are never touched.
  Nothing is deleted while an update is running, and every deletion shows up in Activity.

## 2.5.2

- Agent 1.7.1 (fixes first found by the connector1 agent):
  - After an update, ports bound only to the container itself, and random ports in the ephemeral range
    (32768–60999), no longer count as "lost". This was a false rollback on WebManager (containerd's internal port).
  - An approved retry that gets rolled back again keeps its new "Retry updates" approval. It used to be deleted,
    leaving the container blocked with no way to retry.
  - Agents don't edit their own automation any more. Fixes come back as a hand-off plan, because the code is
    deployed from this repository.

## 2.5.1

- Agent 1.7: both agents can work on the backup server (PBS) over SSH: read everything, and change it only when
  asked. Deleting backups, datastores, retention settings or disks needs an explicit request.

## 2.5.0

- Smooth refreshes: the page is patched in place instead of being redrawn every 10 seconds. Scroll positions,
  text you're selecting, open sections, focus, and half-typed messages all survive a refresh, and nothing flickers.
- Container search filters as you type without losing focus.
- Fixed page spacing: sections were pressed together because the page wrappers had no gaps.
- Phones and small screens: tables drop less important columns instead of running off the screen, the header
  stays on one line, filter buttons scroll, and lists wrap properly.
- Backup-server jobs show as compact rows (state on the right, details underneath).
- Agent 1.6.1: health checks after an update only count real services, so a timer that briefly shows "failed"
  during an upgrade no longer causes a rollback. Host status reads ignore warning lines on stderr.

## 2.4.1

- When a container is deleted, its internal-service history leaves the dashboard right away instead of
  lingering for 7 days.

## 2.4.0

- Chats: each agent and the Datacenter box have their own list of conversations. "+ New chat" starts one,
  and it is titled from its first message (you can rename it). Follow-ups continue the same Claude session
  on the agent, so it remembers the conversation.
- Delete a single message (and its answer), or a whole chat.
- Messages from before chats existed move into an "Earlier messages" chat.

## 2.3.0

- Approve only part of an update: tick individual packages, or use the "Security only", "All" and "None"
  shortcuts. Works for host updates and held-back container updates. The agent installs exactly the packages
  selected.
- Hand-off plans: when an agent can't fix something, or isn't allowed to, its answer ends with a
  "Plan for Claude Code" box and a Copy button.
- Claude usage on the Ask page: tokens, runs, and the API-price equivalent for today, 7 days, and 30 days,
  a 30-day chart, recent runs, and the cost of each answer.
- Backup server details from a read-only PBS API token, with the certificate pinned by fingerprint: CPU, memory,
  system disk, garbage collection, verify, prune and sync jobs, and failed PBS tasks.
- Agents log an event when a container is removed from, or added to, a host.

## 2.2.0

- Requests reach the agents instantly. They keep a connection open (`/api/agent/sync`) instead of checking every
  5 minutes, and progress and answers show up as soon as they're ready.
- Agent answers render as Markdown: headings, lists, tables, code.
- The backup server (PBS) appears as a server on the Overview and Backups pages: datastore usage, backup count,
  verification rate, newest and oldest backup, reachability.
- Every container has "Check for updates" and "Update now" buttons, on the Containers and Updates pages.
- The agents also ping each container's IP address as an internal uptime check.

## 2.1.0 — Homelab Status

- New layout: sidebar with Overview, Containers, Updates, Backups, Uptime, Ask agents, and Activity.
- Overview: a "needs attention" list, key numbers, a card per Proxmox host, and recent activity.
- Containers: every LXC on both hosts with CPU, memory, disk, services, updates, and last backup. Click a row
  for details and one-click actions: start, shut down, reboot, snapshot, back up now, update now.
- Updates: approvals, the nightly schedule and run history, "run now", and per-container update status.
- Backups: Proxmox backup jobs, the last backup per container (age, size, PBS verification), and failed runs.
- Uptime: tunnel hostnames and WebManager sites become monitors automatically. Internal services found in
  containers are checked on the LAN by the agents.
- Ask agents: one agent at a time, or the Datacenter box that sends one message to every agent.
- Alerts (webhooks) for agents going offline, services going down or recovering, failed backups, rollbacks,
  and new approvals.

## 1.2.0

### Added
- **Multiple servers.** Point servers at each other with `PEERS` (and a shared `PEER_TOKEN`) and every dashboard shows an **Other servers** panel with each server's status and uptime. Give each server a name with `SERVER_NAME` or in Settings. See `docs/CONFIGURATION.md#peer-servers-multi-server--federation`.
- **Monitor sync.** With the same `PEER_TOKEN` on every server, monitors you add, edit, pause or delete on one server appear on all of them. Each server still runs its own checks and keeps its own history.
- Ping monitors fall back to TCP checks (ports 443, 80, 53) when ICMP isn't available, for example inside WebManager or a container without `NET_RAW`, or when the `ping` program isn't installed.
- `webmanager.json`, so the app deploys as an app in WebManager.
- The top banner also reports servers that are unreachable, and the monitor and settings screens explain what is synced and what the fields do.
- Clear messages when a peer can't be reached: wrong token, wrong address, redirect, refused, not responding.
- Ping "Status" is now a short label, with the full last-check message on its own line.

### Fixed
- Behind a reverse proxy, login rate limits could be bypassed by sending a fake `X-Forwarded-For` header. Wrong guesses of the admin password and of the API token now share one budget of 10 per minute per address, successful logins are never counted, and Google sign-in has its own limit.
- The admin password and API token could be guessed without limit through the `Authorization` header.
- `/api/peer-status` requests were counted as failed admin logins.
- Editing a monitor while a peer sync or another request changed the list could overwrite the wrong monitor.
- Imports larger than 100 KB failed with a dropped connection; the limit is now 2 MB and oversized requests get a proper error.
- Peer data is validated before it reaches the dashboard, peer responses are size-limited, and a peer with a wrong clock can no longer win every conflict or delete monitors.
- A poll timer leaked on every peer poll.
- Peer addresses were shown to public visitors even with "Show URLs / IP addresses to public visitors" off.
- `/api/logout` skipped the JSON content-type check.
- Data files that parse but have the wrong shape (for example `null`) no longer crash startup; history left by deleted monitors is cleaned up.
- The CDN in front of WebManager cached the page's script for 4 hours, so updates didn't show. The page now loads them under a versioned address.
- `/api/status` is computed at most every 2 seconds, so a busy public dashboard is cheap to serve.
- Idle keep-alive connections no longer end just before a reverse proxy reuses them.

## 1.1.0

### Added
- **Sign in with Google** (OAuth 2.0 / OpenID Connect with PKCE). Only accounts in `ADMIN_EMAILS` can sign in; `@domain.com` entries allow a whole Google Workspace domain. See `docs/GOOGLE_SIGNIN.md`.
- New settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `PUBLIC_URL`, `PASSWORD_LOGIN`, `ALLOW_EMBED`.
- Sessions survive restarts (hashed tokens in `sessions.json`). Sessions of removed admins are revoked at startup.
- The signed-in user is shown in the header, and Settings shows how sign-in is set up.
- TLS certificate expiry alerts at 14, 7, 3 and 1 days left.
- `GET /api/monitors` lists all monitors.
- TCP targets accept `host:port`, `[ipv6]:port` or a URL; ping targets accept a URL. The host (and port) are pulled out automatically.

### Fixed
- Keyword checks failed on gzip, deflate and brotli responses (the body is now decompressed).
- ntfy notifications failed, because emoji in the `Title` header aren't allowed in HTTP headers.
- Ping response times weren't read on non-English Windows (e.g. `Zeit=12ms`).
- Today's bar in the 90-day history was empty during the first half of each hour.
- On phones, the page scrolled sideways because the 90-day bars were too wide.
- A relative `DATA_DIR` depended on the folder the app was started from; it now always means the app folder.
- `.env` was loaded after some settings had already been read. It also now handles `export`, inline comments and a UTF-8 BOM.
- Clicking **Check now** while a check was already running returned stale data; it now waits for that check.
- Manually checking a paused monitor could send down/up alerts.
- Pausing a monitor, or changing its target, kept the old up/down state, cert info and "down since" time.
- Deep links like `/foo/bar` loaded a broken page; they now return 404.
- Sending `null`, strings or arrays as JSON bodies caused 500 errors.
- `"false"` strings were treated as `true` for boolean fields in the API.
- `ftp://…` targets were silently turned into `https://ftp://…`.
- Invalid accepted-status lists such as `200-,` were accepted.
- The installer stopped when `apt-get update` hit an unrelated broken repository.
- Closing the console window on Windows (`SIGHUP`/`SIGBREAK`) didn't save history.
- Stale static files could be cached for 5 minutes after an update.
- The login rate-limit table was never cleaned up.
- An older `self.json` without some fields could crash startup.

## 1.0.0
- First release.
