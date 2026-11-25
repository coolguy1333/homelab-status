#!/usr/bin/env python3
"""Homelab agent: monitors and updates the LXC containers on one Proxmox host.

Runs on a connector container as user `agent`, reaching its Proxmox host as root over SSH.

  hl_agent.py report        collect status, auto-fix the obvious, send report, pick up approvals/tasks (every 5 min)
  hl_agent.py update        nightly: snapshot -> risk check -> update -> health check -> roll back if broken
  hl_agent.py action <id>   carry out an approved pending item (started by `report`)
  hl_agent.py task <id>     run a task sent from the dashboard through Claude (started by `report`)
  hl_agent.py show          print the report that would be sent

Config: ~/agent/config.json. State: ~/agent/state.json. Python standard library only.
"""
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

VERSION = "1.0.0"
HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, "agent")
CONFIG_FILE = os.path.join(BASE, "config.json")
STATE_FILE = os.path.join(BASE, "state.json")
LOCK_FILE = os.path.join(BASE, ".state.lock")
UPDATE_LOCK = os.path.join(BASE, ".update.lock")
LOG_DIR = os.path.join(BASE, "logs")
CLAUDE = os.path.join(HOME, ".local", "bin", "claude")
SELF = os.path.abspath(__file__)
DRY = "--dry-run" in sys.argv

APT_ENV = "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a"
APT_OPTS = "-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
# Packages where a major-version jump is likely to need hand work. Only used when Claude can't be asked.
RISKY_RE = re.compile(r"^(postgresql|mysql|mariadb|mongodb|redis|nginx|apache2|php\d|nodejs|docker|containerd|"
                      r"pihole|lighttpd|python3\.\d+$|openjdk|zfs|proxmox|pve-|libc6$|systemd$|openssh-server$)")


def now_ms():
    return int(time.time() * 1000)


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ------------------------------------------------------------------ config / state

def load_config():
    with open(CONFIG_FILE) as f:
        cfg = json.load(f)
    cfg.setdefault("site_urls", [])
    cfg.setdefault("keep_snapshots", 3)
    cfg.setdefault("exclude_vmids", [])
    cfg.setdefault("disk_warn_pct", 90)
    for u in cfg["site_urls"]:
        # Reports carry the agent token and infrastructure details: never send them in clear text.
        if not u.startswith("https://"):
            raise SystemExit(f"config: site URL {u!r} must start with https://")
    return cfg


CFG = None


@contextmanager
def state_lock():
    os.makedirs(BASE, exist_ok=True)
    with open(LOCK_FILE, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def read_state():
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        s = {}
    for k, d in (("events", []), ("pending", {}), ("containers", {}), ("tasks", {}), ("handled", {}),
                 ("cooldown", {}), ("updateRuns", []), ("host", {})):
        s.setdefault(k, d)
    return s


def write_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


@contextmanager
def state():
    """Read-modify-write the state file under a lock. Keep the body short."""
    with state_lock():
        s = read_state()
        yield s
        # bound everything
        s["events"] = s["events"][-300:]
        s["updateRuns"] = s["updateRuns"][-30:]
        cutoff = now_ms() - 14 * 86400e3
        s["tasks"] = {k: v for k, v in s["tasks"].items() if v.get("t", 0) > cutoff or v.get("status") == "running"}
        s["handled"] = {k: v for k, v in s["handled"].items() if v > cutoff}
        write_state(s)


def event(level, msg, s=None):
    log(f"[{level}] {msg}")
    e = {"id": secrets.token_hex(6), "t": now_ms(), "level": level, "msg": msg[:500]}
    if s is not None:
        s["events"].append(e)
    else:
        with state() as st:
            st["events"].append(e)


def cooled(s, key, seconds):
    """True (and arms the cooldown) if `key` hasn't fired within `seconds`."""
    last = s["cooldown"].get(key, 0)
    if now_ms() - last < seconds * 1000:
        return False
    s["cooldown"][key] = now_ms()
    return True


def add_pending(s, item):
    item.setdefault("t", now_ms())
    s["pending"][item["id"]] = item


# ------------------------------------------------------------------ remote execution

def ssh(cmd, timeout=120):
    """Run a shell command on the Proxmox host as root. Returns (rc, combined output)."""
    sock = os.path.join(HOME, ".ssh", "cm-%r@%h")
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
            "-o", "ControlMaster=auto", "-o", f"ControlPath={sock}", "-o", "ControlPersist=120",
            f"root@{CFG['host']}", cmd]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"


def ssh_json(cmd, timeout=60):
    rc, out = ssh(cmd, timeout)
    if rc != 0:
        raise RuntimeError(out[-300:])
    return json.loads(out)


def cx(vmid, cmd, timeout=300):
    """Run a shell command inside a container."""
    return ssh(f"pct exec {int(vmid)} -- sh -c {shlex.quote(cmd)}", timeout)


def claude(prompt, timeout=1800):
    """Run Claude non-interactively in ~/agent (where CLAUDE.md describes the setup)."""
    try:
        p = subprocess.run([CLAUDE, "-p", prompt, "--output-format", "text"], cwd=BASE,
                           capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "").strip()
        if p.returncode != 0:
            out = (out + "\n" + (p.stderr or "")).strip()
        return p.returncode, out
    except subprocess.TimeoutExpired:
        return 124, f"Claude did not finish within {timeout // 60} minutes."
    except FileNotFoundError:
        return 127, "claude is not installed"


def spawn(*args):
    """Start `hl_agent.py <args>` in the background, outliving this process."""
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, f"{args[0]}-{args[1] if len(args) > 1 else 'x'}.log"), "a")
    subprocess.Popen([sys.executable, SELF, *args], stdout=logf, stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True, cwd=BASE)


# ------------------------------------------------------------------ collection

def node_name():
    rc, out = ssh("hostname")
    if rc != 0:
        raise RuntimeError(f"cannot reach Proxmox host {CFG['host']}: {out[-200:]}")
    return out.strip()


def collect(s):
    node = node_name()
    st = ssh_json(f"pvesh get /nodes/{node}/status --output-format json")
    storage = ssh_json(f"pvesh get /nodes/{node}/storage --output-format json")
    lxc = ssh_json(f"pvesh get /nodes/{node}/lxc --output-format json")
    rc, onboot_out = ssh("grep -H '^onboot:' /etc/pve/lxc/*.conf 2>/dev/null; true")
    onboot = {int(m.group(1)): m.group(2) == "1" for m in re.finditer(r"/(\d+)\.conf:onboot:\s*(\d)", onboot_out)}
    rc, kern = ssh("uname -r; ls /lib/modules | sort -V | tail -1; test -f /var/run/reboot-required && echo REBOOT")
    kl = kern.split()
    reboot = "REBOOT" in kl or (len(kl) >= 2 and kl[0] != kl[1] and "-pve" in kl[1])

    mem = st.get("memory", {})
    host = {
        "node": node, "ip": CFG["host"],
        "cpu": st.get("cpu"), "uptime": st.get("uptime"),
        "loadavg": st.get("loadavg"),
        "memory": {"total": mem.get("total"), "used": mem.get("used")},
        "kernel": (st.get("current-kernel") or {}).get("release") or (kl[0] if kl else None),
        "pveVersion": (st.get("pveversion") or "").replace("pve-manager/", ""),
        "storage": [{"name": x.get("storage"), "type": x.get("type"), "total": x.get("total"), "used": x.get("used")}
                    for x in storage if x.get("active")],
        "rebootRequired": reboot,
        "updates": s["host"].get("updates", {}),
    }
    containers = []
    for c in lxc:
        vmid = int(c["vmid"])
        if c.get("template"):
            continue
        cs = s["containers"].get(str(vmid), {})
        containers.append({
            "vmid": vmid, "name": c.get("name"), "status": c.get("status"),
            "onboot": onboot.get(vmid, False), "self": vmid == CFG.get("self_vmid"),
            "cpu": c.get("cpu"), "mem": c.get("mem"), "maxmem": c.get("maxmem"),
            "disk": c.get("disk"), "maxdisk": c.get("maxdisk"), "uptime": c.get("uptime"),
            "updates": cs.get("updates"), "lastUpdate": cs.get("lastUpdate"),
        })
    return host, containers


def autofix(s, host, containers):
    """Cheap, safe fixes done without Claude. Anything harder goes to Claude, at most every few hours."""
    for c in containers:
        vmid = c["vmid"]
        if c["onboot"] and c["status"] != "running" and vmid not in CFG["exclude_vmids"]:
            if cooled(s, f"start:{vmid}", 900):
                rc, out = ssh(f"pct start {vmid}", 120)
                if rc == 0:
                    event("warn", f"{c['name']} ({vmid}) was {c['status']}; started it again", s)
                    c["status"] = "starting"
                else:
                    event("error", f"{c['name']} ({vmid}) is {c['status']} and would not start: {out[-200:]}", s)
                    if cooled(s, f"claudefix:{vmid}", 6 * 3600):
                        queue_internal_task(s, f"Container {c['name']} (vmid {vmid}) on this host is {c['status']} and "
                                               f"`pct start {vmid}` failed with:\n{out[-1500:]}\n\nFind out why and fix it "
                                               f"so it runs again. Take a snapshot first if you change anything inside it.")
        if c["maxdisk"] and c["disk"] and c["disk"] / c["maxdisk"] * 100 >= CFG["disk_warn_pct"]:
            if cooled(s, f"disk:{vmid}", 86400):
                event("warn", f"{c['name']} ({vmid}) disk is {c['disk'] / c['maxdisk'] * 100:.0f}% full", s)
    for x in host["storage"]:
        if x["total"] and x["used"] and x["used"] / x["total"] * 100 >= CFG["disk_warn_pct"]:
            if cooled(s, f"storage:{x['name']}", 86400):
                event("warn", f"Host storage {x['name']} is {x['used'] / x['total'] * 100:.0f}% full", s)


def queue_internal_task(s, text):
    tid = "i" + secrets.token_hex(5) + "0"
    s["tasks"][tid] = {"id": tid, "text": text, "by": "agent (auto-fix)", "status": "running", "output": "", "t": now_ms(),
                       "internal": True}
    spawn("task", tid)


# ------------------------------------------------------------------ report

def build_report(s, host, containers):
    tasks = [{"id": t["id"], "status": t["status"], "output": t.get("output", "")[-20000:]}
             for t in s["tasks"].values() if not t.get("internal")]
    pending = sorted(s["pending"].values(), key=lambda p: p["t"])
    internal = [t for t in s["tasks"].values() if t.get("internal")]
    events = list(s["events"][-100:])
    return {
        "agent": CFG["name"], "agentVersion": VERSION, "generatedAt": now_ms(),
        "host": host, "containers": containers, "pending": pending,
        "events": events, "updateRuns": s["updateRuns"][-20:],
        "autoTasks": [{"t": t["t"], "status": t["status"], "text": t["text"][:300], "output": t.get("output", "")[-4000:]}
                      for t in internal[-5:]],
        "taskResults": tasks, "acked": list(s["handled"].keys()),
    }


def post(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/agent/report", data=data, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {CFG['token']}",
        "User-Agent": f"homelab-agent/{VERSION}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")


def cmd_report(send=True):
    with state() as s:
        try:
            host, containers = collect(s)
            s["lastCollect"] = {"host": host, "containers": containers}
            if s.get("hostDownSince"):
                event("info", f"Proxmox host {CFG['host']} reachable again", s)
                s.pop("hostDownSince", None)
        except Exception as e:  # host unreachable: still report that
            if not s.get("hostDownSince"):
                s["hostDownSince"] = now_ms()
                event("error", f"Cannot reach Proxmox host {CFG['host']}: {e}", s)
            last = s.get("lastCollect") or {"host": {"node": None, "ip": CFG["host"], "storage": []}, "containers": []}
            host, containers = last["host"], last["containers"]
            host = dict(host, unreachable=True)
        else:
            autofix(s, host, containers)
        report = build_report(s, host, containers)

    if not send:
        print(json.dumps(report, indent=2))
        return
    replies = []
    for url in CFG["site_urls"]:
        try:
            replies.append(post(url, report))
        except (urllib.error.URLError, OSError, ValueError) as e:
            log(f"report to {url} failed: {e}")
    if not replies:
        return

    decisions, tasks = {}, {}
    for r in replies:
        for d in r.get("decisions", []):
            decisions[d["id"]] = d
        for t in r.get("tasks", []):
            tasks[t["id"]] = t
    with state() as s:
        for did, d in decisions.items():
            if did in s["handled"]:
                continue
            s["handled"][did] = now_ms()
            item = s["pending"].get(did)
            if not item:
                continue
            if d["decision"] == "approve":
                item["approvedBy"] = d.get("by")
                item["status"] = "approved"
                event("info", f"Approved by {d.get('by')}: {item['summary']}", s)
                spawn("action", did)
            else:
                event("info", f"Denied by {d.get('by')}: {item['summary']}", s)
                s["pending"].pop(did, None)
        for tid, t in tasks.items():
            if tid in s["tasks"]:
                continue
            s["tasks"][tid] = {"id": tid, "text": t["text"], "by": t.get("by"), "status": "running", "output": "",
                               "t": now_ms()}
            spawn("task", tid)


# ------------------------------------------------------------------ tasks (Claude)

def cmd_task(tid):
    with state() as s:
        t = s["tasks"].get(tid)
        if not t:
            return
        text, by, internal = t["text"], t.get("by"), t.get("internal")
    who = "this agent's own monitoring" if internal else f"{by} via the status dashboard"
    prompt = (f"Request from {who}:\n\n{text}\n\n"
              "You are this Proxmox host's homelab agent (see CLAUDE.md for the setup and rules). "
              "Do what is asked; if it is a question, answer it from real data you look up. "
              "Finish with a short plain-text summary of what you found and anything you changed.")
    rc, out = claude(prompt)
    with state() as s:
        t = s["tasks"].get(tid)
        if t:
            t["status"] = "done" if rc == 0 else "failed"
            t["output"] = out[-20000:] or "(no output)"
        if internal:
            event("info" if rc == 0 else "error", f"Auto-fix finished: {out.strip().splitlines()[-1][:300] if out.strip() else 'no output'}", s)
    cmd_report()  # get the answer onto the dashboard right away


# ------------------------------------------------------------------ updates

def parse_upgradable(out):
    pkgs = []
    for line in out.splitlines():
        m = re.match(r"^(\S+?)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s+(\S+)\]", line)
        if m:
            pkgs.append({"name": m.group(1), "suite": m.group(2), "new": m.group(3), "old": m.group(4),
                         "security": "security" in m.group(2)})
    return pkgs


def major(v):
    v = re.sub(r"^\d+:", "", v)
    m = re.match(r"(\d+)(?:\.(\d+))?", v)
    return (m.group(1), m.group(2)) if m else (v, None)


def fallback_risk(pkgs, removals):
    reasons = []
    if removals:
        reasons.append(f"would remove packages: {', '.join(removals[:10])}")
    for p in pkgs:
        if RISKY_RE.match(p["name"]) and major(p["new"])[0] != major(p["old"])[0]:
            reasons.append(f"{p['name']} major version {p['old']} -> {p['new']}")
    return ("high" if reasons else "low"), reasons


def risk_review(name, pkgs, removals):
    """Ask Claude whether these updates could break the container. Returns (risk, reasons)."""
    listing = "\n".join(f"{p['name']} {p['old']} -> {p['new']} ({p['suite']})" for p in pkgs[:300])
    prompt = (f"You are reviewing pending apt updates for the Proxmox LXC container '{name}' before they are installed "
              f"automatically overnight (non-interactive, keeping existing config files, with a snapshot and automatic "
              f"rollback if services break afterwards).\n\nPackages:\n{listing}\n\n"
              f"Packages apt would REMOVE: {', '.join(removals) or 'none'}\n\n"
              "Say 'high' risk only for things likely to break a running service or need manual steps: major version "
              "upgrades of databases/servers/runtimes, a Debian/Ubuntu release change, package removals, known "
              "breaking upgrades. Normal point releases and security fixes are 'low'. You may inspect the container "
              "with read-only commands if it helps (ssh to the host, pct exec). Do not change anything.\n"
              'Reply with ONLY a JSON object: {"risk": "low" or "high", "reasons": ["..."]}')
    rc, out = claude(prompt, timeout=600)
    m = re.search(r"\{.*\}", out, re.S)
    if rc == 0 and m:
        try:
            j = json.loads(m.group(0))
            if j.get("risk") in ("low", "high"):
                return j["risk"], [str(r) for r in j.get("reasons", [])][:10]
        except json.JSONDecodeError:
            pass
    risk, reasons = fallback_risk(pkgs, removals)
    return risk, reasons + ["(Claude review unavailable; used built-in rules)"]


def health(vmid):
    """Snapshot of what's working inside a container: running?, failed systemd units, listening TCP ports."""
    rc, out = ssh(f"pct status {int(vmid)}")
    running = "running" in out
    if not running:
        return {"running": False, "failed": set(), "ports": set()}
    rc, out = cx(vmid, "systemctl list-units --failed --plain --no-legend --no-pager 2>/dev/null | awk '{print $1}';"
                       " echo ---; ss -ltnH 2>/dev/null | awk '{print $4}'", 60)
    failed_part, _, ports_part = out.partition("---")
    ports = set()
    for a in ports_part.split():
        port = a.rsplit(":", 1)[-1]
        if port.isdigit():
            ports.add(port)
    return {"running": True, "failed": set(failed_part.split()), "ports": ports}


def broken(pre, post):
    problems = []
    if pre["running"] and not post["running"]:
        problems.append("container is not running")
    new_failed = post["failed"] - pre["failed"]
    if new_failed:
        problems.append("services failed: " + ", ".join(sorted(new_failed)[:10]))
    lost = pre["ports"] - post["ports"]
    if lost:
        problems.append("stopped listening on ports: " + ", ".join(sorted(lost, key=int)[:15]))
    return problems


def wait_running(vmid, secs=180):
    end = time.time() + secs
    while time.time() < end:
        rc, out = ssh(f"pct status {int(vmid)}")
        if "running" in out:
            return True
        time.sleep(5)
    return False


def snapshots(vmid):
    rc, out = ssh(f"pct listsnapshot {int(vmid)}")
    return re.findall(r"(hlauto\d{12})", out)


def prune_snapshots(vmid):
    snaps = sorted(set(snapshots(vmid)))
    for name in snaps[:-CFG["keep_snapshots"]] if len(snaps) > CFG["keep_snapshots"] else []:
        rc, out = ssh(f"pct delsnapshot {int(vmid)} {name}", 600)
        if rc != 0:
            log(f"could not delete snapshot {name} of {vmid}: {out[-200:]}")


def set_container(vmid, **kw):
    with state() as s:
        s["containers"].setdefault(str(vmid), {}).update(kw)


def update_container(vmid, name, mode="auto"):
    """mode: auto (nightly), full (approved). Returns a short result string for the run summary."""
    is_self = vmid == CFG.get("self_vmid")
    label = f"{name} ({vmid})"
    rc, out = cx(vmid, "command -v apt-get >/dev/null || { echo NOAPT; exit 0; }; apt-get update -q 2>&1 | tail -5", 900)
    if "NOAPT" in out:
        return f"{label}: skipped (no apt)"
    if rc != 0:
        set_container(vmid, lastUpdate={"t": now_ms(), "result": "failed", "msg": f"apt-get update failed: {out[-200:]}"})
        event("warn", f"{label}: apt-get update failed: {out[-200:]}")
        return f"{label}: apt-get update failed"
    rc, out = cx(vmid, "apt list --upgradable 2>/dev/null", 120)
    pkgs = parse_upgradable(out)
    sec = [p for p in pkgs if p["security"]]
    set_container(vmid, updates={"count": len(pkgs), "security": len(sec), "checkedAt": now_ms()})
    if not pkgs:
        return f"{label}: up to date"

    with state() as s:
        blocked = s["containers"].get(str(vmid), {}).get("blocked")
    rc, sim = cx(vmid, "apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>&1", 300)
    removals = re.findall(r"^Remv (\S+)", sim, re.M)

    if mode == "full":
        plan, reasons = "full", []
    elif blocked:
        plan, reasons = ("security" if sec else "none"), [f"full updates paused: {blocked}"]
    else:
        risk, reasons = risk_review(name, pkgs, removals)
        plan = "full" if risk == "low" else ("security" if sec else "none")

    if DRY:
        return (f"{label}: DRY RUN plan={plan} pkgs={len(pkgs)} security={len(sec)} removals={removals[:5]} "
                f"reasons={reasons[:3]} health={ {k: sorted(v) if isinstance(v, set) else v for k, v in health(vmid).items()} }")

    if plan != "full" and mode != "full":
        # Leave the rest for the user to approve.
        others = [p for p in pkgs if not p["security"]] if plan == "security" else pkgs
        pid = f"ct-update-{vmid}-" + hashlib.sha1(json.dumps([(p['name'], p['new']) for p in others]).encode()).hexdigest()[:8]
        with state() as s:
            for k in [k for k, v in s["pending"].items() if v.get("kind") == "risky-update" and v.get("vmid") == vmid and k != pid]:
                s["pending"].pop(k)
            if pid not in s["pending"]:
                add_pending(s, {"id": pid, "kind": "risky-update", "vmid": vmid,
                                "summary": f"Install {len(others)} held-back update(s) on {label}",
                                "details": "Why they were held back:\n- " + "\n- ".join(reasons or ["(no reason given)"]) +
                                           "\n\nPackages:\n" + "\n".join(f"{p['name']} {p['old']} -> {p['new']}" for p in others[:200]) +
                                           (f"\n\nWould remove: {', '.join(removals)}" if removals else "") +
                                           "\n\nApproving takes a snapshot, installs everything, and rolls back automatically if services break."})
        if plan == "none":
            set_container(vmid, lastUpdate={"t": now_ms(), "result": "held", "msg": "; ".join(reasons)[:300]})
            return f"{label}: {len(pkgs)} update(s) held for approval"

    # Snapshot first. Without one there is no rollback, so only security fixes go in.
    snap = "hlauto" + time.strftime("%Y%m%d%H%M")
    rc, out = ssh(f"pct snapshot {int(vmid)} {snap} --description 'homelab agent: before updates'", 600)
    if rc != 0:
        event("warn", f"{label}: snapshot failed ({out[-150:]}); installing security updates only, no rollback possible")
        snap = None
        if plan == "full" and mode != "full":
            plan = "security" if sec else "none"
        if plan == "none":
            set_container(vmid, lastUpdate={"t": now_ms(), "result": "held", "msg": "snapshot failed"})
            return f"{label}: snapshot failed, nothing installed"

    pre = health(vmid)
    if plan == "full":
        cmd = f"{APT_ENV} apt-get {APT_OPTS} dist-upgrade 2>&1 | tail -30"
        what = f"{len(pkgs)} update(s)"
    else:
        names = " ".join(shlex.quote(p["name"]) for p in sec)
        cmd = f"{APT_ENV} apt-get {APT_OPTS} install --only-upgrade {names} 2>&1 | tail -30"
        what = f"{len(sec)} security update(s)"
    rc, out = cx(vmid, cmd, 3600)
    apt_ok = "E: " not in out
    rc2, rr = cx(vmid, "test -f /var/run/reboot-required && echo YES || true", 60)
    needs_reboot = "YES" in rr

    if is_self:
        # Can't watch our own reboot or roll ourselves back from inside: hand those to the host.
        if needs_reboot:
            ssh(f"systemd-run --on-active=90 --unit=hl-selfreboot-{snap or 'x'} pct reboot {int(vmid)}")
            event("info", f"{label}: updated ({what}); rebooting this agent's container in 90 s")
        result = "ok" if apt_ok else "failed"
        set_container(vmid, lastUpdate={"t": now_ms(), "result": result, "msg": f"{what}; {out[-200:] if not apt_ok else 'done'}"},
                      updates={"count": 0 if plan == "full" else len(pkgs) - len(sec), "security": 0, "checkedAt": now_ms()})
        if snap:
            prune_snapshots(vmid)
        return f"{label}: {what} installed{' (reboot scheduled)' if needs_reboot else ''}"

    if needs_reboot:
        ssh(f"pct reboot {int(vmid)}", 300)
        wait_running(vmid)
    time.sleep(15)
    post_h = health(vmid)
    problems = broken(pre, post_h)
    if problems:  # services can be slow to come back: look again before deciding
        time.sleep(45)
        post_h = health(vmid)
        problems = broken(pre, post_h)

    if problems and snap:
        rc, out2 = ssh(f"pct stop {int(vmid)}; pct rollback {int(vmid)} {snap} && pct start {int(vmid)}", 900)
        msg = f"{label}: update broke it ({'; '.join(problems)}); rolled back to {snap}" + ("" if rc == 0 else f" — ROLLBACK FAILED: {out2[-200:]}")
        event("error", msg)
        set_container(vmid, lastUpdate={"t": now_ms(), "result": "rolled-back" if rc == 0 else "failed", "msg": msg},
                      blocked=f"rolled back on {time.strftime('%Y-%m-%d')} ({'; '.join(problems)[:150]})")
        with state() as s:
            pid = f"ct-retry-{vmid}"
            add_pending(s, {"id": pid, "kind": "risky-update", "vmid": vmid,
                            "summary": f"Retry updates on {label} (last attempt was rolled back)",
                            "details": f"Problems after updating:\n- " + "\n- ".join(problems) + f"\n\napt output (tail):\n{out[-3000:]}"
                                       "\n\nAutomatic full updates for this container are paused until you approve a retry. "
                                       "Security updates still go in. You can also ask the agent to investigate."})
        return f"{label}: ROLLED BACK ({'; '.join(problems)})"
    if problems:
        event("error", f"{label}: after updates: {'; '.join(problems)} (no snapshot to roll back to)")
        set_container(vmid, lastUpdate={"t": now_ms(), "result": "failed", "msg": "; ".join(problems)})
        return f"{label}: BROKEN after update, no snapshot"

    result = "ok" if apt_ok else "failed"
    remaining = 0 if plan == "full" else len(pkgs) - len(sec)
    set_container(vmid, lastUpdate={"t": now_ms(), "result": result, "msg": f"{what}" + ("" if apt_ok else f": {out[-200:]}")},
                  updates={"count": remaining, "security": 0, "checkedAt": now_ms()},
                  **({"blocked": None} if mode == "full" else {}))
    if plan == "full":
        with state() as s:
            for k in [k for k, v in s["pending"].items() if v.get("kind") == "risky-update" and v.get("vmid") == vmid]:
                s["pending"].pop(k)
    if snap:
        prune_snapshots(vmid)
    return f"{label}: {what} installed" + (" and rebooted" if needs_reboot else "") + ("" if apt_ok else " (apt reported errors)")


def check_host_updates():
    rc, out = ssh("apt-get update -q >/dev/null 2>&1; apt list --upgradable 2>/dev/null", 900)
    pkgs = parse_upgradable(out)
    with state() as s:
        s["host"]["updates"] = {"count": len(pkgs), "security": sum(p["security"] for p in pkgs), "checkedAt": now_ms()}
        for k in [k for k, v in s["pending"].items() if v.get("kind") == "host-update" and v.get("status") != "approved"]:
            s["pending"].pop(k)
        if pkgs:
            pid = "host-update-" + hashlib.sha1(json.dumps([(p['name'], p['new']) for p in pkgs]).encode()).hexdigest()[:8]
            add_pending(s, {"id": pid, "kind": "host-update",
                            "summary": f"Update the Proxmox host ({len(pkgs)} package(s), {sum(p['security'] for p in pkgs)} security)",
                            "details": "\n".join(f"{p['name']} {p['old']} -> {p['new']}" for p in pkgs[:300]) +
                                       "\n\nApproving runs `apt full-upgrade` on the host (keeping config files). "
                                       "Containers keep running. If a new kernel arrives, a separate reboot approval appears."})
        last = s.get("lastCollect", {}).get("host", {})
        if last.get("rebootRequired") and not any(v.get("kind") == "host-reboot" for v in s["pending"].values()):
            add_pending(s, {"id": "host-reboot-" + time.strftime("%Y%m%d"), "kind": "host-reboot",
                            "summary": f"Reboot Proxmox host {last.get('node') or CFG['host']} (new kernel/updates need it)",
                            "details": "All containers on this host, including this agent, go down for a few minutes and "
                                       "start again automatically (those set to start on boot)."})
    return len(pkgs)


def cmd_update():
    with open(UPDATE_LOCK, "w") as lf:
        try:
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another update run is in progress")
            return
        started = now_ms()
        node = node_name()
        lxc = ssh_json(f"pvesh get /nodes/{node}/lxc --output-format json")
        targets = []
        for c in lxc:
            vmid = int(c["vmid"])
            if c.get("template") or c.get("status") != "running" or vmid in CFG["exclude_vmids"]:
                continue
            rc, conf = ssh(f"pct config {vmid}")
            if not re.search(r"^ostype:\s*(debian|ubuntu)", conf, re.M):
                continue
            targets.append((vmid, c.get("name") or str(vmid)))
        targets.sort(key=lambda t: (t[0] == CFG.get("self_vmid"), t[0]))  # ourselves last
        results = []
        for vmid, name in targets:
            try:
                results.append(update_container(vmid, name))
            except Exception as e:
                results.append(f"{name} ({vmid}): error {e}")
                event("error", f"{name} ({vmid}): update run crashed: {e}")
            log(results[-1])
        if DRY:
            print("\n".join(results))
            return
        try:
            n = check_host_updates()
            results.append(f"host: {n} update(s) waiting for approval" if n else "host: up to date")
        except Exception as e:
            results.append(f"host: update check failed: {e}")
        bad = [r for r in results if "ROLLED BACK" in r or "BROKEN" in r or "error" in r or "failed" in r]
        held = [r for r in results if "held" in r]
        summary = (f"{len(targets)} container(s) checked in {round((now_ms() - started) / 60000)} min" +
                   (f"; {len(bad)} problem(s)" if bad else "") + (f"; {len(held)} with updates held" if held else ""))
        with state() as s:
            s["updateRuns"].append({"t": now_ms(), "level": "error" if bad else "warn" if held else "info",
                                    "summary": summary + "\n" + "\n".join(results)})
        event("error" if bad else "info", "Nightly update: " + summary)
    cmd_report()


# ------------------------------------------------------------------ approved actions

def cmd_action(pid):
    with state() as s:
        item = s["pending"].get(pid)
    if not item:
        return
    kind = item.get("kind")
    try:
        if kind == "host-update":
            event("info", "Updating the Proxmox host (approved)")
            rc, out = ssh(f"apt-get update -q >/dev/null 2>&1; {APT_ENV} apt-get {APT_OPTS} dist-upgrade 2>&1 | tail -40", 3600)
            event("info" if "E: " not in out else "error", f"Host update finished: {out.strip().splitlines()[-1][:300] if out.strip() else 'no output'}")
            with state() as s:
                s["pending"].pop(pid, None)
                host, containers = collect(s)  # refreshes the "reboot needed" flag
                s["lastCollect"] = {"host": host, "containers": containers}
            check_host_updates()
        elif kind == "host-reboot":
            event("warn", "Rebooting the Proxmox host in 60 s (approved). This agent goes down with it.")
            with state() as s:
                s["pending"].pop(pid, None)
            cmd_report()
            ssh("systemd-run --on-active=60 --unit=hl-host-reboot /bin/systemctl reboot")
            return
        elif kind == "risky-update":
            vmid = int(item["vmid"])
            rc, out = ssh(f"pct config {vmid} | sed -n 's/^hostname: //p'")
            name = out.strip() or str(vmid)
            with open(UPDATE_LOCK, "w") as lf:
                fcntl.flock(lf, fcntl.LOCK_EX)
                r = update_container(vmid, name, mode="full")
            event("info", f"Approved update: {r}")
            with state() as s:
                s["pending"].pop(pid, None)
        else:
            event("warn", f"Don't know how to do approved item {pid} ({kind})")
    except Exception as e:
        event("error", f"Approved action {item.get('summary')} failed: {e}")
    cmd_report()


# ------------------------------------------------------------------ main

def main():
    global CFG
    CFG = load_config()
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    sys.argv = [sys.argv[0]] + args
    cmd = args[0] if args else "show"
    if cmd == "report":
        cmd_report()
    elif cmd == "show":
        cmd_report(send=False)
    elif cmd == "update":
        cmd_update()
    elif cmd == "action" and len(sys.argv) > 2:
        cmd_action(sys.argv[2])
    elif cmd == "task" and len(sys.argv) > 2:
        cmd_task(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
