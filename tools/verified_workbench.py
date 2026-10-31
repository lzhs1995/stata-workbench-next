"""Pinned, idempotent macOS/Windows entry for the shared-session candidate."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import workbench_platform as host
permissions = host.permissions_module()
import shlex
from types import SimpleNamespace
import urllib.request
import urllib.error

WORK = Path(__file__).resolve().parents[1]
PROFILE = Path(os.environ.get("STATA_WORKBENCH_PROFILE", str(Path.home() / ".stata-workbench-next" / "profiles" / "default"))).expanduser().resolve()
EXTENSION = PROFILE / "extensions/lzhs1995.stata-workbench-next-0.2.0-next.1"
try:
    PORT = int(os.environ.get("STATA_WORKBENCH_PORT", "17601"))
except ValueError:
    PORT = 0  # Doctor can report the bad setting before any connection or launch.
CODE_CLI = host.default_code()
VERSION = "0.2.0-next.1"
BUNDLE_SHA256 = "09d274da569e68f1e7a80f7ee82eead46a024f5ab57fcbb74fa9e1d87180cb91"
PINS = {
    WORK / "dist/extension.js": BUNDLE_SHA256,
}


def helpers():
    if sys.platform not in ("darwin", "win32") or not 1024 <= PORT <= 65535:
        raise RuntimeError("this launcher requires macOS/Windows and a valid local port")
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
    def __init__(self):
        self.platform = host.adapter(PROFILE, CODE_CLI, PORT)

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

    def __getattr__(self, name):
        return getattr(self.platform, name)


def activate_once(pid):
    return permissions.activate_once(pid) if sys.platform == "win32" else __import__("mac_workbench").activate_once(pid)


def observe(d):
    instances = [row for row in d.w.code_instances() if row.get("launcher") is True]
    owner = d.w.bridge_owner()
    if len(instances) > 1:
        raise RuntimeError("multiple matching Workbench instances; refusing to select or terminate one")
    if owner and (not instances or owner.get("launcher") is not True
                  or owner.get("launcherPid", owner.get("ppid")) != instances[0]["pid"]):
        raise RuntimeError("bridge listener does not belong to the exact Workbench instance")
    status = d.w.status(timeout=5) if owner else {}
    identity_ok = (bool(instances) and owner is not None
        and ("launcherCreatedAt" not in owner or owner["launcherCreatedAt"] == instances[0].get("createdAt"))
        and status.get("extensionVersion") == VERSION
        and status.get("diskBundleSha256") == BUNDLE_SHA256
        and status.get("bundleIdentityState") == "OK"
        and status.get("guardModuleIdentityState") == "OK"
        and status.get("extensionHostPid") == owner.get("pid"))
    window = permissions.window_observation(instances[0]["pid"] if instances else None)
    return {"launcherPid": instances[0]["pid"] if instances else None,
            "launcher": instances[0] if instances else None,
            "owner": owner, "identityOk": identity_ok,
            "axWindowCount": window["count"], "windowObservation": window,
            "status": status}


def launch_argv(code, profile, workspace, cdp_port=None, disable_workspace_trust=False):
    """VS Code argv for the exact private profile. cdp_port opts in to a
    127.0.0.1-only DevTools endpoint so a remote operator can drive the real
    editor UI when Windows refuses foreground input from a background process.
    disable_workspace_trust opts in to VS Code's --disable-workspace-trust for
    this window only (the early Windows fast launcher did this): the folder opens
    without the trust prompt, but every extension in the private profile then
    runs with full trust, so use it only for a workspace you trust."""
    argv = host.code_launch_command(code) + ["--user-data-dir", str(profile / "user-data"),
        "--extensions-dir", str(profile / "extensions"), "--new-window"]
    if disable_workspace_trust is not False:
        if disable_workspace_trust is not True:
            raise ValueError("disable_workspace_trust must be a bool")
        argv.append("--disable-workspace-trust")
    if cdp_port is not None:
        if type(cdp_port) is not int or not 1024 <= cdp_port <= 65535:
            raise ValueError("invalid DevTools port")
        argv.append("--remote-debugging-port=" + str(cdp_port))
    return argv + [str(Path(workspace).resolve())]


def start_code(argv, platform=None):
    """Start VS Code once. On Windows Code.exe is the GUI process itself and never
    returns like the macOS `code` CLI, so it is started detached without inherited
    pipes; open_once then waits for the bridge identity, not for the process."""
    platform = platform or sys.platform
    if platform == "win32":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0x8) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, creationflags=flags)
        return
    subprocess.run(argv, check=True, timeout=30)


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
        raise RuntimeError("expected one Workbench window; no window was closed")
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
    parser.add_argument("--remote-debugging-port", type=int, default=None,
                        help="with --open on a new launch only: 127.0.0.1 DevTools port for UI automation")
    parser.add_argument("--disable-workspace-trust", action="store_true",
                        help="with --open on a new launch only: skip the workspace trust prompt; "
                             "extensions in the private profile then run with full trust")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    os.environ["WS_FG_ALLOWED"] = "1" if args.open and not args.no_activate else "0"
    os.environ["WS_PHYSICAL_KEYS"] = "0"
    if args.doctor:
        from workbench_doctor import diagnose
        result = diagnose(sys.modules[__name__])
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["verdict"] == "READY" else 2
    d = helpers()
    if args.request_permissions:
        result = permissions.diagnostic(d, observe, request=args.request_permissions)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["verdict"] == "PASS_PERMISSION_WINDOW_CHECK" else 2
    if args.status:
        state = observe(d)
        print(json.dumps(state, ensure_ascii=False))
        return 0 if state["identityOk"] and state["windowObservation"]["ok"] and state["axWindowCount"] == 1 else 2
    with ExitStack() as stack:
        for lock in host.lock_paths(PROFILE, "open"):
            stack.enter_context(host.file_lock(lock))

        def launch():
            if not args.workspace.is_dir():
                raise RuntimeError("workspace must exist")
            start_code(launch_argv(CODE_CLI, PROFILE, args.workspace, args.remote_debugging_port,
                                   args.disable_workspace_trust))

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
