"""Agent update lease: a lost lease holds HA containers, and a busy lease holds a host reboot.

Run: python3 -m unittest discover -s test/agent   (standard library only, no network or SSH)
"""
import importlib.util
import os
import threading
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "agent", "hl_agent.py")


def load():
    spec = importlib.util.spec_from_file_location("hl_agent_under_test", SRC)
    hl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hl)
    hl.CFG = {"name": "connector2", "host": "192.168.10.81", "site_urls": ["https://example.invalid"], "token": "t",
              "exclude_vmids": [], "self_vmid": 203}
    hl.DRY = False
    # The agent's own view of the clock, so a test can fake time without touching the real time module.
    hl.time = types.SimpleNamespace(time=time.time, sleep=time.sleep, strftime=time.strftime, localtime=time.localtime)
    hl.events = []
    hl.event = lambda level, msg, s=None: hl.events.append((level, msg))
    hl.log = lambda *a, **k: None
    hl.plog = lambda *a, **k: None
    hl.progress = lambda *a, **k: None
    hl.cmd_report = lambda *a, **k: None
    return hl


class FakeSite:
    """Scripted answers to lease_call; records every call."""
    def __init__(self, hl, renew_answers):
        self.calls = []
        self.renew = list(renew_answers)
        self.first = True
        hl.lease_call = self

    def __call__(self, op, lid, what="", ttl=0):
        self.calls.append((op, ttl))
        if op == "release":
            return {"released": True}
        if self.first:
            self.first = False
            return {"granted": True, "until": 0}
        return self.renew.pop(0) if self.renew else {"granted": True}


def wait_for(pred, secs=3.0):
    end = time.time() + secs
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.hl = load()
        # Make the renew thread tick fast: stop.wait() is the only timer it uses.
        real_event = threading.Event

        class FastEvent(real_event):
            def wait(self, timeout=None):
                return super().wait(0.01 if timeout else timeout)
        import threading as th
        self._orig_event = th.Event
        th.Event = FastEvent
        self.hl.cx = lambda vmid, cmd, t=0: (0, "/etc/um-ha.conf 192.168.10.213\nHA-CHECKED\n")
        self.hl.peer_healthy = lambda kind, ip: (True, "primary")

    def tearDown(self):
        import threading as th
        th.Event = self._orig_event

    def test_refused_renewal_marks_lost_and_ha_guard_refuses(self):
        hl = self.hl
        site = FakeSite(hl, [{"granted": False, "holder": "connector1", "what": "run"}])
        with hl.update_lease("run", 60, ttl=60) as L:
            self.assertTrue(wait_for(lambda: L["state"] == "lost"))
            why = hl.ha_guard(215, "UptimeMonitor2 (215)")
            self.assertIsNotNone(why)
            self.assertIn("lost", why)
            hl.cx = lambda vmid, cmd, t=0: (0, "HA-CHECKED\n")   # a container that isn't in a pair carries on
            self.assertIsNone(hl.ha_guard(101, "plain (101)"))
        self.assertTrue(any("lost the update lease to connector1" in m for _, m in hl.events))
        self.assertNotIn("release", [op for op, _ in site.calls])  # 3. a lost lease isn't released

    def test_unanswered_renewals_past_ttl_mark_lost(self):
        hl = self.hl
        site = FakeSite(hl, [])
        real = site.__call__
        start = time.time()
        clock = {"t": start}
        hl.time.time = lambda: clock["t"]
        hl.time.sleep = lambda s: None

        def answer(op, lid, what="", ttl=0):
            if site.first:
                return real(op, lid, what, ttl)
            clock["t"] += 30          # every renewal attempt "takes" 30 s and gets no answer
            site.calls.append((op, ttl))
            return None
        hl.lease_call = answer
        with hl.update_lease("run", 60, ttl=60) as L:
            self.assertTrue(wait_for(lambda: L["state"] == "lost"))
            self.assertIsNotNone(hl.ha_guard(215, "UptimeMonitor2 (215)"))
        self.assertTrue(any("has not answered" in m for _, m in hl.events))
        self.assertNotIn("release", [op for op, _ in site.calls])

    def test_held_lease_is_released_and_linger_extends(self):
        hl = self.hl
        site = FakeSite(hl, [])
        with hl.update_lease("run", 60, ttl=60):
            pass
        self.assertEqual(site.calls[-1][0], "release")
        site = FakeSite(hl, [])
        with hl.update_lease("run", 60, ttl=60) as L:
            L["linger"] = 360
        self.assertEqual(site.calls[-1], ("acquire", 360))

    def test_lost_lease_while_waiting_for_partner(self):
        hl = self.hl
        FakeSite(hl, [])
        calls = {"n": 0}

        def sick(kind, ip):
            calls["n"] += 1
            hl.LEASE["state"] = "lost"   # lost during the wait
            return False, "replica, last sync never"
        hl.peer_healthy = sick
        hl.time.sleep = lambda s: None
        with hl.update_lease("run", 60, ttl=60):
            why = hl.ha_guard(215, "UptimeMonitor2 (215)")
        self.assertIn("lost", why)
        self.assertEqual(calls["n"], 1)


class HostRebootTests(unittest.TestCase):
    def setUp(self):
        self.hl = load()
        self.st = {"pending": {}, "events": []}
        hl = self.hl
        from contextlib import contextmanager

        @contextmanager
        def fake_state():
            yield self.st
        hl.state = fake_state
        self.ssh_calls = []
        hl.ssh = lambda cmd, *a, **k: (self.ssh_calls.append(cmd), (0, ""))[1]
        hl.time.sleep = lambda s: None
        self.item = {"id": "host-reboot-20261127", "kind": "host-reboot", "summary": "Reboot Proxmox host HELP",
                     "details": "All containers go down.", "t": 1}
        self.st["pending"][self.item["id"]] = dict(self.item)

    def test_busy_lease_holds_the_reboot(self):
        hl = self.hl
        hl.lease_call = lambda op, lid, what="", ttl=0: {"granted": False, "holder": "connector1", "what": "run"}
        t0 = time.time()
        ticks = iter(range(0, 10 ** 6, 3600))
        hl.time.time = lambda: t0 + next(ticks)   # the 2 h wait runs out at once
        hl.cmd_action(self.item["id"])
        self.assertFalse([c for c in self.ssh_calls if "reboot" in c], "must not reboot while the other host updates")
        self.assertNotIn(self.item["id"], self.st["pending"])
        held = [p for p in self.st["pending"].values() if p["kind"] == "host-reboot"]
        self.assertEqual(len(held), 1)
        self.assertTrue(held[0]["id"].startswith("host-reboot-20261127-held"))
        self.assertIn("Held back: the other host was still updating after 2 h", held[0]["details"])
        self.assertTrue(any("reboot held: the other host was still updating" in m for _, m in hl.events))

    def test_offline_lease_holds_the_reboot(self):
        hl = self.hl
        hl.lease_call = lambda op, lid, what="", ttl=0: None   # the dashboard doesn't answer
        hl.cmd_action(self.item["id"])
        self.assertFalse([c for c in self.ssh_calls if "reboot" in c], "must not reboot when the lease can't be checked")
        self.assertNotIn(self.item["id"], self.st["pending"])
        held = [p for p in self.st["pending"].values() if p["kind"] == "host-reboot"]
        self.assertEqual(len(held), 1)
        self.assertTrue(held[0]["id"].startswith("host-reboot-20261127-held"))
        self.assertIn("the dashboard did not answer", held[0]["details"])
        self.assertNotIn("still updating after 2 h", held[0]["details"])
        self.assertTrue(any("reboot held: the dashboard did not answer" in m for _, m in hl.events))

    def test_granted_lease_reboots(self):
        hl = self.hl
        hl.lease_call = lambda op, lid, what="", ttl=0: {"granted": True}
        hl.cmd_action(self.item["id"])
        self.assertTrue([c for c in self.ssh_calls if "hl-host-reboot" in c])
        self.assertFalse(self.st["pending"])


class SnapshotCommandTests(unittest.TestCase):
    SHELL = set("'\"`$();&|<>\\*?[]{}!#~ \t\n")

    def test_description_is_one_safe_argument(self):
        import shlex
        hl = load()
        long_email = "x" * 88 + "@example.com"
        self.assertEqual(len(long_email), 100)
        for by in ["o'brien@example.com", "a b", "$(id)", long_email, "", None]:
            cmd = hl.snapshot_cmd(212, "hlmanual202611271700", by)
            args = shlex.split(cmd)
            self.assertEqual(args[:3], ["pct", "snapshot", "212"])
            self.assertEqual(args[4], "--description", cmd)
            self.assertEqual(len(args), 6, cmd)
            desc = args[5]
            self.assertTrue(desc.startswith("manual snapshot from the dashboard by "), desc)
            who = desc[len("manual snapshot from the dashboard by "):]
            self.assertFalse(set(who) & self.SHELL, (by, who))
            self.assertLessEqual(len(who), 60)
        self.assertTrue(shlex.split(hl.snapshot_cmd(1, "s", "o'brien@example.com"))[5].endswith("obrien@example.com"))
        self.assertTrue(shlex.split(hl.snapshot_cmd(1, "s", "$(id)"))[5].endswith(" id"))
        self.assertTrue(shlex.split(hl.snapshot_cmd(1, "s", None))[5].endswith(" admin"))


if __name__ == "__main__":
    unittest.main()
