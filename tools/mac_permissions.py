"""Non-lossy macOS permission/window observations. Never modifies TCC or Stata.

Normal queries first check Apple Events consent without prompting. Only the
explicit request command sends a query without that check. Host ancestry is
evidence of candidates, NOT a claim about TCC's responsible-process attribution.
"""
import ctypes
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

SYSTEM_EVENTS = "com.apple.systemevents"
VERSION = "1.1.0"
ADVICE = ("Run --doctor in the failing agent's host. Then --request-permissions "
          "in that SAME host; approve the macOS System Events prompt. Automation "
          "and Accessibility are separate. Do not reset TCC, restart Stata, or "
          "treat an unknown window count as zero.")


class WindowObservationError(RuntimeError):
    def __init__(self, observation):
        self.observation = observation
        super().__init__(observation["status"] + ": " + ADVICE)


def native_permission_status():
    """Apple's public APIs only; askUserIfNeeded=False, no prompt or event sent."""
    if sys.platform != "darwin":
        return {"status": "UNSUPPORTED_PLATFORM", "osStatus": None}
    framework = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")

    class AEDesc(ctypes.Structure):
        _fields_ = [("descriptorType", ctypes.c_uint32), ("dataHandle", ctypes.c_void_p)]

    framework.AECreateDesc.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_long, ctypes.POINTER(AEDesc)]
    framework.AECreateDesc.restype = ctypes.c_int32
    framework.AEDisposeDesc.argtypes = [ctypes.POINTER(AEDesc)]
    framework.AEDisposeDesc.restype = ctypes.c_int32
    framework.AEDeterminePermissionToAutomateTarget.argtypes = [ctypes.POINTER(AEDesc), ctypes.c_uint32, ctypes.c_uint32, ctypes.c_ubyte]
    framework.AEDeterminePermissionToAutomateTarget.restype = ctypes.c_int32
    framework.AXIsProcessTrusted.argtypes = []
    framework.AXIsProcessTrusted.restype = ctypes.c_ubyte
    fourcc = lambda value: int.from_bytes(value, "big")
    target = SYSTEM_EVENTS.encode()
    desc = AEDesc()
    rc = framework.AECreateDesc(fourcc(b"bund"), target, len(target), ctypes.byref(desc))
    if rc != 0:
        return {"status": "PERMISSION_CHECK_FAILED", "osStatus": rc}
    try:
        rc = framework.AEDeterminePermissionToAutomateTarget(ctypes.byref(desc), fourcc(b"core"), fourcc(b"getd"), False)
    finally:
        framework.AEDisposeDesc(ctypes.byref(desc))
    return {"status": {0: "GRANTED", -1743: "AUTOMATION_DENIED", -1744: "AUTOMATION_CONSENT_REQUIRED",
                       -600: "SYSTEM_EVENTS_NOT_RUNNING"}.get(rc, "PERMISSION_CHECK_FAILED"),
            "osStatus": rc, "askUserIfNeeded": False,
            "accessibilityTrustedForProbeProcess": bool(framework.AXIsProcessTrusted()),
            "targetBundleId": SYSTEM_EVENTS}


def permission_status(run=subprocess.run):
    # Bound even native API failures in a child; no automatic retry.
    result = None
    try:
        result = run([sys.executable, "-B", str(Path(__file__).resolve()), "--native-status"],
                     capture_output=True, text=True, timeout=10)
        body = json.loads(result.stdout) if result.returncode == 0 else None
        if not isinstance(body, dict) or not isinstance(body.get("status"), str):
            raise ValueError("invalid permission probe output")
        return body
    except subprocess.TimeoutExpired as exc:
        # The probe ran past its limit (a loaded host), so consent is unmeasured,
        # not failed. Callers may observe again; this function never retries.
        return {"status": "PERMISSION_CHECK_TIMEOUT", "osStatus": None, "error": str(exc),
                "returnCode": None, "stdout": None, "stderr": None}
    except Exception as exc:
        return {"status": "PERMISSION_CHECK_FAILED", "osStatus": None, "error": str(exc),
                "returnCode": getattr(result, "returncode", None), "stdout": getattr(result, "stdout", None),
                "stderr": getattr(result, "stderr", None)}


def automation_granted(check):
    return isinstance(check, dict) and check.get("status") == "GRANTED" and type(check.get("osStatus")) is int and check["osStatus"] == 0


def window_observation(pid, request=False, run=subprocess.run, consent=permission_status):
    obs = {"ok": False, "count": None, "status": "TARGET_NOT_RUNNING", "targetPid": pid,
           "requestAllowed": request, "returnCode": None, "stdout": "", "stderr": "",
           "appleEventError": None, "automaticRetry": False}
    if pid is None:
        return obs
    if type(pid) is not int or pid <= 0:
        return dict(obs, status="INVALID_TARGET_PID")
    if not request:
        check = consent()
        if check.get("status") == "SYSTEM_EVENTS_NOT_RUNNING":
            # System Events exits when idle. Requiring manual consent setup on
            # every exit would regress normal use. Launch only that background
            # system app via Launch Services, then make one passive recheck.
            # Never send an Apple Event while consent is denied/unmeasured.
            try:
                started = run(["/usr/bin/open", "-g", "-b", SYSTEM_EVENTS],
                              capture_output=True, text=True, timeout=10)
                obs["systemEventsStart"] = {"returnCode": started.returncode, "stdout": started.stdout, "stderr": started.stderr}
                if started.returncode != 0:
                    return dict(obs, status="SYSTEM_EVENTS_START_FAILED", advice=ADVICE)
                check = consent()
            except Exception as exc:
                return dict(obs, status="SYSTEM_EVENTS_START_FAILED", error=str(exc), advice=ADVICE)
        obs["permissionCheck"] = check
        if check.get("status") != "GRANTED":
            return dict(obs, status=check.get("status", "PERMISSION_CHECK_FAILED"),
                        appleEventError=check.get("osStatus"), advice=ADVICE)
        if not automation_granted(check):
            return dict(obs, status="PERMISSION_CHECK_FAILED", advice=ADVICE)
    script = (f'tell application "System Events"\n'
              f'set p to first application process whose unix id is {pid}\n'
              'return count of windows of p\nend tell')
    try:
        result = run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True,
                     timeout=30 if request else 10)
        obs.update(returnCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
    except subprocess.TimeoutExpired as exc:
        decode = lambda s: s.decode("utf-8", "replace") if isinstance(s, bytes) else (s or "")
        return dict(obs, status="WINDOW_QUERY_TIMEOUT", stdout=decode(exc.stdout), stderr=decode(exc.stderr), advice=ADVICE)
    except Exception as exc:
        return dict(obs, status="WINDOW_QUERY_FAILED", error=str(exc), advice=ADVICE)
    codes = re.findall(r"\((-\d+)\)", result.stderr)
    code = int(codes[-1]) if codes else None
    obs["appleEventError"] = code
    if result.returncode != 0 or result.stderr.strip():
        status = {-1743: "AUTOMATION_DENIED", -1744: "AUTOMATION_CONSENT_REQUIRED",
                  -25211: "ACCESSIBILITY_DENIED", -1719: "ACCESSIBILITY_DENIED",
                  -1728: "TARGET_UNAVAILABLE", -600: "TARGET_UNAVAILABLE",
                  -1712: "WINDOW_QUERY_TIMEOUT"}.get(code, "WINDOW_QUERY_FAILED")
        # -1719 can also be invalid-index, so don't label that code alone as AX denial.
        if code == -1719 and not any(s in result.stderr.lower() for s in ("assistive", "accessibility", "辅助", "輔助")):
            status = "WINDOW_QUERY_FAILED"
        return dict(obs, status=status, advice=ADVICE)
    value = result.stdout.strip()
    if not re.fullmatch(r"[0-9]+", value):
        return dict(obs, status="WINDOW_QUERY_INVALID_RESPONSE", advice=ADVICE)
    return dict(obs, ok=True, status="OK", count=int(value))


def require_window_observation(state):
    obs = state.get("windowObservation")
    if not isinstance(obs, dict) or obs.get("ok") is not True:
        raise WindowObservationError(obs if isinstance(obs, dict) else {"status": "WINDOW_OBSERVATION_MISSING"})
    if type(obs.get("count")) is not int or obs["count"] < 0 or type(state.get("axWindowCount")) is not int or obs["count"] != state["axWindowCount"]:
        raise WindowObservationError(dict(obs, status="WINDOW_OBSERVATION_INCONSISTENT"))


def host_report(run=subprocess.run):
    rows, apps, errors = [], [], []
    pid = os.getpid()
    seen = set()
    for _ in range(32):
        if pid <= 1 or pid in seen:
            break
        seen.add(pid)
        try:
            result = run(["/bin/ps", "-p", str(pid), "-o", "ppid=,comm="], capture_output=True, text=True, timeout=3)
            if result.returncode != 0:
                raise RuntimeError(result.stderr or "process disappeared")
            parent, executable = result.stdout.strip().split(None, 1)
            rows.append({"pid": pid, "ppid": int(parent), "executable": executable})
            if ".app/Contents/" in executable:
                path = executable.split(".app/Contents/", 1)[0] + ".app"
                if not any(a["path"] == path for a in apps):
                    app = {"path": path}
                    with open(Path(path) / "Contents/Info.plist", "rb") as f:
                        info = plistlib.load(f)
                    app.update(bundleId=info.get("CFBundleIdentifier"), version=info.get("CFBundleShortVersionString"),
                               appleEventsUsageDescription=info.get("NSAppleEventsUsageDescription"))
                    for label, flags in (("signature", ["-dv", "--verbose=2"]), ("entitlements", ["-d", "--entitlements", "-"])):
                        sig = run(["/usr/bin/codesign", *flags, path], capture_output=True, text=True, timeout=5)
                        app[label] = {"returnCode": sig.returncode, "stdout": sig.stdout, "stderr": sig.stderr}
                    apps.append(app)
            pid = int(parent)
        except Exception as exc:
            errors.append(str(exc))
            break
    return {"processAncestry": rows, "candidateApps": apps, "errors": errors,
            "tccResponsibleApp": None, "attribution": "UNCONFIRMED_USE_SYSTEM_PROMPT_OR_TCC_LOG",
            "note": "An ancestor application is a candidate, not proof of TCC attribution. No full argv or secrets collected."}


def service_health(run=subprocess.run):
    """Best-effort recent system-service evidence, not per-host grant inference."""
    try:
        result = run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                      'process == "tccd" AND eventMessage CONTAINS "Database failed to open"'],
                     capture_output=True, text=True, timeout=10)
        return {"recentDatabaseOpenFailureObserved": "Database failed to open" in result.stdout if result.returncode == 0 else None,
                "returnCode": result.returncode, "stdout": result.stdout[-16000:], "stderr": result.stderr[-2000:],
                "scope": "recent tccd log; absence of messages is NOT proof of health or permission"}
    except Exception as exc:
        return {"recentDatabaseOpenFailureObserved": None, "error": str(exc)}


def diagnostic(d, observe, request=False):
    host = host_report()
    # observe enforces exact launcher/bridge binding before a request can occur.
    state = observe(d)
    result = {"toolVersion": VERSION, "host": host, "instance": state,
              "permissionRequestCount": 0, "stataDispatchCount": 0, "launchCount": 0}
    if request and state.get("launcherPid") and state.get("identityOk") is True:
        result["permissionRequestCount"] = 1
        obs = window_observation(state["launcherPid"], request=True)
        state = dict(state, axWindowCount=obs["count"], windowObservation=obs)
        result["instance"] = state
    elif request and state.get("launcherPid") is None and state.get("owner") is None:
        # Bootstrap System Events only, never Workbench/Stata. It may not yet
        # be running, in which case the passive Apple API returns procNotFound.
        result["permissionRequestCount"] = 1
        try:
            probe = subprocess.run(["/usr/bin/osascript", "-e", 'tell application "System Events" to get name'],
                                   capture_output=True, text=True, timeout=30)
            result["bootstrapSystemEvents"] = {"returnCode": probe.returncode, "stdout": probe.stdout, "stderr": probe.stderr}
        except Exception as exc:
            result["bootstrapSystemEvents"] = {"error": str(exc)}
        result["permissionCheckAfterRequest"] = permission_status()
    result["verdict"] = ("PASS_PERMISSION_WINDOW_CHECK" if state.get("identityOk") is True
        and state.get("windowObservation", {}).get("ok") is True
        and type(state.get("axWindowCount")) is int and state["axWindowCount"] == 1 else "BLOCKED")
    if result["verdict"] == "BLOCKED":
        result["permissionServiceHealth"] = service_health()
        if result["permissionServiceHealth"].get("recentDatabaseOpenFailureObserved") is True:
            result["systemRecoveryHint"] = ("tccd recently failed to open its database. This is not necessarily a user denial. "
                "Do not delete/edit TCC.db, reset all permissions, or disable SIP. Save work; an operator-managed "
                "macOS logout/restart may allow the service to reopen its database. This tool never restarts the system.")
    result["note"] = "Permission/window check only; not Stata execution or new full acceptance. " + ADVICE
    return result


if __name__ == "__main__":
    if sys.argv[1:] != ["--native-status"]:
        raise SystemExit("internal non-prompting probe only")
    print(json.dumps(native_permission_status(), ensure_ascii=False))
