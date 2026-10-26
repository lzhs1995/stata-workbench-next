"""Small OS boundary for the shared client. Importing it never probes the desktop."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import shutil
import sys
import time


def default_code(platform=None, environ=None):
    platform = platform or sys.platform
    env = os.environ if environ is None else environ
    if env.get("STATA_WORKBENCH_CODE"):
        return env["STATA_WORKBENCH_CODE"]
    if platform == "darwin":
        return "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    if platform == "win32":
        candidates = [Path(env.get("LOCALAPPDATA", "")) / "Programs/Microsoft VS Code/Code.exe",
                      Path(env.get("ProgramFiles", "C:/Program Files")) / "Microsoft VS Code/Code.exe"]
        return str(next((p for p in candidates if p.is_file()), candidates[0]))
    return shutil.which("code") or "code"


def code_executable(code, platform=None):
    """Never execute a Windows .cmd through cmd.exe with user-controlled paths."""
    platform = platform or sys.platform
    p = Path(code).expanduser().resolve()
    if platform == "win32":
        if p.name.lower() in ("code", "code.cmd") and p.parent.name.lower() == "bin":
            p = p.parent.parent / "Code.exe"
        if p.suffix.lower() != ".exe":
            raise ValueError("STATA_WORKBENCH_CODE must identify Code.exe or its bin/code.cmd")
    return p


def adapter(profile, code, port):
    if sys.platform == "darwin":
        from mac_workbench import MacWorkbench
        return MacWorkbench(profile, code, port)
    if sys.platform == "win32":
        from windows_workbench import WindowsWorkbench
        return WindowsWorkbench(profile, code, port)
    raise RuntimeError("shared desktop client supports macOS and Windows only")


def permissions_module():
    if sys.platform == "win32":
        import windows_workbench
        return windows_workbench
    # mac_permissions is safe to import on other OSes; native probes fail closed.
    import mac_permissions
    return mac_permissions


def lock_paths(profile, purpose, platform=None):
    platform = platform or sys.platform
    paths = []
    # Cooperate with existing Mac controllers; never remove their lock inodes.
    if platform == "darwin":
        if purpose == "open":
            paths.append(Path("/private/tmp/stata-workbench-verified-open.lock"))
        else:
            paths.extend(Path("/private/tmp") / n for n in (
                "stata-workbench-broad-rc739-targeted.lock", "stata-workbench-shared-client.lock"))
    paths.append(Path(profile) / "locks" / (purpose + ".lock"))
    return paths


@contextmanager
def file_lock(path, timeout=0):
    """Stable-inode advisory lock; crash release comes from the OS, never unlink."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+b", buffering=0) as handle:
        if sys.platform == "win32":
            import msvcrt
            def acquire():
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            def release():
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def release():
                fcntl.flock(handle, fcntl.LOCK_UN)
        deadline = time.monotonic() + timeout
        while True:
            try:
                acquire()
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError("another client holds the Workbench lock: " + str(path)) from exc
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        try:
            yield handle
        finally:
            release()


def stata_file_command(path):
    """Stata accepts forward slashes on Windows; do not allow macro expansion."""
    text = Path(path).resolve(strict=True).as_posix()
    if any(c in text for c in ('"', '\n', '\r', '\0', '`', '$')):
        raise ValueError("do-file path contains a Stata quote, macro delimiter or control character")
    if not Path(path).is_file():
        raise ValueError("do-file must be a regular file")
    return 'do "' + text + '"'
