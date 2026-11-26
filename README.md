# Homelab Status

Status and control panel for the homelab. It replaces [Uptime-Monitor](https://github.com/coolguy1333/Uptime-Monitor)
and keeps all of its features (monitors, Google sign-in, webhook alerts, peers).

| Page | What it shows |
|---|---|
| **Overview** | A "needs attention" list, key numbers, a card per Proxmox host, and recent activity |
| **Containers** | Every LXC on both hosts with CPU, memory, disk, services, updates, and backups. Row actions: start, shut down, reboot, snapshot, back up now, update now |
| **Updates** | A live progress bar while an update runs, approvals (host updates and reboots, held-back updates), the nightly schedule per host (everything low-risk, or **security updates only**), run history, "run now", and per-container "security only" / "update all" |
| **Backups** | Proxmox backup jobs, the last backup per container (age, size, PBS verification), failed runs, and snapshots |
| **Uptime** | Public monitors (tunnel hostnames and WebManager sites are added automatically) and internal services found inside containers, checked on the LAN |
| **Ask agents** | A chat inbox: questions and fix requests to one host's agent, or to every agent at once (**Datacenter**). Follow-ups remember the conversation; messages can be copied, asked again, cancelled or deleted |
| **Activity** | Everything the agents did or noticed |
| **Logs** | Each update run step by step (apt output included) with a live view while it runs, and the agents' own log (search, filter, copy, download) |

How it works: an agent on each Proxmox host (connector1 on GOD, connector2 on HELP) reports to this app every
5 minutes. It pings and port-checks the internal services and core servers every 20 seconds (as often as the public
sites are checked), and looks for new services, tunnel hostnames and WebManager sites every 1–2 hours. These are plain
scripts; Claude is only used for chat questions and unclear update reviews. Each night it snapshots, risk-reviews, updates, and health-checks every container, and rolls back if
something broke. Security updates always go in. Risky updates and anything touching the host wait for **Approve**.
Infrastructure pages require Google sign-in.

## Where it runs

Production runs on two dedicated containers with automatic failover: CT 214 UptimeMonitor (GOD) and
CT 215 UptimeMonitor2 (HELP). See [deploy/uptime-ha/README.md](deploy/uptime-ha/README.md). They deploy
`main` from GitHub automatically within 5 minutes.

## Deploy on WebManager (app)

Add this repository as a source, choose **Deploy as an app**, then set the variables:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. Redirect URI: `https://<your-domain>/api/auth/google/callback` |
| `ADMIN_EMAILS` | Google accounts allowed in |
| `ADMIN_PASSWORD` | Long random string (API token; password login is off when Google is set) |
| `AGENT_TOKENS` | `connector1:<token>,connector2:<token>`. Each token is in `/home/agent/agent/config.json` on its connector |
| `PUBLIC_DASHBOARD` | `false` (default): everything requires Google sign-in |
| `NOTIFY_WEBHOOK_URL` | optional Discord/Slack/ntfy for alerts (agent offline, rollbacks, approvals) |

Then point each agent at the site (on each connector, as root):

```bash
bash /root/hl-agent-src/install.sh connector1 192.168.10.23 200 04:00 https://status.example.com   # on connector1
bash /root/hl-agent-src/install.sh connector2 192.168.10.81 203 04:30 https://status.example.com   # on connector2
```

You can list several URLs (for example the app on WebManager and on WebManager2). The agent reports to all of them.

## Agent (`agent/`)

`install.sh` installs `hl_agent.py`, `CLAUDE.md`, the systemd timers (`hl-report`, `hl-update`), and an nftables
firewall. The firewall allows the connector to reach only its own Proxmox host, DNS, and the internet. Agents only
make outbound HTTPS calls. Reports require `https://` and a per-agent bearer token.

```bash
su - agent -c 'python3 ~/agent/hl_agent.py show'              # what would be reported
su - agent -c 'python3 ~/agent/hl_agent.py update --dry-run'  # what tonight's run would do
journalctl -u hl-report -u hl-update -n 50
```
