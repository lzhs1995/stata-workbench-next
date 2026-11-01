"""Pinned, idempotent macOS/Windows entry for the shared-session candidate."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
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
EXTENSION = PROFILE / "extensions/lzhs1995.stata-workbench-next-0.2.0-next.5"
try:
    PORT = int(os.environ.get("STATA_WORKBENCH_PORT", "17601"))
except ValueError:
    PORT = 0  # Doctor can report the bad setting before any connection or launch.
CODE_CLI = host.default_code()
VERSION = "0.2.0-next.5"
BUNDLE_SHA256 = "a8a3de63aaf012585c4fc662a7ac862efcafb42c9a15dc198fd7e09b1a2adfc6"
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


STATE_ROOT = Path(os.environ.get("STATA_WORKBENCH_NEXT_HOME", str(Path.home() / ".stata-workbench-next"))).expanduser()
SESSION_SCHEMA = "stata-workbench-next-session/1"


class SessionRegistryError(RuntimeError):
    pass


class MultipleSessionsError(SessionRegistryError):
    pass


class SessionIdentityError(RuntimeError):
    pass


# 本次调用绑定的会话（bind_session 设）。绑定后整次调用只认这个 sessionId，扩展重载换了会话就拒绝，不改投别的会话。
BOUND_SESSION_ID = None


def pid_alive(pid):
    """True 活着，False 确定已死，None 不知道（无权限、没有 pid）。未知一律当活，不跳过。"""
    if type(pid) is not int or pid <= 0:
        return None
    if sys.platform == "win32":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False if ctypes.get_last_error() == 87 else None  # ERROR_INVALID_PARAMETER = no such pid
        try:
            code = ctypes.c_ulong()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                return None
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return None


def registry_records(root=None, alive=None):
    """注册表里格式正确的记录（含 token），附 alive 三态。读不出、格式不对的文件跳过。"""
    alive = alive or pid_alive
    directory = (root or STATE_ROOT) / "sessions"
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        names = []
    records = []
    for name in names:
        if not name.endswith(".json") or name.startswith("."):
            continue
        try:
            rec = json.loads((directory / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (isinstance(rec, dict) and rec.get("schema") == SESSION_SCHEMA and type(rec.get("port")) is int
                and isinstance(rec.get("sessionId"), str)
                and isinstance(rec.get("token"), str) and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", rec["token"])):
            records.append({**rec, "alive": alive(rec.get("extensionHostPid"))})
    return records


def select_session(selector=None, port=None, root=None, alive=None):
    """选会话：selector 是会话名或 sessionId；没给就按 port 过滤。extensionHostPid 确定已死的跳过。
    一条也没有报 SESSION_REGISTRY_MISSING；多于一条报 MULTIPLE_SESSIONS。两种都不执行代码。"""
    directory = (root or STATE_ROOT) / "sessions"
    live = [r for r in registry_records(root, alive) if r["alive"] is not False]
    if selector:
        found = [r for r in live if selector in (r.get("sessionId"), r.get("sessionName"))]
        if port is not None:
            found = [r for r in found if r["port"] == port]
        what = f"session {selector!r}"
    elif port is not None:
        found = [r for r in live if r["port"] == port]
        what = f"port {port}"
    else:
        found = live
        what = "any live session"
    if not found:
        raise SessionRegistryError(f"SESSION_REGISTRY_MISSING: no live Next session record for {what} in {directory}; nothing was executed")
    if len(found) > 1:
        names = ", ".join(f"{r.get('sessionName') or '?'}={r['sessionId']}:{r['port']}" for r in found)
        raise MultipleSessionsError(f"MULTIPLE_SESSIONS: {len(found)} live Next sessions match {what} ({names}); "
                                    "pass --session <name or id>; nothing was executed")
    return found[0]


def session_record(port=None, root=None):
    """当前请求要用的记录（含 token）。已绑定时只认绑定的 sessionId；每次请求都重新读，
    扩展重载换了会话就报 SESSION_REGISTRY_MISSING，不改投别的会话。"""
    if BOUND_SESSION_ID is not None:
        rec = [r for r in registry_records(root) if r["sessionId"] == BOUND_SESSION_ID and r["alive"] is not False]
        if len(rec) != 1:
            raise SessionRegistryError(f"SESSION_REGISTRY_MISSING: bound session {BOUND_SESSION_ID} is no longer registered; nothing was executed")
        return rec[0]
    return select_session(None, PORT if port is None else port, root)


def auth_headers(port=None, root=None):
    rec = session_record(port, root)
    return {"Authorization": "Bearer " + rec["token"], "Host": f"127.0.0.1:{rec['port']}"}


def bind_session(selector=None, root=None, alive=None):
    """在任何请求之前选定会话，并把 PORT/PROFILE/EXTENSION 指到它。selector 没给时用环境变量
    STATA_WORKBENCH_SESSION；显式设了 STATA_WORKBENCH_PORT 就只在该端口里选。"""
    global BOUND_SESSION_ID, PORT, PROFILE, EXTENSION
    selector = selector or os.environ.get("STATA_WORKBENCH_SESSION") or None
    port = PORT if "STATA_WORKBENCH_PORT" in os.environ else None
    rec = select_session(selector, port, root, alive)
    profile = rec.get("profilePath")
    if profile:
        profile = Path(profile).expanduser().resolve()
        if "STATA_WORKBENCH_PROFILE" in os.environ and profile != PROFILE:
            raise SessionRegistryError(f"SESSION_PROFILE_MISMATCH: session {rec['sessionId']} uses {profile}, "
                                       f"STATA_WORKBENCH_PROFILE is {PROFILE}; nothing was executed")
        EXTENSION = profile / EXTENSION.relative_to(PROFILE)
        PROFILE = profile
    PORT = rec["port"]
    BOUND_SESSION_ID = rec["sessionId"]
    return rec


def verify_session_identity(status, root=None):
    """提交前核对：注册表里绑定的会话与 /status 的 sessionId、port、generation、bundle SHA 一一相同。
    任一缺失或不符就拒绝（不执行）。/status 经过鉴权门时扩展先刷新注册表，所以这里重读一次即可。"""
    rec = session_record(None, root)
    s = status if isinstance(status, dict) else {}
    pairs = {
        "sessionId": (rec.get("sessionId"), (s.get("nextSession") or {}).get("sessionId")),
        "port": (rec.get("port"), (s.get("nextAuth") or {}).get("port")),
        "generation": (rec.get("generation"), s.get("resetGeneration")),
        "bundleSha": (rec.get("diskBundleSha256"), s.get("diskBundleSha256")),
    }
    bad = sorted(k for k, (a, b) in pairs.items() if a is None or b is None or a != b)
    if bad:
        raise SessionIdentityError("SESSION_IDENTITY_MISMATCH: registry and /status differ on " + ", ".join(bad)
                                   + " " + json.dumps({k: pairs[k] for k in bad}) + "; nothing was executed")
    return {k: a for k, (a, _) in pairs.items()}


def list_sessions(root=None, alive=None):
    """--list-sessions：注册表里的会话，不含 token。"""
    keep = ("sessionId", "sessionName", "port", "alive", "extensionHostPid", "backendPid", "startedAt", "generation",
            "profilePath", "workspacePath", "tempDir", "logDir", "graphDir", "checkpointDir", "dataDir", "eventsPath",
            "diskBundleSha256")
    return [{k: r.get(k) for k in keep} for r in registry_records(root, alive)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("bridge redirects are forbidden")


class LocalBridge:
    def __init__(self):
        self.platform = host.adapter(PROFILE, CODE_CLI, PORT)

    def http_post(self, path, payload, timeout=30):
        return self.request(path, payload, timeout)

    def request(self, path, payload=None, timeout=5):
        # /events 只读，只接受数字 since/limit 两个参数
        if path not in ("/status", "/run-command") and not (
                payload is None and re.fullmatch(r"/events\?since=\d{1,12}(&limit=\d{1,4})?", path)):
            raise ValueError("unsupported endpoint")
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json", **auth_headers()})
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

    def events(self, since=0, limit=None, timeout=5):
        path = f"/events?since={int(since)}" + (f"&limit={int(limit)}" if limit else "")
        rc, body = self.request(path, timeout=timeout)
        if rc != 200 or not isinstance(body, dict) or not isinstance(body.get("events"), list):
            raise RuntimeError("events unavailable")
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
    mode.add_argument("--list-sessions", action="store_true", help="print the Next session registry (no tokens) and exit")
    parser.add_argument("--session", default=None,
                        help="session name or id to talk to (env STATA_WORKBENCH_SESSION); required when several are live")
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
    if args.list_sessions:
        print(json.dumps({"sessions": list_sessions()}, ensure_ascii=False))
        return 0
    if args.status:
        bind_session(args.session)  # --open/--request-permissions 不需要已有会话
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
