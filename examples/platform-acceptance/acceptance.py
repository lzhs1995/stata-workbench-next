"""Prepare an isolated Windows acceptance install and collect its local evidence.

This is an operator tool, not the extension runtime or a native acceptance verdict.
It delegates execution to the existing single-POST client and never retries a run.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import uuid
import zipfile

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "tools"))
from verify_release import verify  # noqa: E402

SCHEMA = "windows-workbench-acceptance/1"
AGENT_FILES = ("02_agent_shared.do", "04_queue_first.do", "05_queue_second.do", "07_cleanup.do")
# Free space kept for the Windows test machine itself (updates, temp files),
# on top of the setup budget. Operators can override it with --reserve-bytes.
DEFAULT_RESERVE_BYTES = 5_000_000_000
SETUP_BUDGET_BYTES = 500_000_000


def stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return {"bytes": Path(path).stat().st_size, "sha256": h.hexdigest()}


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def environment(root, port, code):
    profile = root / "profile"
    return {
        "STATA_WORKBENCH_PROFILE": str(profile), "STATA_WORKBENCH_PORT": str(port),
        "STATA_WORKBENCH_CODE": str(code), "STATA_WORKBENCH_PYTHON": sys.executable,
        "MCP_STATA_CONFIG_PATH": str(profile / "mcp.json"),
        "MCP_STATA_RUNTIME_ROOT": str(profile / "runtime"),
        "MCP_STATA_TEMP": str(profile / "mcp-temp"),
        "UV_CACHE_DIR": str(profile / "uv-cache"), "UV_TOOL_DIR": str(profile / "uv-tools"),
        "TMP": str(profile / "tmp"), "TEMP": str(profile / "tmp"),
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
    }


def prepare(root, vsix, stata, code, *, port=17497, configure_only=False,
            reserve_bytes=DEFAULT_RESERVE_BYTES):
    # All preflight checks precede creating the new root or launching a process.
    root = Path(root).absolute()
    if os.path.lexists(root):
        raise FileExistsError("Acceptance root already exists; preserve it and its original receipts")
    # Store the same canonical path that later commands use (including /var on
    # macOS and an existing parent junction on Windows).
    root = root.resolve()
    paths = {name: Path(value).resolve(strict=True)
             for name, value in {"vsix": vsix, "stata": stata, "code": code}.items()}
    if not all(p.is_file() for p in paths.values()):
        raise ValueError("VSIX, Stata and Code must be files")
    if not 1024 <= port <= 65535:
        raise ValueError("Use a private port between 1024 and 65535")
    if reserve_bytes < 0:
        raise ValueError("The disk reserve cannot be negative")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))  # Availability observation, not a permanent reservation.
    ancestor = root.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    available = shutil.disk_usage(ancestor).free
    required = reserve_bytes + SETUP_BUDGET_BYTES
    if available < required:
        raise RuntimeError(f"Insufficient measured free space: {available} bytes free, {required} required "
                           f"({reserve_bytes} reserve + {SETUP_BUDGET_BYTES} setup budget)")
    source_check = verify()
    if source_check["verdict"] != "PASS":
        raise ValueError("Source runtime identity mismatch: " + str(source_check["failedChecks"]))
    check = verify(paths["vsix"])
    if check["verdict"] != "PASS":
        raise ValueError("Source/VSIX runtime identity mismatch: " + str(check["failedChecks"]))
    uv = shutil.which("uv")
    if not configure_only and not uv:
        raise FileNotFoundError("Install uv before preparing the private Stata service")
    code_cli = paths["code"].parent / "resources" / "app" / "out" / "cli.js"
    if not configure_only and not code_cli.is_file():
        raise FileNotFoundError("VS Code CLI missing beside the selected Code.exe: " + str(code_cli))
    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir()  # Atomic refusal if another process created the same root.
    profile = root / "profile"
    work = root / "workspace" / "平台 测试 O'Brien"
    evidence = root / "evidence"
    for directory in (work, evidence, profile / "user-data" / "User", profile / "extensions",
                      profile / "mcp-temp", profile / "tmp"):
        directory.mkdir(parents=True)
    overrides = environment(root, port, paths["code"])
    runtime_python = profile / "runtime" / "Scripts" / "python.exe"
    service_env = {k: v for k, v in overrides.items() if not k.startswith("STATA_WORKBENCH_")}
    write_json(profile / "mcp.json", {"servers": {"mcp_stata": {
        "type": "stdio", "command": str(runtime_python), "args": ["-m", "mcp_stata"], "env": service_env,
    }}})
    write_json(profile / "user-data" / "User" / "settings.json", {
        "stataMcp.visibleBridgePort": port, "stataMcp.stataPath": str(paths["stata"]),
        "stataMcp.autoConfigureMcp": False, "stataMcp.configureClaudeCode": False,
        "stataMcp.configureCodex": False, "stataMcp.loadStataOnStartup": False,
        "stataMcp.showAllLogsInOutput": True, "stataMcp.runFileWorkingDirectory": "${fileDir}",
        "extensions.autoUpdate": False, "extensions.autoCheckUpdates": False,
        "update.mode": "none", "telemetry.telemetryLevel": "off",
    })
    fixtures = {}
    for fixture in sorted(FIXTURES.glob("[0-9][0-9]_*.do")):
        shutil.copy2(fixture, work / fixture.name)
        fixtures[fixture.name] = digest(fixture)
    state = {"schema": SCHEMA, "root": str(root), "repo": str(REPO), "work": str(work),
             "port": port, "code": str(paths["code"]), "stata": str(paths["stata"]),
             "toolsPython": sys.executable, "environment": overrides, "fixtures": fixtures,
             "vsix": {"path": str(paths["vsix"]), **digest(paths["vsix"])},
             "operatorTool": digest(__file__),
             "runtimeManifest": digest(REPO / "release/runtime-manifest.json"),
             "sourceCheck": source_check, "sourceVsixCheck": check, "freeBytesBefore": available,
             "reserveBytes": reserve_bytes, "nativeAcceptance": "NOT_RUN"}
    write_json(root / "acceptance.json", state)
    result = {"phase": "CONFIGURED_NOT_INSTALLED", "nativeAcceptance": "NOT_RUN"}
    if not configure_only:
        try:
            run_logged(state, "venv", [uv, "venv", "--python", "3.11", str(profile / "runtime")])
            run_logged(state, "service-install", [uv, "pip", "install", "--python",
                       str(runtime_python), "mcp-stata==1.26.1"])
            run_logged(state, "service-packages", [uv, "pip", "freeze", "--python", str(runtime_python)])
            # Same invocation as VS Code's official bin/code.cmd, without cmd.exe
            # quoting/interpolation. Scope Electron's node mode to this call only.
            run_logged(state, "vsix-install", [str(paths["code"]), str(code_cli), "--user-data-dir",
                       str(profile / "user-data"), "--extensions-dir", str(profile / "extensions"),
                       "--install-extension", str(paths["vsix"]), "--force"],
                       extra_env={"ELECTRON_RUN_AS_NODE": "1", "VSCODE_DEV": ""})
            result["phase"] = "INSTALL_COMMANDS_SUCCEEDED_NOT_LOADED"
        except Exception as exc:
            result.update(phase="SETUP_FAILED_NO_RETRY", error=repr(exc))
            write_json(evidence / "setup-result.json", result)
            raise
    write_json(evidence / "setup-result.json", result)
    return {**result, "root": str(root), "work": str(work)}


def load_state(root):
    root = Path(root).resolve(strict=True)
    state = json.loads((root / "acceptance.json").read_text(encoding="utf-8"))
    if state.get("schema") != SCHEMA or Path(state["root"]).resolve() != root:
        raise ValueError("Acceptance root binding differs")
    if Path(state["repo"]).resolve() != REPO or state["runtimeManifest"] != digest(REPO / "release/runtime-manifest.json"):
        raise ValueError("Source runtime changed; preserve the original kit and receipts")
    if state.get("operatorTool") != digest(__file__):
        raise ValueError("Operator tool changed; retain the original accepted setup recipe")
    if verify()["verdict"] != "PASS":
        raise ValueError("Source runtime changed; preserve the original kit and receipts")
    expected = environment(root, state["port"], state["code"])
    if state.get("environment") != expected or state.get("toolsPython") != sys.executable:
        raise ValueError("Private environment or tool interpreter binding differs")
    if Path(state["work"]).resolve() != (root / "workspace" / "平台 测试 O'Brien").resolve():
        raise ValueError("Fixture workspace binding differs")
    return state


def run_logged(state, label, argv, *, extra_env=None):
    evidence = Path(state["root"]) / "evidence"
    prefix = evidence / (label + "-" + stamp())
    write_json(prefix.with_suffix(".intent.json"), {"argv": argv, "environmentOverrides": extra_env or {},
               "startedAt": stamp(), "automaticRetries": 0})
    try:
        with prefix.with_suffix(".log").open("xb") as log:
            result = subprocess.run(argv, cwd=state["work"],
                                    env={**os.environ, **state["environment"], **(extra_env or {})},
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    except BaseException as exc:
        write_json(prefix.with_suffix(".result.json"), {"exitCode": None, "error": repr(exc),
                   "automaticRetries": 0, "executionOutcome": "UNKNOWN"})
        raise
    write_json(prefix.with_suffix(".result.json"), {"exitCode": result.returncode, "automaticRetries": 0})
    if result.returncode:
        raise RuntimeError("Command failed; retain the original log and do not retry execution: " + str(prefix))
    return str(prefix.with_suffix(".log"))


def run_agent(state, fixture):
    if fixture not in AGENT_FILES:
        raise ValueError("This fixture needs the editor/Stop route; follow the operator runbook")
    source = Path(state["work"]) / fixture
    if source.is_symlink() or digest(source) != state["fixtures"][fixture]:
        raise ValueError("Fixture changed; review a new execution version before dispatch")
    # A fixed receipt directory prevents accidentally repeating the same fixture.
    receipt = Path(state["root"]) / "evidence" / ("run-" + source.stem)
    if receipt.exists():
        raise FileExistsError("Original fixture receipt already exists; reconcile it, do not resubmit")
    # Exclusive creation covers concurrent invocations and failures before the
    # shared client creates its receipt directory. Never turn uncertainty into a retry.
    write_json(Path(state["root"]) / "evidence" / ("dispatch-" + source.stem + ".json"),
               {"source": str(source), "identity": digest(source), "receipt": str(receipt), "startedAt": stamp()})
    return run_logged(state, source.stem, [sys.executable, "-B", str(REPO / "tools/shared_stata.py"),
                      "--file", str(source), "--cwd", state["work"], "--receipt-dir", str(receipt),
                      "--busy-policy", "wait", "--max-wait", "60"])


def collect(state):
    root = Path(state["root"])
    report = {"schema": SCHEMA, "collectedAt": stamp(), "nativeAcceptance": "NOT_INFERRED",
              "root": str(root), "files": {}, "skipped": [], "doctor": None}
    try:
        report["doctor"] = run_logged(state, "doctor", [sys.executable, "-B", str(REPO / "tools/verified_workbench.py"), "--doctor"])
    except Exception as exc:
        report["doctorError"] = repr(exc)
    total = 0
    snapshots = {}
    pending = [root / "evidence", Path(state["work"]), root / "profile" / "mcp-temp",
               root / "profile" / "user-data" / "logs"]
    while pending:
        directory = pending.pop()
        if not directory.exists():
            continue
        if directory.is_symlink() or directory.is_junction():
            report["skipped"].append({"path": str(directory.relative_to(root)), "reason": "linked directory"})
            continue
        for path in sorted(directory.iterdir()):
            if path.is_symlink() or path.is_junction():
                report["skipped"].append({"path": str(path.relative_to(root)), "reason": "linked path"})
                continue
            if path.is_dir():
                pending.append(path)
                continue
            if not path.is_file():
                continue
            if path.suffix.lower() == ".zip":
                report["skipped"].append({"path": str(path.relative_to(root)), "reason": "prior archive"})
                continue
            size = path.stat().st_size
            if size > 20_000_000 or total + size > 200_000_000:
                report["skipped"].append({"path": str(path.relative_to(root)), "reason": "collection size budget"})
                continue
            # Capture each growing log once; the manifest describes exactly the
            # bytes in the archive, not an earlier size/hash observation.
            with path.open("rb") as stream:
                data = stream.read(20_000_001)
            if len(data) > 20_000_000 or total + len(data) > 200_000_000:
                report["skipped"].append({"path": str(path.relative_to(root)), "reason": "collection size budget"})
                continue
            relative = path.relative_to(root).as_posix()
            report["files"][relative] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            snapshots[relative] = data
            total += len(data)
    prefix = root / "evidence" / ("collection-" + stamp())
    output = prefix.with_suffix(".json")
    report["freeBytesBeforeArchive"] = shutil.disk_usage(root).free
    report["archive"] = None
    if report["freeBytesBeforeArchive"] >= state["reserveBytes"] + total + 10_000_000:
        report["archive"] = str(prefix.with_suffix(".zip"))
        with zipfile.ZipFile(report["archive"], "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, data in snapshots.items():
                archive.writestr(relative, data)
            archive.writestr("acceptance.json", (root / "acceptance.json").read_bytes())
            archive.writestr("collection.json", json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"))
    else:
        report["archiveSkipped"] = "measured free space would fall below the configured reserve"
    write_json(output, report)
    return {"report": str(output), "archive": report["archive"], "files": len(report["files"]), "skipped": len(report["skipped"]),
            "nativeAcceptance": "NOT_INFERRED"}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    setup = sub.add_parser("prepare")
    setup.add_argument("--root", type=Path, required=True)
    setup.add_argument("--vsix", type=Path, required=True)
    setup.add_argument("--stata", type=Path, required=True)
    setup.add_argument("--code", type=Path, required=True)
    setup.add_argument("--port", type=int, default=17497)
    setup.add_argument("--reserve-bytes", type=int, default=DEFAULT_RESERVE_BYTES,
                       help="free space to keep for the machine, in bytes, on top of the 500 MB setup budget")
    setup.add_argument("--configure-only", action="store_true", help="write private config without installing or launching")
    for command in ("open", "collect", "run"):
        child = sub.add_parser(command)
        child.add_argument("--root", type=Path, required=True)
        if command == "run":
            child.add_argument("--fixture", choices=AGENT_FILES, required=True)
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("The installed desktop workflow is Windows-only; portable helper tests do not certify Windows Stata")
    if args.command == "prepare":
        result = prepare(args.root, args.vsix, args.stata, args.code, port=args.port,
                         configure_only=args.configure_only, reserve_bytes=args.reserve_bytes)
    else:
        state = load_state(args.root)
        if args.command == "collect":
            result = collect(state)
        elif args.command == "run":
            result = {"log": run_agent(state, args.fixture)}
        else:
            result = {"log": run_logged(state, "open", [sys.executable, "-B", str(REPO / "tools/verified_workbench.py"),
                        "--open", "--workspace", state["work"]]), "nativeAcceptance": "NOT_INFERRED"}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
