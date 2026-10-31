"""Next 阶段 D 的客户端部分：选会话、MULTIPLE_SESSIONS 与 SESSION_REGISTRY_MISSING 分开报、
跳过已死的 extensionHostPid、绑定后不改投别的会话、提交前核 /status 与注册表一致。"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import shared_stata as client
import verified_workbench as entry


def write(root, sid, port, name=None, pid=None, **extra):
    d = Path(root) / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    rec = {"schema": entry.SESSION_SCHEMA, "sessionId": sid, "port": port, "token": (sid[-1] * 43),
           "extensionHostPid": pid if pid is not None else os.getpid(), "sessionName": name, **extra}
    (d / f"{sid}.json").write_text(json.dumps(rec), encoding="utf-8")
    return rec


def status_for(rec, **over):
    s = {"nextSession": {"sessionId": rec["sessionId"]}, "nextAuth": {"port": rec["port"]},
         "resetGeneration": rec.get("generation"), "diskBundleSha256": rec.get("diskBundleSha256")}
    s.update(over)
    return s


class Isolated(unittest.TestCase):
    """bind_session 改模块全局；每个测试前后存取原值，环境变量也隔离。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.saved = {k: getattr(entry, k) for k in ("PORT", "PROFILE", "EXTENSION", "BOUND_SESSION_ID", "STATE_ROOT")}
        entry.STATE_ROOT = self.root
        entry.BOUND_SESSION_ID = None
        self.env = patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for k in ("STATA_WORKBENCH_SESSION", "STATA_WORKBENCH_PORT", "STATA_WORKBENCH_PROFILE"):
            os.environ.pop(k, None)

    def tearDown(self):
        self.env.stop()
        for k, v in self.saved.items():
            setattr(entry, k, v)
        self.tmp.cleanup()


class SelectTests(Isolated):
    def test_missing_and_multiple_are_reported_separately(self):
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING"):
            entry.select_session()
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2")
        with self.assertRaises(entry.MultipleSessionsError) as cm:
            entry.select_session()
        self.assertIn("MULTIPLE_SESSIONS", str(cm.exception))
        self.assertIn("nothing was executed", str(cm.exception))
        self.assertNotIsInstance(entry.SessionRegistryError("x"), entry.MultipleSessionsError)

    def test_same_port_twice_is_ambiguous_until_the_dead_one_is_skipped(self):
        write(self.root, "sOld", 17601, "p1", pid=111)
        write(self.root, "sNew", 17601, "p1", pid=222)
        with self.assertRaisesRegex(entry.MultipleSessionsError, "MULTIPLE_SESSIONS"):
            entry.select_session(port=17601, alive=lambda pid: True)
        rec = entry.select_session(port=17601, alive=lambda pid: pid != 111)
        self.assertEqual(rec["sessionId"], "sNew")
        unknown = entry.select_session(port=17601, alive=lambda pid: None if pid == 111 else False)
        self.assertEqual(unknown["sessionId"], "sOld", "unknown liveness is kept, only certain death is skipped")

    def test_select_by_name_or_id(self):
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2")
        self.assertEqual(entry.select_session("p2")["sessionId"], "sB")
        self.assertEqual(entry.select_session("sA")["sessionName"], "p1")
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING: no live Next session record for session 'p9'"):
            entry.select_session("p9")
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING"):
            entry.select_session("p1", port=17602)

    def test_real_pid_liveness(self):
        self.assertIs(entry.pid_alive(os.getpid()), True)
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.assertIs(entry.pid_alive(child.pid), False)
        self.assertIsNone(entry.pid_alive(None))
        self.assertIsNone(entry.pid_alive(0))


class BindTests(Isolated):
    def test_bind_points_port_profile_and_extension_at_the_session(self):
        profile = self.root / "profiles" / "p2"
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2", profilePath=str(profile))
        rec = entry.bind_session("p2")
        self.assertEqual((rec["sessionId"], entry.PORT, entry.BOUND_SESSION_ID), ("sB", 17602, "sB"))
        self.assertEqual(entry.PROFILE, profile.resolve())
        self.assertEqual(entry.EXTENSION.parent, profile.resolve() / "extensions")
        self.assertEqual(entry.auth_headers(), {"Authorization": "Bearer " + "B" * 43, "Host": "127.0.0.1:17602"})

    def test_single_live_session_is_chosen_without_a_selector(self):
        write(self.root, "sOnly", 17607, "solo")
        self.assertEqual(entry.bind_session()["sessionId"], "sOnly")
        self.assertEqual(entry.PORT, 17607)

    def test_environment_selector_and_port_filter(self):
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2")
        os.environ["STATA_WORKBENCH_SESSION"] = "p1"
        self.assertEqual(entry.bind_session()["sessionId"], "sA")
        entry.BOUND_SESSION_ID = None
        os.environ.pop("STATA_WORKBENCH_SESSION")
        os.environ["STATA_WORKBENCH_PORT"] = "17602"
        entry.PORT = 17602
        self.assertEqual(entry.bind_session()["sessionId"], "sB")

    def test_explicit_profile_must_match(self):
        write(self.root, "sA", 17601, "p1", profilePath=str(self.root / "profiles/p1"))
        os.environ["STATA_WORKBENCH_PROFILE"] = str(self.root / "other")
        entry.PROFILE = (self.root / "other").resolve()
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_PROFILE_MISMATCH"):
            entry.bind_session("p1")
        self.assertIsNone(entry.BOUND_SESSION_ID)

    def test_bound_session_is_never_switched_after_a_reload(self):
        write(self.root, "sA", 17601, "p1")
        entry.bind_session("p1")
        (self.root / "sessions" / "sA.json").unlink()
        write(self.root, "sA2", 17601, "p1")
        with self.assertRaisesRegex(entry.SessionRegistryError, "bound session sA is no longer registered"):
            entry.auth_headers()

    def test_list_sessions_hides_tokens(self):
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2", pid=999)
        rows = entry.list_sessions(alive=lambda pid: pid != 999)
        self.assertNotIn("A" * 43, json.dumps(rows))
        self.assertEqual([(r["sessionId"], r["alive"]) for r in rows], [("sA", True), ("sB", False)])


class IdentityTests(Isolated):
    def setUp(self):
        super().setUp()
        self.rec = write(self.root, "sA", 17601, "p1", generation=2, diskBundleSha256="a" * 64)
        entry.bind_session("p1")

    def test_matching_status_passes(self):
        self.assertEqual(entry.verify_session_identity(status_for(self.rec)),
                         {"sessionId": "sA", "port": 17601, "generation": 2, "bundleSha": "a" * 64})

    def test_any_difference_or_missing_value_refuses(self):
        for field, over in (("sessionId", {"nextSession": {"sessionId": "sZ"}}), ("port", {"nextAuth": {"port": 17602}}),
                            ("generation", {"resetGeneration": 3}), ("bundleSha", {"diskBundleSha256": "b" * 64}),
                            ("sessionId", {"nextSession": {}}), ("bundleSha", {"diskBundleSha256": None})):
            with self.assertRaises(entry.SessionIdentityError) as cm:
                entry.verify_session_identity(status_for(self.rec, **over))
            self.assertIn("SESSION_IDENTITY_MISMATCH", str(cm.exception))
            self.assertIn(field, str(cm.exception))
            self.assertIn("nothing was executed", str(cm.exception))
        write(self.root, "sA", 17601, "p1", diskBundleSha256="a" * 64)
        with self.assertRaisesRegex(entry.SessionIdentityError, "generation"):
            entry.verify_session_identity(status_for(self.rec))

    def test_mismatch_blocks_dispatch_with_zero_posts(self):
        ready = {"busy": False, "postRunBusy": False, "trueReady": True, "recovery": {"required": False}, "ownedBackendPids": [14],
                 **status_for(self.rec, resetGeneration=5)}
        observed = {"identityOk": True, "axWindowCount": 1, "windowObservation": {"ok": True, "count": 1, "status": "OK"},
                    "status": ready}
        post = Mock()
        with tempfile.TemporaryDirectory() as d:
            result = client.execute_once(SimpleNamespace(w=SimpleNamespace(http_post=post)), {"code": "display 1"},
                                         Path(d) / "r", observe=lambda _: observed)
            self.assertFalse((Path(d) / "r" / "request.json").exists())
        post.assert_not_called()
        self.assertEqual((result["verdict"], result["postCount"]), ("BLOCKED_NO_DISPATCH", 0))
        self.assertIn("SESSION_IDENTITY_MISMATCH", result["error"])


class CliTests(Isolated):
    def test_list_sessions_flag_needs_no_session_and_hides_tokens(self):
        write(self.root, "sA", 17601, "p1")
        with patch.object(sys, "argv", ["shared_stata.py", "--list-sessions"]), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(client.main(), 0)
        body = json.loads(out.getvalue())
        self.assertEqual(body["sessions"][0]["sessionName"], "p1")
        self.assertNotIn("A" * 43, out.getvalue())

    def test_multiple_sessions_stop_the_client_before_any_request(self):
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2")
        helpers = Mock(side_effect=AssertionError("no request may be made"))
        with patch.object(sys, "argv", ["shared_stata.py", "--code", "display 1", "--receipt-dir", "/x"]), \
                patch.object(entry, "helpers", helpers), patch.object(entry, "PORT", entry.PORT):
            with self.assertRaisesRegex(entry.MultipleSessionsError, "MULTIPLE_SESSIONS"):
                client.main()
        helpers.assert_not_called()

    def test_session_flag_selects_one(self):
        write(self.root, "sA", 17601, "p1")
        write(self.root, "sB", 17602, "p2")
        events = Mock(return_value={"ok": True, "events": [], "lastSeq": 0})
        with patch.object(sys, "argv", ["shared_stata.py", "--events", "0", "--session", "p2"]), \
                patch.object(entry.LocalBridge, "events", events), patch.object(entry.LocalBridge, "__init__", lambda self: None), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(client.main(), 0)
        self.assertEqual((entry.BOUND_SESSION_ID, entry.PORT), ("sB", 17602))

    def test_verified_workbench_list_sessions(self):
        write(self.root, "sA", 17601, "p1")
        with patch.object(sys, "argv", ["verified_workbench.py", "--list-sessions"]), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(entry.main(), 0)
        self.assertEqual(json.loads(out.getvalue())["sessions"][0]["sessionId"], "sA")


if __name__ == "__main__":
    unittest.main()
