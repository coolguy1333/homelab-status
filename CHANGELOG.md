# Changelog

## 2.18.2

Datacenter chats show nothing but a progress line until the one combined answer is there.

- **While waiting** ("GOD answered · waiting for HELP") **and while combining** ("Combining the answers…"), the
  dashboard no longer offers each host's answer under "Each host's answer". It appears only folded under the finished
  combined answer. The token/cost line also waits for that answer.
- Unchanged fallbacks: if a host is offline, or no agent can combine, or combining fails, the answers that arrived are
  shown per host as before.

## 2.18.1

The agents' Claude no longer loads the account's claude.ai connectors (agent 1.16.1).

- **What was happening:** the Claude account on the connectors has the owner's claude.ai connectors (Gmail, Google
  Drive, Docs, Sheets, Slides, Calendar, ClickUp, Spotify, Cloudflare, Daily Hub, the status site) and plugin MCP
  servers. Every agent run loaded all of them. A one-word prompt cost about $1.12 at API prices instead of about $0.04,
  and a chat answer could in principle read or send the owner's mail.
- **Now:** every Claude run from `hl_agent.py` passes `--strict-mcp-config` (no `--mcp-config`), so it has no MCP
  servers. That covers chat answers and follow-ups, auto-fixes, update risk reviews and Datacenter merges. Built-in
  tools (Bash, Read, Edit, ...) are unchanged. The agent's `CLAUDE.md` says so. Config `"claude_mcp": true` in
  `~/agent/config.json` turns the connectors back on.
- Claude Remote Control sessions (`claude-agent` unit) are not changed.
- Tests: `test/agent/test_claude_args.py` checks the command line for a chat, a resumed chat, a review, a merge
  (`--tools ""`, one `--strict-mcp-config`), and `claude_mcp: true`.

## 2.18.0

Datacenter chats get ONE answer (agent 1.16.0).

- **One answer:** a Datacenter message still goes to every host's agent, and each answers for its own host. Once
  they have all answered, the dashboard gives the parts to one agent (1.16+, online, preferably one that answered),
  and its Claude writes a single reply from them. It runs with no tools and no MCP servers, so it only rewrites what
  the hosts said (about $0.04 a merge at API prices). Problems, changes, snapshots and handoff plans are kept; a host
  that failed gets one line. Nothing is merged when only one host had something to say (the other said "not mine").
- **Dashboard:** shows that one reply, with each host's own answer folded away under "Each host's answer". While a
  host is still working it shows one "GOD answered · waiting for HELP" line instead of half an answer, then
  "Combining the answers…". The chat list preview no longer shows one host's part as the answer. If no agent can
  merge (offline or older than 1.16) or the merge fails, it falls back to the per-host answers as before.
- **Composer hint:** says "every message is answered by Claude" when the agents have `"quick_answers": false`
  (reported as `quickAnswers`), instead of promising free script answers.
- Merge tasks don't count as chat messages and carry no chat id, so they never resume a host's Claude session.
- Tests: merge task created only after every host answered, to one agent with both parts; none with a notMine host;
  a failed part is merged; an older or offline agent never gets one. Agent: the prompt carries the question (without
  `/ai`) and every part; a merge task skips the scripts and runs Claude with `tools=""`; a failed merge is failed.

## 2.17.0

Only named admins can send work to the agents or change the servers. **Set `ADMIN_EMAILS` before updating**, or
the dashboard becomes view-only for everyone.

- **The problem:** every control route only checked that someone was signed in. With `ADMIN_EMAILS` empty (it was
  optional), that was anyone Cloudflare Access let in, plus anyone holding the `ADMIN_PASSWORD` token. Any of them
  could send agent tasks that run as root on the Proxmox hosts over SSH, approve updates and reboots, start, stop
  or snapshot containers, and install versions on the status servers.
- **Viewing vs controlling:** `Auth.canControl(user)` is true only for a Cloudflare Access user whose email is in
  `ADMIN_EMAILS` (an exact address or an `@domain` entry, matched like `isAllowedEmail`). With `ADMIN_EMAILS` empty
  nobody can control. Viewing works as before.
- **API token:** `ADMIN_PASSWORD` is now read-only for these routes. `CONTROL_API_TOKEN=1` (off by default) lets it
  control too, for scripts, and the startup log warns while it is on. The token can still manage monitors.
- **Routes that now need control** (`needControl()` in `server.js`: 401 when not signed in, otherwise 403
  "Only the emails in ADMIN_EMAILS can do this. Set ADMIN_EMAILS on the server.", or a token-specific message):
  - `POST /api/infra/:agent/tasks` (including `_all`), `/decision`, `/actions`, `/policy`, and `/tasks/:id/cancel`
  - `POST /api/infra/chats`, `POST /api/infra/chats/:id/rename`, `DELETE /api/infra/chats/:id`
  - `DELETE /api/infra/:agent/tasks/:id`, `DELETE /api/infra/_all/groups/:id`
  - `POST /api/servers/control` (check, install, auto-install on/off, sync now)
  - `PUT /api/settings`, `POST /api/settings/test-notification`, `DELETE /api/oauth/clients/:id`
  - `POST /api/import`
- **Reviewed and left as they were:**
  - Monitor create, edit, delete and "check now" still only need a sign-in.
  - All GET routes are read-only.
  - `/api/agent/*` takes agent tokens, and `/api/peer-status` takes the peer token.
  - In `lib/connector.js`: `/oauth/register` and `/oauth/token` are the OAuth protocol itself (registering only
    creates an unapproved client). Approving on `/oauth/authorize` still needs only an Access sign-in, because it
    grants read-only access to what that person can already see. `/mcp` has only read-only tools.
- **`/api/status`** answers `canControl`. When it is false, the dashboard hides the control buttons and shows one
  line saying why. The buttons it hides:
  - sending agents messages, plus retry, cancel, delete, rename and new chat
  - approve/deny, the package picker and the nightly policy
  - container and host actions, and "Ask about"
  - server check/install
  - settings Save, test notification, import, and revoking a client
- **Startup log:** warns when Cloudflare Access is set up but `ADMIN_EMAILS` is empty ("Nobody can send agents work
  until ADMIN_EMAILS is set."), and says whether the API token can control.
- **Docs:** README, `docs/CONFIGURATION.md` (new "Viewing and controlling" section), `docs/CLOUDFLARE_ACCESS.md`, and
  `docs/API.md` (an "admin" vs "control" column).
- **Tests** (`test/control.test.js`) run the real server with a test key pair signing the Access JWTs:
  - Every route above gives 403 to a signed-in user when `ADMIN_EMAILS` is empty, and 401 to an email outside a
    set `ADMIN_EMAILS` (that was never a sign-in).
  - Listed emails and `@domain` entries get through.
  - The token gets 403 unless `CONTROL_API_TOKEN=1`.
  - With `ADMIN_EMAILS` empty, `GET /api/infra` and `GET /api/settings` still work and nothing is queued.
  - The connector test now revokes as the owner (the token gets 403).

## 2.16.2

Two agent fixes (agent 1.15.2).

- **Host reboot when the lease can't be checked:** an approved Proxmox host reboot was only held when the other host
  was still updating ("busy"). When the dashboard didn't answer ("offline"), it rebooted anyway, though the other
  host could have been updating an HA partner right then. Offline is now held like busy and put back as waiting for
  approval under a new id. The held item and the event say which it was: "the other host was still updating after
  2 h", or "the dashboard did not answer, so it was unknown whether the other host was updating".
- **Manual snapshot description:** the dashboard user was put through `shlex.quote` inside single quotes and cut
  after quoting, so an email with an apostrophe broke the command, a space split it into extra arguments, and the
  cut could leave a quote open. The user is now cut down to letters, digits and `@ . _ + -` (at most 60
  characters), and the whole description is quoted once (`snapshot_cmd`). No other agent command had the pattern.
- Tests: a host reboot with an offline lease is held with the offline reason and never sent; the snapshot command
  splits into one clean description argument for `o'brien@example.com`, `a b`, `$(id)` and a 100-character email.

## 2.16.1

A lost update lease now stops HA-sensitive work (agent 1.15.1).

- **Lost lease:** a renewal that was refused (the other agent took the lease) only logged a line, and the run kept
  treating the lease as its own, so containers in an HA pair could still be updated while the other host updated
  their partners. The same happened when renewals went unanswered for longer than the lease's ttl (it had expired
  on the dashboard by then). Both now mark the lease **lost** with a warning event. From then on every HA container
  in the run is held, including one that was waiting for its partner to get healthy. Other containers carry on.
  A lost lease is never released or extended at the end, since it isn't this agent's any more.
- **Host reboot:** when the other host was still updating after the 2 h wait, an approved Proxmox host reboot went
  ahead anyway, which could take both halves of an HA pair down. It is now held and put back as waiting for
  approval (under a new id, so the dashboard shows it again), with a warning event.
- Agent tests: `npm run test:agent` (`python3 -m unittest discover -s test/agent`, standard library only).

## 2.16.0

Scripts do the monitoring, one answer per Datacenter question, and HA pairs are never updated together (agent 1.15.0).

- **Monitoring is script-only.** Nothing automatic calls Claude any more. The nightly update risk check uses the
  built-in rules (`claude_review` now defaults to `never`; set `"auto"` in the agent's config.json for the old
  behaviour), and a container that won't start is reported as an error event instead of being handed to Claude
  (`"autofix_claude": true` brings that back). Claude runs only when you ask it something in a chat.
- **Datacenter chats give one answer.** Every host still checks its own side, but the dashboard folds the replies
  into a single answer. A host whose side has nothing to do with the question (a container that lives on the other
  host) answers "not mine" and is left out: by script for status/start/restart/ping/updates, and Claude is told to
  reply `NOT_FOR_THIS_HOST`. Answers that are one table each (like "list containers") become one table with a
  Host column, and the script note shows once.
- **One host updates at a time.** Update runs, single container updates and approved host reboots take a
  datacenter-wide lease from the dashboard (`POST /api/agent/lease`) first. The other agent waits (nightly: up to
  3 h, `lease_wait_min`), so the two halves of an HA pair (WebManager 212/213, status site 214/215, the tunnel
  connectors) are never updated or rebooted at the same time. A host reboot keeps the lease for 25 min so the
  other host waits until it is back. A connector that reboots itself after updates keeps it 6 more minutes.
- **HA partner check.** A container with `/etc/um-ha.conf` or `/etc/wm-ha.conf` is updated only while its partner
  is healthy (um-ha `/role`: a primary with a healthy app, or a replica synced in the last 2 min; wm-ha
  `/healthz`), waiting up to 10 min for it. If the lease couldn't be taken (dashboard unreachable, or the other
  host still busy) it is held for that night instead.
- `/api/infra` includes `updateLease` (who is updating now).

## 2.15.2

Approved reboots wait for running backups (agent 1.14.1).

- **Host reboot:** an approved Proxmox host reboot used to fire 60 s later no matter what. When that landed on the
  even-hour backup schedule (`*/2:00`), the running backup was killed. The reboot now waits while a backup or
  restore runs on the host (checked every 30 s, at most 1 h, then it reboots anyway as before). A scheduled backup
  doesn't show up as a process named `vzdump`, because Proxmox renames its workers to `task UPID:…:vzdump:…`, so
  the agent checks for both names.
- **Backup server reboot:** same for HOLY. It waits while PBS has a running `backup` (a host writing to it) or
  `reader` (restore) task. Verify and garbage collection don't hold it up.
- A reboot that couldn't be scheduled now shows as an error event instead of nothing.
- Check: `journalctl -u hl-host-reboot` on the host (`hl-pbs-reboot` on the backup server) shows whether it waited.

## 2.15.1

Fixes from a bug check of 2.15.0.

- **Dashboard after the Access sign-in runs out:** API calls then get Cloudflare's redirect to its login page, which
  a fetch can't follow, so the page showed "Cannot reach the monitor server" until you reloaded it yourself. It now
  notices the redirect and reloads (at most once a minute), and Access signs you in again.
- **Approve page:** when Access signed someone in but the site refused it (not in `ADMIN_EMAILS`, or expired), the
  page said Access wasn't set up. It now says which one it is.
- `get_overview` rejects unknown arguments like the other tools.
- Tests for the Cloudflare Access JWT check (signature, issuer, AUD, expiry, `alg` downgrades, edited claims,
  service tokens, `ADMIN_EMAILS`, API token rate limit).

## 2.15.0

**Claude connector** (read-only MCP server at `$PUBLIC_URL/mcp`) and **Cloudflare Access** replaces the site's own
sign-in.

- **Sign-in is Cloudflare Access.** Google sign-in and the password form are gone. The app verifies the JWT Access
  adds to each request (RS256 against the team's keys, issuer, AUD, expiry). A request that didn't come through
  Access, e.g. straight to `:3000` on the LAN, is not signed in. New: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
  `ADMIN_EMAILS` is now an optional second check. `ADMIN_PASSWORD` stays as the API token for scripts. Removed:
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PASSWORD_LOGIN`, `/api/login`, `/api/logout`, `/api/auth/google*`,
  `sessions.json`. Setup and the Access bypasses agents and Claude need: [docs/CLOUDFLARE_ACCESS.md](docs/CLOUDFLARE_ACCESS.md).
- **Claude connector:** add `https://<domain>/mcp` in Claude → Settings → Connectors. 14 read-only tools
  (`get_overview` with the Overview's needs-attention list, monitors, agents, containers, approvals, update runs,
  backups, events, agent logs, Claude usage, internal services, HA status). Compact JSON, ISO 8601 times, 50 items
  per page by default (max 200). It never returns tokens, passwords, webhooks, OAuth data or chat contents.
- **OAuth 2.1 built in:** discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
  dynamic registration, authorization code with PKCE S256 only, refresh tokens that rotate (the old one works for
  2 more minutes, so a failover right after a refresh doesn't disconnect Claude). Redirect URIs are limited to
  `MCP_REDIRECT_ALLOWLIST` (Claude's callbacks by default). Only SHA-256 hashes are stored, in `oauth.json`, which
  um-ha replicates. Access cookies and `ADMIN_PASSWORD` are not accepted on `/mcp`. 60 calls per minute per client;
  every tool call is logged without arguments or results. `MCP_ENABLED=false` turns it all off.
- **Settings → Connected clients:** see who is connected and revoke a client.
- **One npm dependency** (`@modelcontextprotocol/sdk`). um-update now runs `npm ci --omit=dev` and installs
  `node_modules` with the app, and fills it in for an app installed without it (needs `npm` on the container;
  without it the app runs and only the connector is off). `deploy/install.sh` and the Dockerfile do the same.
- Tests: `npm test` (node:test): tool output shapes and limits, no secrets in any output, the OAuth flow, and the
  full connection the way Claude does it.

## 2.14.0

Everything on the Uptime page is checked every 20 seconds, and the backup server gets updates like a Proxmox host
(agent 1.14.0).

- **Checks every 20 s:** public monitors (new and auto-added ones default to 20 s; existing monitors were switched),
  internal services and core servers (agent `check_every` default 20, was 60). A service is marked down after 2
  failed checks, which now takes about 40 s instead of 2 min.
- **Backup server updates:** connector1 (`"pbs_updates": true` in its config) checks HOLY's packages nightly and on
  demand. Updates and reboots wait for approval, exactly like GOD and HELP. The Updates page has a HOLY card
  (packages waiting, security count, "check now", PBS version, kernel, uptime, "reboot needed"), and the Overview
  says when HOLY needs a reboot.
- **um-ha replication is incremental:** the replica asks only for files changed since its last copy, plus a
  manifest so deleted files go too. There is a full copy every 5 minutes and after any role change. With 20 s
  checks the history files are megabytes, so a 5-second full copy would be wasteful.

## 2.13.1

Fixes from a full bug and UI check.

- Backups: a run that finished with `WARNINGS: n` (everything was backed up, e.g. a VM without an efidisk) now
  shows as an amber **warning**, not a red **failed** run. It no longer counts toward "failed runs" or the
  red Overview alert.
- um-update: an install that was cut off (reboot, killed process) no longer leaves the Servers page showing
  "updating" forever. The next check marks it as interrupted and offers Install again. If copying the new files
  fails partway (e.g. disk full), the previous version is put back instead of leaving half-new code.
- um-ha: temporary files while copying data end in `.tmp`, so a leftover is never copied or backed up. um-ha and
  um-update share the backup folder, so both keep 8 copies (rejoins used to prune update backups down to 5).
- Servers page: it keeps showing the last good data for a minute while the app or um-ha restarts (during an
  update), instead of flashing "not running on the um-ha pair". On phones "60 s" no longer wraps.

## 2.13.0

**Servers** page: see and update both status servers from the one serving the dashboard, as in WebManager.

- A card for each server (CT 214 UptimeMonitor, CT 215 UptimeMonitor2) shows its role (primary serving or
  replica with the age of its copy), version and commit, update state, CPU, memory, disk and uptime.
  Buttons: check for updates, install or "update to" the other server's version, automatic updates on/off, and
  sync now (replica). The page also has **Check both** and **Update both**.
- The updater (`um-update`, now Python) works like WebManager's: it tests the new version (scripts parse, and the
  app boots on a spare port with a copy of the data and no webhooks), backs up the code and data, installs it, and
  rolls back if the app doesn't come back. A failed version isn't retried automatically. Automatic installation can
  be switched off per server.
- um-ha has new endpoints: `/status`, `/cluster` (localhost) and `/control` (localhost, or the peer with the token).
  Requests for the other server are forwarded to it. The peer's status is fetched in its own thread, so it never
  slows failover checks.
- Overview: a standby server that stops answering, a replica that stops copying data, or a failed update shows up
  under "needs attention".

## 2.12.0

The status site moved off WebManager onto its own pair of containers with automatic failover (agent 1.13.0).

- CT 214 **UptimeMonitor** (GOD, preferred primary) and CT 215 **UptimeMonitor2** (HELP), Debian 13, run the app
  under systemd. `um-ha` (`deploy/uptime-ha/`) runs the app only on the primary, copies its data folder to the replica
  every 5 seconds, promotes the replica after 60 seconds of primary failure (only if the gateway still answers), and
  hands the role back to GOD 2 minutes after GOD is healthy again (a few seconds of downtime). A returning stale
  primary saves a backup of its data and rejoins as the replica. `um-update.timer` deploys `main` from GitHub every
  5 minutes, replacing WebManager's deploy on push.
- Connector HAProxy: new `uptime` backend on `127.0.0.1:8082`, which follows `:8099/active`. `upt.webmgr.dev` arriving
  on `:8081` (through the `*.webmgr.dev` tunnel wildcard) is forwarded there too.
- Agent 1.13.0 knows about um-ha containers. The app port, which moves with every failover, is left out of service
  discovery and the nightly update health check, so a failover is not reported as a dead service and doesn't roll
  back an update. The agent's CLAUDE.md explains the HA pairs (status site and WebManager), so it doesn't start the
  replica's app.

## 2.11.0

Internal services and core servers are checked every minute, like the public sites (agent 1.12.0).

- The agent's always-running `hl-poll` service now pings and port-checks every internal service and the core servers
  (GOD, HELP, HOLY) every 60 seconds and sends the results straight away. It used to happen only with the 5-minute
  report. A service is marked down after 2 failed checks (2 minutes instead of 10). Plain script, no Claude.
  Change the interval with `"check_every": 60` (seconds, at least 20) in `~/agent/config.json`.
- The 5-minute report reuses those results instead of checking again, and the dashboard doesn't count them twice.
  Agents older than 1.12 keep working as before (checks with the report).
- Discovery (listening services in every container, tunnel hostnames, WebManager sites) has its own schedule: every
  90 minutes (`"discover_every_min"`, 60–120), and right away when the set of running containers changes, so a new or
  restarted container is picked up within 5 minutes. It used to run every 30 minutes with the backup refresh.
- Service and core-server history moved from `infra.json` to `checks.json` (saved at most once a minute), so the
  main state file isn't rewritten with it on every agent sync. Existing history is moved over automatically.

## 2.10.3

Backup server card redesigned (Overview and Backups).

- It gets its own full-width row under the Proxmox hosts, with two columns: storage, stats and server health on the
  left; jobs and problems on the right. Host cards no longer stretch to its height with empty space.
- Failed PBS tasks are grouped: the same job failing every hour is one line ("Verify job · WD-8tb:v-… · 7×,
  last 2h ago") instead of a long list. The full list is under "All N failed tasks" as a compact table.
- Warnings (e.g. garbage collection "WARNINGS: 2") show amber instead of red; jobs that haven't run yet show grey.
- Stat tiles no longer cut their labels off ("guests (23…"); they show 4 in a row, or 2×2 when narrow.
- Times read "2m ago" / "1h ago" instead of "2m 0s ago" / "1h 0m ago" everywhere.

## 2.10.2

Fixed: logs and activity disappearing.

- **Agent logs are saved** (`agentlogs.json`, up to 5000 lines per agent). They were kept in memory only, so every
  restart or redeploy of the dashboard wiped them, and only the newest 300 lines came back with the next report.
- **Activity keeps its own history** (`events.json`, 30 days, up to 3000 events per agent). Activity used to show only
  the newest 100 events in the agent's latest report, so older entries vanished as new ones arrived. The page shows
  300 at a time with **Show older**.
- **Update-run logs can't be lost any more.** An agent used to send a run's full log only for 30 minutes after the
  run; if the dashboard was restarting or unreachable then, it was gone ("not kept"). Now the dashboard says which
  run logs it has, and the agent keeps resending a log until every dashboard has it.
- No events lost in bursts: each report now carries every event since the last report all dashboards received
  (it was the newest 100, then 200). Warning/error alerts are checked against the saved history, so a restart
  doesn't repeat old alerts.
- The Logs page shows up to 1500 lines (was 800).
- Agent 1.11.1.

## 2.10.1

- Fixed: the sidebar scrolled away. On pages shorter than the window the footer made the page scroll and the sidebar
  went with it; the sidebar also sat 5 px too low (it assumed a 57 px header; the header is 62 px). The sidebar now
  follows the real header height and the footer is part of the main column, so the sidebar never moves.
- Fixed: on 360 px phones the Uptime toolbar and internal-service rows pushed the page sideways.
- Fixed: core-server cards said "up for just now" / "state for just now"; they now say e.g. "up for 6s" / "degraded for 3m".
- Fixed: a core server went DOWN / Degraded (with an alert, then a "back up" alert) after a single missed check.
  It now takes two in a row, like internal services; recovery still shows at once.
- Backups and Updates on phones show the host under each container name (the Host column is hidden there), and
  "Not covered" names the host when the same container name exists on both hosts.
- Empty-table messages wrap instead of being cut off.

## 2.10.0

Less Claude usage: things a script can do no longer go to Claude.

- **Quick answers in chat (agent 1.11.0).** Simple requests are answered by a script on the agent, straight from
  live data, at no token cost. This covers: ping (a container, an IP or hostname, several at once, or "everything"),
  "is X up" / "status of X", start / restart / reboot / stop / shut down a container (exact name or ID only; the agent
  never shuts down its own container), disk / memory / CPU use per container, "are any services failing",
  pending updates (all, or "check updates for X"), backups, host status, and last night's update run.
  Anything else, or any message that starts with `/ai`, still goes to Claude. Script answers are marked
  "⚡ script · no Claude tokens", and the usage panel counts them.
- **Nightly update reviews ask Claude far less.** The built-in rules decide the clear cases: security fixes and point
  releases are low risk, and removals or major jumps of databases/servers/runtimes are held. Claude reviews only
  packages that move to a new minor/major version, and its verdict for the same package set is reused for 14 days.
- **Auto-fix:** a container that won't start because of a stale lock (an interrupted backup or snapshot, with
  nothing running) is unlocked and started by the script. Claude is asked at most once a day per container
  (it was every 6 hours).
- Settings in `~/agent/config.json` (all optional): `"quick_answers": false` turns quick answers off;
  `"claude_review": "auto" | "always" | "never"` (default `auto`); `"autofix_claude_hours": 24`.

## 2.9.0

- Merged the parallel dashboard work (2.5.1–2.8.1: logs, live update progress, security-only policy, Ask inbox)
  with core-server monitoring and stale-backup handling. The combined agent is **1.10.0**.

- Core servers: GOD, HELP and HOLY get their own cards at the top of Overview and Uptime (ping, Proxmox :8006,
  PBS :8007, SSH :22, 24-hour bar, uptime). Both agents check all three from the LAN, so a dead host is still
  reported by the agent on the other one. A server counts as DOWN only when no agent can reach it.
  Down, degraded and recovered all send alerts.
- Agent 1.9.1: when the backup storage is offline, the last-known backup data is kept and marked stale,
  instead of claiming every container has "no backup yet". The Backups page shows a banner.

## 2.8.1

- Merged main (agent 1.7 PBS access, 1.7.1 health-check and retry fixes, 1.8 snapshot cleanup) with the dashboard work
  below. The combined agent is **1.9.0**; the dashboard's nightly-policy and log features check for 1.9.0.

## 2.8.0

- **Agent logs on the dashboard.** A new **Logs** page shows each agent's own log (what it ran, warnings, errors),
  refreshed every 5 s, with a host filter, "warnings & errors" filter, search, copy and download.
- **Update logs.** Every update (nightly run, run-now, single container, approved update) keeps a step-by-step log:
  package list, review result, plan, snapshot, the apt output, reboot, health check and rollback. The progress card
  on the Updates page shows it live; afterwards **View log** opens it (Updates → host card → Update logs, and the
  Logs page). Logs of the last 40 runs per host are kept in `runlogs.json`.
- One-click container actions get **View output** (for updates this includes the full log).
- Agent 1.9.0 (includes 1.7.1 and 1.8 from main): writes `~/agent/logs/agent.log` and sends its tail with each report and quick sync; update runs record
  their own log.

## 2.7.0

- **Security-only updates.** Each host's nightly run can be switched between "everything low-risk" (as before) and
  "security updates only" on the Updates page. Containers also get a **Security only** button next to **Update all**,
  and each host has a **Security updates only** run-now button. Needs agent 1.9.0.
- **Live update progress bar.** While an update runs (nightly, run-now, or a single container), the Updates page
  shows which container is being worked on, the current step (snapshot, installing, rebooting, health check, rollback),
  how many are done, and what finished so far. Host cards on the Overview show a small bar too. It refreshes every 3 s.
- **Ask agents reworked.** One inbox for all chats with search and a host filter, unread markers for new answers,
  a spinner on chats that are being worked on, a proper chat layout with the newest message in view and a composer
  that grows as you type (Enter sends, Shift+Enter for a new line), suggestion chips for new chats, and Copy /
  Ask again / Cancel / Delete on messages. On phones the list and the chat are separate screens.
- Styled confirm and rename dialogs replace the browser's pop-ups everywhere.
- New icons in the sidebar and header; the header status chip links to the Overview.
- Updates page: filter containers by "with updates" / "security".
- Containers on phones show the host under the name; long names wrap.
- Fixed: `/api/infra/:agent/decision/:id/cancel` (and similar) was accepted as a task cancel.
- Agent (1.9.0): nightly policy (security only), `update-security` and `update-all-security` actions, live progress
  reporting, and a leftover progress record from a killed run is cleared automatically.

## 2.6.1

- Fixed: short pages (e.g. Containers) were stretched to the sidebar's height, leaving big empty gaps.
- Fixed: "Ask about <container>" opened the chat with an empty box; it now starts a new chat with the question filled in.
- Fixed: Approve/Deny buttons swapped DOM elements on every refresh (both used the same key).
- Agent sync: client disconnects are now detected on the response (the old request listener never fired).
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
