"""Next 多会话启动器（阶段 D）：一个会话 = 一个私有配置目录 + 一个 VS Code 窗口 + 一个端口 + 一份运行时。

  python3 -B tools/stata_session.py open <名字> [--workspace DIR] [--runtime-source DIR]
  python3 -B tools/stata_session.py list
  python3 -B tools/stata_session.py close <名字>

open 建 ~/.stata-workbench-next/profiles/<名字>/：settings.json 写端口（17601-17620 里挑空闲的）和会话名；
扩展目录是指向共用 extensions-shared 的链接；运行时是该会话自己的一份（macOS 用 APFS 克隆 `cp -c -R`，
不再用机器级 ~/.local/share/stata-workbench，A2 实测扩展会原地改写那份）；mcp.json 指向这份运行时。
超过 5 个活会话拒绝。并发的 open 互不阻塞：全局锁只管检查和预留，同名 open 由配置目录的 .open.lock 互斥，
运行时一份一份地拷（拷前重查磁盘）。open 只启动一次、等 VS Code 主进程出现（最多 60 s，launchState 报
visible / accepted-not-visible / prepare-only）、不等 bridge、不激活窗口、不发 Stata 命令；之后用
verified_workbench.py --status --session <名字> 核身份。close 只对该配置目录的 VS Code 主进程发普通退出
（macOS SIGTERM，Windows taskkill 不带 /F），从不强杀。Windows 运行时用整份复制，尚未实机验证。
"""
import argparse
from contextlib import ExitStack, contextmanager
import errno
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
import uuid

import workbench_platform as host
import verified_workbench as entry

NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
TMP_RE = re.compile(r"\.(?P<sid>[^/\\]+)\.(?P<pid>[0-9]+)\.[0-9a-f]{8}\.tmp")
MAX_SESSIONS = 5
# open 只在全局锁内做检查和预留（名字、端口、上限）；拷运行时、写配置、启动 VS Code 在全局锁外。
# 预留的归属是每个配置目录自己的 OS 文件锁 profiles/<名字>/.open.lock：open 在全局锁内拿到它（不阻塞），
# 一直拿到 VS Code 窗口可见或等待到期；进程死了 OS 自动放锁。opening.json 只记端口和本次 token，
# 别的进程判断预留还在不在只看这把锁有没有人拿着（拿不准时当作还在），不看 pid、不看时钟。
OPEN_LOCK_TIMEOUT = 60
PROFILE_LOCK_WAIT = 2          # 别的进程探测锁只占几毫秒；超过这个时间还拿不到就是有人在 open
COPY_LOCK_TIMEOUT = 900        # 运行时一份一份地拷：拷之前在锁内重查磁盘，后一个看得到前一个用掉的空间
LAUNCH_VISIBLE_WAIT = 60       # 启动后等 VS Code 主进程或注册表出现，期间预留不放
PORTS = range(17601, 17621)
FORBIDDEN_PORTS = {17485, 17416, 17497, 17507}
MAC_RESERVE_BYTES = 20 * 10**9


class SessionError(RuntimeError):
    pass


def _lock_byte(handle, lock):
    """对文件第 0 字节加/放不阻塞的独占锁（与 workbench_platform.file_lock 同一机制）；拿不到时抛 OSError。"""
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK if lock else msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, (fcntl.LOCK_EX | fcntl.LOCK_NB) if lock else fcntl.LOCK_UN)


BUSY_ERRNOS = (errno.EACCES, errno.EAGAIN, errno.EDEADLK)


def lock_held_elsewhere(path):
    """该锁文件此刻是否被别的打开方拿着。不存在算没人拿；能拿到就立刻放掉算没人拿；
    拿不到、或探测本身出错（权限、未知 errno），都按「有人拿着」处理（宁可多算一个预留，不放走在跑的 open）。"""
    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    with os.fdopen(fd, "r+b", buffering=0) as handle:
        try:
            _lock_byte(handle, True)
        except OSError:
            return True
        try:
            _lock_byte(handle, False)
        except OSError:
            pass
    return False


@contextmanager
def hold_profile_lock(path, wait=PROFILE_LOCK_WAIT, clock=time.monotonic):
    """拿住配置目录的 open 锁直到退出 with；wait 秒内拿不到就抛 SessionError（有另一个 open 在跑）。"""
    path = Path(path)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+b", buffering=0) as handle:
        deadline = clock() + wait
        while True:
            try:
                _lock_byte(handle, True)
                break
            except OSError as exc:
                if exc.errno not in BUSY_ERRNOS:
                    raise SessionError(f"PROFILE_LOCK_ERROR: cannot lock {path}: {exc}; nothing was launched") from exc
                if clock() >= deadline:
                    raise SessionError(f"SESSION_ALREADY_OPEN: another open of {path.parent.name} is in progress "
                                       f"(it holds {path.name}); nothing was launched") from exc
                time.sleep(0.05)
        try:
            yield handle
        finally:
            try:
                _lock_byte(handle, False)
            except OSError:
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


def mac_launch_argv(code, profile, workspace, env, disable_workspace_trust=False):
    """macOS：`open -n -a <app> --env K=V ... --args ...`。A2 实测这条路径能把环境变量传进扩展宿主。"""
    app = next((p for p in Path(code).expanduser().parents if p.suffix == ".app"), None)
    if app is None:
        raise SessionError(f"cannot find the VS Code .app from {code}")
    argv = ["/usr/bin/open", "-n", "-a", str(app)]
    for key in sorted(env):
        argv += ["--env", f"{key}={env[key]}"]
    tail = ["--user-data-dir", str(profile / "user-data"), "--extensions-dir", str(profile / "extensions"),
            "--new-window", str(Path(workspace).resolve())]
    if disable_workspace_trust:
        tail.append("--disable-workspace-trust")
    return argv + ["--args", *tail]


def windows_launch_argv(code, profile, workspace, disable_workspace_trust=False):
    argv = [str(host.code_executable(code, "win32")), "--user-data-dir", str(profile / "user-data"),
            "--extensions-dir", str(profile / "extensions"), "--new-window", str(Path(workspace).resolve())]
    if disable_workspace_trust:
        argv.append("--disable-workspace-trust")
    return argv


def tree_bytes(root):
    total = 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


def settings_value(path, key):
    """settings.json 里 key 的值；文件读不到或不是 JSON 对象时返回 None。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError):
        return None
    return data.get(key) if isinstance(data, dict) else None


def public(record):
    return {k: v for k, v in record.items() if k != "token"}


# V3-W2：Stata worker 类进程（mcp-stata 服务端、multiprocessing spawn worker、resource_tracker）的命令行特征。
WORKER_CMD_RE = re.compile(r"multiprocessing\.spawn import spawn_main|multiprocessing\.resource_tracker|-m mcp_stata\b")


def is_inside(directory, path):
    try:
        rel = os.path.relpath(os.path.realpath(path), os.path.realpath(directory))
    except ValueError:
        return False
    return rel == "." or not (rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel))


def orphan_reason(before, now, ws):
    """记下的身份 before 与此刻 now 比：只有完全一致、已被收养（ppid 1）、cwd 仍在本会话 ws 下才返回 orphaned。"""
    if not before or not before.get("lstart") or not before.get("cwd"):
        return "identity-unknown"
    if now.get("lstart") != before["lstart"]:
        return "pid-reused"
    if now.get("cwd") != before["cwd"]:
        return "cwd-changed"
    if not is_inside(ws, now["cwd"]):
        return "cwd-outside-session"
    if not WORKER_CMD_RE.search(now.get("command") or ""):
        return "not-a-worker"
    if now.get("ppid") != 1:
        return "not-orphaned"
    return "orphaned"


class Sessions:
    """所有外部动作（启动、进程查找、信号、端口探测、磁盘、时钟）都可注入，测试不真开 VS Code。"""

    def __init__(self, root=None, platform=None, code=None, run=None, popen=None, instances=None, alive=None,
                 port_free=port_free, kill=None, sleep=time.sleep, clock=time.monotonic, disk_free=None, environ=None,
                 now=time.time, launch_wait=LAUNCH_VISIBLE_WAIT, leftovers=None, identity=None, signal=None):
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
        self.now = now
        self.launch_wait = launch_wait
        self.disk_free = disk_free or (lambda p: shutil.disk_usage(p).free)
        self._leftovers = leftovers or self._real_leftovers
        self._identity = identity or self._real_identity
        self._signal = signal or (lambda pid, sig: os.kill(pid, sig))

    @property
    def profiles(self):
        return self.root / "profiles"

    def profile(self, name):
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            raise SessionError(f"INVALID_SESSION_NAME: {name!r} (1-40 of letters, digits, _ and -, starting with a letter or digit)")
        return self.profiles / name

    def _real_instances(self, profile):
        return [row["pid"] for row in host.adapter(profile, self.code, 0).code_instances()]

    def _real_leftovers(self, dirs):
        """V3-W2：还开着这些目录（本会话 ws、mcp-temp）的进程 [{pid, command}]，只读。
        Stata worker 是 mcp-stata 服务端的 multiprocessing spawn 子进程；force reset/关窗只结束服务端，
        服务端没走正常退出时 worker 被 launchd 收养（ppid 1）继续跑。只在 Unix 查（lsof +d 不递归）。"""
        if self.platform == "win32":
            return None
        rows = {}
        for d in dirs:
            if not Path(d).is_dir():
                continue
            try:
                out = subprocess.run(["lsof", "-Fpc", "+d", str(d)], capture_output=True, text=True, timeout=30).stdout
            except (OSError, subprocess.SubprocessError):
                return None
            pid = None
            for line in out.splitlines():
                if line.startswith("p") and line[1:].isdigit():
                    pid = int(line[1:])
                    rows.setdefault(pid, {"pid": pid, "command": None})
                elif line.startswith("c") and pid is not None:
                    rows[pid]["command"] = line[1:][:40]
        return sorted(rows.values(), key=lambda r: r["pid"])

    def _real_identity(self, pid):
        """{pid, ppid, lstart, cwd, command} 或 None（进程不在/读不到）。只读。"""
        env = {**os.environ, "LC_ALL": "C", "LANG": "C"}
        try:
            ps = subprocess.run(["ps", "-o", "pid=,ppid=,lstart=,command=", "-p", str(pid)], capture_output=True,
                                text=True, timeout=10, env=env).stdout.strip()
            m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$", ps)
            if not m or int(m.group(1)) != pid:
                return None
            out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True,
                                 timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        cwd = next((line[1:] for line in out.splitlines() if line.startswith("n")), None)
        return {"pid": pid, "ppid": int(m.group(2)), "lstart": " ".join(m.group(3).split()), "cwd": cwd,
                "command": m.group(4)[:200]}

    def worker_identities(self, name):
        """本会话 ws 下的 Stata worker 类进程（mcp-stata 服务端、spawn_main worker、resource_tracker）的身份。"""
        ws = self.root / "ws" / name
        try:
            rows = self._leftovers([ws])
        except Exception:  # noqa: BLE001  读不到身份：不发信号，只报告
            return None
        if rows is None:
            return None
        out = []
        for row in rows:
            ident = self._identity(row["pid"])
            if ident and ident.get("cwd") and is_inside(ws, ident["cwd"]) and WORKER_CMD_RE.search(ident.get("command") or ""):
                out.append(ident)
        return out

    def settle(self, captured, limit=6.0):
        """给服务端最多 limit 秒自己退出（它正常退出时会带走 worker）；记下的进程都退出或都被收养（ppid 1）就提前结束。"""
        deadline = self.clock() + limit
        while captured and self.clock() < deadline:
            now = [self._identity(c["pid"]) for c in captured]
            if all(n is None or n.get("lstart") != c.get("lstart") or n.get("ppid") == 1 for n, c in zip(now, captured)):
                break
            self.sleep(0.5)
        return captured

    def reap_orphans(self, captured, name, grace=3.0):
        """V3-W2：关窗后仍在的、身份完全一致（pid+启动时刻+cwd）、ppid=1、cwd 在本会话 ws 下的 worker：先 TERM，宽限后 KILL。
        返回 [{pid, startedAt, ended, reason}]；已退出的不列出。身份不符一律不发信号。"""
        ws = self.root / "ws" / name
        out = []
        for before in captured or []:
            now = self._identity(before["pid"])
            if now is None:
                continue
            rec = {"pid": before["pid"], "startedAt": before.get("lstart"), "ended": False}
            reason = orphan_reason(before, now, ws)
            if reason != "orphaned":
                rec["reason"] = reason
                out.append(rec)
                continue
            for sig, label in ((signal.SIGTERM, "orphaned-sigterm"), (signal.SIGKILL, "orphaned-sigkill")):
                try:
                    self._signal(before["pid"], sig)
                except ProcessLookupError:
                    pass
                rec["reason"] = label
                deadline = self.clock() + grace
                while self.clock() < deadline:
                    again = self._identity(before["pid"])
                    if again is None or again.get("lstart") != before.get("lstart"):
                        rec["ended"] = True
                        break
                    self.sleep(0.25)
                if rec["ended"]:
                    break
                again = self._identity(before["pid"])
                if again is None or orphan_reason(before, again, ws) != "orphaned":
                    rec["ended"] = again is None or again.get("lstart") != before.get("lstart")
                    break
            out.append(rec)
        return out

    def leftovers(self, name):
        """关窗后仍占用本会话工作目录或 mcp-temp 的进程；None = 本平台不查或查不了。只报告，不发信号。"""
        profile = self.profile(name)
        try:
            return self._leftovers([self.root / "ws" / name, profile / "mcp-temp"])
        except Exception:  # noqa: BLE001  诊断失败不影响 close 结论
            return None

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

    def reservation(self, name):
        """正在 open 的预留：opening.json 在，且配置目录的 .open.lock 此刻被别人拿着。
        归属只看 OS 锁（open 的进程死了 OS 自动放锁），不看 pid 存活、不看时钟，所以 pid 复用、时钟跳变、
        进程存活查不出来都不会把在跑的 open 当成陈旧件；探测拿不准时按「还在」算。
        opening.json 内容坏了（不是对象、pid 不是正整数）但锁有人拿着，仍算预留，只是没有端口。"""
        profile = self.profiles / name
        try:
            text = (profile / "opening.json").read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError:
            text = ""
        if not lock_held_elsewhere(profile / ".open.lock"):
            return None
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if not isinstance(data, dict) or type(data.get("pid")) is not int or data["pid"] <= 0:
            return {"name": name, "valid": False}
        port = data.get("port")
        return {**data, "name": name, "valid": True, "port": port if type(port) is int else None}

    def active(self):
        """活会话：注册表里活着的记录（按会话名），有 VS Code 进程但还没写注册表的配置目录，加上正在 open 的预留。"""
        active = {r.get("sessionName") or r["sessionId"] for r in self.records()}
        active.update(name for name in self.names() if self.instances(self.profiles / name) or self.reservation(name))
        return active

    def pick_port(self, name):
        """配置目录记着的端口优先（重开同一会话端口不变）；别的配置目录占着的、活会话用着的、被监听的都跳过。"""
        mine = self.meta(name).get("port")
        used = {r["port"] for r in self.records()}
        used.update(p for n in self.names() if n != name for p in [self.meta(n).get("port")] if type(p) is int)
        used.update(p for n in self.names() if n != name for p in [(self.reservation(n) or {}).get("port")] if type(p) is int)
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
        """调用方拿着该配置目录的 .open.lock。拷/克隆在 locks/runtime-copy.lock 里一份一份地做：
        锁内先重查磁盘再拷，后一个 open 看得到前一个已经用掉的空间（全局锁内那次检查只是提前拒绝）。"""
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
            raise SessionError(f"RUNTIME_STAGING_EXISTS: {staging} is left from an earlier open that stopped while copying "
                               f"(no open of {profile.name} is running now); it was not removed. Delete that directory "
                               f"by hand, then open again")
        with ExitStack() as stack:
            try:
                stack.enter_context(host.file_lock(self.root / "locks" / "runtime-copy.lock", timeout=COPY_LOCK_TIMEOUT))
            except TimeoutError:
                raise SessionError(f"RUNTIME_COPY_BUSY: another session's runtime copy did not finish within "
                                   f"{COPY_LOCK_TIMEOUT} s; nothing was copied") from None
            self.check_disk(source if self.platform != "darwin" else None)
            try:
                if self.platform == "darwin":
                    self.run(["/bin/cp", "-c", "-R", str(source), str(staging)])  # APFS 克隆：写时才复制
                    method = "apfs-clone"
                else:
                    shutil.copytree(source, staging, symlinks=True)  # Windows：整份复制
                    method = "copy"
            except BaseException:
                # 本次 open 拿着 .open.lock，staging 只可能是这次建的：拷失败就删掉，下次不会卡在 RUNTIME_STAGING_EXISTS。
                # 进程被杀时到不了这里，留下的 staging 由上面的 RUNTIME_STAGING_EXISTS 报给人处理。
                shutil.rmtree(staging, ignore_errors=True)
                raise
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
        # W-P1（W3 实测）：false 时 Stata 推迟到第一条命令才加载，Windows 上懒加载后的第一个
        # run_command_background 会挂到 break，PRE_LOG 120 s 一到就 504 并封会话；true 时开窗后台
        # connect 约 58 s，第一条输入 6.1 s rc 0。setdefault：用户显式写的 false 照旧不动。
        updated.setdefault("stataMcp.loadStataOnStartup", True)
        # 测试窗口不更新 VS Code 和扩展：Windows 上会话里自动装更新会改用户的安装，并让下一个 open 报
        # 「Code is currently being updated」。setdefault：这个 profile 里已有的显式值不动。
        updated.setdefault("update.mode", "none")
        updated.setdefault("extensions.autoUpdate", False)
        updated.setdefault("extensions.autoCheckUpdates", False)
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

    def launch(self, profile, workspace, env, disable_workspace_trust=False):
        if self.platform == "darwin":
            argv = mac_launch_argv(self.code, profile, workspace, env, disable_workspace_trust)
            self.run(argv)
        elif self.platform == "win32":
            argv = windows_launch_argv(self.code, profile, workspace, disable_workspace_trust)
            flags = getattr(subprocess, "DETACHED_PROCESS", 0x8) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
            self.popen(argv, env={**self.environ, **env}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, close_fds=True, creationflags=flags)
        else:
            raise SessionError("UNSUPPORTED_PLATFORM: macOS and Windows only")
        return argv

    def _refuse_if_open(self, name, profile):
        if self.instances(profile):
            raise SessionError(f"SESSION_ALREADY_OPEN: {name} already has a VS Code window; nothing was launched")
        if any(r.get("sessionName") == name for r in self.records()):
            raise SessionError(f"SESSION_ALREADY_OPEN: a live registry record already uses the name {name}")
        if self.reservation(name):
            raise SessionError(f"SESSION_ALREADY_OPEN: another open of {name} is in progress; nothing was launched")

    def open(self, name, workspace=None, runtime_source=None, shared_extensions=None, launch=True, disable_workspace_trust=False):
        profile = self.profile(name)
        workspace = Path(workspace or profile / "workspace")
        if workspace != profile / "workspace" and not workspace.is_dir():
            raise SessionError(f"WORKSPACE_MISSING: {workspace}")
        token = uuid.uuid4().hex
        with ExitStack() as owned:
            with host.file_lock(self.root / "locks" / "stata-session.lock", timeout=OPEN_LOCK_TIMEOUT):
                self._refuse_if_open(name, profile)
                active = self.active() - {name}
                if len(active) >= MAX_SESSIONS:
                    raise SessionError(f"SESSION_LIMIT: {len(active)} live Next sessions ({', '.join(sorted(active))}); "
                                       f"at most {MAX_SESSIONS}; close one first; nothing was launched")
                source = Path(runtime_source) if runtime_source else default_runtime_source(self.platform, self.environ)
                needs_copy = not runtime_python(profile / "runtime", self.platform).exists()
                self.check_disk(source if needs_copy and self.platform != "darwin" else None)  # 提前拒绝；拷之前在拷贝锁里重查
                for sub in ("user-data", "tmp", "mcp-temp", "pycache", "locks"):
                    (profile / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
                # 这把锁一直拿到本次 open 结束（窗口可见、等待到期或失败），离开全局锁也不放。
                owned.enter_context(hold_profile_lock(profile / ".open.lock"))
                # 拿到锁后再核一次：上一个同名 open 可能刚好在我们等锁时让窗口可见并放了锁。
                if self.instances(profile) or any(r.get("sessionName") == name for r in self.records()):
                    raise SessionError(f"SESSION_ALREADY_OPEN: {name} became live while this open waited; nothing was launched")
                port = self.pick_port(name)
                owned.callback(self._release_reservation, profile, token)
                write_json_atomic(profile / "opening.json", {"pid": os.getpid(), "at": self.now(), "port": port, "token": token})
            return self._open_reserved(name, profile, workspace, source, port, shared_extensions, launch,
                                       disable_workspace_trust)

    def _release_reservation(self, profile, token):
        """只删自己写的 opening.json（核 token）；调用时仍拿着 .open.lock，没有别的 open 能在这之间写它。"""
        path = profile / "opening.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict) and data.get("token") == token:
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def _wait_visible(self, name, profile):
        """启动后等这个配置目录的 VS Code 主进程或同名注册表记录出现，最多 launch_wait 秒；期间预留不放。"""
        deadline = self.clock() + self.launch_wait
        while True:
            try:
                if self.instances(profile) or any(r.get("sessionName") == name for r in self.records()):
                    return "visible"
            except Exception:
                pass  # 查进程出错不等于没启动；照样等到期，结果报 accepted-not-visible
            if self.clock() >= deadline:
                return "accepted-not-visible"
            self.sleep(0.5)

    def _open_reserved(self, name, profile, workspace, source, port, shared_extensions, launch, disable_workspace_trust):
        """全局锁外：名字和端口由 opening.json 预留，归属由本进程拿着的 .open.lock 保证。"""
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        extensions = self.link_extensions(profile, Path(shared_extensions) if shared_extensions else self.root / "extensions-shared")
        runtime = self.prepare_runtime(profile, source)
        config = self.write_mcp_config(profile, Path(runtime["path"]))
        settings = self.write_settings(profile, name, port, config)
        env = self.child_env(profile, name, config)
        meta_path = profile / "session.json"
        try:
            previous = meta_path.read_bytes()
        except FileNotFoundError:
            previous = None
        write_json_atomic(meta_path, {"name": name, "port": port, "profile": str(profile),
            "runtime": runtime, "mcpConfig": str(config), "extensions": extensions,
            "workspace": str(workspace.resolve()), "openedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        argv, state = None, "prepare-only"
        if launch:
            try:
                argv = self.launch(profile, workspace, env, disable_workspace_trust)
            except BaseException as exc:
                # 启动失败：把 session.json 还原成本次之前的样子，新会话的端口不留在 pick_port 的记录里。
                if previous is None:
                    meta_path.unlink(missing_ok=True)
                else:
                    tmp = meta_path.with_name("." + meta_path.name + f".{os.getpid()}.restore.tmp")
                    tmp.write_bytes(previous)
                    os.replace(tmp, meta_path)
                if isinstance(exc, Exception) and not isinstance(exc, SessionError):
                    raise SessionError(f"LAUNCH_FAILED: {exc}; session.json restored; the runtime and settings were kept") from exc
                raise
            state = self._wait_visible(name, profile)
        installed = any((profile / "extensions").glob("lzhs1995.stata-workbench-next-*"))
        return {"verdict": "LAUNCHED" if launch else "PREPARED", "launchCount": int(bool(launch)), "name": name,
                "launchState": state,
                "port": port, "profile": str(profile), "runtime": runtime, "mcpConfig": str(config), "settings": str(settings),
                "extensions": extensions, "extensionInstalled": installed, "argv": argv,
                "next": f"python3 -B tools/verified_workbench.py --status --session {name}",
                "note": ("workspace trust was disabled for this session; use only with a workspace you created"
                          if disable_workspace_trust else "new workspaces require one Trust click before the bridge starts; "
                          "launch is not execution; no bridge wait, no activation, no Stata command was sent"),
                "backendLoad": ("Stata loads in the background after the window opens (about 1 minute on Windows); "
                                "trueReady does not wait for it, and a command sent meanwhile waits for the load "
                                "inside its own pre-log budget"
                                if settings_value(settings, "stataMcp.loadStataOnStartup") is not False else
                                "loadStataOnStartup is false in this profile: Stata loads with the first command; "
                                "on Windows that first command can stall until the pre-log guard cancels it")}

    def list(self):
        records = self.records()
        rows = []
        for name in self.names():
            meta = self.meta(name)
            mine = [public(r) for r in records if r.get("sessionName") == name]
            rows.append({"name": name, "port": meta.get("port"), "profile": str(self.profiles / name),
                         "opening": bool(self.reservation(name)),
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
        if not pids and self.reservation(name):
            return {"verdict": "OPENING", "name": name, "signalled": [],
                    "note": "an open of this session is still in progress (it holds .open.lock); nothing was signalled; "
                            "run close again after the open returns"}
        if not pids:
            return {"verdict": "NOT_RUNNING", "name": name, "signalled": [], "removedRegistryFiles": self._remove_dead_records(name),
                    "removedTmpFiles": self._remove_orphan_tmp()}
        # V3-W2：先记下本会话 worker 类进程的身份（关窗前）；Windows 由 rc.7.82 结束整棵树，这里不处理
        captured = None if self.platform == "win32" else self.worker_identities(name)  # None = 读不到，只报告
        for pid in pids:
            self.kill(pid)
        deadline = self.clock() + wait
        while self.clock() < deadline:
            if not self.instances(profile):
                removed = self._remove_dead_records(name)
                if not any(r.get("sessionName") == name for r in self.records()):
                    result = {"verdict": "CLOSED", "name": name, "signalled": pids, "removedRegistryFiles": removed,
                              "removedTmpFiles": self._remove_orphan_tmp()}
                    if self.platform != "win32":
                        result["orphanWorkers"] = (self.reap_orphans(self.settle(captured), name) if captured is not None else
                                                   [{"pid": None, "startedAt": None, "ended": False, "reason": "identity-unreadable"}])
                    left = self.leftovers(name)
                    result["leftoverProcesses"] = left
                    if left:
                        result["note"] = ("VS Code closed, but these processes still hold this session's workspace or mcp-temp; "
                                          "only processes listed in orphanWorkers with ended=true were signalled")
                    return result
            self.sleep(0.5)
        return {"verdict": "CLOSE_PENDING", "name": name, "signalled": pids, "removedTmpFiles": self._remove_orphan_tmp(),
                "note": "normal quit was requested; VS Code may be waiting on an unsaved-changes prompt; nothing was force-killed"}

    def _remove_dead_records(self, name):
        removed = []
        directory = self.root / "sessions"
        try:
            candidates = sorted(directory.glob("*.json"))
        except OSError:
            candidates = []
        for path in candidates:
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(record, dict) or record.get("sessionName") != name:
                continue
            if self.alive(record.get("extensionHostPid")) is not False:
                continue
            try:
                path.unlink()
            except OSError:
                continue
            removed.append(str(path))
        return removed

    def _remove_orphan_tmp(self):
        """注册表原子写的残留 .<sessionId>.<pid>.<hex>.tmp（next_bridge_auth_core.js writeRecord）。
        写入进程确定已死，这个文件就不会再被改名成记录，读注册表的一方也只读 *.json，所以按写入 pid 判定：
        确定已死才删（未知、活着、pid 被复用都不删），不看内容。publish() 写的记录里没有 sessionName，按内容认不出归属，
        所以不分会话：关任何一个会话，都会删掉 sessions/ 里所有写入者已死的 .tmp（包括别的会话留下的）。"""
        removed = []
        try:
            candidates = sorted((self.root / "sessions").glob(".*.tmp"))
        except OSError:
            candidates = []
        for path in candidates:
            m = TMP_RE.fullmatch(path.name)
            if not m or self.alive(int(m.group("pid"))) is not False:
                continue
            try:
                path.unlink()
            except OSError:
                continue
            removed.append(str(path))
        return removed


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
    op.add_argument("--disable-workspace-trust", action="store_true",
                    help="opt in only for a workspace you created; otherwise keep the Trust prompt")
    sub.add_parser("list")
    cl = sub.add_parser("close")
    cl.add_argument("name")
    cl.add_argument("--wait", type=float, default=20)
    args = parser.parse_args(argv)
    s = sessions or Sessions()
    if args.command == "open":
        result = s.open(args.name, args.workspace, args.runtime_source, args.extensions_dir,
                        launch=not args.prepare_only, disable_workspace_trust=args.disable_workspace_trust)
    elif args.command == "list":
        result = s.list()
    else:
        result = s.close(args.name, args.wait)
    print(json.dumps(result, ensure_ascii=False))
    return 2 if result.get("verdict") in ("CLOSE_PENDING", "OPENING") else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"verdict": "BLOCKED", "error": str(exc), "launchCount": 0}, ensure_ascii=False))
        sys.exit(2)
