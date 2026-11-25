# WebManager automatic failover

Keeps the WebManager sites (and this status site, app 51) up when the
WebManager primary goes down.

| Piece | Where | What it does |
| --- | --- | --- |
| WebManager primary | CT 212 on GOD, `192.168.10.20:8080` | Normal primary |
| WebManager replica | CT 213 on HELP, `192.168.10.116:8080` | `setup.sh --replica-of`, app hosting on, so it mirrors the database, sites and app data |
| `wm-ha` | both WebManager CTs | Promotes the replica / demotes a stale primary, publishes the role |
| HAProxy | Connector1 (CT 200) and Connector2 (CT 203), `127.0.0.1:8081` | Sends tunnel traffic to the active primary |
| Cloudflare tunnel | runs on both connectors | WebManager hostnames point at `http://localhost:8081` |

```text
Cloudflare ──tunnel──▶ cloudflared (connector1 / connector2)
                          │
                          ▼
                   HAProxy 127.0.0.1:8081
                   ├─ ct212 / ct213: whichever has /active = 200 (balance first)
                   └─ fallback: any server whose /healthz answers
```

## wm-ha (`wm-ha`, `install.sh`)

Runs every 10 s from `wm-ha.timer` on both servers.

- **Replica:** if the primary's `/healthz` has failed 18 times in a row
  (3 minutes) and the gateway `192.168.10.1` still answers a ping, it runs
  `webmanager-promote --yes`. Apps then start from the last synced data.
- **Primary:** if the peer is also primary with a newer epoch (the mtime of
  `/var/lib/webmanager/promoted`; 0 = never promoted), this server is the
  stale old primary. It stops its app containers and rejoins the peer with
  `setup.sh --replica-of`. Retries are spaced 10 minutes apart, and the log
  is `/var/lib/wm-ha/rejoin.log`.
- **Publishes its role** via `/etc/nginx/conf.d/wm-ha.conf` on `:8080` with
  `Host: wm-ha.internal`: `/role` returns `"<role> <epoch>"`, and `/active`
  returns 200 only on the primary that should get traffic.

There is no automatic failback. After a failover the roles stay swapped,
which is fine because the servers are symmetric.

`install.sh` also adds a systemd drop-in that sets
`TMPDIR=/var/lib/webmanager/tmp` for `webmanager.service`. WebManager
before PR #16 restored app data from `/tmp`, which `PrivateTmp=true` hid
from Docker, so the drop-in can go once both servers run that version.

Install or update (as root inside each WebManager CT):

```bash
bash install.sh <this server's IP> <the other server's IP>
# CT 212: bash install.sh 192.168.10.20 192.168.10.116
# CT 213: bash install.sh 192.168.10.116 192.168.10.20
```

Logs: `journalctl -u wm-ha`. Config: `/etc/wm-ha.conf` (`FAIL_LIMIT`, `GATEWAY`).

## HAProxy (`haproxy-connector.cfg`)

Install on each connector as `/etc/haproxy/haproxy.cfg` (the stock file is
kept as `haproxy.cfg.dist`). It listens on loopback only, so the connectors'
nftables rules don't change. The stats page is at `http://127.0.0.1:8404/`.

Health checks must send an IP as the `Host` header. Without one, WebManager's
nginx routes the request to the site gateway and returns 404.

## Cloudflare tunnel

Every public hostname that used to point at `http://192.168.10.20:8080` must
point at `http://localhost:8081`:

`webmgr.dev`, `web.mhsit.club`, `mhsit.club`, `print-away.com`, `mhscraft.cc`,
`fingland.cc`, `mhstoday.com`, `fantasy-frc.com`, and the `*.` wildcard of each.

## Caveats

- If CT 212 is only cut off from CT 213 and not actually down, both can run
  apps until it reconnects and rejoins. Bots and similar apps may then act twice.
- An update or reboot of the primary that lasts more than 3 minutes swaps
  the roles.
- Once both servers run WebManager with PR #16, HAProxy could check
  `/healthz?role=primary` directly instead of the `wm-ha.internal` endpoint.
