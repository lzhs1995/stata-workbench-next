"""Pinned, idempotent Mac entry point for the local shared-session candidate."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import mac_permissions as permissions
import shlex
from types import SimpleNamespace
import urllib.request
import urllib.error

WORK = Path(__file__).resolve().parents[1]
PROFILE = Path(os.environ.get("STATA_WORKBENCH_PROFILE", str(Path.home() / ".stata-workbench-shared"))).expanduser().resolve()
EXTENSION = PROFILE / "extensions/lzhs1995.stata-workbench-shared-session-0.1.3-rc.7.44-dev.2"
PORT = int(os.environ.get("STATA_WORKBENCH_PORT", "17485"))
CODE_CLI = os.environ.get("STATA_WORKBENCH_CODE", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
VERSION = "0.1.3-rc.7.44-dev.2"
BUNDLE_SHA256 = "23ba6d13cd0d5711b07d62fefbd0a6a9e02e55dd69639fc8596b3d8e99f579fc"
PINS = {
    WORK / "dist/extension.js": BUNDLE_SHA256,
}


def helpers():
    if sys.platform != "darwin" or not 1024 <= PORT <= 65535:
        raise RuntimeError("this launcher requires macOS and a valid local port")
    for path, sha in {**PINS, EXTENSION / "dist/extension.js": BUNDLE_SHA256}.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != sha:
            raise RuntimeError("candidate identity mismatch: " + str(path))
    if json.loads((EXTENSION / "package.json").read_bytes())["version"] != VERSION:
        raise RuntimeError("installed version mismatch")
    return SimpleNamespace(w=LocalBridge(), _activate_exact_pid_once=activate_once)


def output(argv):
    return subprocess.check_output(argv, text=True, timeout=10).strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("bridge redirects are forbidden")


class LocalBridge:
    def http_post(self, path, payload, timeout=30):
        return self.request(path, payload, timeout)

    def request(self, path, payload=None, timeout=5):
        if path not in ("/status", "/run-command"):
            raise ValueError("unsupported endpoint")
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(req, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def status(self, timeout=5):
        rc, body = self.request("/status", timeout=timeout)
        if rc != 200 or not isinstance(body, dict):
            raise RuntimeError("status unavailable")
        return body

    def code_instances(self):
        rows = []
        expected = str(PROFILE / "user-data")
        for line in output(["/bin/ps", "-ax", "-o", "pid=,args="]).splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2 or "/Contents/MacOS/" not in fields[1]:
                continue
            pid, args = int(fields[0]), fields[1]
            # ps does not preserve shell quotes around paths containing spaces.
            # Bind the executable independently, then the full profile argument.
            if not any(x in args for x in ("--user-data-dir " + expected, "--user-data-dir=" + expected)):
                continue
            try:
                executable = output(["/bin/ps", "-p", str(pid), "-o", "comm="])
            except subprocess.CalledProcessError:
                continue
            expected_executable = Path(CODE_CLI).resolve().parents[3] / "MacOS/Code"
            if Path(executable).resolve() == expected_executable:
                suffix = args.split("--user-data-dir", 1)[1].lstrip("= ")
                if suffix == expected or suffix.startswith(expected + " --"):
                    rows.append({"pid": pid, "launcher": True})
        return rows

    def bridge_owner(self):
        run = subprocess.run(["/usr/sbin/lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=10)
        if run.returncode == 1 and not run.stdout.strip() and not run.stderr.strip():
            return None
        if run.returncode != 0:
            raise RuntimeError("listener census failed")
        pids = set(run.stdout.split())
        if len(pids) != 1:
            raise RuntimeError("listener owner is not unique")
        pid = int(pids.pop())
        ppid = int(output(["/bin/ps", "-p", str(pid), "-o", "ppid="]))
        return {"pid": pid, "ppid": ppid, "launcher": any(i["pid"] == ppid for i in self.code_instances())}

    def launcher_window_count(self, pid):
        obs = permissions.window_observation(pid)
        permissions.require_window_observation({"windowObservation": obs, "axWindowCount": obs["count"]})
        return obs["count"]

    def screen_locked(self):
        text = output(["/usr/sbin/ioreg", "-n", "Root", "-d1"])
        return '"CGSSessionScreenIsLocked" = Yes' in text or '"ScreenIsLocked" = Yes' in text


def activate_once(pid):
    output(["/usr/bin/osascript", "-e",
        f'tell application "System Events"\nset p to first application process whose unix id is {int(pid)}\nset frontmost of p to true\nend tell'])
    actual = int(output(["/usr/bin/osascript", "-e",
        'tell application "System Events" to unix id of first application process whose frontmost is true']))
    return {"ok": actual == pid, "actualPid": actual, "targetPid": pid}


def observe(d):
    instances = [row for row in d.w.code_instances() if row.get("launcher") is True]
    owner = d.w.bridge_owner()
    if len(instances) > 1:
        raise RuntimeError("multiple rc70 instances; refusing to select or terminate one")
    if owner and (not instances or owner.get("launcher") is not True
                  or owner.get("ppid") != instances[0]["pid"]):
        raise RuntimeError("bridge listener does not belong to the exact rc70 instance")
    status = d.w.status(timeout=5) if owner else {}
    identity_ok = (bool(instances) and owner is not None
        and status.get("extensionVersion") == VERSION
        and status.get("diskBundleSha256") == BUNDLE_SHA256
        and status.get("bundleIdentityState") == "OK"
        and status.get("guardModuleIdentityState") == "OK"
        and status.get("extensionHostPid") == owner.get("pid"))
    window = permissions.window_observation(instances[0]["pid"] if instances else None)
    return {"launcherPid": instances[0]["pid"] if instances else None,
            "owner": owner, "identityOk": identity_ok,
            "axWindowCount": window["count"], "windowObservation": window,
            "status": status}


def open_once(d, launch, foreground=True, timeout=120, sleep=time.sleep, clock=time.monotonic):
    before = observe(d)
    if before["launcherPid"] is not None:
        permissions.require_window_observation(before)
    elif not permissions.automation_granted(permissions.permission_status()):
        raise RuntimeError("permissions not verified; no launch attempted. " + permissions.ADVICE)
    launched = False
    if before["launcherPid"] is None:
        if d.w.screen_locked():
            raise RuntimeError("screen locked; no launch attempted")
        launch()
        launched = True
    started = clock()
    state = observe(d)
    if state["launcherPid"] is not None:
        permissions.require_window_observation(state)
    while not state["identityOk"] and clock() - started < timeout:
        sleep(1)
        state = observe(d)
        if state["launcherPid"] is not None:
            permissions.require_window_observation(state)
    if not state["identityOk"]:
        raise RuntimeError("instance exists but bridge identity is not ready; no relaunch/reset/retry")
    permissions.require_window_observation(state)
    if state["axWindowCount"] != 1:
        raise RuntimeError("expected one rc70 window; no window was closed")
    activation = None
    if foreground:
        activation = d._activate_exact_pid_once(state["launcherPid"])
        if activation.get("ok") is not True:
            raise RuntimeError("exact instance could not be brought forward; no retry")
    after = observe(d)
    permissions.require_window_observation(after)
    if after["axWindowCount"] != 1:
        raise RuntimeError("window topology changed while opening; no retry")
    if not after["identityOk"] or after["launcherPid"] != state["launcherPid"]:
        raise RuntimeError("instance changed while opening")
    return {"verdict": "OPENED" if launched else "REUSED", "launchCount": int(launched),
            "activation": activation, "instance": after,
            "bridgeUrl": f"http://127.0.0.1:{PORT}", "version": VERSION,
            "bundleSha256": BUNDLE_SHA256,
            "note": "opening is not execution or formal acceptance; no Stata command was sent"}


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--open", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--doctor", action="store_true", help="non-prompting host/permission/window diagnosis")
    mode.add_argument("--request-permissions", action="store_true", help="one read-only System Events query; may show macOS consent")
    parser.add_argument("--no-activate", action="store_true")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    os.environ["WS_FG_ALLOWED"] = "1" if args.open and not args.no_activate else "0"
    os.environ["WS_PHYSICAL_KEYS"] = "0"
    d = helpers()
    if args.doctor or args.request_permissions:
        result = permissions.diagnostic(d, observe, request=args.request_permissions)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["verdict"] == "PASS_PERMISSION_WINDOW_CHECK" else 2
    if args.status:
        state = observe(d)
        print(json.dumps(state, ensure_ascii=False))
        return 0 if state["identityOk"] and state["windowObservation"]["ok"] and state["axWindowCount"] == 1 else 2
    with open("/private/tmp/stata-workbench-verified-open.lock", "a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def launch():
            if not args.workspace.is_dir():
                raise RuntimeError("workspace must exist")
            subprocess.run([CODE_CLI, "--user-data-dir", str(PROFILE / "user-data"),
                "--extensions-dir", str(PROFILE / "extensions"), "--new-window",
                str(args.workspace.resolve())], check=True, timeout=30)

        result = open_once(d, launch, foreground=not args.no_activate)
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"verdict": "BLOCKED", "error": str(exc), "automaticRetry": False,
                          "windowObservation": getattr(exc, "observation", None)}, ensure_ascii=False))
        sys.exit(2)
