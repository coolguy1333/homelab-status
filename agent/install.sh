#!/usr/bin/env bash
# Install / upgrade the homelab agent automation on a connector container. Run as root in the connector.
#   bash install.sh <name> <proxmox-host-ip> <own-vmid> [update-time HH:MM] [site-url ...]
#   e.g. bash install.sh connector1 192.168.10.23 200 04:00 https://status.example.com
# Re-running keeps the existing token and config, and updates the scripts, units, and firewall.
set -euo pipefail
NAME=${1:?name}; HOST=${2:?proxmox host ip}; VMID=${3:?own vmid}; UPDATE_AT=${4:-04:00}; shift 4 || true
SITES=("$@")
HERE=$(cd "$(dirname "$0")" && pwd)
A=/home/agent/agent
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

install -d -o agent -g agent -m 700 "$A" "$A/logs"
install -o agent -g agent -m 755 "$HERE/hl_agent.py" "$A/hl_agent.py"
sed -e "s/__NAME__/$NAME/g" -e "s/__HOST__/$HOST/g" -e "s/__SELF_VMID__/$VMID/g" "$HERE/CLAUDE.md.tmpl" > "$A/CLAUDE.md"
chown agent:agent "$A/CLAUDE.md"

# config.json: keep the token if one exists; set the host, vmid, and (if given) site URLs.
python3 - "$A/config.json" "$NAME" "$HOST" "$VMID" "$UPDATE_AT" "${SITES[@]}" <<'EOF'
import json, os, secrets, sys
path, name, host, vmid, update_at, *sites = sys.argv[1:]
try:
    cfg = json.load(open(path))
except FileNotFoundError:
    cfg = {}
cfg.update({"name": name, "host": host, "self_vmid": int(vmid), "update_time": update_at})
cfg.setdefault("token", secrets.token_urlsafe(32))
cfg.setdefault("site_urls", [])
if sites:
    cfg["site_urls"] = sites
cfg.setdefault("keep_snapshots", 3)
cfg.setdefault("exclude_vmids", [])
fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(path + ".tmp", path)
EOF
chown agent:agent "$A/config.json"; chmod 600 "$A/config.json"

cat > /etc/systemd/system/hl-report.service <<EOF
[Unit]
Description=Homelab agent: report status ($NAME)
After=network-online.target
[Service]
Type=oneshot
User=agent
WorkingDirectory=$A
Environment=HOME=/home/agent PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $A/hl_agent.py report
# Tasks and approved actions it starts must outlive this run.
KillMode=process
TimeoutStartSec=10min
EOF
cat > /etc/systemd/system/hl-report.timer <<EOF
[Unit]
Description=Homelab agent: report every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/hl-poll.service <<EOF
[Unit]
Description=Homelab agent: instant pickup of dashboard requests ($NAME)
After=network-online.target
Wants=network-online.target
[Service]
User=agent
WorkingDirectory=$A
Environment=HOME=/home/agent PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $A/hl_agent.py poll
# Tasks it starts must survive a restart of this service.
KillMode=process
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/hl-update.service <<EOF
[Unit]
Description=Homelab agent: nightly container updates ($NAME)
After=network-online.target
[Service]
Type=oneshot
User=agent
WorkingDirectory=$A
Environment=HOME=/home/agent PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $A/hl_agent.py update
KillMode=process
TimeoutStartSec=8h
EOF
cat > /etc/systemd/system/hl-update.timer <<EOF
[Unit]
Description=Homelab agent: nightly updates at $UPDATE_AT
[Timer]
OnCalendar=*-*-* $UPDATE_AT:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

# ---- firewall: this container may reach only its Proxmox host, DNS, and the internet.
command -v nft >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables >/dev/null
DNS=$(awk '/^nameserver/{print $2}' /etc/resolv.conf | grep -E '^[0-9.]+$' | paste -sd, -)
# This container's own LAN subnet (e.g. 192.168.10.0/24). Tunnels (cloudflared, playit) on the connectors
# forward to services there, so the subnet stays reachable; every other private network is blocked.
LAN=$(ip -4 -o route show scope link dev eth0 2>/dev/null | awk '{print $1}' | grep -E '^[0-9.]+/[0-9]+$' | head -1)
LAN_RULE=""
[ -n "$LAN" ] && LAN_RULE="ip daddr $LAN accept"
DNS_RULES=""
[ -n "$DNS" ] && DNS_RULES="ip daddr { $DNS } meta l4proto { udp, tcp } th dport 53 accept"
cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# Managed by homelab agent install.sh. Egress: own LAN subnet ($LAN) + DNS + internet; other private networks blocked.
flush ruleset
table inet hl {
  set private4 { type ipv4_addr; flags interval; elements = { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } }
  chain output {
    type filter hook output priority 0; policy accept;
    oif lo accept
    ct state established,related accept
    ip daddr $HOST tcp dport { 22, 8006 } accept
    $LAN_RULE
    $DNS_RULES
    udp dport { 67, 68 } accept
    ip daddr @private4 counter reject with icmp type admin-prohibited
    ip6 daddr fc00::/7 counter reject
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto { icmp, ipv6-icmp } accept
    udp dport 41641 accept
    udp sport { 67, 68 } accept
  }
}
EOF
nft -c -f /etc/nftables.conf
systemctl enable -q nftables
systemctl restart nftables

# Let the agent user ping container IPs (uptime checks) without raw-socket privileges.
G=$(id -g agent)
echo "net.ipv4.ping_group_range = $G $G" > /etc/sysctl.d/90-hl-agent-ping.conf
sysctl -q -p /etc/sysctl.d/90-hl-agent-ping.conf || true

systemctl daemon-reload
systemctl enable -q --now hl-report.timer hl-update.timer hl-poll.service
systemctl restart hl-poll.service
echo "installed $NAME (host $HOST, vmid $VMID, updates at $UPDATE_AT)"
echo "AGENT_TOKENS entry: $NAME:$(python3 -c "import json;print(json.load(open('$A/config.json'))['token'])")"
