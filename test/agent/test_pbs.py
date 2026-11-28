"""The backup server (PBS) like a host: install now (all or security), the nightly "security" setting, runs.

Run: python3 -m unittest discover -s test/agent   (standard library only, no network or SSH)
"""
import contextlib
import importlib.util
import os
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "agent", "hl_agent.py")

UPGRADABLE = ("Listing...\n"
              "openssl/stable-security 3.0.1 amd64 [upgradable from: 3.0.0]\n"
              "proxmox-backup-server/stable 4.2.15-1 amd64 [upgradable from: 4.2.14-1]\n")


def load(busy_checks=0, policy=None):
    spec = importlib.util.spec_from_file_location("hl_agent_pbs_test", SRC)
    hl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hl)
    hl.CFG = {"name": "connector1", "pbs_updates": True, "pbs": {"server": "192.168.10.245"}}
    hl.log = hl.plog = lambda *a, **k: None
    hl.progress = lambda *a, **k: None
    hl.events = []
    hl.event = lambda level, msg, s=None: hl.events.append((level, msg))
    hl.time = types.SimpleNamespace(time=lambda: 0, sleep=lambda s: None, strftime=lambda *a: "20261128")
    st = {"pending": {}, "policy": policy or {}, "pbsHost": {"name": "HOLY"}}

    @contextlib.contextmanager
    def fake_state():
        yield st
    hl.state = fake_state
    cmds = []
    left = {"busy": busy_checks}

    def pbs_ssh(cmd, timeout=120):
        cmds.append(cmd)
        if cmd == hl.PBS_BUSY:
            left["busy"] -= 1
            return (0 if left["busy"] >= 0 else 1), ""
        if "apt list --upgradable" in cmd:
            return 0, UPGRADABLE
        return 0, "Setting up openssl ...\n"
    hl.pbs_ssh = pbs_ssh
    hl.check_pbs_updates = lambda: st["pbsHost"].setdefault("updates", {"count": 0, "security": 0}) and 0
    return hl, st, cmds


class PbsInstallTest(unittest.TestCase):
    def test_security_installs_only_security_packages(self):
        hl, st, cmds = load()
        out = hl.pbs_install("security", "owner")
        apt = [c for c in cmds if "--only-upgrade" in c]
        self.assertEqual(len(apt), 1)
        self.assertIn("openssl", apt[0])
        self.assertNotIn("proxmox-backup-server", apt[0])
        self.assertIn("1 security update(s) installed", out)
        self.assertEqual(st["pbsRuns"][-1]["level"], "info")
        self.assertFalse(any("reboot" in c for c in cmds), "never reboots")

    def test_full_runs_dist_upgrade(self):
        hl, st, cmds = load()
        out = hl.pbs_install("full", "owner")
        self.assertTrue(any("dist-upgrade" in c for c in cmds))
        self.assertIn("2 update(s) installed", out)

    def test_waits_for_a_running_backup_then_installs(self):
        hl, st, cmds = load(busy_checks=3)
        hl.pbs_install("full", "owner")
        self.assertEqual(cmds.count(hl.PBS_BUSY), 4)
        self.assertTrue(any("dist-upgrade" in c for c in cmds))

    def test_held_when_still_busy_after_30_min(self):
        hl, st, cmds = load(busy_checks=10_000)
        out = hl.pbs_install("full", "owner")
        self.assertTrue(out.startswith("Held"))
        self.assertFalse(any("dist-upgrade" in c for c in cmds))
        self.assertEqual(st["pbsRuns"][-1]["level"], "warn")

    def test_not_the_owner_refuses(self):
        hl, st, cmds = load()
        hl.CFG["pbs_updates"] = False
        with self.assertRaises(RuntimeError):
            hl.pbs_install("full", "owner")

    def test_policy_keeps_the_pbs_setting(self):
        hl, st, _ = load()
        st.update(handled={}, tasks={})
        hl.handle_replies([{"policy": {"securityOnly": False, "pbs": "security", "at": 5, "by": "owner"}}])
        self.assertEqual(st["policy"]["pbs"], "security")
        hl.handle_replies([{"policy": {"securityOnly": True, "pbs": "nonsense", "at": 6, "by": "owner"}}])
        self.assertEqual(st["policy"]["pbs"], "ask")


if __name__ == "__main__":
    unittest.main()
