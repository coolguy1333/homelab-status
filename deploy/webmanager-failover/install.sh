#!/usr/bin/env bash
# install.sh SELF_IP PEER_IP [preferred]  (run as root inside the WebManager CT)
# Pass "preferred" on the server that should normally be the primary: after a
# failover, the roles switch back to it once it has been healthy for 2 minutes.
set -Eeuo pipefail
SELF_IP=$1 PEER_IP=$2
PREFERRED=0
[[ ${3:-} == preferred ]] && PREFERRED=1
cd "$(dirname "$0")"

command -v ping >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iputils-ping >/dev/null
[[ -d /root/webmanager/.git ]] || git clone -q https://github.com/coolguy1333/WebManager.git /root/webmanager

install -m 755 wm-ha /usr/local/sbin/wm-ha
cat >/etc/wm-ha.conf <<EOF
SELF_IP=$SELF_IP
PEER_IP=$PEER_IP
GATEWAY=192.168.10.1
# Promote after the primary has failed health checks for 60 seconds
# (and at least 5 checks in a row).
FAIL_AFTER=60
MIN_FAILS=5
# 1 on the server that should normally be the primary (automatic failback).
PREFERRED=$PREFERRED
# Fail back once the preferred server has been a healthy replica this long.
FAILBACK_AFTER=120
EOF

cat >/etc/systemd/system/wm-ha.service <<'EOF'
[Unit]
Description=WebManager automatic failover check
After=network-online.target webmanager.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/wm-ha
TimeoutStartSec=15min
EOF
cat >/etc/systemd/system/wm-ha.timer <<'EOF'
[Unit]
Description=WebManager automatic failover check every 5 s

[Timer]
OnBootSec=30s
OnUnitInactiveSec=5s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

# App data restores bind-mount a temp dir into Docker; PrivateTmp would hide it.
install -d -o webmanager -g webmanager -m 700 /var/lib/webmanager/tmp
mkdir -p /etc/systemd/system/webmanager.service.d
printf '# Docker bind-mounts app restore temp dirs; PrivateTmp hides /tmp from dockerd.\n[Service]\nEnvironment=TMPDIR=/var/lib/webmanager/tmp\n' \
    >/etc/systemd/system/webmanager.service.d/tmpdir.conf

install -d -m 755 /srv/wm-ha
rm -f /srv/wm-ha/active
cat >/etc/nginx/conf.d/wm-ha.conf <<'EOF'
# Role endpoint for the HAProxy failover on the Cloudflare connectors (wm-ha).
server {
    listen 8080;
    server_name wm-ha.internal;
    root /srv/wm-ha;
    default_type text/plain;
    access_log off;
    location = /role   { try_files /role =503; }
    location = /active { root /run/wm-ha; try_files /active =503; }
    location / { return 404; }
}
EOF
nginx -t -q
systemctl daemon-reload
systemctl reload nginx
NEEDS_RESTART=$(systemctl show webmanager -p Environment --value | grep -c TMPDIR || true)
[[ $NEEDS_RESTART -gt 0 ]] || systemctl restart webmanager
systemctl enable -q --now wm-ha.timer
/usr/local/sbin/wm-ha
echo "role: $(cat /srv/wm-ha/role)  active: $([[ -e /run/wm-ha/active ]] && echo yes || echo no)"
