# Homelab Status on its own containers, with failover (um-ha)

The status site (`upt.webmgr.dev`) used to be WebManager app 51. It now runs on two dedicated Debian 13
containers. One serves the site while the other keeps a live copy, ready to take over.

| | Host | CT | IP | Role |
| --- | --- | --- | --- | --- |
| **UptimeMonitor** | GOD | 214 | 192.168.10.213 | preferred primary |
| **UptimeMonitor2** | HELP | 215 | 192.168.10.110 | replica |

```text
Cloudflare ──tunnel──▶ cloudflared (connector1 / connector2)
                          │  upt.webmgr.dev → http://localhost:8082
                          ▼
                   HAProxy 127.0.0.1:8082 (backend "uptime")
                   ├─ um1 / um2: whichever has :8099/active = 200 (balance first)
                   └─ fallback: any app whose :3000/api/health answers
                          │
          ┌───────────────┴───────────────┐
   CT 214 UptimeMonitor            CT 215 UptimeMonitor2
   app :3000 (running)  ──data──▶  app stopped, copy of the data
   um-ha :8099          every 5 s  um-ha :8099
```

## What runs where

- `uptime-monitor.service`: the app (Node, `/opt/uptime-monitor`, data in `/var/lib/uptime-monitor`,
  settings in `/etc/uptime-monitor.env`, which is identical on both). It is **not** enabled at boot:
  um-ha starts it only on the primary.
- `um-ha.service` (`/usr/local/sbin/um-ha`, config `/etc/um-ha.conf`, state `/var/lib/um-ha/state.json`).
- `um-update.timer` (`/usr/local/sbin/um-update`): every 5 minutes it checks `main` on GitHub and installs a
  new version, the way WebManager's updater does. It **tests** first (every script must parse, and the new app
  must start and answer `/api/health` on a spare port with a copy of the data and no webhooks), **backs up** the
  code (`/opt/uptime-monitor.prev`) and data (`/var/lib/um-ha/backups`), **installs**, and restarts the app if
  it was running. If the app doesn't answer within 40 s, it **rolls back**. A version that failed isn't retried
  automatically, so click Install to try it again. The result is in `/var/lib/um-ha/update.json`. Automatic
  installation can be turned off per server (`/var/lib/um-ha/auto-install` = `0`); new versions then wait for
  Install. A running app restarts for about 2 seconds, so an update never triggers a failover.

## Servers page (dashboard → Servers)

As in WebManager, you see and update **both** servers from the one that serves the dashboard. Each card shows
its role, when the replica last copied the data, its version and update state, CPU, memory and disk, and
uptime. Buttons: **Check for updates**, **Install** / **Update to** (the version the other one runs), **Stop
/ start automatic updates**, and **Sync now** on the replica. The page also has **Check both** and **Update both**.
A standby that stops answering, a stale copy, or a failed update also shows on the Overview.

The app asks its local um-ha (`127.0.0.1:8099`, `/cluster` and `/control`; localhost only). um-ha forwards
anything for the other server to that server's `/control` with the shared token. That server starts
`um-update` itself, in its own transient unit.

## um-ha

- **Replication:** the replica downloads a snapshot of the primary's data folder (`GET /snapshot`,
  restricted to the peer IP and a shared token) every `SYNC_EVERY` = 5 s. The app writes its JSON files
  atomically, so every snapshot is consistent. Sign-ins (`sessions.json`) are copied too, so nobody is
  logged out by a failover.
- **Failover:** if the primary has not been a *healthy* primary (`/role` says primary and its app
  answers `/api/health`) for `FAIL_AFTER` = 60 s, with at least 5 failed checks in a row, while the
  gateway still pings, the replica promotes itself. The new epoch is the current time in ms, and the
  app starts from the last snapshot.
- **Rejoin:** a server that comes back and finds the peer primary with a newer epoch doesn't start its
  app. It saves a copy of its own data to `/var/lib/um-ha/backups/` (the last 5 are kept) and becomes
  the replica.
- **Failback:** UptimeMonitor (GOD, `PREFERRED=1`) takes the primary role back once it has been a
  healthy, synced replica for `FAILBACK_AFTER` = 120 s. It sends `POST /handover`, and the peer stops
  its app (which saves everything) and answers with its final data. GOD loads that data, starts its app,
  and promotes itself; the peer sees the newer epoch and becomes the replica. The site is down for a few
  seconds. If the handover doesn't finish within `HANDOVER_TIMEOUT` = 60 s, the peer starts serving
  again, and GOD waits 30 minutes before trying again.
- `GET :8099/role` returns JSON (role, epoch, app health, last sync), and `GET :8099/active` returns 200
  only on the healthy primary.

## Install / reinstall

As root in each container, from a checkout of this repo, with the same token on both:

```bash
UM_HA_TOKEN=<shared secret> UM_HA_LABEL="GOD · CT 214" bash deploy/uptime-ha/install.sh 192.168.10.213 192.168.10.110 preferred --primary   # CT 214
UM_HA_TOKEN=<shared secret> UM_HA_LABEL="HELP · CT 215" bash deploy/uptime-ha/install.sh 192.168.10.110 192.168.10.213                     # CT 215
```

`--primary` only matters on the very first install. Re-running the installer keeps the data, the
settings, the token, and the current role.

## Everyday commands

```bash
curl -s 127.0.0.1:8099/role                 # role, epoch, last sync
journalctl -u um-ha -f                      # failover decisions
journalctl -u uptime-monitor -f             # the app
um-update --check                           # check GitHub now (or the Servers page)
um-update                                   # check and install if automatic installation is on
cat /var/lib/um-ha/update.json              # last check / install result
```

**Manual switchover** (for example before maintenance on GOD): on CT 214, run
`systemctl stop um-ha uptime-monitor`. CT 215 promotes itself after 60 s. Then `systemctl start um-ha`
on CT 214: it rejoins as the replica and takes the primary role back 2 minutes later. For maintenance
on HELP, nothing is needed while CT 215 is the replica.

**Changing settings:** edit `/etc/uptime-monitor.env` on **both** containers, then run
`systemctl try-restart uptime-monitor` (this only restarts the app where it is running).

## Notes

- Both IPs come from DHCP. Pin them in UniFi (fixed IP for each MAC), because HAProxy and um-ha
  use these addresses.
- During a failover test, the connector agents' autofix restarts stopped onboot containers. Add 214/215
  to `exclude_vmids` in `/home/agent/agent/config.json` first, then remove them afterwards.
- The epoch is wall-clock time, so the two hosts need NTP (Proxmox has it by default).
