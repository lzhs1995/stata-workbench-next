"""Real Windows PowerShell 5.1/7 execution, without Stata or a desktop session."""
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
class WindowsEntrypointTests(unittest.TestCase):
    def test_legacy_and_current_wrappers_reject_unsafe_modes_before_dispatch(self):
        for shell in ("powershell.exe", "pwsh.exe"):
            executable = shutil.which(shell)
            self.assertIsNotNone(executable, shell + " is required in the Windows test environment")
            for script in ("invoke_stata_visible.ps1", "invoke_stata_visible_safe.ps1"):
                for flag in ("-AllowHttp500Retry", "-NoSharedStateMutation", "-UseRunFileHandler"):
                    with self.subTest(shell=shell, script=script, flag=flag):
                        result = subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive",
                            "-File", str(ROOT / "scripts" / script), "-Code", 'display "中文 & %TEMP%"', flag],
                            capture_output=True, timeout=20)
                        self.assertEqual(result.returncode, 2)
                        output = (result.stdout + result.stderr).decode("utf-8", "replace")
                        self.assertNotIn("ParserError", output)
                        self.assertNotIn("not recognized", output)
                        self.assertTrue(any(s in output for s in ("retired", "hidden replacement", "human-file acceptance")), output)


if __name__ == "__main__":
    unittest.main()
