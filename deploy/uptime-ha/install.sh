#!/usr/bin/env bash
# Installs (or updates) Homelab Status with um-ha failover on one of the two status containers.
# Run as root inside the container, from a checkout of this repo:
#
#   UM_HA_TOKEN=<shared secret> [UM_HA_LABEL="GOD · CT 214"] bash deploy/uptime-ha/install.sh <this server's IP> <the other server's IP> [preferred] [--primary]
#     UptimeMonitor  (GOD):  ... install.sh 192.168.10.X 192.168.10.Y preferred --primary
#     UptimeMonitor2 (HELP): ... install.sh 192.168.10.Y 192.168.10.X
#
# The app's settings go in /etc/uptime-monitor.env (same file on both servers; see README.md).
# --primary only matters on the very first install (no /var/lib/um-ha/state.json yet).
# Re-running it is safe: it keeps the data, the settings and the current role.
set -euo pipefail

SELF_IP=${1:?usage: install.sh <self ip> <peer ip> [preferred] [--primary]}
PEER_IP=${2:?usage: install.sh <self ip> <peer ip> [preferred] [--primary]}
shift 2
PREFERRED=0
FIRST_ROLE=replica
for a in "$@"; do
  case "$a" in
    preferred) PREFERRED=1 ;;
    --primary) FIRST_ROLE=primary ;;
    *) echo "unknown option $a" >&2; exit 1 ;;
  esac
done

SRC=/opt/homelab-status-src
REPO=https://github.com/coolguy1333/homelab-status.git
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "==> Packages"
apt-get update -qq || true
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3 nodejs ca-certificates curl iputils-ping >/dev/null
echo "    node $(node --version), python $(python3 --version | cut -d' ' -f2)"

echo "==> Source checkout in $SRC (the updater pulls it every 5 minutes)"
if [ ! -d "$SRC/.git" ]; then
  if [ "$HERE" != "$SRC" ] && [ -d "$HERE/.git" ]; then
    git -c safe.directory='*' clone -q "$HERE" "$SRC"
    git -C "$SRC" remote set-url origin "$REPO"
  else
    git clone -q "$REPO" "$SRC"
  fi
fi

echo "==> App user, folders, code"
id uptime >/dev/null 2>&1 || useradd --system --home /var/lib/uptime-monitor --shell /usr/sbin/nologin uptime
install -d -o uptime -g uptime -m 750 /var/lib/uptime-monitor
install -d -m 755 /opt/uptime-monitor
install -d -m 700 /var/lib/um-ha
cp -r "$HERE/server.js" "$HERE/package.json" "$HERE/lib" "$HERE/public" /opt/uptime-monitor/

if [ ! -f /etc/uptime-monitor.env ]; then
  echo "    WARNING: /etc/uptime-monitor.env is missing; writing a stub (the app needs the real settings)"
  printf 'PORT=3000\nHOST=0.0.0.0\nTRUST_PROXY=true\n' > /etc/uptime-monitor.env
fi
chown root:uptime /etc/uptime-monitor.env
chmod 640 /etc/uptime-monitor.env

echo "==> Services"
# um-ha starts and stops the app: it must not start by itself at boot (a stale primary would serve old data).
cp "$HERE/deploy/uptime-monitor.service" /etc/systemd/system/uptime-monitor.service
install -m 755 "$HERE/deploy/uptime-ha/um-ha" /usr/local/sbin/um-ha
install -m 755 "$HERE/deploy/uptime-ha/um-update" /usr/local/sbin/um-update
for u in um-ha.service um-update.service um-update.timer; do
  cp "$HERE/deploy/uptime-ha/$u" "/etc/systemd/system/$u"
done

TOKEN=${UM_HA_TOKEN:-}
if [ -z "$TOKEN" ] && [ -f /etc/um-ha.conf ]; then
  TOKEN=$(sed -n 's/^TOKEN=//p' /etc/um-ha.conf)
fi
[ -n "$TOKEN" ] || { echo "UM_HA_TOKEN is not set (use the same value on both servers)" >&2; exit 1; }

if [ -f /etc/um-ha.conf ]; then
  # keep tuned values, rewrite the identity
  sed -i -e "s/^SELF_IP=.*/SELF_IP=$SELF_IP/" -e "s/^PEER_IP=.*/PEER_IP=$PEER_IP/" \
         -e "s/^PREFERRED=.*/PREFERRED=$PREFERRED/" -e "s/^TOKEN=.*/TOKEN=$TOKEN/" /etc/um-ha.conf
else
  cat > /etc/um-ha.conf <<CONF
# um-ha settings (see /opt/homelab-status-src/deploy/uptime-ha/README.md). Restart after editing: systemctl restart um-ha
SELF_IP=$SELF_IP
PEER_IP=$PEER_IP
PREFERRED=$PREFERRED
TOKEN=$TOKEN
# seconds the primary must be failing before the replica takes over
FAIL_AFTER=60
MIN_FAILS=5
# seconds the preferred server waits as a healthy replica before taking the primary role back
FAILBACK_AFTER=120
HANDOVER_TIMEOUT=60
FAILBACK_BACKOFF=1800
SYNC_EVERY=5
CHECK_EVERY=2
GATEWAY=192.168.10.1
CONF
fi
if [ -n "${UM_HA_LABEL:-}" ]; then   # shown on the Servers page, e.g. "GOD · CT 214"
  sed -i '/^LABEL=/d' /etc/um-ha.conf
  echo "LABEL=$UM_HA_LABEL" >> /etc/um-ha.conf
fi
chmod 600 /etc/um-ha.conf

if [ ! -f /var/lib/um-ha/state.json ]; then
  if [ "$FIRST_ROLE" = primary ]; then
    echo '{"role": "primary", "epoch": 1}' > /var/lib/um-ha/state.json
  else
    echo '{"role": "replica", "epoch": 0}' > /var/lib/um-ha/state.json
  fi
  echo "    first install: starting as $FIRST_ROLE"
fi

systemctl daemon-reload
systemctl disable uptime-monitor >/dev/null 2>&1 || true
systemctl enable um-ha.service um-update.timer >/dev/null
systemctl restart um-ha.service
systemctl start um-update.timer
# Code changed: a running app (primary) picks it up; a replica's app stays stopped.
systemctl try-restart uptime-monitor || true
git -C "$SRC" rev-parse HEAD > /var/lib/um-ha/installed-rev 2>/dev/null || true

sleep 3
echo
echo "um-ha:  $(curl -s "http://127.0.0.1:8099/role" || echo 'not answering yet')"
echo "Logs:   journalctl -u um-ha -u uptime-monitor -f"
