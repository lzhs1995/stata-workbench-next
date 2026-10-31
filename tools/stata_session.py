"""Next 多会话启动器（阶段 D）：一个会话 = 一个私有配置目录 + 一个 VS Code 窗口 + 一个端口 + 一份运行时。

  python3 -B tools/stata_session.py open <名字> [--workspace DIR] [--runtime-source DIR]
  python3 -B tools/stata_session.py list
  python3 -B tools/stata_session.py close <名字>

open 建 ~/.stata-workbench-next/profiles/<名字>/：settings.json 写端口（17601-17620 里挑空闲的）和会话名；
扩展目录是指向共用 extensions-shared 的链接；运行时是该会话自己的一份（macOS 用 APFS 克隆 `cp -c -R`，
不再用机器级 ~/.local/share/stata-workbench，A2 实测扩展会原地改写那份）；mcp.json 指向这份运行时。
超过 5 个活会话拒绝。open 只启动一次、不等 bridge、不激活窗口、不发 Stata 命令；之后用
verified_workbench.py --status --session <名字> 核身份。close 只对该配置目录的 VS Code 主进程发普通退出
（macOS SIGTERM，Windows taskkill 不带 /F），从不强杀。Windows 运行时用整份复制，尚未实机验证。
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

import workbench_platform as host
import verified_workbench as entry

NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
MAX_SESSIONS = 5
PORTS = range(17601, 17621)
FORBIDDEN_PORTS = {17485, 17416, 17497, 17507}
MAC_RESERVE_BYTES = 20 * 10**9


class SessionError(RuntimeError):
    pass


def state_root():
    return Path(os.environ.get("STATA_WORKBENCH_NEXT_HOME", str(Path.home() / ".stata-workbench-next"))).expanduser()


def default_runtime_source(platform=None, environ=None):
    platform = platform or sys.platform
    env = os.environ if environ is None else environ
    if env.get("STATA_WORKBENCH_RUNTIME_SOURCE"):
        return Path(env["STATA_WORKBENCH_RUNTIME_SOURCE"]).expanduser()
    if platform == "win32":
        return Path(env.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "stata-workbench" / "mcp-stata-1.26.1"
    return Path.home() / ".local/share/stata-workbench/mcp-stata-1.26.1"


def runtime_python(root, platform=None):
    return Path(root) / ("Scripts/python.exe" if (platform or sys.platform) == "win32" else "bin/python3")


def port_free(port):
    """只试绑 127.0.0.1；绑得上就算空闲，立刻关掉。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def write_json_atomic(path, data, mode=0o600):
    path = Path(path)
    tmp = path.with_name("." + path.name + f".{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def mac_launch_argv(code, profile, workspace, env):
    """macOS：`open -n -a <app> --env K=V ... --args ...`。A2 实测这条路径能把环境变量传进扩展宿主。"""
    app = next((p for p in Path(code).expanduser().parents if p.suffix == ".app"), None)
    if app is None:
        raise SessionError(f"cannot find the VS Code .app from {code}")
    argv = ["/usr/bin/open", "-n", "-a", str(app)]
    for key in sorted(env):
        argv += ["--env", f"{key}={env[key]}"]
    return argv + ["--args", "--user-data-dir", str(profile / "user-data"), "--extensions-dir", str(profile / "extensions"),
                   "--new-window", str(Path(workspace).resolve())]


def windows_launch_argv(code, profile, workspace):
    return [str(host.code_executable(code, "win32")), "--user-data-dir", str(profile / "user-data"),
            "--extensions-dir", str(profile / "extensions"), "--new-window", str(Path(workspace).resolve())]


def tree_bytes(root):
    total = 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


def public(record):
    return {k: v for k, v in record.items() if k != "token"}


class Sessions:
    """所有外部动作（启动、进程查找、信号、端口探测、磁盘、时钟）都可注入，测试不真开 VS Code。"""

    def __init__(self, root=None, platform=None, code=None, run=None, popen=None, instances=None, alive=None,
                 port_free=port_free, kill=None, sleep=time.sleep, clock=time.monotonic, disk_free=None, environ=None):
        self.root = Path(root) if root else state_root()
        self.platform = platform or sys.platform
        self.environ = dict(os.environ if environ is None else environ)
        self.code = code or host.default_code(self.platform, self.environ)
        self.run = run or (lambda argv: subprocess.run(argv, check=True, timeout=60))
        self.popen = popen or subprocess.Popen
        self._instances = instances or self._real_instances
        self.alive = alive or entry.pid_alive
        self.port_free = port_free
        self.kill = kill or self._real_kill
        self.sleep, self.clock = sleep, clock
        self.disk_free = disk_free or (lambda p: shutil.disk_usage(p).free)

    @property
    def profiles(self):
        return self.root / "profiles"

    def profile(self, name):
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            raise SessionError(f"INVALID_SESSION_NAME: {name!r} (1-40 of letters, digits, _ and -, starting with a letter or digit)")
        return self.profiles / name

    def _real_instances(self, profile):
        return [row["pid"] for row in host.adapter(profile, self.code, 0).code_instances()]

    def instances(self, profile):
        """该配置目录（精确的 --user-data-dir）下的 VS Code 主进程 pid。"""
        return list(self._instances(profile)) if (Path(profile) / "user-data").exists() else []

    def _real_kill(self, pid):
        if self.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid)], capture_output=True, timeout=30)  # 不带 /F：请窗口自己退出
        else:
            os.kill(pid, signal.SIGTERM)

    def records(self):
        return [r for r in entry.registry_records(self.root, self.alive) if r["alive"] is not False]

    def names(self):
        try:
            return sorted(p.name for p in self.profiles.iterdir() if p.is_dir() and NAME_RE.fullmatch(p.name))
        except FileNotFoundError:
            return []

    def meta(self, name):
        try:
            return json.loads((self.profiles / name / "session.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def active(self):
        """活会话：注册表里活着的记录（按会话名），加上有 VS Code 进程但还没写注册表的配置目录。"""
        active = {r.get("sessionName") or r["sessionId"] for r in self.records()}
        active.update(name for name in self.names() if self.instances(self.profiles / name))
        return active

    def pick_port(self, name):
        """配置目录记着的端口优先（重开同一会话端口不变）；别的配置目录占着的、活会话用着的、被监听的都跳过。"""
        mine = self.meta(name).get("port")
        used = {r["port"] for r in self.records()}
        used.update(p for n in self.names() if n != name for p in [self.meta(n).get("port")] if type(p) is int)
        candidates = ([mine] if type(mine) is int and mine in PORTS else []) + [p for p in PORTS if p != mine]
        for port in candidates:
            if port not in used and port not in FORBIDDEN_PORTS and self.port_free(port):
                return port
        raise SessionError("NO_FREE_PORT: every port in 17601-17620 is used by another Next profile or a listener")

    def check_disk(self, copy_source=None):
        probe = self.root
        while not probe.exists():
            probe = probe.parent
        free = self.disk_free(probe)
        if self.platform == "darwin":
            need = MAC_RESERVE_BYTES  # APFS 克隆几乎不占空间；这是用户定的保留线
        else:
            need = 2 * 10**9 + (tree_bytes(copy_source) if copy_source and Path(copy_source).is_dir() else 0)
        if free < need:
            raise SessionError(f"DISK_RESERVE: {free / 1e9:.1f} GB free, need {need / 1e9:.1f} GB; nothing was created")

    def link_extensions(self, profile, shared):
        link = profile / "extensions"
        shared.mkdir(parents=True, exist_ok=True, mode=0o700)
        is_junction = getattr(link, "is_junction", lambda: False)()
        if link.is_symlink() or is_junction:
            if os.path.realpath(link) != os.path.realpath(shared):
                raise SessionError(f"EXTENSIONS_LINK_MISMATCH: {link} points to {os.path.realpath(link)}, not {shared}")
            return "shared"
        if link.exists():
            return "private"  # 早先建的私有扩展目录，保留不动
        if os.name == "nt":  # 按真实主机：目录联接不需要提权（符号链接需要）
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(shared)], check=True, capture_output=True, timeout=30)
        else:
            link.symlink_to(shared, target_is_directory=True)
        return "shared"

    def prepare_runtime(self, profile, source):
        dest = profile / "runtime"
        if runtime_python(dest, self.platform).exists():
            return {"path": str(dest), "method": "existing"}
        source = Path(source).expanduser()
        if not runtime_python(source, self.platform).is_file():
            raise SessionError(f"RUNTIME_SOURCE_MISSING: {runtime_python(source, self.platform)} not found; pass --runtime-source")
        if dest.exists():
            raise SessionError(f"RUNTIME_INCOMPLETE: {dest} exists without its python; not overwritten")
        staging = profile / ".runtime.partial"
        if staging.exists():
            raise SessionError(f"RUNTIME_STAGING_EXISTS: {staging} is left from an earlier attempt; not removed")
        if self.platform == "darwin":
            self.run(["/bin/cp", "-c", "-R", str(source), str(staging)])  # APFS 克隆：写时才复制
            method = "apfs-clone"
        else:
            shutil.copytree(source, staging, symlinks=True)  # Windows：整份复制，尚未实机验证
            method = "copy"
        os.replace(staging, dest)
        return {"path": str(dest), "method": method, "source": str(source)}

    def write_mcp_config(self, profile, runtime):
        env = {"MCP_STATA_RUNTIME_ROOT": str(runtime), "MCP_STATA_TEMP": str(profile / "mcp-temp"),
               "TMPDIR": str(profile / "tmp"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
               "PYTHONPYCACHEPREFIX": str(profile / "pycache"), "MCP_STATA_LOGLEVEL": "INFO"}
        if self.platform == "win32":
            env.update(TEMP=str(profile / "tmp"), TMP=str(profile / "tmp"))
        path = profile / "mcp.json"
        write_json_atomic(path, {"servers": {"mcp_stata": {"type": "stdio", "command": str(runtime_python(runtime, self.platform)),
                                                            "args": ["-m", "mcp_stata"], "env": env}}})
        return path

    def write_settings(self, profile, name, port, config_path):
        path = profile / "user-data" / "User" / "settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        current = {}
        if path.exists():
            try:
                current = json.loads(path.read_text(encoding="utf-8") or "{}")
            except ValueError:
                raise SessionError(f"SETTINGS_NOT_PLAIN_JSON: {path} has comments or is not JSON; nothing was changed") from None
            if not isinstance(current, dict):
                raise SessionError(f"SETTINGS_NOT_PLAIN_JSON: {path} is not a JSON object; nothing was changed")
        updated = {**current, "stataMcp.visibleBridgePort": port, "stataMcp.nextSessionName": name,
                   "stataMcp.nextProfilePath": str(profile), "stataMcp.nextMcpConfigPath": str(config_path)}
        updated.setdefault("stataMcp.loadStataOnStartup", False)
        if updated != current:
            write_json_atomic(path, updated)
        return path

    def child_env(self, profile, name, config_path):
        env = {"STATA_WORKBENCH_NEXT_SESSION": name, "STATA_WORKBENCH_NEXT_PROFILE": str(profile),
               "STATA_WORKBENCH_NEXT_HOME": str(self.root), "MCP_STATA_CONFIG_PATH": str(config_path),
               "TMPDIR": str(profile / "tmp")}
        if self.platform == "win32":
            env.update(TEMP=str(profile / "tmp"), TMP=str(profile / "tmp"))
        return env

    def launch(self, profile, workspace, env):
        if self.platform == "darwin":
            argv = mac_launch_argv(self.code, profile, workspace, env)
            self.run(argv)
        elif self.platform == "win32":
            argv = windows_launch_argv(self.code, profile, workspace)
            flags = getattr(subprocess, "DETACHED_PROCESS", 0x8) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
            self.popen(argv, env={**self.environ, **env}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, close_fds=True, creationflags=flags)
        else:
            raise SessionError("UNSUPPORTED_PLATFORM: macOS and Windows only")
        return argv

    def open(self, name, workspace=None, runtime_source=None, shared_extensions=None, launch=True):
        profile = self.profile(name)
        workspace = Path(workspace or profile / "workspace")
        if workspace != profile / "workspace" and not workspace.is_dir():
            raise SessionError(f"WORKSPACE_MISSING: {workspace}")
        with host.file_lock(self.root / "locks" / "stata-session.lock", timeout=10):
            if self.instances(profile):
                raise SessionError(f"SESSION_ALREADY_OPEN: {name} already has a VS Code window; nothing was launched")
            if any(r.get("sessionName") == name for r in self.records()):
                raise SessionError(f"SESSION_ALREADY_OPEN: a live registry record already uses the name {name}")
            active = self.active() - {name}
            if len(active) >= MAX_SESSIONS:
                raise SessionError(f"SESSION_LIMIT: {len(active)} live Next sessions ({', '.join(sorted(active))}); "
                                   f"at most {MAX_SESSIONS}; close one first; nothing was launched")
            source = Path(runtime_source) if runtime_source else default_runtime_source(self.platform, self.environ)
            needs_copy = not runtime_python(profile / "runtime", self.platform).exists()
            self.check_disk(source if needs_copy and self.platform != "darwin" else None)
            for sub in ("user-data", "tmp", "mcp-temp", "pycache", "locks"):
                (profile / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
            workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
            extensions = self.link_extensions(profile, Path(shared_extensions) if shared_extensions else self.root / "extensions-shared")
            runtime = self.prepare_runtime(profile, source)
            port = self.pick_port(name)
            config = self.write_mcp_config(profile, Path(runtime["path"]))
            settings = self.write_settings(profile, name, port, config)
            env = self.child_env(profile, name, config)
            write_json_atomic(profile / "session.json", {"name": name, "port": port, "profile": str(profile),
                "runtime": runtime, "mcpConfig": str(config), "extensions": extensions,
                "workspace": str(workspace.resolve()), "openedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
            argv = self.launch(profile, workspace, env) if launch else None
        installed = any((profile / "extensions").glob("lzhs1995.stata-workbench-next-*"))
        return {"verdict": "LAUNCHED" if launch else "PREPARED", "launchCount": int(bool(launch)), "name": name,
                "port": port, "profile": str(profile), "runtime": runtime, "mcpConfig": str(config), "settings": str(settings),
                "extensions": extensions, "extensionInstalled": installed, "argv": argv,
                "next": f"python3 -B tools/verified_workbench.py --status --session {name}",
                "note": "launch is not execution; no bridge wait, no activation, no Stata command was sent"}

    def list(self):
        records = self.records()
        rows = []
        for name in self.names():
            meta = self.meta(name)
            mine = [public(r) for r in records if r.get("sessionName") == name]
            rows.append({"name": name, "port": meta.get("port"), "profile": str(self.profiles / name),
                         "runtime": (meta.get("runtime") or {}).get("method"),
                         "vscodePids": self.instances(self.profiles / name), "sessions": mine})
        known = set(self.names())
        orphans = [public(r) for r in records if (r.get("sessionName") or "") not in known]
        return {"profiles": rows, "otherLiveSessions": orphans, "active": len(self.active()), "max": MAX_SESSIONS}

    def close(self, name, wait=20):
        profile = self.profile(name)
        if not profile.is_dir():
            raise SessionError(f"SESSION_UNKNOWN: {profile} does not exist")
        pids = self.instances(profile)
        if not pids:
            return {"verdict": "NOT_RUNNING", "name": name, "signalled": []}
        for pid in pids:
            self.kill(pid)
        deadline = self.clock() + wait
        while self.clock() < deadline:
            if not self.instances(profile) and not any(r.get("sessionName") == name for r in self.records()):
                return {"verdict": "CLOSED", "name": name, "signalled": pids}
            self.sleep(0.5)
        return {"verdict": "CLOSE_PENDING", "name": name, "signalled": pids,
                "note": "normal quit was requested; VS Code may be waiting on an unsaved-changes prompt; nothing was force-killed"}


def main(argv=None, sessions=None):
    parser = argparse.ArgumentParser(description="Next multi-session launcher (at most 5 sessions, ports 17601-17620)")
    sub = parser.add_subparsers(dest="command", required=True)
    op = sub.add_parser("open")
    op.add_argument("name")
    op.add_argument("--workspace", type=Path, default=None)
    op.add_argument("--runtime-source", type=Path, default=None,
                    help="mcp-stata runtime to clone (default: env STATA_WORKBENCH_RUNTIME_SOURCE or the machine runtime)")
    op.add_argument("--extensions-dir", type=Path, default=None, help="shared extensions directory (default <home>/extensions-shared)")
    op.add_argument("--prepare-only", action="store_true", help="create the profile and runtime but do not start VS Code")
    sub.add_parser("list")
    cl = sub.add_parser("close")
    cl.add_argument("name")
    cl.add_argument("--wait", type=float, default=20)
    args = parser.parse_args(argv)
    s = sessions or Sessions()
    if args.command == "open":
        result = s.open(args.name, args.workspace, args.runtime_source, args.extensions_dir, launch=not args.prepare_only)
    elif args.command == "list":
        result = s.list()
    else:
        result = s.close(args.name, args.wait)
    print(json.dumps(result, ensure_ascii=False))
    return 2 if result.get("verdict") == "CLOSE_PENDING" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"verdict": "BLOCKED", "error": str(exc), "launchCount": 0}, ensure_ascii=False))
        sys.exit(2)
