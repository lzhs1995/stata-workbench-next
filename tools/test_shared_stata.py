import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import shared_stata as client


def state(rid="old"):
    s = {"busy": False, "postRunBusy": False, "trueReady": True, "recovery": {"required": False},
         "runId": rid, "requestId": "req-" + rid, "ownedBackendPids": [14], "lifecycleVersion": "rc7.27", "completionMarkerVerified": True,
         "perRunCompletionMarkerVerified": True, "perRunEvidenceFailure": None}
    s["lastCompletedRun"] = dict(s)
    return {"identityOk": True, "axWindowCount": 1, "launcherPid": 12,
            "windowObservation": {"ok": True, "count": 1, "status": "OK"},
            "owner": {"pid": 13, "ppid": 12}, "status": s}


class SharedClientTests(unittest.TestCase):
    def test_file_dispatch_freezes_original_bytes_before_post(self):
        with tempfile.TemporaryDirectory(prefix="shared 中文 ") as directory:
            root = Path(directory)
            source = root / "author's & file.do"
            original = b'display "original"\r\n'
            source.write_bytes(original)
            receipt = root / "receipt"
            def post(endpoint, payload, **kwargs):
                self.assertEqual((receipt / "runtime-execution.do").read_bytes(), original)
                self.assertIn((receipt / "runtime-execution.do").resolve().as_posix(), payload["code"])
                source.write_bytes(b"display 999\n")
                raise TimeoutError("response lost after submission")
            result = client.execute_once(SimpleNamespace(w=SimpleNamespace(http_post=Mock(side_effect=post))),
                {"code": "unused original path"}, receipt, source_path=source, observe=lambda _: state())
            self.assertEqual(result["postCount"], 1)
            self.assertEqual(result["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertEqual((receipt / "runtime-execution.do").read_bytes(), original)
            self.assertEqual(result["executionSource"]["bytes"], len(original))

    def test_pre_submit_wait_never_sends_or_resets(self):
        busy = state()
        busy["status"]["busy"] = True
        d = SimpleNamespace(w=Mock())
        sleep = Mock()
        result = client.wait_ready(d, 10, observe=Mock(side_effect=[busy, state()]), clock=lambda: 0, sleep=sleep)
        self.assertTrue(client.ready(result))
        sleep.assert_called_once_with(1)
        d.w.assert_not_called()
        self.assertEqual(d.w.method_calls, [])
        with self.assertRaises(TimeoutError):
            client.wait_ready(d, 0, observe=lambda _: busy, clock=lambda: 1, sleep=sleep)
        with self.assertRaisesRegex(RuntimeError, "identity"):
            client.wait_ready(d, 10, observe=lambda _: dict(busy, identityOk=False), clock=lambda: 0, sleep=sleep)

    def test_failed_http_envelope_retains_run_identity_without_accepting_or_retrying(self):
        with tempfile.TemporaryDirectory() as directory:
            inner = {"ok": False, "runId": "new", "requestId": "req-new", "rc": 101}
            body = {"_httperror": json.dumps(inner)}
            original = copy.deepcopy(body)
            post = Mock(return_value=(500, body))
            result = client.execute_once(SimpleNamespace(w=SimpleNamespace(http_post=post)),
                {"code": "display 1"}, Path(directory) / "receipt",
                observe=Mock(side_effect=[state(), state("new")]))
            self.assertEqual(result["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertEqual(result["postCount"], 1)
            self.assertEqual(result["retryCount"], 0)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(result["response"], original)
            self.assertEqual(result["responseDiagnostics"]["fields"],
                             {"runId": "new", "requestId": "req-new", "rc": 101})
            self.assertFalse(result["checks"]["http200"])
            self.assertFalse(result["checks"]["noHttpErrorEnvelope"])
            saved = json.loads((Path(directory) / "receipt/response.json").read_text())
            self.assertEqual(saved, {"http": 500, "body": original})
            self.assertFalse((Path(directory) / "receipt/run.log").exists())

    def test_diagnostics_reject_malformed_and_conflicting_envelopes(self):
        for raw, issue in ((None, "HTTP_ERROR_PAYLOAD_NOT_STRING"),
                           ("{bad", "HTTP_ERROR_PAYLOAD_INVALID_JSON"),
                           ("[]", "HTTP_ERROR_PAYLOAD_NOT_OBJECT"),
                           ("null", "HTTP_ERROR_PAYLOAD_NOT_OBJECT")):
            self.assertIn(issue, client.response_diagnostics({"_httperror": raw})["issues"])
        for value in (None, [], "failure"):
            self.assertIn("RESPONSE_NOT_OBJECT", client.response_diagnostics(value)["issues"])
        for key, outer, inner in (("runId", "old", "new"), ("requestId", "a", "b"),
                                   ("rc", False, 0)):
            body = {key: outer, "_httperror": json.dumps({key: inner})}
            diag = client.response_diagnostics(body)
            self.assertEqual(diag["fields"], {})
            self.assertEqual(diag["conflictingFields"], [key])
            self.assertEqual(diag["topLevelFields"][key], outer)
            self.assertEqual(diag["httpErrorFields"][key], inner)
        body = {"runId": "new", "_httperror": '{"runId":"new","rc":101}'}
        self.assertEqual(client.response_diagnostics(body)["fields"], {"runId": "new", "rc": 101})

    def test_http_error_envelope_cannot_be_promoted_by_success_fields(self):
        body = {"ok": True, "rc": 0, "runId": "new", "requestId": "new", "_httperror": "{}"}
        checks = client.completion_checks({"runId": "new"}, 200, body, state(), state("new"))
        self.assertFalse(checks["noHttpErrorEnvelope"])
        self.assertFalse(all(checks.values()))

    def test_permission_revoked_after_post_is_unconfirmed_not_zero_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            after = state("new")
            after.update(axWindowCount=None, windowObservation={"ok": False, "count": None, "status": "AUTOMATION_DENIED"})
            post = Mock(return_value=(200, {"ok": True, "rc": 0, "runId": "new"}))
            obs = Mock(side_effect=[state(), after])
            sleep = Mock()
            result = client.execute_once(SimpleNamespace(w=SimpleNamespace(http_post=post)),
                {"code": "display 1"}, Path(directory) / "receipt", observe=obs, sleep=sleep)
            self.assertEqual(result["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertEqual(result["postCount"], 1)
            self.assertEqual(result["after"], after)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(obs.call_count, 2)
            sleep.assert_not_called()

    def test_denial_retains_error_without_post(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = state()
            bad.update(axWindowCount=None, windowObservation={"ok": False, "count": None,
                "status": "AUTOMATION_DENIED", "returnCode": 1, "stderr": "Not authorized (-1743)", "appleEventError": -1743})
            post = Mock()
            result = client.execute_once(SimpleNamespace(w=SimpleNamespace(http_post=post)),
                {"code": "display 1"}, Path(directory) / "receipt", observe=lambda _: bad)
            self.assertEqual(result["verdict"], "BLOCKED_NO_DISPATCH")
            self.assertEqual(result["postCount"], 0)
            self.assertEqual(result["windowObservation"], bad["windowObservation"])
            post.assert_not_called()

    def test_exact_completion_and_missing_matrix(self):
        before, after = state(), state("new")
        body = {"ok": True, "rc": 0, "runId": "new", "requestId": "req"}
        request = {"runId": "req"}
        self.assertTrue(all(client.completion_checks(request, 200, body, before, after).values()))
        for key in after["status"]:
            bad = copy.deepcopy(after)
            del bad["status"][key]
            if key not in ("runId", "requestId"):
                self.assertFalse(all(client.completion_checks(request, 200, body, before, bad).values()), key)
        for key in ("rc", "ok", "requestId", "runId"):
            bad = dict(body)
            del bad[key]
            self.assertFalse(all(client.completion_checks(request, 200, bad, before, after).values()), key)
        for value in (False, None, "0"):
            self.assertFalse(all(client.completion_checks(request, 200, dict(body, rc=value), before, after).values()))
        for value in (None, {}, {"required": None}, {"required": 0}, {"required": True}):
            bad = copy.deepcopy(after)
            bad["status"]["recovery"] = value
            self.assertFalse(client.ready(bad))

    def test_identity_and_stale_rejection(self):
        body = {"ok": True, "rc": 0, "runId": "new", "requestId": "new"}
        for key, value in (("launcherPid", 99), ("owner", {"pid": 99}), ("identityOk", False), ("axWindowCount", True)):
            bad = state("new")
            bad[key] = value
            self.assertFalse(all(client.completion_checks({"runId": "new"}, 200, body, state(), bad).values()))
        self.assertFalse(all(client.completion_checks({"runId": "new"}, 200, body, state("new"), state("new")).values()))
        changed = state("new")
        changed["status"]["ownedBackendPids"] = [15]
        self.assertFalse(all(client.completion_checks({"runId": "new"}, 200, body, state(), changed).values()))
        for value in (None, [], [False], [0], [-1], ["14"], [14, 14]):
            before, after = state(), state("new")
            before["status"]["ownedBackendPids"] = value
            after["status"]["ownedBackendPids"] = value
            self.assertFalse(client.ready(before), repr(value))
            self.assertFalse(all(client.completion_checks({"runId": "new"}, 200, body, before, after).values()), repr(value))
        server_body = {"ok": True, "rc": 0, "runId": "new", "requestId": "req-new",
                       "lifecycle": {"requestId": "req-new", "runId": "new", "sourceMode": "agent"}}
        self.assertTrue(all(client.completion_checks({"clientToken": "token"}, 200, server_body, state(), state("new")).values()))
        for key in ("requestId", "runId", "sourceMode"):
            bad = copy.deepcopy(server_body)
            del bad["lifecycle"][key]
            self.assertFalse(all(client.completion_checks({"clientToken": "token"}, 200, bad, state(), state("new")).values()), key)

    def test_one_post_retained_log_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "source.log"
            client.write_once(log, b"___VERIFIED_CLIENT_token___\n___CODEX_RUN_DONE_new___\n")
            post = Mock(return_value=(200, {"ok": True, "rc": 0, "runId": "new", "requestId": "req-new", "logPath": str(log),
                "lifecycle": {"requestId": "req-new", "runId": "new", "sourceMode": "agent"}}))
            d = SimpleNamespace(w=SimpleNamespace(http_post=post))
            with patch.object(client.uuid, "uuid4", return_value=SimpleNamespace(hex="token")):
                result = client.execute_once(d, {"code": "display 1"}, root / "receipt", observe=Mock(side_effect=[state(), state("new")]))
            self.assertEqual(result["verdict"], "PASS_VISIBLE_SHARED_RUN")
            self.assertEqual(post.call_count, 1)
            self.assertNotIn("runId", post.call_args.args[1])
            self.assertIn("___VERIFIED_CLIENT_token___", post.call_args.args[1]["code"])
            self.assertEqual((root / "receipt/run.log").read_bytes(), log.read_bytes())
            with self.assertRaises(FileExistsError):
                client.execute_once(d, {"code": "display 1"}, root / "receipt")
            self.assertEqual(post.call_count, 1)
            with patch.object(client.uuid, "uuid4", return_value=SimpleNamespace(hex="wrong-token")):
                missing = client.execute_once(d, {"code": "display 1"}, root / "missing-marker", observe=Mock(side_effect=[state(), state("new")]))
            self.assertEqual(missing["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertIn("client request marker absent", missing["error"])
            self.assertEqual(post.call_count, 2)

    def test_timed_out_probe_is_reobserved_without_repeating_the_post(self):
        # 2026-10-30 Mac stress: /bin/ps ran past its 10 s limit under load 198 right
        # after a successful POST, and the run was reported unconfirmed.
        probe = subprocess.TimeoutExpired(["/bin/ps", "-ax", "-o", "pid=,args="], 10)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "source.log"
            client.write_once(log, b"___VERIFIED_CLIENT_token___\n___CODEX_RUN_DONE_new___\n")
            body = {"ok": True, "rc": 0, "runId": "new", "requestId": "req-new", "logPath": str(log),
                    "lifecycle": {"requestId": "req-new", "runId": "new", "sourceMode": "agent"}}
            post = Mock(return_value=(200, body))
            d = SimpleNamespace(w=SimpleNamespace(http_post=post))
            sleep = Mock()
            with patch.object(client.uuid, "uuid4", return_value=SimpleNamespace(hex="token")):
                result = client.execute_once(d, {"code": "display 1"}, root / "receipt", sleep=sleep,
                    observe=Mock(side_effect=[probe, state(), probe, state("new")]))
            self.assertEqual(result["verdict"], "PASS_VISIBLE_SHARED_RUN")
            self.assertEqual(post.call_count, 1)
            self.assertEqual(len(result["observationRetries"]), 2)
            self.assertEqual(sleep.call_count, 2)
            # Persistent timeouts after the POST stay unconfirmed, still with one POST.
            post.reset_mock()
            with patch.object(client.uuid, "uuid4", return_value=SimpleNamespace(hex="token")):
                lost = client.execute_once(d, {"code": "display 1"}, root / "lost", sleep=Mock(),
                    observe=Mock(side_effect=[state(), probe, probe, probe]))
            self.assertEqual(lost["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertEqual(lost["postCount"], 1)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(len(lost["observationRetries"]), client.OBSERVE_ATTEMPTS)
            # Persistent timeouts before the POST never dispatch.
            post.reset_mock()
            blocked = client.execute_once(d, {"code": "display 1"}, root / "blocked", sleep=Mock(),
                observe=Mock(side_effect=[probe, probe, probe]))
            self.assertEqual(blocked["verdict"], "BLOCKED_NO_DISPATCH")
            self.assertEqual(blocked["postCount"], 0)
            post.assert_not_called()

    def test_timed_out_window_observation_is_reobserved_without_repeating_the_post(self):
        # 2026-10-30 Mac stop-race run: the passive permission probe timed out under
        # load and dispatch was blocked with permission advice.
        def timed(status):
            s = state()
            s["windowObservation"] = {"ok": False, "count": None, "status": status}
            s["axWindowCount"] = None
            return s
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "source.log"
            client.write_once(log, b"___VERIFIED_CLIENT_token___\n___CODEX_RUN_DONE_new___\n")
            body = {"ok": True, "rc": 0, "runId": "new", "requestId": "req-new", "logPath": str(log),
                    "lifecycle": {"requestId": "req-new", "runId": "new", "sourceMode": "agent"}}
            post = Mock(return_value=(200, body))
            d = SimpleNamespace(w=SimpleNamespace(http_post=post))
            sleep = Mock()
            with patch.object(client.uuid, "uuid4", return_value=SimpleNamespace(hex="token")):
                result = client.execute_once(d, {"code": "display 1"}, root / "receipt", sleep=sleep,
                    observe=Mock(side_effect=[timed("PERMISSION_CHECK_TIMEOUT"), state(),
                                              timed("WINDOW_QUERY_TIMEOUT"), state("new")]))
            self.assertEqual(result["verdict"], "PASS_VISIBLE_SHARED_RUN")
            self.assertEqual(post.call_count, 1)
            self.assertEqual(result["observationRetries"], ["PERMISSION_CHECK_TIMEOUT", "WINDOW_QUERY_TIMEOUT"])
            # Still timed out after the last attempt: blocked before the POST, status kept.
            post.reset_mock()
            observe = Mock(return_value=timed("PERMISSION_CHECK_TIMEOUT"))
            blocked = client.execute_once(d, {"code": "display 1"}, root / "blocked", sleep=Mock(), observe=observe)
            self.assertEqual(blocked["verdict"], "BLOCKED_NO_DISPATCH")
            self.assertEqual(blocked["postCount"], 0)
            self.assertEqual(blocked["windowObservation"]["status"], "PERMISSION_CHECK_TIMEOUT")
            self.assertEqual(observe.call_count, client.OBSERVE_ATTEMPTS)
            post.assert_not_called()
        # Real permission answers are never retried.
        for status in ("PERMISSION_CHECK_FAILED", "AUTOMATION_DENIED", "WINDOW_QUERY_FAILED"):
            observe, sleep = Mock(return_value=timed(status)), Mock()
            self.assertEqual(client.observe_settled(SimpleNamespace(), observe, sleep)["windowObservation"]["status"], status)
            self.assertEqual(observe.call_count, 1)
            sleep.assert_not_called()

    def test_other_observation_errors_are_not_retried(self):
        observe = Mock(side_effect=RuntimeError("bridge listener does not belong to the exact Workbench instance"))
        sleep = Mock()
        with self.assertRaisesRegex(RuntimeError, "does not belong"):
            client.observe_settled(SimpleNamespace(), observe, sleep)
        self.assertEqual(observe.call_count, 1)
        sleep.assert_not_called()

    def test_busy_no_post_and_timeout_no_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            post = Mock(side_effect=TimeoutError("unknown execution outcome"))
            d = SimpleNamespace(w=SimpleNamespace(http_post=post))
            busy = state()
            busy["status"]["busy"] = True
            blocked = client.execute_once(d, {"code": "display 1"}, root / "busy", observe=lambda _: busy)
            self.assertEqual(blocked["postCount"], 0)
            post.assert_not_called()
            unmeasured = state()
            del unmeasured["status"]["ownedBackendPids"]
            blocked = client.execute_once(d, {"code": "display 1"}, root / "unmeasured", observe=lambda _: unmeasured)
            self.assertEqual(blocked["postCount"], 0)
            post.assert_not_called()
            timed = client.execute_once(d, {"code": "display 1"}, root / "timeout", observe=lambda _: state())
            self.assertEqual(timed["postCount"], 1)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(timed["verdict"], "EXECUTION_UNCONFIRMED_NO_RETRY")
            self.assertEqual(json.loads((root / "timeout/result.json").read_bytes())["retryCount"], 0)


if __name__ == "__main__":
    unittest.main()
