import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import workbench_platform as host
import windows_workbench as win
import workbench_doctor
import verified_workbench as entry


class LockTests(unittest.TestCase):
    def test_real_process_contention_crash_release_and_stable_inode(self):
        with tempfile.TemporaryDirectory(prefix="workbench 锁 ") as directory:
            lock = Path(directory) / "shared.lock"
            script = ("import sys,time; from workbench_platform import file_lock; "
                      "cm=file_lock(sys.argv[1]); cm.__enter__(); print('LOCKED',flush=True); time.sleep(30)")
            child = subprocess.Popen([sys.executable, "-B", "-u", "-c", script, str(lock)],
                                     cwd=Path(__file__).parent, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), "LOCKED")
                inode = lock.stat().st_ino
                with self.assertRaises(TimeoutError):
                    with host.file_lock(lock, timeout=0.1):
                        self.fail("second process acquired held lock")
                child.kill()  # This test owns only this synthetic child.
                child.wait(timeout=5)
                with host.file_lock(lock, timeout=2):
                    self.assertEqual(lock.stat().st_ino, inode)
                self.assertTrue(lock.exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                child.stdout.close()

    def test_distinct_profiles_have_independent_locks(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a", Path(directory) / "b"
            la, lb = host.lock_paths(a, "execute", "win32"), host.lock_paths(b, "execute", "win32")
            with host.file_lock(la[0]), host.file_lock(lb[0]):
                self.assertNotEqual(la, lb)


class WindowsBindingTests(unittest.TestCase):
    def setUp(self):
        self.exe = r"C:\Program Files\Microsoft VS Code\Code.exe"
        self.profile = r"C:\Users\研究 用户\.stata-workbench-shared"
        self.argv = [self.exe, "--user-data-dir", self.profile + r"\user-data",
                     "--extensions-dir=" + self.profile + r"\extensions"]
        self.root = {"pid": 100, "ppid": 1, "createdAt": "2026-10-27T01:00:00Z", "executable": self.exe, "argv": self.argv}
        self.owner = {"pid": 101, "ppid": 100, "createdAt": "2026-10-27T01:00:01Z"}

    def test_exact_profile_and_process_identity(self):
        matched = win.matching_launchers([self.root], self.exe.lower(), self.profile)
        self.assertEqual([r["pid"] for r in matched], [100])
        owner = win.bind_listener([self.root, self.owner], [101, 101], matched)
        self.assertEqual(owner["launcherPid"], 100)
        self.assertEqual(owner["createdAt"], self.owner["createdAt"])
        for argv in (self.argv + ["--type=utility"], self.argv + ["--user-data-dir", self.profile],
                     [self.exe, "--user-data-dir", self.profile + r"\user-data-other", "--extensions-dir", self.profile + r"\extensions"]):
            self.assertEqual(win.matching_launchers([dict(self.root, argv=argv)], self.exe, self.profile), [])

    def test_foreign_listener_pid_reuse_and_multiple_owners(self):
        matched = win.matching_launchers([self.root], self.exe, self.profile)
        self.assertFalse(win.bind_listener([self.root, dict(self.owner, ppid=200)], [101], matched)["launcher"])
        reused = dict(self.root, createdAt="2026-10-27T02:00:00Z")
        self.assertFalse(win.bind_listener([reused, self.owner], [101], matched)["launcher"])
        with self.assertRaisesRegex(RuntimeError, "not unique"):
            win.bind_listener([self.root, self.owner], [100, 101], matched)
        self.assertIsNone(win.bind_listener([], [], []))

    @unittest.skipUnless(sys.platform == "win32", "requires actual Windows parser and CIM")
    def test_real_windows_parser_process_and_tcp_queries(self):
        # Includes cmd metacharacters; parsing does not invoke a command shell.
        argv = self.argv + ["C:\\研究 & %TEMP%\\folder with spaces\\"]
        self.assertEqual(win.split_command_line(subprocess.list2cmdline(argv)), argv)
        rows = win.process_rows()
        own = next(r for r in rows if r["pid"] == os.getpid())
        self.assertTrue(own["createdAt"])
        import socket
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            adapter = win.WindowsWorkbench(Path.home() / "absent-test-profile", self.exe, listener.getsockname()[1])
            owner = adapter.bridge_owner()
            self.assertEqual(owner["pid"], os.getpid())
            self.assertFalse(owner["launcher"])


class PortabilityTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "POSIX subprocess itself may import fcntl")
    def test_import_does_not_probe_or_import_fcntl_on_windows(self):
        script = "import sys; import verified_workbench,shared_stata; print('fcntl' in sys.modules)"
        result = subprocess.run([sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "False")

    def test_do_file_path_unicode_spaces_and_macro_rejection(self):
        with tempfile.TemporaryDirectory(prefix="workbench 路径 ") as directory:
            p = Path(directory) / "a & b's.do"
            p.write_bytes(b"display 1\r\n")
            self.assertEqual(host.stata_file_command(p), 'do "' + p.resolve().as_posix() + '"')
            for name in ("macro$name.do", "local`name.do"):
                p = Path(directory) / name
                p.touch()
                with self.assertRaises(ValueError):
                    host.stata_file_command(p)

    def test_doctor_reports_missing_install_without_launch(self):
        with patch.object(entry, "helpers", side_effect=RuntimeError("candidate absent")) as helpers:
            result = workbench_doctor.diagnose(entry)
        self.assertEqual(result["verdict"], "NEEDS_ATTENTION")
        self.assertEqual(result["launchCount"], 0)
        self.assertEqual(result["stataDispatchCount"], 0)
        self.assertIn("candidate absent", next(c["detail"] for c in result["checks"] if c["name"] == "instance"))
        helpers.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
