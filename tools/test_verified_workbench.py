"""Mock-only launcher tests: no process, network, GUI or Stata launch."""
import copy
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import verified_workbench as v


class LauncherTests(unittest.TestCase):
    def test_declared_version_matches_package_and_install_directory(self):
        version = json.loads((v.WORK / "package.json").read_text())["version"]
        self.assertEqual(v.VERSION, version)
        self.assertEqual(v.EXTENSION.name, "lzhs1995.stata-workbench-next-" + version)

    def test_declared_dependencies_match_real_disk(self):
        for path, expected in v.PINS.items():
            with self.subTest(path=str(path)):
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected)

    def setUp(self):
        self.state = {"launcherPid": 20, "owner": {"pid": 21, "ppid": 20},
                      "identityOk": True, "axWindowCount": 1, "status": {},
                      "windowObservation": {"ok": True, "count": 1, "status": "OK"}}
        self.consent = patch.object(v.permissions, "permission_status", return_value={"status": "GRANTED", "osStatus": 0})
        self.consent.start()
        self.addCleanup(self.consent.stop)
        self.launched = []
        self.activated = []
        self.d = SimpleNamespace(w=SimpleNamespace(screen_locked=lambda: False),
            _activate_exact_pid_once=lambda pid: self.activated.append(pid) or {"ok": True})

    def test_reuse_never_launches(self):
        with patch.object(v, "observe", return_value=self.state):
            result = v.open_once(self.d, lambda: self.launched.append(True))
        self.assertEqual(result["verdict"], "REUSED")
        self.assertEqual(self.launched, [])
        self.assertEqual(self.activated, [20])

    def test_cold_launch_once(self):
        absent = dict(self.state, launcherPid=None, identityOk=False)
        with patch.object(v, "observe", side_effect=[absent, self.state, self.state]):
            result = v.open_once(self.d, lambda: self.launched.append(True), foreground=False)
        self.assertEqual(result["launchCount"], 1)
        self.assertEqual(self.launched, [True])
        self.assertEqual(self.activated, [])

    def test_existing_unready_never_restarts(self):
        with patch.object(v, "observe", return_value=dict(self.state, identityOk=False)):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                v.open_once(self.d, lambda: self.launched.append(True), timeout=0)
        self.assertEqual(self.launched, [])

    def test_multiwindow_rejects_before_activation(self):
        with patch.object(v, "observe", return_value=dict(self.state, axWindowCount=2)):
            with self.assertRaises(RuntimeError):
                v.open_once(self.d, lambda: self.launched.append(True))
        self.assertEqual(self.activated, [])

    def test_instance_swap_rejected(self):
        with patch.object(v, "observe", side_effect=[self.state, self.state, dict(self.state, launcherPid=99)]):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                v.open_once(self.d, lambda: None)

    def test_screen_lock_blocks_launch(self):
        self.d.w.screen_locked = lambda: True
        with patch.object(v, "observe", return_value=dict(self.state, launcherPid=None)):
            with self.assertRaisesRegex(RuntimeError, "locked"):
                v.open_once(self.d, lambda: self.launched.append(True))
        self.assertEqual(self.launched, [])

    def test_binding_rejects_wrong_parent_and_duplicate_instances(self):
        instance = {"launcher": True, "pid": 20}
        status = {"extensionVersion": v.VERSION, "diskBundleSha256": v.BUNDLE_SHA256,
                  "bundleIdentityState": "OK", "guardModuleIdentityState": "OK", "extensionHostPid": 21}
        w = SimpleNamespace(code_instances=lambda: [instance],
            bridge_owner=lambda: {"pid": 21, "ppid": 99, "launcher": True},
            status=lambda **kw: status, launcher_window_count=lambda pid: 1)
        with self.assertRaisesRegex(RuntimeError, "does not belong"):
            v.observe(SimpleNamespace(w=w))
        w.bridge_owner = lambda: {"pid": 21, "ppid": 20, "launcher": True}
        with patch.object(v.permissions, "window_observation", return_value={"ok": True, "count": 1, "status": "OK"}):
            self.assertTrue(v.observe(SimpleNamespace(w=w))["identityOk"])
        w.code_instances = lambda: [instance, copy.deepcopy(instance)]
        with self.assertRaisesRegex(RuntimeError, "multiple"):
            v.observe(SimpleNamespace(w=w))

    def test_permission_failure_stops_before_launch_or_activation(self):
        bad = dict(self.state, axWindowCount=None, windowObservation={"ok": False, "count": None, "status": "AUTOMATION_DENIED"})
        with patch.object(v, "observe", return_value=bad) as obs:
            with self.assertRaisesRegex(RuntimeError, "AUTOMATION_DENIED"):
                v.open_once(self.d, lambda: self.launched.append(True))
        self.assertEqual(obs.call_count, 1)
        self.assertEqual(self.launched, [])
        self.assertEqual(self.activated, [])

    def test_no_permission_no_cold_launch(self):
        with patch.object(v, "observe", return_value=dict(self.state, launcherPid=None)), patch.object(v.permissions, "permission_status", return_value={"status": "AUTOMATION_DENIED"}):
            with self.assertRaisesRegex(RuntimeError, "no launch"):
                v.open_once(self.d, lambda: self.launched.append(True))
        self.assertEqual(self.launched, [])

    def test_observe_never_calls_lossy_legacy_window_helper(self):
        from unittest.mock import Mock
        window = {"ok": False, "count": None, "status": "AUTOMATION_DENIED", "appleEventError": -1743}
        w = SimpleNamespace(code_instances=lambda: [{"launcher": True, "pid": 20}],
            bridge_owner=lambda: {"pid": 21, "ppid": 20, "launcher": True}, status=lambda **kw: {},
            launcher_window_count=Mock(side_effect=AssertionError("legacy helper called")))
        with patch.object(v.permissions, "window_observation", return_value=window):
            state = v.observe(SimpleNamespace(w=w))
        self.assertIsNone(state["axWindowCount"])
        self.assertEqual(state["windowObservation"], window)
        w.launcher_window_count.assert_not_called()

    def test_windows_start_is_detached_and_does_not_wait_for_the_gui(self):
        # 10-28 Windows 实机：直接 subprocess.run(Code.exe, timeout=30) 等 GUI 退出，30 秒后超时 BLOCKED
        argv = ["C:\\VS Code\\Code.exe", "--user-data-dir", "C:\\p\\user-data", "--new-window", "C:\\w"]
        with patch.object(v.subprocess, "Popen") as popen, patch.object(v.subprocess, "run") as run:
            v.start_code(argv, platform="win32")
        run.assert_not_called()
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], argv)
        kwargs = popen.call_args.kwargs
        for stream in ("stdin", "stdout", "stderr"):
            self.assertIs(kwargs[stream], v.subprocess.DEVNULL)
        self.assertTrue(kwargs["close_fds"])
        self.assertTrue(kwargs["creationflags"] & 0x8, "DETACHED_PROCESS")
        popen.return_value.wait.assert_not_called()

    def test_devtools_port_is_opt_in_validated_and_precedes_the_workspace(self):
        from pathlib import Path
        with patch.object(v.host, "code_launch_command", return_value=["Code.exe"]):
            plain = v.launch_argv("Code.exe", Path("/p"), "/w")
            self.assertFalse(any(a.startswith("--remote-debugging-port") for a in plain))
            cdp = v.launch_argv("Code.exe", Path("/p"), "/w", 9335)
            self.assertEqual(cdp[-2], "--remote-debugging-port=9335")
            self.assertEqual(cdp[-1], str(Path("/w").resolve()))
            for bad in (80, 70000, "9335", True):
                with self.assertRaises(ValueError):
                    v.launch_argv("Code.exe", Path("/p"), "/w", bad)

    def test_workspace_trust_prompt_is_kept_unless_disabled_by_bool_opt_in(self):
        # Early Windows fast launcher passed --disable-workspace-trust always; here it is opt-in.
        from pathlib import Path
        with patch.object(v.host, "code_launch_command", return_value=["Code.exe"]):
            plain = v.launch_argv("Code.exe", Path("/p"), "/w")
            self.assertNotIn("--disable-workspace-trust", plain)
            off = v.launch_argv("Code.exe", Path("/p"), "/w", 9335, True)
            self.assertEqual(off.count("--disable-workspace-trust"), 1)
            self.assertEqual(off[-1], str(Path("/w").resolve()))
            self.assertLess(off.index("--disable-workspace-trust"), off.index("--remote-debugging-port=9335"))
            for bad in (1, "yes", None):
                with self.assertRaises(ValueError):
                    v.launch_argv("Code.exe", Path("/p"), "/w", None, bad)

    def test_mac_start_still_waits_for_the_cli_and_checks_its_result(self):
        with patch.object(v.subprocess, "Popen") as popen, patch.object(v.subprocess, "run") as run:
            v.start_code(["/usr/local/bin/code", "--new-window", "/w"], platform="darwin")
        popen.assert_not_called()
        run.assert_called_once_with(["/usr/local/bin/code", "--new-window", "/w"], check=True, timeout=30)


if __name__ == "__main__":
    unittest.main()
