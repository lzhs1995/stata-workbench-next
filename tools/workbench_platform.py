"""Small OS boundary for the shared client. Importing it never probes the desktop."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import re
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
        local_app_data = env.get("LOCALAPPDATA")
        program_files = env.get("ProgramFiles", "C:/Program Files")
        user_profile = env.get("USERPROFILE") or env.get("HOME")
        candidates = []
        if local_app_data:
            candidates.extend((Path(local_app_data) / "Programs/Microsoft VS Code/Code.exe",
                               Path(local_app_data) / "Programs/Microsoft VS Code/bin/code.cmd"))
        candidates.extend((Path(program_files) / "Microsoft VS Code/Code.exe",
                           Path(program_files) / "Microsoft VS Code/bin/code.cmd"))
        if user_profile:
            candidates.append(Path(user_profile) / ".local/bin/code.cmd")
        for name in ("code.exe", "code.cmd"):
            found = shutil.which(name, path=env.get("PATH"))
            if found:
                candidates.append(Path(found))
        return str(next((p for p in candidates if p.is_file()), candidates[0] if candidates else Path("code.exe")))
    return shutil.which("code") or "code"


def code_executable(code, platform=None):
    """Return the real process image used by VS Code.

    The configured Windows value may be the official ``bin\\code.cmd`` shim.
    We resolve that shim to ``Code.exe`` before process identity checks, so the
    observer and launcher use the same executable even when the shim lives in
    a user-local directory.  We never pass a user-controlled command through a
    shell.
    """
    platform = platform or sys.platform
    p = Path(code).expanduser().resolve()
    if platform == "win32":
        if p.suffix.lower() in (".cmd", ".bat"):
            p = windows_code_target(p)
        if p.suffix.lower() != ".exe":
            raise ValueError("STATA_WORKBENCH_CODE must identify Code.exe or a resolvable bin\\code.cmd")
    return p


_CODE_TARGET_RE = re.compile(
    r"(?i)(?P<target>%~dp0[^\"\r\n]*?Code\.exe|[A-Za-z]:[\\/][^\"\r\n]*?Code\.exe|\\\\[^\"\r\n]*?Code\.exe|/[^\"\r\n]*?Code\.exe|\.\.[\\/][^\"\r\n]*?Code\.exe)"
)


def _cmd_text(path):
    """Read a Windows shim without executing it, accepting common BOMs."""
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Windows Code shim is not valid UTF-8/UTF-16 text: " + str(path))


def windows_code_target(code):
    """Resolve a Code shim to a real ``Code.exe`` without shell expansion.

    Standard VS Code shims use ``%~dp0..\\Code.exe``.  A few package managers
    place a forwarding shim in ``~\\.local\\bin``; for those, the target is
    accepted only when the shim names a concrete absolute or relative
    ``Code.exe`` path.  Environment-variable expansion and arbitrary command
    execution are deliberately unsupported.
    """
    shim = Path(code).expanduser().resolve()
    if shim.suffix.lower() == ".exe":
        return shim
    if shim.suffix.lower() not in (".cmd", ".bat"):
        raise ValueError("Windows Code path must be Code.exe or a .cmd/.bat shim: " + str(shim))
    candidates = [shim.parent.parent / "Code.exe"] if shim.parent.name.casefold() == "bin" else []
    if shim.is_file():
        text = _cmd_text(shim)
        for match in _CODE_TARGET_RE.finditer(text):
            raw = match.group("target")
            if raw.startswith("%~dp0"):
                candidate = shim.parent / raw[len("%~dp0"):].lstrip("\\/")
            elif raw.startswith("..") or raw.startswith("."):
                candidate = shim.parent / raw
            elif raw.startswith("/") or raw.startswith("\\\\") or (len(raw) >= 2 and raw[1] == ":"):
                candidate = Path(raw)
            else:
                continue
            candidates.append(candidate)
    for candidate in candidates:
        candidate = candidate.expanduser().resolve()
        if candidate.is_file() and candidate.suffix.casefold() == ".exe" and candidate.name.casefold() == "code.exe":
            return candidate
    raise ValueError("STATA_WORKBENCH_CODE shim does not resolve to an existing Code.exe: " + str(shim))


def code_launch_command(code, platform=None):
    """Return a shell-free argv prefix for launching VS Code."""
    platform = platform or sys.platform
    if platform == "win32":
        return [str(code_executable(code, platform))]
    return [str(code_executable(code, platform))]


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
