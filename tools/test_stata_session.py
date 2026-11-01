"""Next 阶段 D：tools/stata_session.py。所有启动、进程、信号、端口、磁盘都用替身，不开 VS Code。"""
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
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
        self.tmp.cleanup()

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
                    environ={"SystemRoot": "C:\\Windows"})
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
        self.assertIs(settings["stataMcp.loadStataOnStartup"], False)
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
        (u / "settings.json").write_text(json.dumps({"editor.fontSize": 15, "stataMcp.loadStataOnStartup": True}))
        s.open("p1", runtime_source=self.source, launch=False)
        merged = json.loads((u / "settings.json").read_text())
        self.assertEqual((merged["editor.fontSize"], merged["stataMcp.loadStataOnStartup"]), (15, True))
        (u / "settings.json").write_text('{\n  // comment\n  "a": 1\n}')
        with self.assertRaisesRegex(ss.SessionError, "SETTINGS_NOT_PLAIN_JSON"):
            s.open("p1", runtime_source=self.source, launch=False)
        self.assertIn("// comment", (u / "settings.json").read_text())

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
