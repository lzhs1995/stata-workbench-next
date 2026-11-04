"""Single visible AI dispatch to the verified, existing Workbench session."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid

import verified_workbench as entry


def write_once(path, data):
    raw = data if isinstance(data, bytes) else (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def _valid_backend_pids(value):
    return (isinstance(value, list) and bool(value)
            and all(type(pid) is int and pid > 0 for pid in value)
            and len(set(value)) == len(value))


def _idle_session(instance):
    s = instance.get("status") or {}
    try:
        entry.permissions.require_window_observation(instance)
    except entry.permissions.WindowObservationError:
        return False
    return (instance.get("identityOk") is True and type(instance.get("axWindowCount")) is int
            and instance["axWindowCount"] == 1 and s.get("busy") is False
            and s.get("postRunBusy") is False and s.get("trueReady") is True
            and isinstance(s.get("recovery"), dict) and s["recovery"].get("required") is False)


def ready(instance):
    s = instance.get("status") or {}
    return _idle_session(instance) and _valid_backend_pids(s.get("ownedBackendPids"))


def cold_backend(instance):
    """M2：窗口刚开、Stata 后端还没起（懒启动）。其余全绿时可以提交一次：
    扩展的 /run-command 会先起后端并在 rc.7.72 的上限内等 Stata 就绪，未就绪就拒绝且不派发。"""
    s = instance.get("status") or {}
    start = s.get("backendStart")
    return (_idle_session(instance) and s.get("ownedBackendPids") == []
            and isinstance(start, dict) and start.get("connected") is False)


WARMUP_REFUSALS = ("PRE_RUN_BACKEND_WARMUP_TIMEOUT", "PRE_RUN_BACKEND_WARMUP_FAILED", "PRE_RUN_BACKEND_WARMUP_CANCELLED")


def prerun_refusal(http, body):
    """扩展在派发前明确拒绝（warm-up 超时/失败/Stop）：payloadDispatched 为 false，返回原因和能否重试。
    不是这种明确拒绝就返回 None（照旧按「执行未确认」处理，不重试）。"""
    if not isinstance(body, dict) or type(http) is not int or http == 200:
        return None
    envelope = body
    if "reasonCode" not in body and isinstance(body.get("_httperror"), str):
        try:
            envelope = json.loads(body["_httperror"])
        except (ValueError, RecursionError):
            return None
    if not isinstance(envelope, dict) or envelope.get("reasonCode") not in WARMUP_REFUSALS:
        return None
    if envelope.get("payloadDispatched") is not False or envelope.get("preRunStage") != "backend-warmup":
        return None
    return {"reasonCode": envelope["reasonCode"], "payloadDispatched": False,
            "retryable": envelope.get("retryable") is True, "retryAfterMs": envelope.get("retryAfterMs"),
            "lastStatus": envelope.get("lastStatus"), "message": envelope.get("message")}


OBSERVE_ATTEMPTS = 3
# Window observations that ran past their limit: consent or the window count is
# unmeasured, not denied. Every other status is a real answer and is kept.
TIMED_OUT_WINDOW_OBSERVATIONS = ("PERMISSION_CHECK_TIMEOUT", "WINDOW_QUERY_TIMEOUT")


def observe_settled(d, observe=entry.observe, sleep=time.sleep, retries=None):
    """Read-only observation that tolerates a timed-out probe.

    Retried: subprocess.TimeoutExpired (a ps/lsof call that ran past its limit on
    a heavily loaded host) and a window observation whose permission check or
    window query timed out. Identity, permission and status results are returned
    or raised unchanged; after the last attempt the timed-out observation is
    returned as is. This never repeats a dispatch.
    """
    for attempt in range(1, OBSERVE_ATTEMPTS + 1):
        try:
            state = observe(d)
        except subprocess.TimeoutExpired as exc:
            if retries is not None:
                retries.append(repr(exc))
            if attempt == OBSERVE_ATTEMPTS:
                raise
            sleep(1)
            continue
        window = state.get("windowObservation") if isinstance(state, dict) else None
        status = window.get("status") if isinstance(window, dict) else None
        if status not in TIMED_OUT_WINDOW_OBSERVATIONS or attempt == OBSERVE_ATTEMPTS:
            return state
        if retries is not None:
            retries.append(status)
        sleep(1)


def response_diagnostics(body):
    """Expose error-envelope identities without certifying completion or retry safety.

    Some HTTP helpers retain a failed response as a JSON string in _httperror.
    Keep the original response intact; never feed this diagnostic view into the
    success checks. In particular, a missing runId does not prove zero execution.
    """
    result = {"source": "response", "fields": {}, "issues": []}
    if not isinstance(body, dict):
        result["issues"].append("RESPONSE_NOT_OBJECT")
        return result
    fields = ("runId", "requestId", "rc", "logPath")
    top = {key: body[key] for key in fields if key in body}
    result["fields"] = top.copy()
    if "_httperror" not in body:
        return result
    result["source"] = "response._httperror"
    raw = body["_httperror"]
    if not isinstance(raw, str):
        result["issues"].append("HTTP_ERROR_PAYLOAD_NOT_STRING")
        return result
    try:
        nested = json.loads(raw)
    except (ValueError, RecursionError):
        result["issues"].append("HTTP_ERROR_PAYLOAD_INVALID_JSON")
        return result
    if not isinstance(nested, dict):
        result["issues"].append("HTTP_ERROR_PAYLOAD_NOT_OBJECT")
        return result
    inner = {key: nested[key] for key in fields if key in nested}
    result["topLevelFields"] = top
    result["httpErrorFields"] = inner
    conflicts = [key for key in fields if key in top and key in inner
                 and (type(top[key]) is not type(inner[key]) or top[key] != inner[key])]
    if conflicts:
        result["issues"].append("HTTP_ERROR_FIELD_CONFLICT")
        result["conflictingFields"] = conflicts
        result["fields"] = {}  # Do not synthesize an identity from conflicting envelopes.
    else:
        result["fields"].update(inner)
    return result


def _cold_start_bound(after, rid):
    """冷启动：提交前没有后端，所以没法比「前后同一个」；改为要求这次 run 自己起了后端并已登记。"""
    s = after.get("status") or {}
    cold = (s.get("backendStart") or {}).get("lastCold") or {}
    return (_valid_backend_pids(s.get("ownedBackendPids")) and isinstance(rid, str) and bool(rid)
            and cold.get("runId") == rid and cold.get("outcome") == "CONNECTED")


def completion_checks(request, http, body, before, after):
    body = body if isinstance(body, dict) else {}
    s = after.get("status") or {}
    completed = s.get("lastCompletedRun") or {}
    rid = body.get("runId")
    request_id = body.get("requestId")
    lifecycle = body.get("lifecycle") or {}
    client_token = request.get("clientToken")
    request_bound = (isinstance(request_id, str) and bool(request_id)
        and lifecycle.get("requestId") == request_id
        and completed.get("requestId") == request_id
        and lifecycle.get("runId") == rid
        and lifecycle.get("sourceMode") == "agent"
        and request_id != (before["status"].get("lastCompletedRun") or {}).get("requestId")) if client_token else (request_id == request.get("runId"))
    return {
        "http200": type(http) is int and http == 200,
        "noHttpErrorEnvelope": "_httperror" not in body,
        "responseOk": body.get("ok") is True,
        "requestBound": request_bound,
        "newRunId": isinstance(rid, str) and bool(rid) and rid != before["status"].get("runId"),
        "responseRcZero": type(body.get("rc")) is int and body["rc"] == 0,
        "sameLauncher": before.get("launcherPid") == after.get("launcherPid") and before.get("launcher") == after.get("launcher"),
        "sameBridgeOwner": before.get("owner") == after.get("owner"),
        "sameStataBackend": _cold_start_bound(after, rid) if request.get("coldBackend") else (
            _valid_backend_pids(before["status"].get("ownedBackendPids"))
            and before["status"]["ownedBackendPids"] == s.get("ownedBackendPids")),
        "readyAfter": ready(after),
        "completedRunBound": isinstance(rid, str) and completed.get("runId") == rid,
        "currentLifecycle": s.get("lifecycleVersion") == "rc7.27",
        "completedLifecycle": completed.get("lifecycleVersion") == "rc7.27",
        "currentMarker": s.get("completionMarkerVerified") is True,
        "currentPerRunMarker": s.get("perRunCompletionMarkerVerified") is True,
        "currentEvidenceIntact": "perRunEvidenceFailure" in s and s["perRunEvidenceFailure"] is None,
        "completedMarker": completed.get("completionMarkerVerified") is True,
        "completedPerRunMarker": completed.get("perRunCompletionMarkerVerified") is True,
        "completedEvidenceIntact": "perRunEvidenceFailure" in completed and completed["perRunEvidenceFailure"] is None,
    }


STATA_RC_LINE = re.compile(r"^(?:\{[a-z]+\})*(?:r\((\d+)\);|\{search r\((\d+)\)(?:,[^}]*)?\})$")


def stata_error_checks(http, body, before, after, marker):
    """rc.7.85：扩展回 outcome=STATA_ERROR 时，核对它确实是本次请求、Stata 跑到了 r(n) 并停下。

    只在全部为真时判 STATA_ERROR_CONFIRMED；否则仍是 EXECUTION_UNCONFIRMED_NO_RETRY。
    log 里客户端 marker 只能作为回显的命令出现（`. display …`），不能作为输出行出现。"""
    body = body if isinstance(body, dict) else {}
    s = after.get("status") or {}
    completed = s.get("lastCompletedRun") or {}
    lifecycle = body.get("lifecycle") or {}
    rc, rid, request_id = body.get("stataRc"), body.get("runId"), body.get("requestId")
    path = Path(body.get("logPath") or "")
    lines = []
    if path.is_file():
        lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines()]
    log_rcs = [int(m.group(1) or m.group(2)) for m in map(STATA_RC_LINE.match, lines) if m]
    return {
        "http500": type(http) is int and http == 500,
        "outcomeStataError": body.get("outcome") == "STATA_ERROR" and body.get("executed") is True,
        "payloadMayHaveRun": body.get("payloadMayHaveRun") is True,
        "stataRcPositive": type(rc) is int and rc > 0,
        "requestBound": isinstance(request_id, str) and bool(request_id)
            and lifecycle.get("requestId") == request_id and completed.get("requestId") == request_id
            and request_id != (before["status"].get("lastCompletedRun") or {}).get("requestId"),
        "completedRunBound": isinstance(rid, str) and bool(rid) and completed.get("runId") == rid
            and lifecycle.get("runId") == rid and lifecycle.get("sourceMode") == "agent",
        "completedRcMatches": completed.get("rc") == rc and completed.get("phase") == "failed",
        "logPathBound": isinstance(body.get("logPath"), str) and bool(body["logPath"])
            and completed.get("logPath") == body["logPath"] and lifecycle.get("logPath") == body["logPath"],
        "logRcMatches": bool(log_rcs) and log_rcs[-1] == rc,
        "clientMarkerNotPrinted": bool(lines) and not any(line.endswith("}" + marker) or line == marker for line in lines),
        "sameStataBackend": _valid_backend_pids(before["status"].get("ownedBackendPids"))
            and before["status"]["ownedBackendPids"] == s.get("ownedBackendPids"),
        "readyAfter": ready(after),
    }


def stop_checks(http, body, before, after):
    """rc.7.87：扩展说这次失败是被 Stop 结束的（stoppedBy）时，核对 Stop 记录确实属于本次请求的 run、
    在这次提交之后发生，且 Stop 之后会话已恢复可用。全部为真才判 STOPPED_NO_RETRY；否则照旧 UNCONFIRMED。"""
    body = body if isinstance(body, dict) else {}
    s = after.get("status") or {}
    completed = s.get("lastCompletedRun") or {}
    stop = body.get("stoppedBy") if isinstance(body.get("stoppedBy"), dict) else {}
    last = s.get("lastSoftStop") if isinstance(s.get("lastSoftStop"), dict) else {}
    gen_before, gen_after = (before.get("status") or {}).get("resetGeneration"), s.get("resetGeneration")
    request_id = body.get("runId")
    return {
        "http500": type(http) is int and http == 500,
        "notStataError": body.get("outcome") != "STATA_ERROR",
        "stopKnown": stop.get("by") in ("person", "api", "watchdog"),
        "requestBound": isinstance(request_id, str) and bool(request_id) and completed.get("requestId") == request_id
            and request_id != (before["status"].get("lastCompletedRun") or {}).get("requestId"),
        "stoppedRunBound": isinstance(stop.get("runId"), str) and bool(stop["runId"])
            and completed.get("runId") == stop["runId"] and completed.get("phase") == "failed",
        "stopAfterSubmit": type(gen_before) is int and type(stop.get("generation")) is int and stop["generation"] > gen_before
            and gen_after == stop["generation"] and s.get("resetGenerationKind") == "soft-stop",
        "restoredAfter": last.get("runId") == stop.get("runId") and last.get("ok") is True,
        "readyAfter": ready(after),
    }


def execute_once(d, request, receipt, timeout=3600, observe=entry.observe, sleep=time.sleep, source_path=None):
    receipt = Path(receipt)
    receipt.mkdir(mode=0o700, parents=True, exist_ok=False)
    result = {"verdict": "BLOCKED_NO_DISPATCH", "postCount": 0, "retryCount": 0,
              "request": request, "error": None, "startedAtEpoch": time.time(), "observationRetries": []}
    look = lambda: observe_settled(d, observe, sleep, result["observationRetries"])
    try:
        before = look()
        result["before"] = before
        entry.permissions.require_window_observation(before)
        cold = not ready(before) and cold_backend(before)
        if not ready(before) and not cold:
            raise RuntimeError("existing session is not ready; no launch, reset or dispatch")
        result["coldBackend"] = cold
        # 阶段 D：注册表里绑定的会话必须就是 /status 报的这个（sessionId、port、generation、bundle SHA）
        result["sessionIdentity"] = entry.verify_session_identity(before.get("status"))
        write_once(receipt / "request.json", request)
        write_once(receipt / "before.json", before)
        payload = dict(request)
        if source_path is not None:
            original = Path(source_path).resolve(strict=True)
            source = original.read_bytes()
            execution = receipt.resolve() / "runtime-execution.do"
            write_once(execution, source)
            payload["code"] = entry.host.stata_file_command(execution)
            result["executionSource"] = {"authorPath": str(original), "path": str(execution),
                "bytes": len(source), "sha256": hashlib.sha256(source).hexdigest()}
            write_once(receipt / "execution-source.json", result["executionSource"])
        token = uuid.uuid4().hex
        payload.pop("runId", None)
        payload.pop("clientToken", None)
        marker = "___VERIFIED_CLIENT_" + token + "___"
        payload["code"] += '\n#delimit cr\ndisplay as text "' + marker + '"\n'
        payload["source"] = "agent"
        result["clientToken"] = token
        result["wireRequest"] = payload
        write_once(receipt / "wire-request.json", payload)
        result["postCount"] = 1
        result["verdict"] = "EXECUTION_UNCONFIRMED_NO_RETRY"
        http, body = d.w.http_post("/run-command", payload, timeout=timeout)
        result.update(http=http, response=body)
        write_once(receipt / "response.json", {"http": http, "body": body})
        result["responseDiagnostics"] = response_diagnostics(body)
        write_once(receipt / "response-diagnostics.json", result["responseDiagnostics"])
        refusal = prerun_refusal(http, body)
        if refusal is not None:
            # 扩展明确说没派发：记成拒绝，原因和能否重试交给调用方；本客户端不重发
            result["refusal"] = refusal
            result["verdict"] = "REFUSED_NOT_DISPATCHED"
        after = look()
        # Only observe completion settlement. Never repeat the POST.
        stata_error = isinstance(body, dict) and body.get("outcome") == "STATA_ERROR"
        stopped = isinstance(body, dict) and isinstance(body.get("stoppedBy"), dict)  # rc.7.87：等 Stop 的恢复做完再看
        for _ in range(30):
            if ready(after) or (http != 200 and not stata_error and not stopped) or after.get("windowObservation", {}).get("ok") is not True:
                break
            sleep(1)
            after = look()
            if after.get("windowObservation", {}).get("ok") is not True:
                break
        result["after"] = after
        entry.permissions.require_window_observation(after)
        checks = completion_checks({"clientToken": token, "coldBackend": cold}, http, body, before, after)
        result["checks"] = checks
        result["failedChecks"] = [k for k, v in checks.items() if v is not True]
        if all(checks.values()):
            path = Path(body.get("logPath") or "")
            if not path.is_file():
                raise RuntimeError("completed run log missing")
            log = path.read_bytes()
            rid = body["runId"]
            if not log or ("___CODEX_RUN_DONE_" + rid + "___").encode() not in log:
                raise RuntimeError("exact run completion marker absent from raw log")
            if marker.encode() not in log:
                raise RuntimeError("client request marker absent from raw log")
            write_once(receipt / "run.log", log)
            result["log"] = {"originalPath": str(path), "sha256": hashlib.sha256(log).hexdigest(), "bytes": len(log)}
            result["verdict"] = "PASS_VISIBLE_SHARED_RUN"
            result["note"] = "Legacy verdict certifies execution/identity, not simultaneous source/Terminal visibility."
        elif isinstance(body, dict) and body.get("outcome") == "STATA_ERROR":
            errors = stata_error_checks(http, body, before, after, marker)
            result["stataErrorChecks"] = errors
            if all(errors.values()):
                log = Path(body["logPath"]).read_bytes()
                write_once(receipt / "run.log", log)
                result["log"] = {"originalPath": body["logPath"], "sha256": hashlib.sha256(log).hexdigest(), "bytes": len(log)}
                result["verdict"] = "STATA_ERROR_CONFIRMED"
                result["stataRc"] = body["stataRc"]
                result["note"] = "Stata ran the code and stopped with this return code; nothing is retried."
        elif stopped:
            checks = stop_checks(http, body, before, after)
            result["stopChecks"] = checks
            if all(checks.values()):
                result["verdict"] = "STOPPED_NO_RETRY"
                result["stoppedBy"] = body["stoppedBy"]["by"]
                result["note"] = ("A Stop ended this run and the session restored its pre-run checkpoint. "
                                  "Part of the code may have run before the Stop; nothing is retried.")
    except Exception as exc:
        result["error"] = repr(exc)
        result["windowObservation"] = getattr(exc, "observation", None)
    finally:
        result["endedAtEpoch"] = time.time()
        write_once(receipt / "result.json", result)
    return result


def wait_ready(d, deadline, observe=entry.observe, clock=time.monotonic, sleep=time.sleep):
    """Poll before submission only. Identity/visibility failures are never retried."""
    while True:
        state = observe_settled(d, observe, sleep)
        entry.permissions.require_window_observation(state)
        if not state.get("identityOk") or state.get("axWindowCount") != 1:
            raise RuntimeError("instance identity/window is not verified; no dispatch")
        if ready(state) or cold_backend(state):
            return state
        s = state.get("status") or {}
        if s.get("recovery", {}).get("required") is not False:
            raise RuntimeError("session requires recovery; no automatic reset")
        if clock() >= deadline:
            raise TimeoutError("session did not become ready before the pre-submit deadline")
        sleep(min(1, max(0, deadline - clock())))


def agent_name(value):
    """--agent-name：只留字母、数字、空格和 ._-@，1–40 字；与扩展 next_session_core 的清洗规则一致。"""
    text = " ".join("".join(c for c in str(value) if c.isalnum() or c in " ._@-").split())[:40]
    if not text:
        raise argparse.ArgumentTypeError("agent name needs letters or digits")
    return text


def print_events(since, limit):
    """只读：GET /events?since=N，原样打印 JSON；不提交代码，不取执行锁。"""
    body = entry.LocalBridge().events(since=since, limit=limit)
    print(json.dumps(body, ensure_ascii=False))
    return 0


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--code")
    source.add_argument("--file", type=Path)
    source.add_argument("--events", type=int, metavar="SINCE",
                        help="print the session event stream after sequence number SINCE (0 = from the start) and exit")
    source.add_argument("--list-sessions", action="store_true", help="print the Next session registry (no tokens) and exit")
    parser.add_argument("--session", default=None,
                        help="session name or id (env STATA_WORKBENCH_SESSION); required when several are live")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--receipt-dir", type=Path)
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--busy-policy", choices=("fail", "wait"), default="fail")
    parser.add_argument("--max-wait", type=float, default=60)
    parser.add_argument("--label", default="Shared session AI run")
    parser.add_argument("--agent-name", type=agent_name,
                        default=os.environ.get("STATA_WORKBENCH_AGENT_NAME") or "agent",
                        help="name shown in the Stata Terminal header and the event stream (env STATA_WORKBENCH_AGENT_NAME)")
    parser.add_argument("--limit", type=int, default=None, help="with --events: at most this many events (1-500)")
    args = parser.parse_args()
    if args.list_sessions:
        print(json.dumps({"sessions": entry.list_sessions()}, ensure_ascii=False))
        return 0
    if args.events is not None:
        if args.events < 0 or (args.limit is not None and not 1 <= args.limit <= 500):
            parser.error("--events needs SINCE >= 0 and --limit 1-500")
        entry.bind_session(args.session)  # 先选定会话；没有或不唯一就停下
        return print_events(args.events, args.limit)
    if args.timeout < 1 or not math.isfinite(args.max_wait) or args.max_wait < 0 or not args.cwd.is_dir():
        parser.error("positive timeout and existing cwd required")
    # 先选定会话再做任何请求；没有或不唯一（MULTIPLE_SESSIONS）就在这里停下，不执行代码
    entry.bind_session(args.session)
    os.environ.update(WS_FG_ALLOWED="0", WS_WINDOW_ALLOWED="0", WS_PHYSICAL_KEYS="0")
    d = entry.helpers()
    token = "shared_" + uuid.uuid4().hex
    receipt = args.receipt_dir or Path.cwd() / ".stata-receipts" / token
    if args.file:
        code = entry.host.stata_file_command(args.file)
    else:
        code = args.code
    if not code or not code.strip():
        parser.error("empty code is not an execution")
    request = {"code": code, "cwd": str(args.cwd.resolve()),
               "source": "agent", "agentId": "verified-shared-session-client", "agentName": args.agent_name,
               "label": args.label}
    with ExitStack() as stack:
        wait = args.max_wait if args.busy_policy == "wait" else 0
        deadline = time.monotonic() + wait
        for lock in entry.host.lock_paths(entry.PROFILE, "execute"):
            stack.enter_context(entry.host.file_lock(lock, timeout=max(0, deadline - time.monotonic())))
        if args.busy_policy == "wait":
            wait_ready(d, deadline)
        result = execute_once(d, request, receipt, args.timeout, source_path=args.file)
    diagnostics = result.get("responseDiagnostics") or response_diagnostics(result.get("response"))
    print(json.dumps({"verdict": result["verdict"], "postCount": result["postCount"], "retryCount": 0,
                      "runId": diagnostics["fields"].get("runId"),
                      "requestId": diagnostics["fields"].get("requestId"),
                      "responseDiagnostics": diagnostics, "receipt": str(receipt),
                      "error": result["error"], "failedChecks": result.get("failedChecks"),
                      "coldBackend": result.get("coldBackend"), "refusal": result.get("refusal"),
                      "stataRc": result.get("stataRc"), "stataErrorChecks": result.get("stataErrorChecks"),
                      "stoppedBy": result.get("stoppedBy"), "stopChecks": result.get("stopChecks"),
                      "windowObservation": result.get("windowObservation")}, ensure_ascii=False))
    return 0 if result["verdict"] == "PASS_VISIBLE_SHARED_RUN" else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"verdict": "BLOCKED", "error": repr(exc), "automaticRetry": False}))
        sys.exit(2)
