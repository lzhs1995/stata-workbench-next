import copy
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch
import verify_release as release
import verified_workbench as entry
import mac_workbench


class PublicReleaseTests(unittest.TestCase):
    def test_source_manifest(self):
        self.assertEqual(release.verify()["verdict"], "PASS")

    def test_tampered_file_fails(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "release").mkdir()
            (root / "package.json").write_text('{"version":"1"}')
            (root / "runtime.js").write_text("tampered")
            (root / "release/runtime-manifest.json").write_text(json.dumps({"version":"1", "files": {
                "runtime.js": {"sha256":"0" * 64, "bytes":8}}}))
            self.assertEqual(release.verify(root=root)["failedChecks"], ["runtime.js"])

    def test_redirect_and_foreign_endpoints_refused(self):
        with self.assertRaisesRegex(RuntimeError, "redirect"):
            entry.NoRedirect().redirect_request(None, None, 302, None, None, "https://example.com")
        with self.assertRaises(ValueError):
            entry.LocalBridge().request("/force-reset", {})

    def test_apple_script_window_binding(self):
        with patch.object(entry.permissions, "window_observation", return_value={"ok": True, "count": 1}) as out:
            self.assertEqual(entry.LocalBridge().launcher_window_count(42), 1)
            out.assert_called_once_with(42)

    @unittest.skipUnless(sys.platform == "darwin", "Mac adapter path rules")
    def test_profile_prefix_collision_rejected(self):
        expected = str(entry.PROFILE / "user-data")
        executable = str(Path(entry.CODE_CLI).resolve().parents[3] / "MacOS/Code")
        rows = f"42 {executable} --user-data-dir {expected}-foreign --other\n"
        with patch.object(mac_workbench, "output", side_effect=[rows, executable]):
            self.assertEqual(entry.LocalBridge().code_instances(), [])

    @unittest.skipUnless(sys.platform == "darwin", "Mac adapter path rules")
    def test_exact_profile_accepted(self):
        expected = str(entry.PROFILE / "user-data")
        executable = str(Path(entry.CODE_CLI).resolve().parents[3] / "MacOS/Code")
        rows = f"42 {executable} --user-data-dir {expected} --extensions-dir /other\n"
        with patch.object(mac_workbench, "output", side_effect=[rows, executable]):
            self.assertEqual(entry.LocalBridge().code_instances(), [{"pid":42,"launcher":True}])
