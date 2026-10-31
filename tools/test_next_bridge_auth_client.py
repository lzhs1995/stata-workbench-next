"""Next 阶段 C 的客户端部分：从会话注册表读 token，每个请求带 Bearer 和精确 Host。
最后一项起一个真 HTTP 服务，核客户端真的发出了这两个头。"""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

import verified_workbench as entry

TOKEN = "t" * 43


def write(directory, name, **fields):
    rec = {"schema": entry.SESSION_SCHEMA, "sessionId": name, "port": 17601, "token": TOKEN,
           "startedAt": "2026-10-31T13:00:00.000Z", **fields}
    (directory / f"{name}.json").write_text(json.dumps(rec), encoding="utf-8")
    return rec


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_registry_fails_before_any_request(self):
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING"):
            entry.session_record(17601, self.root)
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING"):
            entry.session_record(17601, self.root / "nope")

    def test_picks_this_port_and_refuses_two_live_records(self):
        # 阶段 D：同一端口两条活记录不再「取最新」，而是 MULTIPLE_SESSIONS；extensionHostPid 已死的那条跳过
        write(self.sessions, "other-port", port=17602, token="o" * 43)
        write(self.sessions, "old", startedAt="2026-10-31T12:00:00.000Z", token="a" * 43, extensionHostPid=111)
        write(self.sessions, "new", startedAt="2026-10-31T13:30:00.000Z", token="b" * 43, extensionHostPid=222)
        with patch.object(entry, "pid_alive", lambda pid: True):
            with self.assertRaisesRegex(entry.MultipleSessionsError, "MULTIPLE_SESSIONS"):
                entry.session_record(17601, self.root)
        with patch.object(entry, "pid_alive", lambda pid: pid != 111):
            self.assertEqual(entry.session_record(17601, self.root)["sessionId"], "new")
            self.assertEqual(entry.auth_headers(17601, self.root),
                             {"Authorization": "Bearer " + "b" * 43, "Host": "127.0.0.1:17601"})

    def test_skips_malformed_and_foreign_records(self):
        (self.sessions / "broken.json").write_text("{not json", encoding="utf-8")
        (self.sessions / ".tmp.json").write_text(json.dumps({"port": 17601}), encoding="utf-8")
        write(self.sessions, "wrong-schema", schema="something-else")
        write(self.sessions, "bad-token", token="has spaces in it!!")
        with self.assertRaisesRegex(entry.SessionRegistryError, "SESSION_REGISTRY_MISSING"):
            entry.session_record(17601, self.root)
        write(self.sessions, "good")
        self.assertEqual(entry.session_record(17601, self.root)["sessionId"], "good")

    def test_real_request_carries_bearer_and_exact_host(self):
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.update(self.headers)
                body = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            write(self.sessions, "live", port=port)
            bridge = entry.LocalBridge.__new__(entry.LocalBridge)
            with patch.object(entry, "PORT", port), patch.object(entry, "STATE_ROOT", self.root):
                code, body = bridge.request("/status")
        finally:
            server.shutdown()
        self.assertEqual((code, body), (200, {"ok": True}))
        self.assertEqual(seen.get("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(seen.get("Host"), f"127.0.0.1:{port}")


if __name__ == "__main__":
    unittest.main()
