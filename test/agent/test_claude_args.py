"""Every agent Claude run starts with no MCP servers (no claude.ai connectors), unless config "claude_mcp" is true.

Run: python3 -m unittest discover -s test/agent   (standard library only, no network or SSH)
"""
import importlib.util
import json
import os
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "agent", "hl_agent.py")


def load(cfg_extra=None):
    spec = importlib.util.spec_from_file_location("hl_agent_args_test", SRC)
    hl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hl)
    hl.CFG = {"name": "connector1", **(cfg_extra or {})}
    hl.record_usage = lambda u: None
    calls = []

    def run(args, **kw):
        calls.append(args)
        return types.SimpleNamespace(returncode=0, stdout=json.dumps({"result": "ok", "session_id": "s1"}), stderr="")
    hl.subprocess = types.SimpleNamespace(run=run, TimeoutExpired=TimeoutError)
    return hl, calls


class ClaudeArgsTest(unittest.TestCase):
    def test_chat_task_has_no_mcp_servers(self):
        hl, calls = load()
        self.assertEqual(hl.claude("hello"), (0, "ok"))
        self.assertIn("--strict-mcp-config", calls[0])
        self.assertNotIn("--mcp-config", calls[0])
        self.assertNotIn("--tools", calls[0])  # built-in tools (Bash, Read, ...) stay

    def test_resumed_and_review_runs_too(self):
        hl, calls = load()
        hl.claude("follow-up", resume="abc")
        hl.claude("review", kind="review")
        for a in calls:
            self.assertIn("--strict-mcp-config", a)
        self.assertEqual(calls[0][calls[0].index("--resume") + 1], "abc")

    def test_merge_run_has_no_tools_and_no_mcp(self):
        hl, calls = load()
        hl.claude("merge", tools="")
        a = calls[0]
        self.assertEqual(a.count("--strict-mcp-config"), 1)
        self.assertEqual(a[a.index("--tools") + 1], "")

    def test_config_can_turn_connectors_back_on(self):
        hl, calls = load({"claude_mcp": True})
        hl.claude("hello")
        self.assertNotIn("--strict-mcp-config", calls[0])


if __name__ == "__main__":
    unittest.main()
