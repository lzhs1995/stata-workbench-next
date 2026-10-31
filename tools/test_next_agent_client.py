"""Next 阶段 B 的客户端部分：--agent-name 清洗、请求里带 agentName、--events 只读。"""
import argparse
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

import shared_stata as client
import verified_workbench as entry


class AgentNameTests(unittest.TestCase):
    def test_sanitize_matches_extension_rules(self):
        self.assertEqual(client.agent_name("  codex-astra "), "codex-astra")
        self.assertEqual(client.agent_name("<b>claude</b>"), "bclaudeb")
        self.assertEqual(client.agent_name("研究助手 1"), "研究助手 1")
        self.assertEqual(len(client.agent_name("a" * 99)), 40)
        for bad in ("", "   ", "<>"):
            with self.assertRaises(argparse.ArgumentTypeError):
                client.agent_name(bad)

    def test_request_carries_agent_name(self):
        captured = {}

        def fake_execute(d, request, receipt, timeout, source_path=None):
            captured.update(request)
            return {"verdict": "PASS_VISIBLE_SHARED_RUN", "postCount": 1, "error": None,
                    "responseDiagnostics": {"fields": {"runId": "r", "requestId": "q"}}}

        argv = ["shared_stata.py", "--code", "display 1", "--agent-name", "claude code", "--receipt-dir", "/nonexistent-ok"]
        with patch.object(sys, "argv", argv), patch.object(entry, "helpers", Mock()), patch.object(entry, "bind_session", Mock()), \
                patch.object(client, "execute_once", fake_execute), \
                patch.object(entry.host, "lock_paths", Mock(return_value=[])), redirect_stdout(io.StringIO()):
            self.assertEqual(client.main(), 0)
        self.assertEqual(captured["agentName"], "claude code")
        self.assertEqual(captured["source"], "agent")

    def test_agent_name_defaults_from_environment(self):
        # 默认值在 main() 建 parser 时读环境变量，所以要在 main() 之前设
        captured = {}

        def fake_execute(d, request, receipt, timeout, source_path=None):
            captured.update(request)
            return {"verdict": "PASS_VISIBLE_SHARED_RUN", "postCount": 1, "error": None,
                    "responseDiagnostics": {"fields": {}}}

        for env, expected in (({"STATA_WORKBENCH_AGENT_NAME": "codex"}, "codex"), ({}, "agent")):
            captured.clear()
            with patch.dict("os.environ", env, clear=False), \
                    patch.object(sys, "argv", ["shared_stata.py", "--code", "display 1", "--receipt-dir", "/x"]), \
                    patch.object(entry, "helpers", Mock()), patch.object(entry, "bind_session", Mock()), patch.object(client, "execute_once", fake_execute), \
                    patch.object(entry.host, "lock_paths", Mock(return_value=[])), redirect_stdout(io.StringIO()):
                if not env:
                    import os
                    os.environ.pop("STATA_WORKBENCH_AGENT_NAME", None)
                self.assertEqual(client.main(), 0)
            self.assertEqual(captured["agentName"], expected)


class EventsTests(unittest.TestCase):
    def test_events_is_read_only_and_never_takes_the_execution_lock(self):
        lock = Mock(side_effect=AssertionError("events must not lock"))
        events = Mock(return_value={"ok": True, "events": [{"seq": 4}], "lastSeq": 4})
        with patch.object(sys, "argv", ["shared_stata.py", "--events", "3", "--limit", "10"]), \
                patch.object(entry.host, "lock_paths", lock), patch.object(entry, "helpers", lock), \
                patch.object(entry, "bind_session", Mock()), \
                patch.object(entry.LocalBridge, "events", events), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(client.main(), 0)
        events.assert_called_once_with(since=3, limit=10)
        self.assertEqual(json.loads(out.getvalue())["events"], [{"seq": 4}])

    def test_events_rejects_bad_bounds(self):
        for argv in (["--events", "-1"], ["--events", "0", "--limit", "0"], ["--events", "0", "--limit", "501"]):
            with patch.object(sys, "argv", ["shared_stata.py", *argv]), redirect_stdout(io.StringIO()), \
                    patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
                client.main()

    def test_bridge_allows_only_numeric_events_queries(self):
        bridge = entry.LocalBridge.__new__(entry.LocalBridge)
        for path in ("/events", "/events?since=x", "/events?since=1&limit=1&x=2", "/events?since=1;rm", "/soft-stop"):
            with self.assertRaisesRegex(ValueError, "unsupported endpoint"):
                bridge.request(path)
        with self.assertRaisesRegex(ValueError, "unsupported endpoint"):
            bridge.request("/events?since=1", payload={"x": 1})


if __name__ == "__main__":
    unittest.main()
