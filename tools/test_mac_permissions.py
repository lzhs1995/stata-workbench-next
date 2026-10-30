"""All permission tests are offline; never prompt, run AppleScript or Stata."""
import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import mac_permissions as p


class PermissionTests(unittest.TestCase):
    def query(self, rc=0, stdout="1\n", stderr=""):
        run = Mock(return_value=SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr))
        result = p.window_observation(42, run=run, consent=lambda: {"status": "GRANTED", "osStatus": 0})
        return result, run

    def test_zero_one_multiple_only_from_successful_integer_read(self):
        for number in (0, 1, 2, 11):
            result, run = self.query(stdout=str(number))
            self.assertTrue(result["ok"])
            self.assertEqual(result["count"], number)
            script = run.call_args.args[0][-1]
            self.assertIn("unix id is 42", script)
            self.assertIn("count of windows of p", script)
            self.assertEqual(run.call_count, 1)
            self.assertNotIn("frontmost", script)

    def test_apple_error_matrix_retains_original(self):
        for error, category in ((-1743, "AUTOMATION_DENIED"), (-1744, "AUTOMATION_CONSENT_REQUIRED"),
                (-25211, "ACCESSIBILITY_DENIED"), (-1728, "TARGET_UNAVAILABLE"),
                (-1712, "WINDOW_QUERY_TIMEOUT"), (-1719, "WINDOW_QUERY_FAILED"), (-12345, "WINDOW_QUERY_FAILED")):
            message = "execution error: something failed (%s)" % error
            result, _ = self.query(1, "0", message)
            self.assertFalse(result["ok"])
            self.assertIsNone(result["count"])
            self.assertEqual(result["status"], category)
            self.assertEqual(result["stderr"], message)
            self.assertEqual(result["appleEventError"], error)
        result, _ = self.query(1, "", "not allowed assistive access (-1719)")
        self.assertEqual(result["status"], "ACCESSIBILITY_DENIED")

    def test_invalid_stdout_or_stderr_never_zero(self):
        for text in ("", "true", "None", "-1", "1.0", "1\n2", "OK 1"):
            result, _ = self.query(stdout=text)
            self.assertEqual(result["status"], "WINDOW_QUERY_INVALID_RESPONSE")
            self.assertIsNone(result["count"])
        result, _ = self.query(stdout="0", stderr="unexpected warning")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["count"])

    def test_timeout_and_os_failure(self):
        for error, status in ((subprocess.TimeoutExpired("osascript", 10, output=b"partial", stderr=b"error"), "WINDOW_QUERY_TIMEOUT"),
                              (OSError("unavailable"), "WINDOW_QUERY_FAILED")):
            run = Mock(side_effect=error)
            result = p.window_observation(42, request=True, run=run)
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["count"])
            self.assertEqual(run.call_count, 1)

    def test_passive_denials_never_send_event_or_retry(self):
        for status in ("AUTOMATION_DENIED", "AUTOMATION_CONSENT_REQUIRED", "PERMISSION_CHECK_FAILED"):
            run = Mock()
            result = p.window_observation(42, run=run, consent=lambda: {"status": status})
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["count"])
            run.assert_not_called()

    def test_idle_system_events_start_is_not_permission_request(self):
        for final in ({"status": "AUTOMATION_DENIED", "osStatus": -1743},
                      {"status": "SYSTEM_EVENTS_NOT_RUNNING", "osStatus": -600}):
            run = Mock(return_value=SimpleNamespace(returncode=0, stdout="", stderr=""))
            consent = Mock(side_effect=[{"status": "SYSTEM_EVENTS_NOT_RUNNING"}, final])
            result = p.window_observation(42, run=run, consent=consent)
            self.assertEqual(result["status"], final["status"])
            self.assertIsNone(result["count"])
            run.assert_called_once_with(["/usr/bin/open", "-g", "-b", p.SYSTEM_EVENTS], capture_output=True, text=True, timeout=10)
            self.assertEqual(consent.call_count, 2)
        run = Mock(side_effect=[SimpleNamespace(returncode=0, stdout="", stderr=""), SimpleNamespace(returncode=0, stdout="1", stderr="")])
        consent = Mock(side_effect=[{"status": "SYSTEM_EVENTS_NOT_RUNNING"}, {"status": "GRANTED", "osStatus": 0}])
        self.assertTrue(p.window_observation(42, run=run, consent=consent)["ok"])
        self.assertEqual(run.call_count, 2)  # one app start, one read; no retry

    def test_system_events_start_failure_does_not_query(self):
        run = Mock(return_value=SimpleNamespace(returncode=1, stdout="", stderr="failed"))
        consent = Mock(return_value={"status": "SYSTEM_EVENTS_NOT_RUNNING"})
        result = p.window_observation(42, run=run, consent=consent)
        self.assertEqual(result["status"], "SYSTEM_EVENTS_START_FAILED")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(consent.call_count, 1)

    def test_explicit_request_one_readonly_query_without_preemptive_denial(self):
        consent = Mock(side_effect=AssertionError("request must reach system"))
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout="1", stderr=""))
        result = p.window_observation(42, request=True, run=run, consent=consent)
        self.assertTrue(result["ok"])
        self.assertTrue(result["requestAllowed"])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.kwargs["timeout"], 30)
        consent.assert_not_called()

    def test_invalid_pid_no_native_probe_no_event(self):
        for pid in (None, False, True, 0, -2, "42", 4.2):
            run, consent = Mock(), Mock()
            result = p.window_observation(pid, run=run, consent=consent)
            self.assertFalse(result["ok"])
            self.assertIsNone(result["count"])
            run.assert_not_called()
            consent.assert_not_called()

    def test_native_subprocess_bounded_and_bad_output_unknown(self):
        for code, text in ((1, "{}"), (0, ""), (0, "null"), (0, "{}")):
            run = Mock(return_value=SimpleNamespace(returncode=code, stdout=text))
            self.assertEqual(p.permission_status(run)["status"], "PERMISSION_CHECK_FAILED")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps({"status": "AUTOMATION_DENIED", "osStatus": -1743})))
        self.assertEqual(p.permission_status(run)["osStatus"], -1743)

    def test_native_probe_timeout_is_unmeasured_not_failed(self):
        # 2026-10-30 Mac stop-race run: the --native-status child ran past 10 s under
        # load and was reported as PERMISSION_CHECK_FAILED with permission advice.
        run = Mock(side_effect=subprocess.TimeoutExpired("python3", 10))
        check = p.permission_status(run)
        self.assertEqual(check["status"], "PERMISSION_CHECK_TIMEOUT")
        self.assertEqual(run.call_count, 1)
        self.assertFalse(p.automation_granted(check))
        query = Mock()
        result = p.window_observation(42, run=query, consent=lambda: check)
        self.assertEqual(result["status"], "PERMISSION_CHECK_TIMEOUT")
        self.assertIsNone(result["count"])
        query.assert_not_called()

    def test_unknown_or_inconsistent_observation_blocks(self):
        for obs, count in ((None, 1), ({"ok": False, "status": "AUTOMATION_DENIED"}, 0),
            ({"ok": True, "count": True}, 1), ({"ok": True, "count": 1}, 2)):
            with self.assertRaises(p.WindowObservationError):
                p.require_window_observation({"windowObservation": obs, "axWindowCount": count})

    def test_request_requires_bound_existing_instance(self):
        invalid = {"launcherPid": 42, "owner": {}, "identityOk": False, "axWindowCount": None}
        with patch.object(p, "host_report", return_value={}), patch.object(p, "service_health", return_value={}), patch.object(p, "window_observation") as query:
            result = p.diagnostic(None, lambda _: invalid, request=True)
        self.assertEqual(result["permissionRequestCount"], 0)
        query.assert_not_called()

    def test_malformed_grant_never_sends_event(self):
        for value in (None, False, "0", 1):
            run = Mock()
            result = p.window_observation(42, run=run, consent=lambda: {"status": "GRANTED", "osStatus": value})
            self.assertEqual(result["status"], "PERMISSION_CHECK_FAILED")
            run.assert_not_called()

    def test_db_failure_is_diagnostic_not_synthetic_grant(self):
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout="tccd: Database failed to open", stderr=""))
        self.assertTrue(p.service_health(run)["recentDatabaseOpenFailureObserved"])
        run = Mock(side_effect=OSError("log unreadable"))
        self.assertIsNone(p.service_health(run)["recentDatabaseOpenFailureObserved"])


if __name__ == "__main__":
    unittest.main()
