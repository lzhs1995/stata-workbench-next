"""Next 阶段 D：tools/stata_session.py。所有启动、进程、信号、端口、磁盘都用替身，不开 VS Code。"""
import errno
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

import stata_session as ss
import verified_workbench as entry

POSIX = os.name != "nt"


def fake_runtime(root):
    for rel in ("bin/python3", "Scripts/python.exe", "lib/python3.11/site-packages/mcp_stata/server.py"):
        p = Path(root) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x", encoding="utf-8")
    return Path(root)


def write_record(root, sid, port, name, pid=None, **extra):
    d = Path(root) / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    rec = {"schema": entry.SESSION_SCHEMA, "sessionId": sid, "port": port, "token": "t" * 43,
           "extensionHostPid": pid or os.getpid(), "sessionName": name, **extra}
    (d / f"{sid}.json").write_text(json.dumps(rec), encoding="utf-8")
    return rec


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="next sessions ")
        self.root = Path(self.tmp.name) / "home"
        self.source = fake_runtime(Path(self.tmp.name) / "machine-runtime")
        self.running = {}
        self.calls = []

    def tearDown(self):
        self.join_all()
        self.tmp.cleanup()

    def in_threads(self, s, names, until, timeout=15):
        """每个名字一个线程跑 s.open；等 until() 成立（或超时）后返回结果表和错误表（线程还在跑）。"""
        results, errors = {}, []
        def go(name):
            try:
                results[name] = s.open(name, runtime_source=self.source)
            except Exception as exc:
                errors.append(repr(exc))
        self.threads = getattr(self, "threads", []) + [threading.Thread(target=go, args=(n,), daemon=True) for n in names]
        for t in self.threads[-len(names):]:
            t.start()
        deadline = time.monotonic() + timeout
        while not until() and time.monotonic() < deadline:
            time.sleep(0.02)
        return results, errors

    def join_all(self):
        for t in getattr(self, "threads", []):
            t.join(20)
        self.threads = []

    def run_cmd(self, argv):
        self.calls.append(list(argv))
        if argv[:3] == ["/bin/cp", "-c", "-R"]:
            shutil.copytree(argv[3], argv[4], symlinks=True)

    def sessions(self, platform="darwin", **kw):
        args = dict(root=self.root, platform=platform, run=self.run_cmd, popen=Mock(),
                    code="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" if platform == "darwin"
                    else "C:/VSCode/Code.exe",
                    instances=lambda profile: self.running.get(Path(profile).name, []),
                    alive=lambda pid: True, port_free=lambda port: True, sleep=Mock(), disk_free=lambda p: 10**12,
                    environ={"SystemRoot": "C:\\Windows"}, launch_wait=0, leftovers=lambda dirs: [])
        args.update(kw)
        return ss.Sessions(**args)


class OpenTests(Base):
    def test_prepare_creates_an_isolated_profile_with_its_own_runtime(self):
        s = self.sessions()
        r = s.open("p1", runtime_source=self.source, launch=False)
        p = self.root / "profiles" / "p1"
        self.assertEqual((r["verdict"], r["launchCount"], r["port"]), ("PREPARED", 0, 17601))
        self.assertEqual(r["runtime"]["method"], "apfs-clone")
        self.assertIn(["/bin/cp", "-c", "-R", str(self.source), str(p / ".runtime.partial")], self.calls)
        self.assertTrue((p / "runtime/bin/python3").is_file() and not (p / ".runtime.partial").exists())
        cfg = json.loads((p / "mcp.json").read_text())["servers"]["mcp_stata"]
        self.assertEqual(cfg["command"], str(p / "runtime/bin/python3"))
        self.assertEqual(cfg["args"], ["-m", "mcp_stata"])
        self.assertEqual(cfg["env"]["MCP_STATA_RUNTIME_ROOT"], str(p / "runtime"))
        self.assertEqual(cfg["env"]["MCP_STATA_TEMP"], str(p / "mcp-temp"))
        self.assertNotIn(".local/share/stata-workbench", json.dumps(cfg))
        settings = json.loads((p / "user-data/User/settings.json").read_text())
        self.assertEqual(settings["stataMcp.visibleBridgePort"], 17601)
        self.assertEqual(settings["stataMcp.nextSessionName"], "p1")
        self.assertEqual(settings["stataMcp.nextProfilePath"], str(p))
        self.assertEqual(settings["stataMcp.nextMcpConfigPath"], str(p / "mcp.json"))
        # W-P1：默认开窗即加载 Stata（懒加载在 Windows 上让第一条命令挂到 PRE_LOG 截断）
        self.assertIs(settings["stataMcp.loadStataOnStartup"], True)
        self.assertIn("loads in the background", r["backendLoad"])
        self.assertEqual(os.path.realpath(p / "extensions"), os.path.realpath(self.root / "extensions-shared"))
        if POSIX:
            self.assertEqual((p / "mcp.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((p / "tmp").stat().st_mode & 0o777, 0o700)
        meta = json.loads((p / "session.json").read_text())
        self.assertEqual((meta["name"], meta["port"]), ("p1", 17601))

    def test_second_session_gets_the_next_port_and_reopen_keeps_its_port(self):
        s = self.sessions()
        self.assertEqual(s.open("p1", runtime_source=self.source, launch=False)["port"], 17601)
        self.assertEqual(s.open("p2", runtime_source=self.source, launch=False)["port"], 17602)
        r = s.open("p1", runtime_source=self.source, launch=False)
        self.assertEqual((r["port"], r["runtime"]["method"]), (17601, "existing"))
        self.assertEqual(sum(1 for c in self.calls if c[:2] == ["/bin/cp", "-c"]), 2, "runtime cloned once per profile")

    def test_port_choice_skips_live_sessions_listeners_and_protected_ports(self):
        write_record(self.root, "sX", 17601, "elsewhere")
        s = self.sessions(port_free=lambda port: port != 17602)
        self.assertEqual(s.open("p1", runtime_source=self.source, launch=False)["port"], 17603)
        self.assertTrue(not ss.FORBIDDEN_PORTS & set(ss.PORTS))
        full = self.sessions(port_free=lambda port: False)
        with self.assertRaisesRegex(ss.SessionError, "NO_FREE_PORT"):
            full.open("p9", runtime_source=self.source, launch=False)

    def test_existing_settings_are_merged_and_jsonc_is_refused(self):
        s = self.sessions()
        u = self.root / "profiles/p1/user-data/User"
        u.mkdir(parents=True)
        (u / "settings.json").write_text(json.dumps({"editor.fontSize": 15, "stataMcp.loadStataOnStartup": False}))
        r = s.open("p1", runtime_source=self.source, launch=False)
        merged = json.loads((u / "settings.json").read_text())
        # 用户显式写的 false 不被新默认值覆盖，回包也说明第一条命令会去加载 Stata
        self.assertEqual((merged["editor.fontSize"], merged["stataMcp.loadStataOnStartup"]), (15, False))
        self.assertIn("loadStataOnStartup is false", r["backendLoad"])
        (u / "settings.json").write_text('{\n  // comment\n  "a": 1\n}')
        with self.assertRaisesRegex(ss.SessionError, "SETTINGS_NOT_PLAIN_JSON"):
            s.open("p1", runtime_source=self.source, launch=False)
        self.assertIn("// comment", (u / "settings.json").read_text())

    def test_new_profile_turns_off_vscode_and_extension_updates_but_keeps_explicit_values(self):
        s = self.sessions()
        s.open("fresh", runtime_source=self.source, launch=False)
        fresh = json.loads((self.root / "profiles/fresh/user-data/User/settings.json").read_text())
        self.assertEqual((fresh["update.mode"], fresh["extensions.autoUpdate"], fresh["extensions.autoCheckUpdates"]),
                         ("none", False, False))
        u = self.root / "profiles/kept/user-data/User"
        u.mkdir(parents=True)
        (u / "settings.json").write_text(json.dumps({"update.mode": "manual", "extensions.autoUpdate": "onlyEnabledExtensions"}))
        s.open("kept", runtime_source=self.source, launch=False)
        kept = json.loads((u / "settings.json").read_text())
        self.assertEqual((kept["update.mode"], kept["extensions.autoUpdate"], kept["extensions.autoCheckUpdates"]),
                         ("manual", "onlyEnabledExtensions", False))

    def test_sixth_session_is_refused_before_anything_is_created(self):
        s = self.sessions()
        for n in range(1, 6):
            s.open(f"p{n}", runtime_source=self.source, launch=False)
            self.running[f"p{n}"] = [1000 + n]
        with self.assertRaisesRegex(ss.SessionError, "SESSION_LIMIT: 5 live"):
            s.open("p6", runtime_source=self.source, launch=False)
        self.assertFalse((self.root / "profiles/p6").exists())
        self.running.pop("p3")
        self.assertEqual(s.open("p6", runtime_source=self.source, launch=False)["verdict"], "PREPARED")

    def test_concurrent_opens_launch_outside_the_lock_with_distinct_ports(self):
        """M8：三个并发 open 能同时停在启动里（全局锁已放），端口各不相同，结束后没有残留预留。"""
        gate, entered = threading.Event(), []
        def slow_launch(profile, workspace, env, disable_workspace_trust=False):
            entered.append(profile.name)
            gate.wait(20)
            return ["fake-launch", profile.name]
        s = self.sessions()
        s.launch = slow_launch
        results, errors = self.in_threads(s, ("c1", "c2", "c3"), until=lambda: len(entered) == 3)
        self.assertEqual(sorted(entered), ["c1", "c2", "c3"], "all three opens reach launch at the same time")
        gate.set()
        self.join_all()
        self.assertEqual(errors, [])
        self.assertEqual(len({r["port"] for r in results.values()}), 3)
        self.assertFalse(any((self.root / "profiles" / n / "opening.json").exists() for n in ("c1", "c2", "c3")))

    def test_in_flight_open_counts_toward_the_limit_and_reserves_its_port(self):
        """预留只看 .open.lock 有没有人拿着：拿着就算活会话并占端口；没人拿着的 opening.json 是陈旧件。"""
        for n in range(4):
            write_record(self.root, f"s{n}", 17610 + n, f"r{n}")
        s = self.sessions(alive=lambda pid: False)  # pid 查出来是死的也不影响：只看锁
        p = self.root / "profiles" / "busy"
        p.mkdir(parents=True)
        ss.write_json_atomic(p / "opening.json", {"pid": 999999, "at": 0, "port": 17601, "token": "other"})
        self.assertIsNone(s.reservation("busy"), "nobody holds the lock: stale file")
        s4 = self.sessions()
        with ss.hold_profile_lock(p / ".open.lock"):
            self.assertEqual(s.reservation("busy")["port"], 17601)
            with self.assertRaisesRegex(ss.SessionError, "SESSION_LIMIT"):
                s4.open("p1", runtime_source=self.source, launch=False)
            with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
                s4.open("busy", runtime_source=self.source, launch=False)
            (self.root / "sessions" / "s3.json").unlink()
            self.assertEqual(s4.open("p1", runtime_source=self.source, launch=False)["port"], 17602)
        self.assertIsNone(s.reservation("busy"))
        self.assertEqual(s4.open("busy", runtime_source=self.source, launch=False)["verdict"], "PREPARED")

    def test_same_name_open_is_refused_while_the_first_still_runs_even_after_a_clock_jump(self):
        """R1：先开的 open 停在启动里，30 分钟、时钟前跳或后跳都不让同名第二个 open 进来；
        第一个结束后它只删自己的预留。"""
        gate, entered = threading.Event(), []
        def slow_launch(profile, workspace, env, disable_workspace_trust=False):
            entered.append(profile.name)
            gate.wait(20)
            return ["fake-launch"]
        clock = {"now": 10000.0}
        first = self.sessions(now=lambda: clock["now"])
        first.launch = slow_launch
        results, errors = self.in_threads(first, ("dup",), until=lambda: entered == ["dup"])
        second = self.sessions(now=lambda: clock["now"])
        for jump in (ss.OPEN_LOCK_TIMEOUT * 31, -10**6):
            clock["now"] += jump
            with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
                second.open("dup", runtime_source=self.source)
        self.assertEqual(entered, ["dup"], "the second open never reached launch")
        gate.set()
        self.join_all()
        self.assertEqual(errors, [])
        self.assertFalse((self.root / "profiles/dup/opening.json").exists())
        self.assertEqual(second.open("dup", runtime_source=self.source)["verdict"], "LAUNCHED")

    def test_open_rechecks_after_waiting_for_the_profile_lock(self):
        """前一个同名 open 在我们等 .open.lock 的那一小段里让窗口可见并放了锁：拿到锁后重查，拒绝重复启动。"""
        held = threading.Event()
        p = self.root / "profiles" / "rc"
        p.mkdir(parents=True)
        def holder():
            with ss.hold_profile_lock(p / ".open.lock"):
                held.set()
                time.sleep(0.3)
                self.running["rc"] = [5151]
        self.threads = [threading.Thread(target=holder, daemon=True)]
        self.threads[0].start()
        self.assertTrue(held.wait(10))
        with self.assertRaisesRegex(ss.SessionError, "became live while this open waited"):
            self.sessions().open("rc", runtime_source=self.source, launch=False)
        self.assertFalse((p / "session.json").exists())

    def test_an_old_opener_never_deletes_a_reservation_it_does_not_own(self):
        """compare-and-delete：opening.json 的 token 不是自己的就不删。"""
        s = self.sessions()
        def swap_owner(profile, workspace, env, disable_workspace_trust=False):
            ss.write_json_atomic(profile / "opening.json", {"pid": 4242, "at": 0, "port": 17609, "token": "someone-else"})
            return ["fake-launch"]
        s.launch = swap_owner
        s.open("own", runtime_source=self.source)
        left = json.loads((self.root / "profiles/own/opening.json").read_text())
        self.assertEqual(left["token"], "someone-else")

    def test_unknown_lock_state_or_broken_reservation_fails_closed(self):
        """R2：探测锁出错按「有人在 open」算；opening.json 内容坏了但锁有人拿着，也算预留（只是没有端口）。"""
        s = self.sessions()
        p = self.root / "profiles" / "u1"
        p.mkdir(parents=True)
        ss.write_json_atomic(p / "opening.json", {"pid": 1, "at": 0, "port": 17601, "token": "x"})
        (p / ".open.lock").write_bytes(b"")
        with patch.object(ss, "_lock_byte", side_effect=OSError(errno.EIO, "probe failed")):
            self.assertTrue(s.reservation("u1"))
        with patch.object(ss.os, "open", side_effect=PermissionError("denied")):
            self.assertTrue(ss.lock_held_elsewhere(p / ".open.lock"))
        with ss.hold_profile_lock(p / ".open.lock"):
            self.assertEqual(s.pick_port("other"), 17602, "the reserved port is skipped")
            for bad in ("[1, 2]", "not json", json.dumps({"pid": -3, "port": 17601}), json.dumps({"pid": "7"})):
                (p / "opening.json").write_text(bad, encoding="utf-8")
                r = s.reservation("u1")
                self.assertEqual((bool(r), r["valid"]), (True, False), bad)
                self.assertIn("u1", s.active())
                with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
                    s.open("u1", runtime_source=self.source, launch=False)
        (p / "opening.json").write_text("[1, 2]", encoding="utf-8")
        self.assertIsNone(s.reservation("u1"), "broken file, nobody holds the lock: ignored without raising")
        self.assertNotIn("u1", s.active())

    def test_concurrent_copies_near_the_disk_reserve_recheck_inside_the_copy_lock(self):
        """R3：两份 Windows 整份复制同时过了全局锁里的检查，第二份在拷贝锁里重查时看到第一份用掉的空间而拒绝。"""
        free = {"bytes": int(3.5 * 10**9)}
        tree = 10**9
        started, inside = [], threading.Event()
        real_prepare = ss.Sessions.prepare_runtime
        s = self.sessions(platform="win32", popen=Mock(), disk_free=lambda p: free["bytes"])
        def prepare(profile, source):
            started.append(profile.name)
            return real_prepare(s, profile, source)
        s.prepare_runtime = prepare
        def fake_copytree(src, dst, symlinks=True):
            inside.wait(10)  # 两个 open 都过了全局锁里的检查之后，第一份才真正占用空间
            Path(dst).mkdir(parents=True)
            fake_runtime(dst)
            free["bytes"] -= tree
        with patch.object(ss, "tree_bytes", return_value=tree), patch.object(ss.shutil, "copytree", side_effect=fake_copytree):
            results, errors = self.in_threads(s, ("w1", "w2"), until=lambda: len(started) == 2)
            inside.set()
            self.join_all()
        self.assertEqual(len(results), 1, errors)
        self.assertEqual(len(errors), 1)
        self.assertIn("DISK_RESERVE", errors[0])
        self.assertGreaterEqual(free["bytes"], 2 * 10**9, "the 2 GB reserve is kept")
        loser = ({"w1", "w2"} - set(results)).pop()
        self.assertFalse((self.root / "profiles" / loser / ".runtime.partial").exists())
        self.assertFalse((self.root / "profiles" / loser / "opening.json").exists())

    def test_close_during_an_open_reports_opening_and_signals_nothing(self):
        s = self.sessions()
        p = self.root / "profiles" / "o1"
        p.mkdir(parents=True)
        ss.write_json_atomic(p / "opening.json", {"pid": os.getpid(), "at": 0, "port": 17601, "token": "t"})
        kill = Mock()
        s.kill = kill
        with ss.hold_profile_lock(p / ".open.lock"):
            r = s.close("o1")
            self.assertEqual(r["verdict"], "OPENING")
            self.assertTrue(s.list()["profiles"][0]["opening"])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(ss.main(["close", "o1"], sessions=s), 2)
        kill.assert_not_called()
        self.assertEqual(s.close("o1")["verdict"], "NOT_RUNNING")

    def test_launch_waits_until_the_window_is_visible_and_reports_when_it_is_not(self):
        """启动后等 VS Code 主进程出现才放预留；到期没出现报 accepted-not-visible，预留也放掉。"""
        ticks = iter(range(0, 10000))
        s = self.sessions(clock=lambda: next(ticks), launch_wait=5)
        seen = []
        def launch(profile, workspace, env, disable_workspace_trust=False):
            return ["fake-launch"]
        def sleep(_):
            seen.append(s.reservation("v1") is not None)
            if len(seen) == 2:
                self.running["v1"] = [3131]
        s.launch, s.sleep = launch, sleep
        r = s.open("v1", runtime_source=self.source)
        self.assertEqual((r["verdict"], r["launchState"]), ("LAUNCHED", "visible"))
        self.assertEqual(seen, [True, True], "the reservation is held while waiting for the window")
        self.assertFalse((self.root / "profiles/v1/opening.json").exists())
        self.running.clear()
        r = s.open("v2", runtime_source=self.source)
        self.assertEqual(r["launchState"], "accepted-not-visible")
        self.assertFalse((self.root / "profiles/v2/opening.json").exists())
        self.assertEqual(s.open("v3", runtime_source=self.source, launch=False)["launchState"], "prepare-only")

    def test_os_lock_is_released_when_the_opening_process_dies(self):
        """真多进程：子进程拿着 .open.lock 时同名 open 被拒；杀掉子进程后锁由 OS 放掉，下一个 open 进得来。"""
        p = self.root / "profiles" / "mp"
        p.mkdir(parents=True)
        ss.write_json_atomic(p / "opening.json", {"pid": 1, "at": 0, "port": 17601, "token": "child"})
        code = ("import sys,time; sys.path.insert(0, sys.argv[1]); import stata_session as ss\n"
                "with ss.hold_profile_lock(sys.argv[2]):\n    print('HELD', flush=True); time.sleep(120)\n")
        child = subprocess.Popen([sys.executable, "-B", "-c", code, str(Path(ss.__file__).parent), str(p / ".open.lock")],
                                 stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "HELD")
            s = self.sessions()
            self.assertTrue(s.reservation("mp"))
            with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
                s.open("mp", runtime_source=self.source, launch=False)
        finally:
            child.kill()
            child.wait(30)
            child.stdout.close()
        deadline = time.monotonic() + 10
        while s.reservation("mp") and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIsNone(s.reservation("mp"), "the OS released the dead child's lock")
        self.assertEqual(s.open("mp", runtime_source=self.source, launch=False)["verdict"], "PREPARED")

    def test_failed_open_releases_its_reservation(self):
        s = self.sessions()
        def broken(profile, source):
            raise ss.SessionError("RUNTIME_COPY_FAILED: test")
        s.prepare_runtime = broken
        with self.assertRaisesRegex(ss.SessionError, "RUNTIME_COPY_FAILED"):
            s.open("f1", runtime_source=self.source, launch=False)
        self.assertFalse((self.root / "profiles" / "f1" / "opening.json").exists())
        self.assertNotIn("f1", s.active())
        ok = self.sessions()
        self.assertEqual(ok.open("f2", runtime_source=self.source, launch=False)["port"], 17601, "port freed")

    def test_each_failure_stage_releases_what_it_reserved(self):
        """拷到一半失败删掉本次 staging；启动失败把 session.json 还原（新会话端口放掉，重开的会话端口原样保留）。"""
        win = self.sessions(platform="win32", popen=Mock())
        def half_copy(src, dst, symlinks=True):
            Path(dst).mkdir(parents=True)
            (Path(dst) / "half").write_text("x", encoding="utf-8")
            raise OSError(errno.ENOSPC, "disk full")
        with patch.object(ss.shutil, "copytree", side_effect=half_copy):
            with self.assertRaises(OSError):
                win.open("c1", runtime_source=self.source)
        self.assertFalse((self.root / "profiles/c1/.runtime.partial").exists(), "own staging removed")
        self.assertFalse((self.root / "profiles/c1/opening.json").exists())
        s = self.sessions()
        def boom(*a, **k):
            raise RuntimeError("open -a failed")
        s.launch = boom
        with self.assertRaisesRegex(ss.SessionError, "LAUNCH_FAILED"):
            s.open("l1", runtime_source=self.source)
        self.assertFalse((self.root / "profiles/l1/session.json").exists(), "new session metadata removed")
        self.assertFalse((self.root / "profiles/l1/opening.json").exists())
        self.assertEqual(self.sessions().open("l2", runtime_source=self.source, launch=False)["port"], 17601, "port freed")
        before = (self.root / "profiles/l2/session.json").read_bytes()
        with self.assertRaisesRegex(ss.SessionError, "LAUNCH_FAILED"):
            s.open("l2", runtime_source=self.source)
        self.assertEqual((self.root / "profiles/l2/session.json").read_bytes(), before, "reopened session keeps its metadata")
        self.assertEqual(self.sessions().pick_port("x"), 17602, "l2 still owns 17601")

    def test_live_registry_records_count_toward_the_limit(self):
        for n in range(5):
            write_record(self.root, f"s{n}", 17610 + n, f"r{n}")
        with self.assertRaisesRegex(ss.SessionError, "SESSION_LIMIT"):
            self.sessions().open("p1", runtime_source=self.source, launch=False)
        dead = self.sessions(alive=lambda pid: False)
        self.assertEqual(dead.open("p1", runtime_source=self.source, launch=False)["verdict"], "PREPARED")

    def test_an_open_session_is_not_opened_twice(self):
        s = self.sessions()
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [4242]
        with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
            s.open("p1", runtime_source=self.source)
        self.running.clear()
        write_record(self.root, "sLive", 17601, "p1")
        with self.assertRaisesRegex(ss.SessionError, "SESSION_ALREADY_OPEN"):
            s.open("p1", runtime_source=self.source)
        self.assertFalse(any(c[0] == "/usr/bin/open" for c in self.calls))

    def test_runtime_problems_stop_before_launch(self):
        s = self.sessions()
        with self.assertRaisesRegex(ss.SessionError, "RUNTIME_SOURCE_MISSING"):
            s.open("p1", runtime_source=Path(self.tmp.name) / "nope")
        (self.root / "profiles/p2/runtime").mkdir(parents=True)
        with self.assertRaisesRegex(ss.SessionError, "RUNTIME_INCOMPLETE"):
            s.open("p2", runtime_source=self.source)
        (self.root / "profiles/p3/.runtime.partial").mkdir(parents=True)
        with self.assertRaisesRegex(ss.SessionError, "RUNTIME_STAGING_EXISTS"):
            s.open("p3", runtime_source=self.source)
        self.assertTrue((self.root / "profiles/p3/.runtime.partial").is_dir(), "leftover staging is not removed")
        self.assertFalse(any(c[0] == "/usr/bin/open" for c in self.calls))

    def test_disk_reserve_is_checked_before_any_directory_is_made(self):
        mac = self.sessions(disk_free=lambda p: 19 * 10**9)
        with self.assertRaisesRegex(ss.SessionError, "DISK_RESERVE"):
            mac.open("p1", runtime_source=self.source)
        self.assertFalse((self.root / "profiles/p1").exists())
        win = self.sessions(platform="win32", disk_free=lambda p: 2 * 10**9 + 1)  # 不够 2 GB + 运行时大小
        with self.assertRaisesRegex(ss.SessionError, "DISK_RESERVE"):
            win.open("w1", runtime_source=self.source)

    def test_invalid_names_are_refused(self):
        s = self.sessions()
        for bad in ("", "-x", "a b", "../up", "x" * 41, "中文"):
            with self.assertRaisesRegex(ss.SessionError, "INVALID_SESSION_NAME"):
                s.open(bad, launch=False)


class LaunchTests(Base):
    def test_mac_launch_passes_the_session_environment_once(self):
        s = self.sessions()
        r = s.open("p1", runtime_source=self.source)
        p = self.root / "profiles/p1"
        opens = [c for c in self.calls if c[0] == "/usr/bin/open"]
        self.assertEqual(len(opens), 1)
        argv = opens[0]
        self.assertEqual(argv[:3], ["/usr/bin/open", "-n", "-a"])
        self.assertEqual(Path(argv[3]).name, "Visual Studio Code.app")
        env = {argv[i + 1].split("=", 1)[0]: argv[i + 1].split("=", 1)[1] for i, a in enumerate(argv) if a == "--env"}
        self.assertEqual(env["STATA_WORKBENCH_NEXT_SESSION"], "p1")
        self.assertEqual(env["MCP_STATA_CONFIG_PATH"], str(p / "mcp.json"))
        self.assertEqual(env["STATA_WORKBENCH_NEXT_PROFILE"], str(p))
        self.assertEqual(env["TMPDIR"], str(p / "tmp"))
        tail = argv[argv.index("--args") + 1:]
        self.assertEqual(tail[:5], ["--user-data-dir", str(p / "user-data"), "--extensions-dir", str(p / "extensions"), "--new-window"])
        self.assertNotIn("--remote-debugging-port", " ".join(argv))
        self.assertEqual((r["verdict"], r["launchCount"]), ("LAUNCHED", 1))
        self.assertIn("--session p1", r["next"])

    def test_windows_launch_is_detached_with_inherited_environment_and_a_full_copy(self):
        popen = Mock()
        s = self.sessions(platform="win32", popen=popen)
        r = s.open("w1", runtime_source=self.source)
        p = self.root / "profiles/w1"
        self.assertEqual(r["runtime"]["method"], "copy")
        self.assertTrue((p / "runtime/Scripts/python.exe").is_file())
        cfg = json.loads((p / "mcp.json").read_text())["servers"]["mcp_stata"]
        self.assertEqual(cfg["command"], str(p / "runtime/Scripts/python.exe"))
        self.assertEqual((cfg["env"]["TEMP"], cfg["env"]["TMP"]), (str(p / "tmp"), str(p / "tmp")))
        popen.assert_called_once()
        argv, kw = popen.call_args.args[0], popen.call_args.kwargs
        self.assertTrue(argv[0].endswith("Code.exe"))
        self.assertEqual(argv[1:6], ["--user-data-dir", str(p / "user-data"), "--extensions-dir", str(p / "extensions"), "--new-window"])
        self.assertEqual(kw["env"]["STATA_WORKBENCH_NEXT_SESSION"], "w1")
        self.assertEqual(kw["env"]["SystemRoot"], "C:\\Windows")
        self.assertEqual((kw["env"]["TEMP"], kw["env"]["TMP"]), (str(p / "tmp"), str(p / "tmp")))
        self.assertTrue(kw["creationflags"] & 0x8 and kw["creationflags"] & 0x200)
        self.assertFalse(any(c[:2] == ["/bin/cp", "-c"] for c in self.calls), "no APFS clone on Windows")

    def test_workspace_trust_is_opt_in_on_both_platforms(self):
        s = self.sessions()
        s.open("trusted", runtime_source=self.source, disable_workspace_trust=True)
        mac_argv = next(c for c in self.calls if c[:3] == ["/usr/bin/open", "-n", "-a"])
        self.assertEqual(mac_argv[-1], "--disable-workspace-trust")
        plain = self.sessions()
        plain_calls = []
        plain.run = lambda argv: (plain_calls.append(list(argv)), self.run_cmd(argv))[1]
        plain.open("prompt", runtime_source=self.source)
        plain_argv = next(c for c in plain_calls if c[:3] == ["/usr/bin/open", "-n", "-a"])
        self.assertNotIn("--disable-workspace-trust", plain_argv)
        win = self.sessions(platform="win32", popen=Mock())
        win.open("w-trusted", runtime_source=self.source, disable_workspace_trust=True)
        self.assertEqual(win.popen.call_args.args[0][-1], "--disable-workspace-trust")


class ListCloseTests(Base):
    def test_list_shows_profiles_and_sessions_without_tokens(self):
        s = self.sessions()
        s.open("p1", runtime_source=self.source, launch=False)
        write_record(self.root, "sA", 17601, "p1")
        write_record(self.root, "sB", 17605, "stray")
        self.running["p1"] = [77]
        out = s.list()
        self.assertNotIn("t" * 43, json.dumps(out))
        row = out["profiles"][0]
        self.assertEqual((row["name"], row["port"], row["vscodePids"], row["runtime"]), ("p1", 17601, [77], "apfs-clone"))
        self.assertEqual([x["sessionId"] for x in row["sessions"]], ["sA"])
        self.assertEqual([x["sessionId"] for x in out["otherLiveSessions"]], ["sB"])
        self.assertEqual((out["active"], out["max"]), (2, 5))

    def test_close_asks_only_this_profile_to_quit_and_waits(self):
        s = self.sessions()
        s.open("p1", runtime_source=self.source, launch=False)
        s.open("p2", runtime_source=self.source, launch=False)
        self.running.update(p1=[501], p2=[502])
        killed = []
        s.kill = lambda pid: (killed.append(pid), self.running.pop("p1"))
        r = s.close("p1")
        self.assertEqual((r["verdict"], r["signalled"], killed), ("CLOSED", [501], [501]))
        self.assertEqual(self.running, {"p2": [502]}, "the other session is untouched")
        self.assertEqual(s.close("p1")["verdict"], "NOT_RUNNING")
        with self.assertRaisesRegex(ss.SessionError, "SESSION_UNKNOWN"):
            s.close("never")

    def test_close_reports_processes_still_holding_the_session_and_signals_nothing_else(self):
        # V3-W2：force reset 后旧 Stata worker 被 launchd 收养，关窗后仍占着本会话目录；close 要如实报告
        seen = []
        s = self.sessions(leftovers=lambda dirs: (seen.append([str(d) for d in dirs]),
                                                  [{"pid": 25045, "command": "python3.11"}])[1])
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [501]
        killed = []
        s.kill = lambda pid: (killed.append(pid), self.running.pop("p1"))
        r = s.close("p1")
        self.assertEqual((r["verdict"], killed), ("CLOSED", [501]), "only the VS Code instance is signalled")
        self.assertEqual(r["leftoverProcesses"], [{"pid": 25045, "command": "python3.11"}])
        self.assertIn("nothing was signalled", r["note"])
        self.assertEqual(seen, [[str(self.root / "ws" / "p1"), str(self.root / "profiles" / "p1" / "mcp-temp")]])

    def test_close_leftover_check_failure_keeps_the_verdict(self):
        def boom(dirs):
            raise RuntimeError("lsof missing")
        s = self.sessions(leftovers=boom)
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [501]
        s.kill = lambda pid: self.running.pop("p1")
        r = s.close("p1")
        self.assertEqual((r["verdict"], r["leftoverProcesses"]), ("CLOSED", None))
        self.assertNotIn("note", r)

    def test_close_clean_reports_an_empty_leftover_list(self):
        s = self.sessions()
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [501]
        s.kill = lambda pid: self.running.pop("p1")
        r = s.close("p1")
        self.assertEqual((r["verdict"], r["leftoverProcesses"]), ("CLOSED", []))
        self.assertNotIn("note", r)

    def test_real_leftover_check_is_unix_only(self):
        self.assertIsNone(ss.Sessions(root=self.root, platform="win32", code="C:/VSCode/Code.exe")._real_leftovers([self.root]))

    def test_close_that_does_not_finish_is_reported_not_forced(self):
        clock = iter(range(0, 1000, 5))
        s = self.sessions(clock=lambda: next(clock))
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [601]
        kill = Mock()
        s.kill = kill
        r = s.close("p1", wait=20)
        self.assertEqual(r["verdict"], "CLOSE_PENDING")
        kill.assert_called_once_with(601)

    def test_close_removes_only_dead_records_for_this_session(self):
        s = self.sessions(alive=lambda pid: pid != 701)
        s.open("p1", runtime_source=self.source, launch=False)
        s.open("p2", runtime_source=self.source, launch=False)
        write_record(self.root, "dead-p1", 17610, "p1", pid=701)
        write_record(self.root, "live-p1", 17611, "p1", pid=702)
        write_record(self.root, "dead-p2", 17612, "p2", pid=701)
        removed = s.close("p1")["removedRegistryFiles"]
        self.assertEqual([Path(p).name for p in removed], ["dead-p1.json"])
        self.assertTrue((self.root / "sessions/live-p1.json").exists())
        self.assertTrue((self.root / "sessions/dead-p2.json").exists())

    def test_close_removes_tmp_files_whose_writer_is_dead_on_every_close_path(self):
        d = self.root / "sessions"
        publish = json.dumps({"schema": entry.SESSION_SCHEMA, "sessionId": "s20261101T022743Z-5cf656f6", "port": 17601,
                              "token": "t" * 43, "extensionHostPid": 18392})  # publish() 的形状：没有 sessionName
        files = {
            "publish": (".s20261101T022743Z-5cf656f6.18392.407142d0.tmp", publish),
            "update": (".s20261101T022744Z-aaaaaaaa.18392.0000ffff.tmp", json.dumps({"sessionName": "p1"})),
            "empty": (".s20261101T022745Z-bbbbbbbb.18392.11112222.tmp", ""),
            "torn": (".s20261101T022747Z-dddddddd.18392.55556666.tmp", '{"sessionName": "p1"'),
            "other_session": (".s20261101T022749Z-ffffffff.4001.9999aaaa.tmp", json.dumps({"sessionName": "p2"})),
            "live": (".s20261101T022746Z-cccccccc.702.33334444.tmp", publish),
            "unknown": (".s20261101T022748Z-eeeeeeee.703.77778888.tmp", publish),
            "other_tmp": (".settings.json.18392.tmp", ""),
        }
        dead = {"publish", "update", "empty", "torn", "other_session"}  # 不分会话：关 p1 也删 p2 的死写入者 tmp
        alive = lambda pid: {18392: False, 4001: False, 702: True, 703: None}.get(pid, True)

        def seed():
            d.mkdir(parents=True, exist_ok=True)
            for fname, text in files.values():
                (d / fname).write_text(text, encoding="utf-8")

        def check(result):
            self.assertEqual(sorted(Path(p).name for p in result["removedTmpFiles"]), sorted(files[k][0] for k in dead))
            for key in set(files) - dead:
                self.assertTrue((d / files[key][0]).exists(), key)

        s = self.sessions(alive=alive)
        s.open("p1", runtime_source=self.source, launch=False)
        seed()
        check(s.close("p1"))                     # NOT_RUNNING
        seed()
        clock = iter(range(0, 1000, 5))
        pending = self.sessions(alive=alive, clock=lambda: next(clock))
        self.running["p1"] = [601]
        pending.kill = Mock()
        r = pending.close("p1", wait=20)         # CLOSE_PENDING：F-win 收尾时 w1、w2 实际走的路径
        self.assertEqual(r["verdict"], "CLOSE_PENDING")
        check(r)

    def test_real_kill_is_a_normal_quit(self):
        with patch.object(ss.os, "kill") as k:
            self.sessions()._real_kill(321)
        k.assert_called_once_with(321, ss.signal.SIGTERM)
        with patch.object(ss.subprocess, "run") as run:
            self.sessions(platform="win32")._real_kill(321)
        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "321"])
        self.assertNotIn("/F", run.call_args.args[0])

    def test_cli_list_and_blocked_exit(self):
        s = self.sessions()
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(ss.main(["list"], sessions=s), 0)
        self.assertEqual(json.loads(out.getvalue())["max"], 5)
        s.open("p1", runtime_source=self.source, launch=False)
        self.running["p1"] = [9]
        s.kill = Mock()
        clock = iter(range(0, 1000, 30))
        s.clock = lambda: next(clock)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(ss.main(["close", "p1", "--wait", "1"], sessions=s), 2)


class HelperTests(unittest.TestCase):
    def test_port_free_probes_only_loopback(self):
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen(1)
            port = busy.getsockname()[1]
            self.assertFalse(ss.port_free(port))
        self.assertTrue(ss.port_free(port))

    def test_default_runtime_source(self):
        self.assertEqual(ss.default_runtime_source("darwin", {}), Path.home() / ".local/share/stata-workbench/mcp-stata-1.26.1")
        self.assertEqual(ss.default_runtime_source("win32", {"LOCALAPPDATA": "C:/L"}), Path("C:/L/stata-workbench/mcp-stata-1.26.1"))
        self.assertEqual(ss.default_runtime_source("darwin", {"STATA_WORKBENCH_RUNTIME_SOURCE": "/r"}), Path("/r"))


if __name__ == "__main__":
    unittest.main()
