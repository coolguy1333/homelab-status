# Homelab Status

Status and control panel for the homelab. It replaces [Uptime-Monitor](https://github.com/coolguy1333/Uptime-Monitor)
and keeps all of its features (monitors, Google sign-in, webhook alerts, peers).

| Page | What it shows |
|---|---|
| **Overview** | A "needs attention" list, key numbers, a card per Proxmox host, and recent activity |
| **Containers** | Every LXC on both hosts with CPU, memory, disk, services, updates, and backups. Row actions: start, shut down, reboot, snapshot, back up now, update now |
| **Updates** | Approvals (host updates and reboots, held-back updates), the nightly schedule and run history, "run now" |
| **Backups** | Proxmox backup jobs, the last backup per container (age, size, PBS verification), failed runs, and snapshots |
| **Uptime** | Public monitors (tunnel hostnames and WebManager sites are added automatically) and internal services found inside containers, checked on the LAN |
| **Ask agents** | Questions and fix requests to one host's agent, or to every agent at once with the **Datacenter** box |
| **Activity** | Everything the agents did or noticed |

How it works: an agent on each Proxmox host (connector1 on GOD, connector2 on HELP) reports to this app every
5 minutes. Each night it snapshots, risk-reviews, updates, and health-checks every container, and rolls back if
something broke. Security updates always go in. Risky updates and anything touching the host wait for **Approve**.
Infrastructure pages require Google sign-in.

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
