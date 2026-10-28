"""The operator kit uses actual ZIP identities, files and argv; no licensed Stata."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "examples/platform-acceptance/acceptance.py"
spec = importlib.util.spec_from_file_location("acceptance_kit", SCRIPT)
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class OperatorKitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.packages = tempfile.TemporaryDirectory(prefix="acceptance-package-")
        cls.vsix = Path(cls.packages.name) / "candidate.vsix"
        manifest = json.loads((REPO / "release/runtime-manifest.json").read_bytes())
        with zipfile.ZipFile(cls.vsix, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative in sorted(set(manifest["files"]) | {"package.json"}):
                archive.write(REPO / relative, "extension/" + relative)

    @classmethod
    def tearDownClass(cls):
        cls.packages.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="验收 O'Brien ")
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root = self.parent / "private installation"

    def configured(self):
        with patch.object(kit.subprocess, "run", side_effect=AssertionError("configure-only launched a process")):
            result = kit.prepare(self.root, self.vsix, sys.executable, sys.executable,
                                 port=free_port(), configure_only=True, reserve_bytes=0)
        self.assertEqual(result["phase"], "CONFIGURED_NOT_INSTALLED")
        return kit.load_state(self.root)

    def test_configuration_keeps_exact_private_paths_and_does_not_execute(self):
        state = self.configured()
        self.assertEqual(state["nativeAcceptance"], "NOT_RUN")
        settings = json.loads((self.root / "profile/user-data/User/settings.json").read_bytes())
        config = json.loads((self.root / "profile/mcp.json").read_bytes())["servers"]["mcp_stata"]
        self.assertEqual(config["args"], ["-m", "mcp_stata"])
        self.assertEqual(config["command"], str(self.root / "profile/runtime/Scripts/python.exe"))
        self.assertFalse(settings["stataMcp.autoConfigureMcp"])
        self.assertFalse(settings["stataMcp.loadStataOnStartup"])
        self.assertEqual(settings["stataMcp.runFileWorkingDirectory"], "${fileDir}")
        self.assertEqual(len(state["fixtures"]), 7)
        for name, expected in state["fixtures"].items():
            self.assertEqual(kit.digest(Path(state["work"]) / name), expected)
        self.assertTrue(all(str(self.root) in value for key, value in config["env"].items()
                            if key not in ("PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE")))

    def test_existing_root_preserves_every_original_byte(self):
        self.root.mkdir()
        sentinel = self.root / "operator-work.txt"
        sentinel.write_bytes(b"keep original user work")
        with self.assertRaises(FileExistsError):
            kit.prepare(self.root, self.vsix, sys.executable, sys.executable, configure_only=True)
        self.assertEqual(sentinel.read_bytes(), b"keep original user work")
        self.assertEqual(list(self.root.iterdir()), [sentinel])

    def test_parent_alias_resolves_to_one_persisted_environment(self):
        link = self.parent / "aliased parent"
        target = self.parent / "real parent"
        target.mkdir()
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)
        result = kit.prepare(link / "root", self.vsix, sys.executable, sys.executable,
                             port=free_port(), configure_only=True, reserve_bytes=0)
        state = kit.load_state(link / "root")
        self.assertEqual(result["root"], str(target / "root"))
        self.assertEqual(state["environment"]["STATA_WORKBENCH_PROFILE"], str(target / "root/profile"))

    def test_busy_port_refuses_before_creating_root(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with self.assertRaises(OSError):
                kit.prepare(self.root, self.vsix, sys.executable, sys.executable,
                            port=listener.getsockname()[1], configure_only=True, reserve_bytes=0)
        self.assertFalse(self.root.exists())

    def test_wrong_runtime_version_refuses_before_installation(self):
        bad = self.parent / "wrong.vsix"
        with zipfile.ZipFile(self.vsix) as original, zipfile.ZipFile(bad, "w") as archive:
            for entry in original.infolist():
                raw = original.read(entry)
                if entry.filename == "extension/package.json":
                    value = json.loads(raw)
                    value["version"] = "0.0.0-wrong"
                    raw = json.dumps(value).encode()
                archive.writestr(entry.filename, raw)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            kit.prepare(self.root, bad, sys.executable, sys.executable,
                        port=free_port(), configure_only=True, reserve_bytes=0)
        self.assertFalse(self.root.exists())

    def test_low_actual_free_space_refuses_before_writes(self):
        # 4.34 GB 是 2026-10-28 实测的 Windows C: 可用空间，低于默认 5 GB + 500 MB。
        with patch.object(kit.shutil, "disk_usage") as usage:
            usage.return_value.free = 4_340_000_000
            with self.assertRaisesRegex(RuntimeError, "measured free space: 4340000000 bytes free, 5500000000 required"):
                kit.prepare(self.root, self.vsix, sys.executable, sys.executable,
                            port=free_port(), configure_only=True)
        self.assertFalse(self.root.exists())

    def test_free_space_exactly_at_reserve_plus_budget_is_accepted(self):
        with patch.object(kit.shutil, "disk_usage") as usage:
            usage.return_value.free = kit.DEFAULT_RESERVE_BYTES + kit.SETUP_BUDGET_BYTES
            with patch.object(kit.subprocess, "run", side_effect=AssertionError("configure-only launched a process")):
                result = kit.prepare(self.root, self.vsix, sys.executable, sys.executable,
                                     port=free_port(), configure_only=True)
        self.assertEqual(result["phase"], "CONFIGURED_NOT_INSTALLED")
        self.assertEqual(kit.load_state(self.root)["reserveBytes"], kit.DEFAULT_RESERVE_BYTES)

    def test_negative_reserve_is_refused_before_writes(self):
        with self.assertRaisesRegex(ValueError, "cannot be negative"):
            kit.prepare(self.root, self.vsix, sys.executable, sys.executable,
                        port=free_port(), configure_only=True, reserve_bytes=-1)
        self.assertFalse(self.root.exists())

    def test_reserve_bytes_option_defaults_and_overrides(self):
        base = ["prepare", "--root", "r", "--vsix", "v", "--stata", "s", "--code", "c"]
        parser = kit.build_parser()
        self.assertEqual(parser.parse_args(base).reserve_bytes, 5_000_000_000)
        self.assertEqual(parser.parse_args(base + ["--reserve-bytes", "2000000000"]).reserve_bytes, 2_000_000_000)

    def test_changed_environment_is_not_rebound_silently(self):
        self.configured()
        path = self.root / "acceptance.json"
        state = json.loads(path.read_bytes())
        state["environment"]["STATA_WORKBENCH_PROFILE"] = "another profile"
        path.write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError, "environment"):
            kit.load_state(self.root)

    def test_subprocess_failure_has_original_intent_and_no_retry(self):
        state = self.configured()
        observed = []

        def fail(argv, **kwargs):
            intents = list((self.root / "evidence").glob("probe-*.intent.json"))
            self.assertEqual(len(intents), 1)
            self.assertEqual(json.loads(intents[0].read_bytes())["argv"], argv)
            self.assertEqual(kwargs["cwd"], state["work"])
            self.assertEqual(kwargs["env"]["STATA_WORKBENCH_PROFILE"], str(self.root / "profile"))
            observed.append(argv)
            return subprocess.CompletedProcess(argv, 9)

        argv = [sys.executable, "--example-path", str(Path(state["work"]) / "a file.do")]
        with patch.object(kit.subprocess, "run", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "do not retry"):
                kit.run_logged(state, "probe", argv)
        self.assertEqual(observed, [argv])
        result = next((self.root / "evidence").glob("probe-*.result.json"))
        self.assertEqual(json.loads(result.read_bytes())["exitCode"], 9)

    def test_changed_fixture_and_existing_receipt_prevent_dispatch(self):
        state = self.configured()
        source = Path(state["work"]) / "02_agent_shared.do"
        source.write_text("display 999\n")
        with patch.object(kit, "run_logged") as run:
            with self.assertRaisesRegex(ValueError, "Fixture changed"):
                kit.run_agent(state, source.name)
            run.assert_not_called()
        receipt = self.root / "evidence/run-04_queue_first"
        receipt.mkdir()
        with patch.object(kit, "run_logged") as run:
            with self.assertRaisesRegex(FileExistsError, "reconcile"):
                kit.run_agent(state, "04_queue_first.do")
            run.assert_not_called()

    def test_failed_dispatch_cannot_be_replayed_without_a_client_receipt(self):
        state = self.configured()
        with patch.object(kit, "run_logged", side_effect=OSError("client launch failed")) as run:
            with self.assertRaisesRegex(OSError, "client launch failed"):
                kit.run_agent(state, "02_agent_shared.do")
            with self.assertRaises(FileExistsError):
                kit.run_agent(state, "02_agent_shared.do")
        self.assertEqual(run.call_count, 1)

    def test_install_uses_official_code_cli_without_shell_or_node_mode_leak(self):
        code = self.parent / "VS Code" / "Code.exe"
        code.parent.mkdir()
        code.write_bytes(b"test executable placeholder")
        cli = code.parent / "resources/app/out/cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_bytes(b"test CLI placeholder")
        with patch.object(kit.shutil, "which", return_value="uv.exe"), patch.object(kit, "run_logged") as run:
            kit.prepare(self.root, self.vsix, sys.executable, code, port=free_port(), reserve_bytes=0)
        install = next(c for c in run.call_args_list if c.args[1] == "vsix-install")
        self.assertEqual(install.args[2][:2], [str(code), str(cli)])
        self.assertEqual(install.kwargs["extra_env"], {"ELECTRON_RUN_AS_NODE": "1", "VSCODE_DEV": ""})
        self.assertNotIn("ELECTRON_RUN_AS_NODE", kit.load_state(self.root)["environment"])

    def test_code_cli_follows_versioned_folder_named_by_launcher(self):
        # VS Code 1.121 on the Windows test machine: resources live in a commit folder
        # (f6cfa2ea24) named by bin\code.cmd, not beside Code.exe.
        code = self.parent / "VS Code" / "Code.exe"
        (code.parent / "bin").mkdir(parents=True)
        code.write_bytes(b"test executable placeholder")
        for folder in ("0ld0000000", "f6cfa2ea24"):
            cli = code.parent / folder / "resources/app/out/cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_bytes(b"test CLI placeholder")
        # 两个版本目录并存且没有 launcher：拒绝猜测
        self.assertIsNone(kit.code_cli_path(code))
        (code.parent / "bin/code.cmd").write_text(
            '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n'
            '"%~dp0..\\Code.exe" "%~dp0..\\f6cfa2ea24\\resources\\app\\out\\cli.js" %*\r\n')
        self.assertEqual(kit.code_cli_path(code), code.parent / "f6cfa2ea24/resources/app/out/cli.js")
        with patch.object(kit.shutil, "which", return_value="uv.exe"), patch.object(kit, "run_logged") as run:
            kit.prepare(self.root, self.vsix, sys.executable, code, port=free_port(), reserve_bytes=0)
        install = next(c for c in run.call_args_list if c.args[1] == "vsix-install")
        self.assertEqual(install.args[2][:2], [str(code), str(code.parent / "f6cfa2ea24/resources/app/out/cli.js")])

    def test_open_no_activate_is_forwarded_and_default_still_activates(self):
        state = {"work": "C:\\run\\workspace"}
        self.assertNotIn("--no-activate", kit.open_argv(state))
        self.assertEqual(kit.open_argv(state, True)[-1], "--no-activate")
        args = kit.build_parser().parse_args(["open", "--root", "C:\\run", "--no-activate"])
        self.assertTrue(args.no_activate)
        self.assertFalse(kit.build_parser().parse_args(["open", "--root", "C:\\run"]).no_activate)

    def test_missing_code_cli_is_refused_before_root_is_created(self):
        code = self.parent / "VS Code" / "Code.exe"
        code.parent.mkdir()
        code.write_bytes(b"test executable placeholder")
        with patch.object(kit.shutil, "which", return_value="uv.exe"):
            with self.assertRaisesRegex(FileNotFoundError, "VS Code CLI missing"):
                kit.prepare(self.root, self.vsix, sys.executable, code, port=free_port(), reserve_bytes=0)
        self.assertFalse(self.root.exists())

    def test_collector_does_not_follow_external_links_or_invent_acceptance(self):
        state = self.configured()
        outside = self.parent / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("outside acceptance scope")
        link = self.root / "evidence/external"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
        with patch.object(kit, "run_logged", return_value="doctor-observation-only"):
            result = kit.collect(state)
        report = json.loads(Path(result["report"]).read_bytes())
        self.assertEqual(report["nativeAcceptance"], "NOT_INFERRED")
        self.assertFalse(any("external/" in path or "external\\" in path for path in report["files"]))
        self.assertTrue(any(item["path"].endswith("external") for item in report["skipped"]))
        with zipfile.ZipFile(result["archive"]) as archive:
            self.assertFalse(any("external/" in name for name in archive.namelist()))
            for name, identity in report["files"].items():
                raw = archive.read(name)
                self.assertEqual(len(raw), identity["bytes"])
                self.assertEqual(kit.hashlib.sha256(raw).hexdigest(), identity["sha256"])

    @unittest.skipUnless(sys.platform == "win32", "Actual Windows CLI path/argv case")
    def test_windows_cli_configures_unicode_apostrophe_path(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "prepare", "--root", str(self.root),
            "--vsix", str(self.vsix), "--stata", sys.executable, "--code", sys.executable,
            "--port", str(free_port()), "--configure-only"], capture_output=True, text=True, encoding="utf-8", check=True)
        self.assertEqual(json.loads(result.stdout)["root"], str(self.root))
        self.assertEqual(kit.load_state(self.root)["nativeAcceptance"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
