# Homelab Status

Status dashboard for the homelab. It replaces [Uptime-Monitor](https://github.com/coolguy1333/Uptime-Monitor) and keeps
all of its features (website/IP/port monitors, self-uptime, peers, Google sign-in, webhook alerts). It adds a
**Proxmox hosts** section fed by the always-on connector agents.

- **Each agent** (connector1 on GOD, connector2 on HELP) looks after the LXC containers on its own Proxmox host:
  - Every 5 minutes it reports status and restarts containers that should be running. Anything it can't fix
    goes to Claude.
  - Every night it takes a snapshot, reviews the risk of the pending updates, updates, health-checks, and rolls
    back automatically if services broke.
  - Security updates always go in. Risky updates, host updates, and host reboots wait for **Approve** on this page.
- **Ask an agent** anything, or tell it to fix something, from the box on its card. The answer appears there.
- Infrastructure details and actions are visible **only to signed-in admins**, even if the dashboard is public.

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
