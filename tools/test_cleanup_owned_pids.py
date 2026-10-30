"""Real Windows PowerShell 5.1/7: force-reset cleanup with no owned backend PIDs.

The extension calls the script exactly like this when force reset runs before
any backend was started (Windows 2026-10-30 13:59Z: cleanup ok false).
An empty list must be a no-op success; a non-empty list with no valid PID
stays refused. The script without its no-op block is the negative control.
No process is enumerated or stopped on these paths.
"""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cleanup_mcp_stata_processes.ps1"
NOOP_START = b"# The force-reset caller passes the owned backend PIDs it knows about;"
NOOP_END = b"  exit 0\n}\n\n"  # scripts/** is -text: these bytes are LF on every checkout


def run(shell, script, csv):
    return subprocess.run([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
                           "-Force", "-OwnedPidCsv", csv], capture_output=True, timeout=30)


@unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
class CleanupOwnedPidsTests(unittest.TestCase):
    def setUp(self):
        self.shells = []
        for name in ("powershell.exe", "pwsh.exe"):
            executable = shutil.which(name)
            self.assertIsNotNone(executable, name + " is required in the Windows test environment")
            self.shells.append(executable)

    def test_empty_owned_pid_list_is_a_clean_noop(self):
        for shell in self.shells:
            for csv in ("", " "):
                with self.subTest(shell=shell, csv=csv):
                    result = run(shell, SCRIPT, csv)
                    self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
                    body = json.loads(result.stdout.decode("utf-8", "replace"))
                    self.assertIs(body["ok"], True)
                    self.assertEqual(body["mode"], "owned-pids")
                    self.assertEqual(body["killedCount"], 0)
                    self.assertEqual(result.stderr, b"")

    def test_non_empty_list_without_valid_pid_is_still_refused(self):
        for shell in self.shells:
            with self.subTest(shell=shell):
                result = run(shell, SCRIPT, "abc,1")
                self.assertEqual(result.returncode, 2)
                self.assertIn("Refusing global cleanup", result.stdout.decode("utf-8", "replace"))

    def test_negative_control_pre_fix_script_refuses_the_empty_list(self):
        # The pre-fix script is this script without the no-op block (exact inverse).
        text = SCRIPT.read_bytes()
        start = text.index(NOOP_START)
        end = text.index(NOOP_END, start) + len(NOOP_END)
        self.assertEqual(text.count(NOOP_START), 1)
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / "cleanup_mcp_stata_processes.ps1"
            old.write_bytes(text[:start] + text[end:])
            result = run(self.shells[0], old, "")
            self.assertEqual(result.returncode, 2)
            self.assertIn("Refusing global cleanup", result.stdout.decode("utf-8", "replace"))

if __name__ == "__main__":
    unittest.main()
