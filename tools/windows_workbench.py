"""Windows process and desktop adapter. No Stata dispatch, reset or process kill."""
import base64
import ctypes
from ctypes import wintypes
import json
import ntpath
import os
from pathlib import Path
import subprocess
import sys

from workbench_platform import code_executable

ADVICE = "Use the same interactive Windows desktop and user as VS Code; run --doctor. No elevation, reset or retry is performed."


def powershell_json(script):
    if sys.platform != "win32":
        raise RuntimeError("Windows system query requires Windows")
    shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
    encoded = base64.b64encode((prefix + script).encode("utf-16-le")).decode("ascii")
    result = subprocess.run([str(shell), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                            capture_output=True, encoding="utf-8", errors="strict", timeout=20,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0:
        raise RuntimeError("Windows system query failed: " + result.stderr[-2000:])
    text = result.stdout.lstrip("\ufeff").strip()
    # Windows PowerShell 5.1 prints nothing for `@() | ConvertTo-Json`; an empty
    # pipeline (for example no listener before the first launch) is None, not an error.
    return json.loads(text) if text else None


def process_rows():
    rows = powershell_json("@(Get-CimInstance Win32_Process | Select-Object "
        "@{n='pid';e={[int]$_.ProcessId}},@{n='ppid';e={[int]$_.ParentProcessId}},"
        "@{n='executable';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}},"
        "@{n='createdAt';e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}}}) | ConvertTo-Json -Depth 4 -Compress")
    return rows if isinstance(rows, list) else [rows]


def split_command_line(command):
    # Use Windows' own parser, not POSIX shlex or a lossy space split.
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    kernel.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel.LocalFree.restype = wintypes.HLOCAL
    count = ctypes.c_int()
    argv = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not argv:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return [argv[i] for i in range(count.value)]
    finally:
        kernel.LocalFree(ctypes.cast(argv, wintypes.HLOCAL))


def option_values(argv, key):
    values = []
    for i, arg in enumerate(argv):
        if arg == key:
            values.append(argv[i + 1] if i + 1 < len(argv) else "")
        elif arg.startswith(key + "="):
            values.append(arg[len(key) + 1:])
    return values


def matching_launchers(rows, executable, profile, split=split_command_line):
    normalize = lambda p: ntpath.normcase(ntpath.normpath(str(p)))
    matches = []
    for row in rows:
        if not row.get("executable") or normalize(row["executable"]) != normalize(executable):
            continue
        argv = row.get("argv") if "argv" in row else split(row.get("commandLine") or "")
        if any(a == "--type" or a.startswith("--type=") for a in argv):
            continue
        users = option_values(argv, "--user-data-dir")
        extensions = option_values(argv, "--extensions-dir")
        if len(users) != 1 or normalize(users[0]) != normalize(ntpath.join(str(profile), "user-data")):
            continue
        if len(extensions) != 1 or normalize(extensions[0]) != normalize(ntpath.join(str(profile), "extensions")):
            continue
        if type(row.get("pid")) is not int or row["pid"] <= 0 or not row.get("createdAt"):
            continue
        matches.append({k: row[k] for k in ("pid", "ppid", "createdAt", "executable")} | {"launcher": True})
    return matches


def bind_listener(rows, listener_pids, launchers):
    pids = set(listener_pids)
    if not pids:
        return None
    if len(pids) != 1:
        raise RuntimeError("listener owner is not unique")
    processes = {row["pid"]: row for row in rows}
    pid = pids.pop()
    owner = processes.get(pid)
    if not owner or not owner.get("createdAt"):
        raise RuntimeError("listener process identity unavailable")
    current, seen, root = owner, set(), None
    for _ in range(32):
        if current["pid"] in seen:
            break
        seen.add(current["pid"])
        root = next((p for p in launchers if p["pid"] == current["pid"]
                     and p["createdAt"] == current.get("createdAt")), None)
        if root:
            break
        parent = processes.get(current.get("ppid"))
        if not parent or not parent.get("createdAt") or parent["createdAt"] > current["createdAt"]:
            break  # Parent PID has been reused, or its identity is unavailable.
        current = parent
    return {"pid": pid, "ppid": owner["ppid"], "createdAt": owner["createdAt"],
            "launcher": root is not None, "launcherPid": root["pid"] if root else None,
            "launcherCreatedAt": root["createdAt"] if root else None}


class WindowsWorkbench:
    def __init__(self, profile, code, port):
        self.profile, self.code, self.port = Path(profile), code_executable(code), port

    def code_instances(self):
        return matching_launchers(process_rows(), self.code, self.profile)

    def bridge_owner(self):
        if type(self.port) is not int or not 1024 <= self.port <= 65535:
            raise ValueError("invalid bridge port")
        pids = powershell_json("@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq "
            + str(self.port) + " | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress")
        rows = process_rows()
        return bind_listener(rows, [] if pids is None else pids if isinstance(pids, list) else [pids],
                             matching_launchers(rows, self.code, self.profile))

    def screen_locked(self):
        return not automation_granted(permission_status())

    def launcher_window_count(self, pid):
        obs = window_observation(pid)
        require_window_observation({"windowObservation": obs, "axWindowCount": obs["count"]})
        return obs["count"]


def user32():
    if sys.platform != "win32":
        raise RuntimeError("Windows desktop observation requires Windows")
    api = ctypes.WinDLL("user32", use_last_error=True)
    api.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenInputDesktop.restype = wintypes.HANDLE
    api.CloseDesktop.argtypes = [wintypes.HANDLE]
    api.CloseDesktop.restype = wintypes.BOOL
    api.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    api.GetUserObjectInformationW.restype = wintypes.BOOL
    api.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    api.GetWindowThreadProcessId.restype = wintypes.DWORD
    api.IsWindowVisible.argtypes = [wintypes.HWND]
    api.IsWindowVisible.restype = wintypes.BOOL
    api.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    api.GetWindow.restype = wintypes.HWND
    api.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    api.GetWindowTextLengthW.restype = ctypes.c_int
    api.SetForegroundWindow.argtypes = [wintypes.HWND]
    api.SetForegroundWindow.restype = wintypes.BOOL
    api.GetForegroundWindow.restype = wintypes.HWND
    return api


def permission_status():
    try:
        api = user32()
        desktop = api.OpenInputDesktop(0, False, 0x0001)  # DESKTOP_READOBJECTS, never switch desktops.
        if not desktop:
            return {"status": "DESKTOP_UNAVAILABLE", "osStatus": ctypes.get_last_error()}
        try:
            name, needed = ctypes.create_unicode_buffer(256), wintypes.DWORD()
            if not api.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name), ctypes.byref(needed)):
                return {"status": "DESKTOP_QUERY_FAILED", "osStatus": ctypes.get_last_error()}
            return {"status": "GRANTED" if name.value.casefold() == "default" else "SCREEN_LOCKED",
                    "osStatus": 0, "desktop": name.value, "scope": "interactive desktop; not macOS consent"}
        finally:
            api.CloseDesktop(desktop)
    except Exception as exc:
        return {"status": "DESKTOP_QUERY_FAILED", "osStatus": None, "error": str(exc)}


def automation_granted(check):
    return check.get("status") == "GRANTED" and type(check.get("osStatus")) is int and check["osStatus"] == 0


def window_handles(pid):
    api, found = user32(), []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    api.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    api.EnumWindows.restype = wintypes.BOOL
    @callback_type
    def visit(hwnd, unused):
        owner = wintypes.DWORD()
        api.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and api.IsWindowVisible(hwnd) and not api.GetWindow(hwnd, 4) and api.GetWindowTextLengthW(hwnd):
            found.append(hwnd)
        return True
    if not api.EnumWindows(visit, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return found


class WindowObservationError(RuntimeError):
    def __init__(self, observation):
        self.observation = observation
        super().__init__(observation["status"] + ": " + ADVICE)


def window_observation(pid, request=False):
    obs = {"ok": False, "count": None, "targetPid": pid, "status": "TARGET_NOT_RUNNING", "automaticRetry": False}
    if pid is None:
        return obs
    if type(pid) is not int or pid <= 0:
        return dict(obs, status="INVALID_TARGET_PID")
    check = permission_status()
    if not automation_granted(check):
        return dict(obs, status=check["status"], permissionCheck=check)
    try:
        return dict(obs, ok=True, count=len(window_handles(pid)), status="OK", method="EnumWindows",
                    scope="top-level windows only; source/Terminal layout needs separate observation")
    except Exception as exc:
        return dict(obs, status="WINDOW_QUERY_FAILED", error=str(exc))


def require_window_observation(state):
    obs = state.get("windowObservation")
    if not isinstance(obs, dict) or obs.get("ok") is not True:
        raise WindowObservationError(obs if isinstance(obs, dict) else {"status": "WINDOW_OBSERVATION_MISSING"})
    if type(obs.get("count")) is not int or obs["count"] < 0 or type(state.get("axWindowCount")) is not int or obs["count"] != state["axWindowCount"]:
        raise WindowObservationError(dict(obs, status="WINDOW_OBSERVATION_INCONSISTENT"))


def activate_once(pid):
    windows = window_handles(pid)
    if len(windows) != 1:
        return {"ok": False, "targetPid": pid, "error": "expected one window"}
    api = user32()
    accepted = bool(api.SetForegroundWindow(windows[0]))
    actual = wintypes.DWORD()
    api.GetWindowThreadProcessId(api.GetForegroundWindow(), ctypes.byref(actual))
    return {"ok": accepted and actual.value == pid, "actualPid": actual.value, "targetPid": pid}


def diagnostic(d, observe, request=False):
    state = observe(d)
    return {"verdict": "PASS_PERMISSION_WINDOW_CHECK" if state.get("identityOk")
            and state.get("windowObservation", {}).get("ok") and state.get("axWindowCount") == 1 else "BLOCKED",
            "instance": state, "permissionRequestCount": 0, "stataDispatchCount": 0, "launchCount": 0,
            "note": "Windows desktop query only; no macOS permission request applies. " + ADVICE}
