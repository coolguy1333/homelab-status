"""Datacenter merge tasks: one reply written from every host's answer, with no tools.

Run: python3 -m unittest discover -s test/agent   (standard library only, no network or SSH)
"""
import contextlib
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "agent", "hl_agent.py")


def load():
    spec = importlib.util.spec_from_file_location("hl_agent_merge_test", SRC)
    hl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hl)
    hl.CFG = {"name": "connector1", "host": "192.168.10.23", "site_urls": [], "token": "t", "quick_answers": True}
    hl.log = lambda *a, **k: None
    hl.sync_now = lambda: None
    hl.cmd_report = lambda *a, **k: None
    st = {"tasks": {}}

    @contextlib.contextmanager
    def fake_state():
        yield st
    hl.state = fake_state
    return hl, st


class MergeTest(unittest.TestCase):
    def test_prompt_has_question_and_every_part(self):
        hl, _ = load()
        p = hl.merge_prompt("/ai what needs updating?", [
            {"host": "GOD", "output": "## Updates\n- 3 containers"},
            {"host": "HELP", "output": "boom", "failed": True},
        ])
        self.assertIn("\nwhat needs updating?\n", p)
        self.assertNotIn("/ai", p)
        self.assertIn("### GOD\n\n## Updates\n- 3 containers", p)
        self.assertIn("### HELP — this agent FAILED\n\nboom", p)
        self.assertIn("## Handoff plan for Claude Code", p)

    def test_merge_task_skips_scripts_and_runs_claude_without_tools(self):
        hl, st = load()
        calls = []

        def fake_claude(prompt, **kw):
            calls.append((prompt, kw))
            hl.LAST_USAGE = {"input": 10, "output": 5, "cost": 0.01}
            return 0, "One answer."
        hl.claude = fake_claude
        hl.quick_answer = lambda text: self.fail("a merge task must not go to the scripts")
        st["tasks"]["m1"] = {"id": "m1", "text": "list containers", "status": "running",
                             "merge": [{"host": "GOD", "output": "a"}, {"host": "HELP", "output": "b"}]}
        hl.cmd_task("m1")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1].get("tools"), "")
        self.assertEqual(calls[0][1].get("kind"), "merge")
        self.assertIsNone(calls[0][1].get("resume"))
        t = st["tasks"]["m1"]
        self.assertEqual((t["status"], t["output"]), ("done", "One answer."))
        self.assertEqual(t["usage"]["cost"], 0.01)

    def test_failed_merge_is_reported_failed(self):
        hl, st = load()
        hl.claude = lambda prompt, **kw: (1, "Claude stopped: error")
        st["tasks"]["m2"] = {"id": "m2", "text": "x", "status": "running", "merge": [{"host": "GOD", "output": "a"}]}
        hl.cmd_task("m2")
        self.assertEqual(st["tasks"]["m2"]["status"], "failed")

    def test_handle_replies_keeps_the_merge_parts(self):
        hl, st = load()
        st.update(handled={}, pending={})
        spawned = []
        hl.spawn = lambda *a: spawned.append(a)
        hl.event = lambda *a, **k: None
        hl.handle_replies([{"tasks": [{"id": "m3", "text": "q", "merge": [{"host": "GOD", "output": "a"}]}]}])
        self.assertEqual(st["tasks"]["m3"]["merge"], [{"host": "GOD", "output": "a"}])
        self.assertNotIn("chat", st["tasks"]["m3"])
        self.assertEqual(spawned, [("task", "m3")])


if __name__ == "__main__":
    unittest.main()
