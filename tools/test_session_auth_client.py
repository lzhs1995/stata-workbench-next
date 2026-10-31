"""Client authentication contract: registry lookup precedes every request."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verified_workbench as client


class SessionAuthClientTests(unittest.TestCase):
    def test_missing_registry_does_not_request(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"STATA_WORKBENCH_SESSION_ROOT": tmp}, clear=False):
            bridge = client.LocalBridge.__new__(client.LocalBridge)
            bridge.platform = None
            bridge.request = client.LocalBridge.request.__get__(bridge)
            with self.assertRaisesRegex(RuntimeError, "SESSION_REGISTRY_MISSING"):
                bridge.request("/status")

    def test_registry_token_and_headers(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"STATA_WORKBENCH_SESSION_ROOT": tmp}, clear=False):
            token = "ab" * 32
            Path(tmp, "sid.json").write_text(json.dumps({"sessionId": "sid", "port": 17601, "token": token}))
            bridge = client.LocalBridge.__new__(client.LocalBridge)
            bridge.platform = None
            seen = {}
            class Opener:
                def open(self, request, timeout):
                    seen.update(request.headers)
                    class Response:
                        status = 200
                        def __enter__(self): return self
                        def __exit__(self, *args): pass
                        def read(self): return b'{"ok":true}'
                    return Response()
            with patch.object(client.urllib.request, "build_opener", return_value=Opener()):
                bridge.request("/status")
            self.assertEqual(seen["Authorization"], "Bearer " + token)
            self.assertEqual(seen["Host"], "127.0.0.1:17601")


if __name__ == "__main__":
    unittest.main()
