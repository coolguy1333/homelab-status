#!/usr/bin/env bash
# install.sh SELF_IP PEER_IP  (run as root inside the WebManager CT)
set -Eeuo pipefail
SELF_IP=$1 PEER_IP=$2
cd "$(dirname "$0")"

command -v ping >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iputils-ping >/dev/null
[[ -d /root/webmanager/.git ]] || git clone -q https://github.com/coolguy1333/WebManager.git /root/webmanager

install -m 755 wm-ha /usr/local/sbin/wm-ha
cat >/etc/wm-ha.conf <<EOF
SELF_IP=$SELF_IP
PEER_IP=$PEER_IP
GATEWAY=192.168.10.1
# 18 checks x 10 s = 3 minutes of primary downtime before promoting.
FAIL_LIMIT=18
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
Description=WebManager automatic failover check every 10 s

[Timer]
OnBootSec=30s
OnUnitInactiveSec=10s
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
cat >/etc/nginx/conf.d/wm-ha.conf <<'EOF'
# Role endpoint for the HAProxy failover on the Cloudflare connectors (wm-ha).
server {
    listen 8080;
    server_name wm-ha.internal;
    root /srv/wm-ha;
    default_type text/plain;
    access_log off;
    location = /role   { try_files /role =503; }
    location = /active { try_files /active =503; }
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
echo "role: $(cat /srv/wm-ha/role)  active: $([[ -e /srv/wm-ha/active ]] && echo yes || echo no)"
