#!/usr/bin/env python3
"""Homelab agent: monitors and updates the LXC containers on one Proxmox host.

Runs on a connector container as user `agent`, reaching its Proxmox host as root over SSH.

  hl_agent.py report        collect status, auto-fix the obvious, send report, pick up approvals/tasks (every 5 min)
  hl_agent.py update        nightly: snapshot -> risk check -> update -> health check -> roll back if broken
                            (security updates only when the dashboard's nightly policy says so)
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
import ssl
import hashlib as _hashlib
import socket
from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

VERSION = "1.9.0"
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


LOG_FILE = os.path.join(LOG_DIR, "agent.log")
PROC = "agent"   # which command this process runs (report, update, task, ...); set in main()


def log(msg, level="info"):
    """Log to stderr (journal / per-run file) and to ~/agent/logs/agent.log, whose tail the dashboard shows."""
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 2_000_000:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"t": now_ms(), "p": PROC, "l": level, "m": str(msg)[:2000]}) + "\n")
    except OSError:
        pass


def log_tail(n=300):
    """The newest `n` lines of agent.log."""
    try:
        with open(LOG_FILE, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 600_000))
            raw = f.read().decode("utf-8", "replace").splitlines()[-n:]
    except OSError:
        return []
    out = []
    for line in raw:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass  # a line cut in half by the seek
    return out


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
    log(f"[{level}] {msg}", level)
    e = {"id": secrets.token_hex(6), "t": now_ms(), "level": level, "msg": msg[:500]}

    def add(st):
        st["events"].append(e)
        p = st.get("progress")
        if p and p.get("id") == OWN_RUN:  # also into the log of the update this process is running
            p.setdefault("log", []).append({"t": e["t"], "l": level, "m": msg[:2000]})
    if s is not None:
        add(s)
    else:
        with state() as st:
            add(st)


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

def ssh(cmd, timeout=120, stdout_only=False):
    """Run a shell command on the Proxmox host as root. Returns (rc, combined output), or just stdout
    with stdout_only (for machine-readable output, so warnings on stderr can't corrupt it)."""
    sock = os.path.join(HOME, ".ssh", "cm-%r@%h")
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
            "-o", "ControlMaster=auto", "-o", f"ControlPath={sock}", "-o", "ControlPersist=120",
            f"root@{CFG['host']}", cmd]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if stdout_only:
            return p.returncode, p.stdout.strip() if p.returncode == 0 else (p.stdout + p.stderr).strip()
        return p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"


def ssh_json(cmd, timeout=60):
    rc, out = ssh(cmd, timeout, stdout_only=True)
    if rc != 0:
        raise RuntimeError(out[-300:])
    return json.loads(out)


def cx(vmid, cmd, timeout=300):
    """Run a shell command inside a container."""
    return ssh(f"pct exec {int(vmid)} -- sh -c {shlex.quote(cmd)}", timeout)


LAST_USAGE = {}
LAST_SESSION = None


def claude(prompt, timeout=1800, kind="task", label="", resume=None):
    """Run Claude non-interactively in ~/agent (where CLAUDE.md describes the setup).
    Returns (rc, text). Token usage of the run is recorded (see record_usage) and left in LAST_USAGE."""
    global LAST_USAGE, LAST_SESSION
    LAST_USAGE, LAST_SESSION = {}, None
    args = [CLAUDE, "-p", prompt, "--output-format", "json"] + (["--resume", resume] if resume else [])
    try:
        p = subprocess.run(args, cwd=BASE, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, f"Claude did not finish within {timeout // 60} minutes."
    except FileNotFoundError:
        return 127, "claude is not installed"
    raw = (p.stdout or "").strip()
    try:
        d = json.loads(raw.splitlines()[-1] if raw else "{}")
    except ValueError:
        d = {}
    if not d:
        if resume:  # the old session is gone (pruned, reinstalled…): start fresh instead of failing
            return claude(prompt, timeout, kind, label, resume=None)
        return p.returncode or 1, (raw + "\n" + (p.stderr or "")).strip() or "no output"
    LAST_SESSION = d.get("session_id")
    u = d.get("usage") or {}
    models = list((d.get("modelUsage") or {}).keys())
    LAST_USAGE = {
        "t": now_ms(), "kind": kind, "label": label[:120],
        "input": u.get("input_tokens", 0), "output": u.get("output_tokens", 0),
        "cacheRead": u.get("cache_read_input_tokens", 0), "cacheWrite": u.get("cache_creation_input_tokens", 0),
        "cost": round(float(d.get("total_cost_usd") or 0), 4), "model": models[0] if models else None,
        "turns": d.get("num_turns"), "ms": d.get("duration_ms"), "error": bool(d.get("is_error")),
    }
    record_usage(LAST_USAGE)
    text = d.get("result") or ""
    rc = 0 if not d.get("is_error") and p.returncode == 0 else 1
    if rc and not text:
        text = f"Claude stopped: {d.get('subtype') or d.get('api_error_status') or 'error'}"
    return rc, text.strip()


def record_usage(u):
    day = time.strftime("%Y-%m-%d")
    with state() as s:
        daily = s.setdefault("usageDaily", {})
        d = daily.setdefault(day, {"runs": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0})
        d["runs"] += 1
        for k in ("input", "output", "cacheRead", "cacheWrite"):
            d[k] += int(u.get(k) or 0)
        d["cost"] = round(d["cost"] + float(u.get("cost") or 0), 4)
        for k in sorted(daily)[:-90]:
            daily.pop(k)
        runs = s.setdefault("usageRuns", [])
        runs.append(u)
        s["usageRuns"] = runs[-50:]


def usage_report(s):
    daily = s.get("usageDaily", {})
    def total(days):
        keys = [time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400)) for i in range(days)]
        out = {"runs": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0}
        for k in keys:
            for f in out:
                out[f] += (daily.get(k) or {}).get(f, 0)
        out["cost"] = round(out["cost"], 2)
        return out
    return {"today": total(1), "week": total(7), "month": total(30),
            "daily": {k: daily[k] for k in sorted(daily)[-30:]}, "recent": s.get("usageRuns", [])[-15:]}


def spawn(*args):
    """Start `hl_agent.py <args>` in the background, outliving this process."""
    os.makedirs(LOG_DIR, exist_ok=True)
    # one small log per run; keep the newest 200
    logs = sorted((os.path.join(LOG_DIR, f) for f in os.listdir(LOG_DIR)), key=os.path.getmtime)
    for old in logs[:-200]:
        try:
            os.remove(old)
        except OSError:
            pass
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


def job_covers(job, vmid, node):
    if not job.get("enabled", 1) or (job.get("node") and job["node"] != node):
        return False
    if job.get("all"):
        return str(vmid) not in str(job.get("exclude", "")).split(",")
    return str(vmid) in str(job.get("vmid", "")).split(",")


def collect_slow(s, node, host, containers, force=False):
    """Backups, backup jobs/tasks and snapshots. Heavier, so refreshed every 30 minutes."""
    slow = s.get("slow") or {}
    if not force and now_ms() - slow.get("t", 0) < 30 * 60e3:
        return slow
    vmids = {c["vmid"] for c in containers}
    jobs = []
    try:
        for j in ssh_json("pvesh get /cluster/backup --output-format json"):
            if j.get("type", "vzdump") != "vzdump":
                continue
            jobs.append({"id": j.get("id"), "schedule": j.get("schedule"), "storage": j.get("storage"),
                         "enabled": bool(j.get("enabled", 1)), "nextRun": (j.get("next-run") or 0) * 1000 or None,
                         "mode": j.get("mode"), "keep": j.get("prune-backups"), "comment": j.get("comment"),
                         "node": j.get("node"),
                         "guests": ("all" + (f" except {j['exclude']}" if j.get("exclude") else "")) if j.get("all") else str(j.get("vmid", "")),
                         "covers": sorted(v for v in vmids if job_covers(j, v, node)), "_raw": j})
    except Exception as e:
        log(f"backup jobs: {e}")
    backups = {}
    pbs = []
    storages = [x for x in ssh_json(f"pvesh get /nodes/{node}/storage --output-format json")
                if x.get("active") and "backup" in str(x.get("content", ""))]
    for st in storages:
        try:
            items = ssh_json(f"pvesh get /nodes/{node}/storage/{st['storage']}/content --content backup --output-format json", 120)
        except Exception as e:
            log(f"backup list {st['storage']}: {e}")
            continue
        if st.get("type") == "pbs":
            pbs.append(pbs_summary(st, items))
        for b in items:
            v = int(b.get("vmid") or 0)
            if v not in vmids:
                continue
            e = backups.setdefault(v, {"count": 0, "size": 0, "last": None, "first": None})
            e["count"] += 1
            e["size"] += b.get("size") or 0
            t = (b.get("ctime") or 0) * 1000
            if not e["last"] or t > e["last"]["t"]:
                e["last"] = {"t": t, "size": b.get("size"), "storage": st["storage"],
                             "verified": (b.get("verification") or {}).get("state"), "protected": bool(b.get("protected"))}
            if not e["first"] or t < e["first"]:
                e["first"] = t
    tasks = []
    try:
        for t in ssh_json(f"pvesh get /nodes/{node}/tasks --typefilter vzdump --limit 40 --output-format json"):
            tasks.append({"upid": t.get("upid"), "t": (t.get("starttime") or 0) * 1000,
                          "end": (t.get("endtime") or 0) * 1000 or None, "status": t.get("status") or "running",
                          "vmid": int(t["id"]) if str(t.get("id", "")).isdigit() else None})
    except Exception as e:
        log(f"backup tasks: {e}")
    first = "seenTasks" not in s
    seen = s.setdefault("seenTasks", {})
    if first:  # don't replay history as dozens of alerts: one summary instead
        bad = [t for t in tasks if t["status"] not in ("OK", "running")]
        for t in tasks:
            seen[t["upid"]] = now_ms()
        if bad:
            event("error", f"{len(bad)} of the last {len(tasks)} backup runs on this host failed "
                           f"(latest: {bad[0]['status']} at {time.strftime('%Y-%m-%d %H:%M', time.localtime(bad[0]['t'] / 1000))})", s)
    for t in tasks:
        if t["status"] not in ("OK", "running") and t["upid"] not in seen:
            seen[t["upid"]] = now_ms()
            who = f" of {t['vmid']}" if t["vmid"] else ""
            event("error", f"Backup{who} failed: {t['status']}", s)
    s["seenTasks"] = {k: v for k, v in seen.items() if now_ms() - v < 14 * 86400e3}
    names = {c["vmid"]: c["name"] for c in containers}
    snaps = {}
    for v in sorted(vmids):
        try:
            snaps[v] = [{"name": x["name"], "t": (x.get("snaptime") or 0) * 1000, "description": (x.get("description") or "")[:120]}
                        for x in ssh_json(f"pvesh get /nodes/{node}/lxc/{v}/snapshot --output-format json") if x.get("name") != "current"]
        except Exception:
            pass
    for v in sorted(snaps):
        removed = cleanup_snapshots(v, snaps[v], s, names.get(v, str(v)))
        if removed:
            snaps[v] = [x for x in snaps[v] if x["name"] not in removed]
    for j in jobs:
        j.pop("_raw", None)
    slow = {"t": now_ms(), "jobs": jobs, "backups": {str(k): v for k, v in backups.items()}, "tasks": tasks[:40], "pbs": pbs,
            "snapshots": {str(k): v for k, v in snaps.items()},
            "services": discover_services(containers), "public": discover_public()}
    slow["webmanager"] = discover_webmanager(containers)
    for c in containers:
        c.pop("_webmanager", None)
    # Every running WebManager site becomes a public monitor too (main address only, not aliases).
    for wm in slow["webmanager"]:
        for site in wm["sites"]:
            if site.get("hosts") and site.get("status") in (None, "running", "deployed", "ready", "live"):
                h = site["hosts"][0]
                slow["public"].append({"host": h, "name": site["name"], "url": f"{site.get('scheme', 'https')}://{h}/",
                                       "service": f"WebManager ({wm['container']})"})
    s["slow"] = slow
    return slow


IGNORE_PORTS = {25, 111, 631, 5355}  # mail relay, rpcbind, cups, llmnr: noise, not services


def pbs_api(path, timeout=10):
    """GET from the Proxmox Backup Server API with the read-only token in config.json ("pbs").
    The server's self-signed certificate is accepted only if its SHA-256 fingerprint matches."""
    pc = CFG.get("pbs") or {}
    if not pc.get("token_id") or not pc.get("secret") or not pc.get("server"):
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    import http.client
    conn = http.client.HTTPSConnection(pc["server"], int(pc.get("port", 8007)), timeout=timeout, context=ctx)
    try:
        conn.connect()
        der = conn.sock.getpeercert(binary_form=True)
        fp = ":".join(f"{b:02x}" for b in _hashlib.sha256(der).digest())
        want = str(pc.get("fingerprint", "")).lower()
        if not want or fp != want:
            raise RuntimeError("PBS certificate fingerprint does not match the one in config.json")
        conn.request("GET", "/api2/json/" + path.lstrip("/"),
                     headers={"Authorization": f"PBSAPIToken={pc['token_id']}:{pc['secret']}"})
        r = conn.getresponse()
        body = r.read().decode()
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}: {body[:120]}")
        return json.loads(body).get("data")
    finally:
        conn.close()


def pbs_details(datastore):
    """Extra PBS facts (needs the API token with the Audit role). Missing pieces are simply left out."""
    out, errors = {}, []
    def get(key, path):
        try:
            v = pbs_api(path)
            if v is not None:
                out[key] = v
        except Exception as e:
            errors.append(f"{path}: {e}")
    get("node", "nodes/localhost/status")
    get("version", "version")
    get("usage", "status/datastore-usage")
    get("gc", "admin/gc")
    get("verify", "admin/verify")
    get("prune", "admin/prune")
    get("sync", "admin/sync")
    get("failedTasks", "nodes/localhost/tasks?errors=1&limit=15")
    if not out and not errors:
        return None
    n = out.get("node") or {}
    res = {
        "version": (out.get("version") or {}).get("version"),
        "uptime": n.get("uptime"), "cpu": n.get("cpu"), "loadavg": n.get("loadavg"),
        "memory": {"total": (n.get("memory") or {}).get("total"), "used": (n.get("memory") or {}).get("used")},
        "root": {"total": (n.get("root") or {}).get("total"), "used": (n.get("root") or {}).get("used")},
        "datastores": [{"store": d.get("store"), "total": d.get("total"), "used": d.get("used"),
                        "estimatedFull": d.get("estimated-full-date"), "error": d.get("error")}
                       for d in (out.get("usage") or [])],
        "gc": [{"store": g.get("store"), "state": g.get("last-run-state"), "last": (g.get("last-run-endtime") or 0) * 1000 or None,
                "next": (g.get("next-run") or 0) * 1000 or None, "removed": g.get("removed-bytes"), "pending": g.get("pending-bytes")}
               for g in (out.get("gc") or [])],
        "jobs": [{"type": typ, "id": j.get("id"), "store": j.get("store"), "schedule": j.get("schedule"),
                  "state": j.get("last-run-state"), "last": (j.get("last-run-endtime") or 0) * 1000 or None,
                  "next": (j.get("next-run") or 0) * 1000 or None}
                 for typ in ("verify", "prune", "sync") for j in (out.get(typ) or [])],
        "failedTasks": [{"t": (x.get("starttime") or 0) * 1000, "type": x.get("worker_type"), "id": x.get("worker_id"),
                         "status": x.get("status")} for x in (out.get("failedTasks") or [])][:15],
        "errors": errors[:5],
    }
    return res


def pbs_summary(st, items):
    """A Proxmox Backup Server storage as the cluster sees it (no extra credentials needed)."""
    try:
        cfg = ssh_json(f"pvesh get /storage/{st['storage']} --output-format json")
    except Exception:
        cfg = {}
    server = cfg.get("server")
    port = int(cfg.get("port") or 8007)
    up, ms = False, None
    if server:
        t0 = time.time()
        try:
            with socket.create_connection((server, port), timeout=4):
                up, ms = True, round((time.time() - t0) * 1000, 1)
        except OSError:
            pass
    times = sorted((b.get("ctime") or 0) * 1000 for b in items)
    ver = [((b.get("verification") or {}).get("state")) for b in items]
    guests = {}
    for b in items:
        g = guests.setdefault(b.get("vmid"), {"n": 0, "last": 0, "size": 0, "type": b.get("subtype")})
        g["n"] += 1
        g["size"] = max(g["size"], b.get("size") or 0)
        g["last"] = max(g["last"], (b.get("ctime") or 0) * 1000)
    day = now_ms() - 86400e3
    return {
        "storage": st["storage"], "server": server, "port": port, "datastore": cfg.get("datastore"),
        "reachable": up, "ms": ms, "total": st.get("total"), "used": st.get("used"), "avail": st.get("avail"),
        "count": len(items), "guests": len(guests),
        "containers": sum(1 for g in guests.values() if g["type"] == "lxc"), "vms": sum(1 for g in guests.values() if g["type"] == "qemu"),
        "last": times[-1] if times else None, "oldest": times[0] if times else None,
        "last24h": sum(1 for t in times if t > day),
        "verifiedOk": sum(1 for v in ver if v == "ok"), "verifyFailed": sum(1 for v in ver if v == "failed"),
        "unverified": sum(1 for v in ver if not v),
        "staleGuests": sum(1 for g in guests.values() if g["last"] < now_ms() - 3 * 86400e3),
        "checkedAt": now_ms(),
        "details": pbs_details(cfg.get("datastore")) if (CFG.get("pbs") or {}).get("server") == server else None,
    }


def discover_services(containers):
    """Listening TCP ports inside each running container (not loopback-only ones)."""
    found = []
    for c in containers:
        if c["status"] != "running":
            continue
        rc, out = cx(c["vmid"], "hostname -I 2>/dev/null; echo ---; ss -ltnpH 2>/dev/null; "
                                "if test -f /var/lib/webmanager/webmanager.sqlite3; then echo WEBMANAGER-FOUND; fi", 30)
        if rc != 0 or "---" not in out:
            continue
        if "WEBMANAGER-FOUND" in out:
            c["_webmanager"] = True
        ips_part, _, ss_part = out.partition("---")
        ip = next((x for x in ips_part.split() if re.match(r"^\d+\.\d+\.\d+\.\d+$", x) and not x.startswith("127.")), None)
        if not ip:
            continue
        # The container's address itself (ping), before its ports.
        found.append({"key": f"{c['vmid']}:ping", "vmid": c["vmid"], "container": c["name"], "ip": ip, "port": 0, "proc": "ping"})
        seen = set()
        for line in ss_part.splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            local = parts[3]
            addr, _, port = local.rpartition(":")
            if not port.isdigit() or addr.startswith("127.") or addr in ("[::1]", "::1") or "%lo" in addr:
                continue
            port = int(port)
            if port in IGNORE_PORTS or port in seen:
                continue
            seen.add(port)
            m = re.search(r'users:\(\("([^"]+)"', line)
            found.append({"key": f"{c['vmid']}:{port}", "vmid": c["vmid"], "container": c["name"], "ip": ip,
                          "port": port, "proc": m.group(1) if m else None})
    return found


WEBMANAGER_SITES_PY = r"""
import json, sqlite3
env = {}
try:
    for line in open('/etc/webmanager/webmanager.env'):
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.rstrip('\n').split('=', 1)
            env[k.strip()] = v.strip().strip('"')
except OSError:
    pass
base = env.get('WEBMANAGER_SITE_BASE_DOMAIN', '')
scheme = env.get('WEBMANAGER_SITE_PUBLIC_SCHEME', 'http') or 'http'
db = sqlite3.connect('file:/var/lib/webmanager/webmanager.sqlite3?mode=ro', uri=True)
db.row_factory = sqlite3.Row
doms = {r['id']: r['name'] for r in db.execute('SELECT id, name FROM domains')}
out = []
for s in db.execute('SELECT * FROM sites'):
    keys = s.keys()
    hosts = []
    d = doms.get(s['domain_id']) if 'domain_id' in keys and s['domain_id'] else base
    if d:
        hosts.append(d if ('use_domain_root' in keys and s['use_domain_root']) else s['slug'] + '.' + d)
    try:
        for a in db.execute('SELECT a.use_domain_root, a.hostname_prefix, d.name FROM site_domain_aliases a '
                            'JOIN domains d ON d.id = a.domain_id WHERE a.site_id = ?', (s['id'],)):
            hosts.append(a[2] if a[0] else (a[1] or s['slug']) + '.' + a[2])
    except sqlite3.Error:
        pass
    out.append({'name': s['name'], 'status': s['status'] if 'status' in keys else None,
                'hosts': list(dict.fromkeys(hosts)), 'scheme': scheme})
print(json.dumps(out))
"""


def discover_webmanager(containers):
    """Sites hosted by any WebManager running in this host's containers (read-only look at its database)."""
    found = []
    for c in containers:
        if not c.get("_webmanager"):
            continue
        rc, out = cx(c["vmid"], f"python3 - <<'PYEOF'\n{WEBMANAGER_SITES_PY}\nPYEOF", 60)
        try:
            sites = json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            log(f"WebManager in {c['name']}: could not read sites: {out[-200:]}")
            continue
        found.append({"container": c["name"], "vmid": c["vmid"], "sites": sites})
    return found


def discover_public():
    """Public hostnames served by this connector's Cloudflare tunnel (from cloudflared's metrics server)."""
    out = []
    for port in (20241, 20242, 20243):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/config", timeout=3) as r:
                cfg = json.loads(r.read().decode())
        except (OSError, ValueError):
            continue
        for rule in (cfg.get("config") or cfg).get("ingress", []):
            h = rule.get("hostname") or ""
            if h and "*" not in h:
                out.append({"host": h, "service": rule.get("service")})
        break
    return out


def check_services(services):
    def one(sv):
        t0 = time.time()
        if sv.get("port") == 0:  # ICMP ping of the container's IP
            try:
                p = subprocess.run(["ping", "-c", "1", "-W", "2", sv["ip"]], capture_output=True, text=True, timeout=5)
                m = re.search(r"time=([\d.]+)", p.stdout)
                return {**sv, "ok": p.returncode == 0, "ms": float(m.group(1)) if m else None,
                        **({} if p.returncode == 0 else {"err": "no ping reply"})}
            except (OSError, subprocess.TimeoutExpired) as e:
                return {**sv, "ok": False, "ms": None, "err": str(e)[:80]}
        try:
            with socket.create_connection((sv["ip"], sv["port"]), timeout=3):
                return {**sv, "ok": True, "ms": round((time.time() - t0) * 1000, 1)}
        except OSError as e:
            return {**sv, "ok": False, "ms": None, "err": str(e)[:80]}
    if not services:
        return []
    with ThreadPoolExecutor(max_workers=16) as ex:
        return list(ex.map(one, services))


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
    for c in containers:
        b = c.get("backup") or {}
        if b.get("covered") and b.get("last") and now_ms() - b["last"]["t"] > 26 * 3600e3:
            if cooled(s, f"backupage:{c['vmid']}", 86400):
                event("warn", f"{c['name']} ({c['vmid']}): last backup is {round((now_ms() - b['last']['t']) / 3600e3)} h old", s)
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
    tasks = [{"id": t["id"], "status": t["status"], "output": t.get("output", "")[-20000:], "usage": t.get("usage")}
             for t in s["tasks"].values() if not t.get("internal")]
    pending = sorted(s["pending"].values(), key=lambda p: p["t"])
    internal = [t for t in s["tasks"].values() if t.get("internal")]
    events = list(s["events"][-100:])
    return {
        "agent": CFG["name"], "agentVersion": VERSION, "generatedAt": now_ms(),
        "host": host, "containers": containers, "pending": pending,
        "events": events, "updateRuns": s["updateRuns"][-20:],
        "backups": {k: (s.get("slow") or {}).get(k) for k in ("jobs", "tasks", "t", "pbs")},
        "services": s.get("serviceChecks", []),
        "public": (s.get("slow") or {}).get("public", []),
        "webmanager": (s.get("slow") or {}).get("webmanager", []),
        "schedule": {"updates": CFG.get("update_time"), "reportEvery": 300,
                     "securityOnly": bool((s.get("policy") or {}).get("securityOnly"))},
        "policy": s.get("policy"),
        "progress": s.get("progress"),
        # Full logs only for recent runs (the dashboard stores them); older ones as a summary line.
        "runLogs": [r if (r.get("end") or 0) > now_ms() - 30 * 60e3 else {k: v for k, v in r.items() if k != "log"}
                    for r in (s.get("runLogs") or [])[-10:]],
        "logs": log_tail(300),
        "usage": usage_report(s),
        "autoTasks": [{"t": t["t"], "status": t["status"], "text": t["text"][:300], "output": t.get("output", "")[-4000:]}
                      for t in internal[-5:]],
        "taskResults": tasks, "acked": list(s["handled"].keys()),
    }


def sync(url, wait=0):
    """Quick channel: send task progress, then wait up to `wait` s for new work from the dashboard."""
    with state() as s:
        cutoff = now_ms() - 15 * 60e3
        results = [{"id": t["id"], "status": t["status"], "output": t.get("output", "")[-20000:], "usage": t.get("usage")}
                   for t in s["tasks"].values() if not t.get("internal") and t.get("u", t["t"]) > cutoff]
        acked = list(s["handled"].keys())
        prog = s.get("progress")
    if prog:
        prog = dict(prog, log=(prog.get("log") or [])[-150:])
    data = json.dumps({"taskResults": results, "acked": acked, "wait": wait, "progress": prog, "logs": log_tail(60)}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/agent/sync", data=data, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {CFG['token']}",
        "User-Agent": f"homelab-agent/{VERSION}"})
    with urllib.request.urlopen(req, timeout=wait + 20) as r:
        return json.loads(r.read().decode() or "{}")


def sync_now():
    for url in CFG["site_urls"]:
        try:
            sync(url, 0)
        except (urllib.error.URLError, OSError, ValueError) as e:
            log(f"sync to {url} failed: {e}")


def cmd_poll():
    """Long-running: picks up dashboard requests within a second (systemd hl-poll.service)."""
    import threading

    def loop(url):
        backoff = 5
        while True:
            try:
                r = sync(url, 25)
                backoff = 5
                if r.get("tasks") or r.get("decisions"):
                    handle_replies([r])
                    sync(url, 0)  # show "running" on the dashboard right away
                elif isinstance(r.get("policy"), dict):
                    handle_replies([r])  # nightly policy change only
            except (urllib.error.URLError, OSError, ValueError) as e:
                log(f"poll {url}: {e}")
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
            except Exception as e:  # never die; systemd would restart us anyway
                log(f"poll {url}: unexpected {e!r}")
                time.sleep(10)

    threads = [threading.Thread(target=loop, args=(u,), daemon=True) for u in CFG["site_urls"]]
    for t in threads:
        t.start()
    while True:
        time.sleep(3600)


def post(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/agent/report", data=data, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {CFG['token']}",
        "User-Agent": f"homelab-agent/{VERSION}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")


def cmd_report(send=True):
    with state() as s:
        clear_stale_progress(s)
        try:
            host, containers = collect(s)
            try:
                slow = collect_slow(s, host["node"], host, containers)
            except Exception as e:
                log(f"slow collect failed: {e}")
                slow = s.get("slow") or {}
            for c in containers:
                b = (slow.get("backups") or {}).get(str(c["vmid"])) or {}
                c["backup"] = {**b, "covered": any(c["vmid"] in j.get("covers", []) for j in slow.get("jobs", []))}
                c["snapshots"] = (slow.get("snapshots") or {}).get(str(c["vmid"]), [])
            prev = {c["vmid"]: c["name"] for c in (s.get("lastCollect") or {}).get("containers", [])}
            now_ids = {c["vmid"]: c["name"] for c in containers}
            if prev:
                for v, n in prev.items():
                    if v not in now_ids:
                        event("warn", f"Container {n} ({v}) is no longer on this host (deleted or migrated)", s)
                for v, n in now_ids.items():
                    if v not in prev:
                        event("info", f"New container on this host: {n} ({v})", s)
            s["lastCollect"] = {"host": host, "containers": containers}
            s["serviceChecks"] = check_services(slow.get("services") or [])
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
    handle_replies(replies)


def handle_replies(replies):
    """Act on decisions and tasks the dashboard sent back (from a report or a quick sync)."""
    if not replies:
        return
    decisions, tasks, policy = {}, {}, None
    for r in replies:
        if isinstance(r.get("policy"), dict):
            policy = r["policy"]
        for d in r.get("decisions", []):
            decisions[d["id"]] = d
        for t in r.get("tasks", []):
            tasks[t["id"]] = t
    with state() as s:
        if policy is not None and (s.get("policy") or {}).get("at") != policy.get("at"):
            s["policy"] = {"securityOnly": bool(policy.get("securityOnly")), "at": policy.get("at"), "by": policy.get("by")}
            event("info", f"Nightly updates set to {'security updates only' if s['policy']['securityOnly'] else 'full (risk-checked)'}"
                          f" by {policy.get('by') or 'the dashboard'}", s)
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
                known = {p["name"] for p in item.get("packages") or []}
                sel = [n for n in (d.get("packages") or []) if n in known]
                if sel:
                    item["selected"] = sel
                event("info", f"Approved by {d.get('by')}: {item['summary']}" + (f" — only {len(sel)} selected package(s)" if sel else ""), s)
                spawn("action", did)
            else:
                event("info", f"Denied by {d.get('by')}: {item['summary']}", s)
                s["pending"].pop(did, None)
        for tid, t in tasks.items():
            if tid in s["tasks"]:
                continue
            s["tasks"][tid] = {"id": tid, "text": t["text"], "by": t.get("by"), "status": "running", "output": "",
                               "t": now_ms(), "u": now_ms(), **({"action": t["action"]} if t.get("action") else {}),
                               **({"chat": t["chat"]} if t.get("chat") else {})}
            spawn("ctaction" if t.get("action") else "task", tid)


# ------------------------------------------------------------------ tasks (Claude)

def cmd_task(tid):
    with state() as s:
        t = s["tasks"].get(tid)
        if not t:
            return
        text, by, internal = t["text"], t.get("by"), t.get("internal")
        chat = t.get("chat")
        session = (s.get("chatSessions") or {}).get(chat) if chat else None
    who = "this agent's own monitoring" if internal else f"{by} via the status dashboard"
    prompt = (f"Request from {who}:\n\n{text}\n\n"
              "You are this Proxmox host's homelab agent (see CLAUDE.md for the setup and rules). "
              "Do what is asked; if it is a question, answer it from real data you look up. "
              "Your reply is shown on a web dashboard that renders Markdown: use short headings, bullet lists, "
              "**bold** for key facts, `code` for commands/paths, and tables where they help. Keep it concise. "
              "End with what you changed (or 'No changes made') and any snapshot you took.\n\n"
              "If you could NOT fully solve it — because the fix is outside what you may do (host changes the owner "
              "did not explicitly ask for, the other Proxmox host, VMs, deleting backups, the router/firewall, "
              "Cloudflare), you lack access, or you are not confident — finish with a section headed exactly "
              "`## Handoff plan for Claude Code`. Write it so the owner can paste it straight into Claude Code on "
              "their PC, which can SSH into both connector containers over Tailscale and from there reach the "
              "Proxmox hosts as root. Include: the problem and the evidence you found; numbered steps with the exact "
              "commands and which machine each runs on; risks, and how to undo each step; how to verify it worked. "
              "Never include passwords, tokens or keys. Leave the section out if you fixed everything.")
    if session:  # follow-up in an existing chat: Claude already has the context and the rules
        prompt = (f"Follow-up from {who} in the same conversation:\n\n{text}\n\n"
                  "Same rules and format as before (Markdown; end with what you changed; add a "
                  "`## Handoff plan for Claude Code` section only if you could not solve it).")
    rc, out = claude(prompt, kind="autofix" if internal else "task", label=text[:120], resume=session)
    usage = dict(LAST_USAGE)
    if chat and LAST_SESSION:
        with state() as s:
            cs = s.setdefault("chatSessions", {})
            cs[chat] = LAST_SESSION
            if len(cs) > 300:
                for k in list(cs)[:-300]:
                    cs.pop(k)
    with state() as s:
        t = s["tasks"].get(tid)
        if t:
            t["status"] = "done" if rc == 0 else "failed"
            t["output"] = out[-20000:] or "(no output)"
            t["u"] = now_ms()
            if usage:
                t["usage"] = {k: usage.get(k) for k in ("input", "output", "cacheRead", "cacheWrite", "cost", "model", "turns", "ms")}
        if internal:
            event("info" if rc == 0 else "error", f"Auto-fix finished: {out.strip().splitlines()[-1][:300] if out.strip() else 'no output'}", s)
    sync_now()    # answer onto the dashboard right away
    cmd_report()  # then refresh everything else


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
    rc, out = claude(prompt, timeout=600, kind="review", label=f"update review: {name}")
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
    # Only real services count: a timer/socket/path unit can show "failed" for a moment while its package is
    # upgraded (e.g. wtmpdb-rotate.timer) without anything actually being broken.
    rc, out = cx(vmid, "systemctl list-units --failed --type=service --plain --no-legend --no-pager 2>/dev/null | awk '{print $1}';"
                       " echo ---; ss -ltnH 2>/dev/null | awk '{print $4}'", 60)
    failed_part, _, ports_part = out.partition("---")
    ports = set()
    for a in ports_part.split():
        addr, _, port = a.rpartition(":")
        if not port.isdigit():
            continue
        # Ports only the container itself can reach (127.x / ::1) aren't services anyone depends on, and ports
        # in the ephemeral range get a new random number every restart (e.g. containerd's): neither counts as lost.
        if addr.startswith("127.") or addr in ("[::1]", "::1") or "%lo" in addr:
            continue
        if 32768 <= int(port) <= 60999:
            continue
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


DAY_MS = 86400e3
SNAP_RE = re.compile(r"^(hlauto|hlfix|hlmanual)\d{12}$")


def snapshot_expired(snap, newest_auto):
    """Is this one of OUR snapshots that is no longer useful? Snapshots not made by the agents never are."""
    m = SNAP_RE.match(snap["name"])
    if not m:
        return None  # made by a person in Proxmox: never touched
    age = now_ms() - (snap.get("t") or now_ms())
    kind = m.group(1)
    if kind == "hlauto":
        if snap["name"] in newest_auto:
            return None
        return "superseded by newer update snapshots"
    from_dashboard = "from the dashboard" in (snap.get("description") or "")
    limit = 30 if (kind == "hlmanual" and from_dashboard) else 7
    if age > limit * DAY_MS:
        return f"older than {limit} days"
    return None


def cleanup_snapshots(vmid, snaps, s, name):
    """Delete expired agent snapshots of one container. Skipped while an update run holds the lock."""
    auto = sorted((x for x in snaps if x["name"].startswith("hlauto")), key=lambda x: x.get("t") or 0)
    keep_auto = {x["name"] for x in auto[-2:] if now_ms() - (x.get("t") or 0) <= 7 * DAY_MS}
    if auto and not keep_auto:  # even if all are older than 7 days, keep the very newest one
        keep_auto = {auto[-1]["name"]} if now_ms() - (auto[-1].get("t") or 0) <= 30 * DAY_MS else set()
    doomed = [(x, why) for x in snaps if (why := snapshot_expired(x, keep_auto))]
    if not doomed:
        return []
    try:
        lf = open(UPDATE_LOCK, "w")
        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        return []  # an update is running and may still need its snapshot
    removed = []
    try:
        for x, why in doomed[:10]:
            rc, out = ssh(f"pct delsnapshot {int(vmid)} {x['name']}", 600)
            if rc == 0:
                removed.append(x["name"])
                event("info", f"Deleted snapshot {x['name']} of {name} ({vmid}): {why}", s)
            else:
                log(f"could not delete snapshot {x['name']} of {vmid}: {out[-200:]}")
    finally:
        lf.close()
    return removed


def prune_snapshots(vmid):
    snaps = sorted(set(snapshots(vmid)))
    keep = min(2, CFG["keep_snapshots"])
    for name in snaps[:-keep] if len(snaps) > keep else []:
        rc, out = ssh(f"pct delsnapshot {int(vmid)} {name}", 600)
        if rc != 0:
            log(f"could not delete snapshot {name} of {vmid}: {out[-200:]}")


def set_container(vmid, **kw):
    with state() as s:
        s["containers"].setdefault(str(vmid), {}).update(kw)


# ------------------------------------------------------------------ live update progress (shown as a bar on the dashboard)

OWN_RUN = None     # id of the update run this process is driving (its events go into that run's log)
RUN_LOG_MAX = 600  # lines kept per run


def _plog(p, msg, level="info"):
    for line in str(msg).splitlines() or [""]:
        p.setdefault("log", []).append({"t": now_ms(), "l": level, "m": line[:2000]})
    p["log"] = p["log"][-RUN_LOG_MAX:]


def progress_start(kind, mode, targets, title=""):
    """Begin a progress record (with its own log) for an update: kind run = every container, single = one."""
    global OWN_RUN
    if DRY:
        return
    OWN_RUN = secrets.token_hex(6)
    with state() as s:
        s["progress"] = {"id": OWN_RUN, "kind": kind, "mode": mode, "title": title, "total": len(targets), "done": 0,
                         "startedAt": now_ms(), "u": now_ms(), "current": None, "step": None, "results": [], "log": []}
        _plog(s["progress"], f"{title or 'Update'} started ({mode}, {len(targets)} container(s))")
    log(f"{title or 'update'} started", "info")
    sync_now()


def progress(step=None, msg=None, push=True, level="info", **kw):
    """Move the active progress record on, add `msg` to its log, and push it to the dashboard.
    A no-op when no update is running."""
    with state() as s:
        p = s.get("progress")
        if not p:
            return
        if step:
            p["step"] = step
        if msg:
            _plog(p, msg, level)
        p.update(kw)
        p["u"] = now_ms()
    if msg:
        log(msg, level)
    if push:
        sync_now()


def plog(msg, level="info"):
    """Add lines (e.g. apt output) to the running update's log without pushing right away."""
    progress(msg=msg, push=False, level=level)


def progress_result(vmid, name, result):
    bad = re.search(r"ROLLED BACK|BROKEN|error|failed", str(result))
    with state() as s:
        p = s.get("progress")
        if not p:
            return
        p["done"] = min(p["total"], p["done"] + 1)
        p["results"] = (p.get("results") or [])[-59:] + [{"vmid": vmid, "name": name, "r": str(result)[:300]}]
        p["current"], p["step"], p["u"] = None, None, now_ms()
        _plog(p, f"→ {result}", "error" if bad else "info")
    sync_now()


def clear_stale_progress(s):
    """A progress record with no update holding the lock is left over from a killed run: drop it."""
    if not s.get("progress"):
        return
    try:
        with open(UPDATE_LOCK, "a") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lf, fcntl.LOCK_UN)
    except OSError:  # BlockingIOError: an update is running right now
        return
    s["progress"] = None


def progress_end(level=None, summary=""):
    """Finish the running update: archive its log under runLogs (sent with the report) and clear the bar.
    Returns the log lines."""
    global OWN_RUN
    if DRY:
        return []
    with state() as s:
        p = s.get("progress")
        s["progress"] = None
        if not p:
            return []
        lines = p.get("log") or []
        bad = any(r for r in p.get("results") or [] if re.search(r"ROLLED BACK|BROKEN|error|failed", r.get("r", "")))
        lvl = level or ("error" if bad else "info")
        _plog(p, f"Finished: {summary or (str(p.get('done')) + '/' + str(p.get('total')) + ' done')}", lvl)
        lines = p["log"]
        runs = (s.get("runLogs") or [])[-9:]
        runs.append({"id": p.get("id"), "t": p.get("startedAt"), "end": now_ms(), "kind": p.get("kind"), "mode": p.get("mode"),
                     "title": p.get("title") or "Update", "level": lvl, "summary": (summary or "")[:500],
                     "done": p.get("done"), "total": p.get("total"), "log": lines[-RUN_LOG_MAX:]})
        s["runLogs"] = runs
    OWN_RUN = None
    sync_now()
    return lines


def fmt_log(lines):
    return "\n".join(time.strftime("%H:%M:%S", time.localtime(l["t"] / 1000)) + "  " + l["m"] for l in lines)


def update_container(vmid, name, mode="auto", only=None):
    """mode: auto (nightly), full (approved / "Update now"), security (security updates only).
    Returns a short result string for the run summary."""
    is_self = vmid == CFG.get("self_vmid")
    label = f"{name} ({vmid})"
    progress("apt-update", f"{label}: refreshing package lists", current={"vmid": vmid, "name": name})
    rc, out = cx(vmid, "command -v apt-get >/dev/null || { echo NOAPT; exit 0; }; apt-get update -q 2>&1 | tail -5", 900)
    if "NOAPT" in out:
        return f"{label}: skipped (no apt)"
    if rc != 0:
        plog(out[-1500:], "error")
        set_container(vmid, lastUpdate={"t": now_ms(), "result": "failed", "msg": f"apt-get update failed: {out[-200:]}"})
        event("warn", f"{label}: apt-get update failed: {out[-200:]}")
        return f"{label}: apt-get update failed"
    rc, out = cx(vmid, "apt list --upgradable 2>/dev/null", 120)
    pkgs = parse_upgradable(out)
    sec = [p for p in pkgs if p["security"]]
    set_container(vmid, updates={"count": len(pkgs), "security": len(sec), "checkedAt": now_ms()})
    plog(f"{label}: {len(pkgs)} update(s) available, {len(sec)} security" +
         (": " + ", ".join(p["name"] for p in pkgs[:25]) + (" …" if len(pkgs) > 25 else "") if pkgs else ""))
    if not pkgs:
        return f"{label}: up to date"

    with state() as s:
        blocked = s["containers"].get(str(vmid), {}).get("blocked")
    rc, sim = cx(vmid, "apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>&1", 300)
    removals = re.findall(r"^Remv (\S+)", sim, re.M)

    if mode == "full":
        plan, reasons = "full", []
    elif mode == "security":
        plan, reasons = ("security" if sec else "none"), ["security-only mode"]
        if not sec:
            return f"{label}: no security updates ({len(pkgs)} other update(s) left for later)"
    elif blocked:
        plan, reasons = ("security" if sec else "none"), [f"full updates paused: {blocked}"]
    else:
        progress("review", f"{label}: asking Claude to review {len(pkgs)} update(s)", pkgs=len(pkgs))
        risk, reasons = risk_review(name, pkgs, removals)
        plog(f"{label}: review says {risk} risk" + (": " + "; ".join(reasons[:5]) if reasons else ""), "warn" if risk == "high" else "info")
        plan = "full" if risk == "low" else ("security" if sec else "none")

    if DRY:
        return (f"{label}: DRY RUN plan={plan} pkgs={len(pkgs)} security={len(sec)} removals={removals[:5]} "
                f"reasons={reasons[:3]} health={ {k: sorted(v) if isinstance(v, set) else v for k, v in health(vmid).items()} }")

    if removals:
        plog(f"{label}: apt would remove {', '.join(removals[:10])}", "warn")
    plog(f"{label}: plan: {'install everything' if plan == 'full' else 'security updates only' if plan == 'security' else 'hold everything for approval'}")
    if plan != "full" and mode not in ("full", "security"):
        # Leave the rest for the user to approve.
        others = [p for p in pkgs if not p["security"]] if plan == "security" else pkgs
        pid = f"ct-update-{vmid}-" + hashlib.sha1(json.dumps([(p['name'], p['new']) for p in others]).encode()).hexdigest()[:8]
        with state() as s:
            for k in [k for k, v in s["pending"].items() if v.get("kind") == "risky-update" and v.get("vmid") == vmid and k != pid]:
                s["pending"].pop(k)
            if pid not in s["pending"]:
                add_pending(s, {"id": pid, "kind": "risky-update", "vmid": vmid,
                                "packages": [{k: p[k] for k in ("name", "old", "new", "security")} for p in others[:400]],
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
    progress("snapshot", f"{label}: snapshot {snap}")
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
    if only:
        wanted = [p for p in pkgs if p["name"] in set(only)]
        if not wanted:
            set_container(vmid, lastUpdate={"t": now_ms(), "result": "ok", "msg": "selected packages were already up to date"})
            return f"{label}: selected packages already up to date"
        names = " ".join(shlex.quote(p["name"]) for p in wanted)
        cmd = f"{APT_ENV} apt-get {APT_OPTS} install --only-upgrade {names} 2>&1 | tail -30"
        what = f"{len(wanted)} selected update(s)"
        plan = "selected"
    elif plan == "full":
        cmd = f"{APT_ENV} apt-get {APT_OPTS} dist-upgrade 2>&1 | tail -30"
        what = f"{len(pkgs)} update(s)"
    else:
        names = " ".join(shlex.quote(p["name"]) for p in sec)
        cmd = f"{APT_ENV} apt-get {APT_OPTS} install --only-upgrade {names} 2>&1 | tail -30"
        what = f"{len(sec)} security update(s)"
    progress("install", f"{label}: installing {what}", what=what)
    rc, out = cx(vmid, cmd, 3600)
    apt_ok = "E: " not in out
    plog(out[-4000:] or "(no apt output)", "info" if apt_ok else "error")
    rc2, rr = cx(vmid, "test -f /var/run/reboot-required && echo YES || true", 60)
    needs_reboot = "YES" in rr

    if is_self:
        # Can't watch our own reboot or roll ourselves back from inside: hand those to the host.
        if needs_reboot:
            ssh(f"systemd-run --on-active=90 --unit=hl-selfreboot-{snap or 'x'} pct reboot {int(vmid)}")
            event("info", f"{label}: updated ({what}); rebooting this agent's container in 90 s")
        result = "ok" if apt_ok else "failed"
        set_container(vmid, lastUpdate={"t": now_ms(), "result": result, "msg": f"{what}; {out[-200:] if not apt_ok else 'done'}"},
                      updates={"count": 0 if plan == "full" else len(pkgs) - (len(only) if plan == "selected" else len(sec)), "security": 0, "checkedAt": now_ms()})
        if snap:
            prune_snapshots(vmid)
        return f"{label}: {what} installed{' (reboot scheduled)' if needs_reboot else ''}"

    if needs_reboot:
        progress("reboot", f"{label}: rebooting (the update asked for it)")
        ssh(f"pct reboot {int(vmid)}", 300)
        wait_running(vmid)
    progress("health", f"{label}: health check (services and listening ports)")
    time.sleep(15)
    post_h = health(vmid)
    problems = broken(pre, post_h)
    if problems:  # services can be slow to come back: look again before deciding
        plog(f"{label}: not healthy yet ({'; '.join(problems)}), checking again in 45 s", "warn")
        time.sleep(45)
        post_h = health(vmid)
        problems = broken(pre, post_h)

    if problems and snap:
        progress("rollback", f"{label}: still broken ({'; '.join(problems)}), rolling back to {snap}", level="error")
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
    remaining = 0 if plan == "full" else len(pkgs) - (len(only) if plan == "selected" else len(sec))
    set_container(vmid, lastUpdate={"t": now_ms(), "result": result, "msg": f"{what}" + ("" if apt_ok else f": {out[-200:]}")},
                  updates={"count": remaining, "security": 0, "checkedAt": now_ms()},
                  **({"blocked": None} if mode == "full" and plan == "full" else {}))
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
                            "packages": [{k: p[k] for k in ("name", "old", "new", "security")} for p in pkgs[:600]],
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


def cmd_update(mode=None):
    """Nightly run. mode: None = follow the dashboard's policy, "security" = security updates only."""
    if mode is None:
        with state() as s:
            mode = "security" if (s.get("policy") or {}).get("securityOnly") else "auto"
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
        progress_start("run", mode, targets, "Security-only update run" if mode == "security" else "Nightly update run")
        try:
            for vmid, name in targets:
                try:
                    results.append(update_container(vmid, name, mode=mode))
                except Exception as e:
                    results.append(f"{name} ({vmid}): error {e}")
                    event("error", f"{name} ({vmid}): update run crashed: {e}")
                log(results[-1])
                progress_result(vmid, name, results[-1])
            if DRY:
                print("\n".join(results))
                return
            progress("host", "Checking the Proxmox host for updates")
            try:
                n = check_host_updates()
                results.append(f"host: {n} update(s) waiting for approval" if n else "host: up to date")
            except Exception as e:
                results.append(f"host: update check failed: {e}")
            plog(results[-1])
        finally:
            progress_end(summary="; ".join(r for r in results if re.search(r"ROLLED BACK|BROKEN|error|failed|held", r))[:400]
                         or f"{len(targets)} container(s) checked")
        bad = [r for r in results if "ROLLED BACK" in r or "BROKEN" in r or "error" in r or "failed" in r]
        held = [r for r in results if "held" in r]
        summary = (("Security-only run: " if mode == "security" else "") + f"{len(targets)} container(s) checked in {round((now_ms() - started) / 60000)} min" +
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
            sel = item.get("selected")
            if sel:
                event("info", f"Updating {len(sel)} selected package(s) on the Proxmox host (approved)")
                names = " ".join(shlex.quote(n) for n in sel)
                rc, out = ssh(f"apt-get update -q >/dev/null 2>&1; {APT_ENV} apt-get {APT_OPTS} install --only-upgrade {names} 2>&1 | tail -40", 3600)
            else:
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
            # Consume the approval BEFORE updating: if this attempt is rolled back again, update_container
            # creates a fresh "Retry updates" approval (often with the same id), which must survive.
            with state() as s:
                s["pending"].pop(pid, None)
            with open(UPDATE_LOCK, "w") as lf:
                fcntl.flock(lf, fcntl.LOCK_EX)
                progress_start("single", "selected" if item.get("selected") else "full", [vmid], f"Approved update: {name} ({vmid})")
                r = "crashed"
                try:
                    r = update_container(vmid, name, mode="full", only=item.get("selected"))
                finally:
                    progress_end(summary=r)
            event("info", f"Approved update: {r}")
        else:
            event("warn", f"Don't know how to do approved item {pid} ({kind})")
    except Exception as e:
        event("error", f"Approved action {item.get('summary')} failed: {e}")
    cmd_report()


# ------------------------------------------------------------------ direct actions from the dashboard

def cmd_ctaction(tid):
    with state() as s:
        t = s["tasks"].get(tid)
        if not t:
            return
        act, by = t["action"], t.get("by")
    typ, vmid = act.get("type"), act.get("vmid")
    out, ok = "", True
    try:
        if vmid is not None:
            vmid = int(vmid)
            rc, conf = ssh(f"pct config {vmid}")
            if rc != 0:
                raise RuntimeError(f"container {vmid} not found on this host")
            name = (re.search(r"^hostname:\s*(\S+)", conf, re.M) or [None, str(vmid)])[1]
            label = f"{name} ({vmid})"
        if typ in ("start", "shutdown", "reboot"):
            if typ == "shutdown" and vmid == CFG.get("self_vmid"):
                raise RuntimeError("refusing to shut down this agent's own container")
            if typ == "reboot" and vmid == CFG.get("self_vmid"):
                rc, o = ssh(f"systemd-run --on-active=20 --unit=hl-selfreboot-{int(time.time())} pct reboot {vmid}")
                out = "This agent's container reboots in 20 seconds."
            else:
                cmd = {"start": f"pct start {vmid}", "shutdown": f"pct shutdown {vmid} --timeout 120", "reboot": f"pct reboot {vmid} --timeout 120"}[typ]
                rc, o = ssh(cmd, 300)
                ok = rc == 0
                rc2, stt = ssh(f"pct status {vmid}")
                out = (o + "\n" if o else "") + stt
        elif typ == "snapshot":
            snap = "hlmanual" + time.strftime("%Y%m%d%H%M")
            rc, o = ssh(f"pct snapshot {vmid} {snap} --description 'manual snapshot from the dashboard by {shlex.quote(str(by or 'admin'))[:60]}'", 600)
            ok, out = rc == 0, (f"Snapshot {snap} created." if rc == 0 else o)
        elif typ == "backup":
            with state() as s:
                jobs = (s.get("slow") or {}).get("jobs") or []
            storage = next((j["storage"] for j in jobs if vmid in j.get("covers", [])), None) or next((j["storage"] for j in jobs), None)
            if not storage:
                raise RuntimeError("no backup storage found (no backup job is configured)")
            rc, o = ssh(f"vzdump {vmid} --storage {shlex.quote(storage)} --mode snapshot --notes-template '{{{{guestname}}}} (manual)' 2>&1 | tail -15", 7200)
            ok, out = rc == 0 and "ERROR" not in o, o
            with state() as s:
                s.pop("slow", None)  # refresh the backup list on the next report
        elif typ in ("update", "update-security"):
            with open(UPDATE_LOCK, "w") as lf:
                fcntl.flock(lf, fcntl.LOCK_EX)
                mode = "full" if typ == "update" else "security"
                progress_start("single", mode, [vmid], f"{'Security updates' if mode == 'security' else 'Update'}: {label}")
                lines = []
                try:
                    out = update_container(vmid, name, mode=mode)
                finally:
                    lines = progress_end(summary=out or "crashed")
                out = f"{out}\n\n--- log ---\n{fmt_log(lines)}" if lines else out
            ok = "ROLLED BACK" not in out and "BROKEN" not in out and "failed" not in out
        elif typ in ("update-all", "update-all-security"):
            cmd_update("security" if typ == "update-all-security" else None)
            with state() as s:
                runs = s["updateRuns"]
                out = runs[-1]["summary"] if runs else "done"
        elif typ == "check":
            rc, o = cx(vmid, "command -v apt-get >/dev/null || { echo NOAPT; exit 0; }; apt-get update -q 2>&1 | tail -3", 900)
            if "NOAPT" in o:
                raise RuntimeError("this container does not use apt")
            rc, lst = cx(vmid, "apt list --upgradable 2>/dev/null", 120)
            pkgs = parse_upgradable(lst)
            sec = [x for x in pkgs if x["security"]]
            set_container(vmid, updates={"count": len(pkgs), "security": len(sec), "checkedAt": now_ms()})
            with state() as s:  # show the new count right away
                for c in (s.get("lastCollect") or {}).get("containers", []):
                    if c["vmid"] == vmid:
                        c["updates"] = s["containers"][str(vmid)]["updates"]
            out = (f"{len(pkgs)} update(s) available ({len(sec)} security):\n" + "\n".join(f"{x['name']} {x['old']} -> {x['new']}" for x in pkgs[:60])
                   + ("\n…" if len(pkgs) > 60 else "")) if pkgs else "Up to date."
        elif typ == "check-updates":
            n = check_host_updates()
            out = f"{n} host package update(s) available." if n else "The host is up to date."
        else:
            raise RuntimeError(f"unknown action {typ}")
    except Exception as e:
        ok, out = False, str(e)
    with state() as s:
        t = s["tasks"].get(tid)
        if t:
            t["status"] = "done" if ok else "failed"
            t["output"] = (out or "done")[-20000:]
            t["u"] = now_ms()
        event("info" if ok else "error", f"{t['text'] if t else typ} ({'done' if ok else 'failed'}) — requested by {by}", s)
    sync_now()
    cmd_report()


# ------------------------------------------------------------------ main

def main():
    global CFG, PROC
    CFG = load_config()
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    sys.argv = [sys.argv[0]] + args
    cmd = args[0] if args else "show"
    PROC = cmd
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
    elif cmd == "poll":
        cmd_poll()
    elif cmd == "ctaction" and len(sys.argv) > 2:
        cmd_ctaction(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
