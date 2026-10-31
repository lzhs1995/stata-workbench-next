"""Read-only pre-install/runtime diagnosis; missing dependencies remain reportable."""
import json
import platform
from pathlib import Path
import shutil
import sys


def diagnose(entry):
    checks = []
    def check(name, ok, detail, action):
        checks.append({"name": name, "ok": bool(ok), "detail": detail,
                       "action": None if ok else action})
    check("platform", sys.platform in ("darwin", "win32"), platform.platform(),
          "Use macOS or Windows for the desktop client.")
    check("python", sys.version_info >= (3, 10), {"version": platform.python_version(), "executable": sys.executable},
          "Install Python 3.10 or newer; CI currently verifies Python 3.14.")
    try:
        code = entry.host.code_executable(entry.CODE_CLI)
        check("vscode", code.is_file(), str(code), "Install VS Code or set STATA_WORKBENCH_CODE to its executable.")
        package = code.parent.parent / "package.json" if sys.platform == "darwin" else code.parent / "resources/app/package.json"
        if package.is_file():
            check("vscodeVersion", True, json.loads(package.read_bytes()).get("version"), "")
    except Exception as exc:
        code = None
        check("vscode", False, str(exc), "Set STATA_WORKBENCH_CODE to Code.exe (Windows) or the app/bin/code CLI (Mac).")
    check("port", 1024 <= entry.PORT <= 65535, entry.PORT, "Set STATA_WORKBENCH_PORT to a local port in 1024..65535.")
    settings = entry.PROFILE / "user-data/User/settings.json"
    # VS Code settings are JSONC. Do not rewrite them or silently parse a comment as JSON.
    settings_result = {"path": str(settings), "exists": settings.is_file()}
    configured_stata = None
    if settings.is_file():
        try:
            config = json.loads(settings.read_text(encoding="utf-8-sig"))
            configured_stata = config.get("stataMcp.stataPath")
            configured_port = config.get("stataMcp.visibleBridgePort", 17601)
            check("configuredPort", type(configured_port) is int and configured_port == entry.PORT,
                  configured_port, "Align STATA_WORKBENCH_PORT with stataMcp.visibleBridgePort in this profile.")
        except (ValueError, UnicodeError) as exc:
            settings_result.update(parseStatus="JSONC_OR_INVALID_JSON", error=str(exc))
            check("settingsParse", False, settings_result["parseStatus"],
                  "Review JSONC settings in VS Code; this read-only doctor cannot verify their port/path values.")
    check("installedBundle", (entry.EXTENSION / "dist/extension.js").is_file(), str(entry.EXTENSION),
          "Install this candidate VSIX into the selected profile/extensions directory.")
    stata_candidates = []
    if isinstance(configured_stata, str) and configured_stata:
        stata_candidates.append(Path(configured_stata).expanduser())
    if sys.platform == "darwin":
        stata_candidates.extend(Path("/Applications/Stata").glob("*.app/Contents/MacOS/stata*"))
        stata_candidates.extend(Path("/Applications").glob("Stata*.app/Contents/MacOS/stata*"))
    elif sys.platform == "win32":
        import os
        base = Path(os.environ.get("ProgramFiles", "C:/Program Files"))
        stata_candidates.extend(base.glob("Stata*/Stata*.exe"))
    stata_candidates = sorted({str(p) for p in stata_candidates if p.is_file()})
    check("stata", bool(stata_candidates), stata_candidates,
          "Install licensed Stata and set stataMcp.stataPath; this tool does not read or validate the license.")
    instance = None
    try:
        # Pins are verified before connecting to any candidate bridge.
        d = entry.helpers()
        instance = entry.observe(d)
        check("instance", instance.get("identityOk") is True, instance,
              "Open the exact configured profile and inspect its Workbench connection; do not reset another instance.")
    except Exception as exc:
        check("instance", False, str(exc), "Check installed version/hash and selected profile. No launch or reset was attempted.")
    if instance:
        check("window", instance.get("windowObservation", {}).get("ok") is True and instance.get("axWindowCount") == 1,
              instance.get("windowObservation"), entry.permissions.ADVICE)
    return {"schema": "workbench-doctor/1", "verdict": "READY" if all(c["ok"] for c in checks) else "NEEDS_ATTENTION",
            "os": sys.platform, "architecture": platform.machine(), "profile": str(entry.PROFILE),
            "settings": settings_result, "uv": shutil.which("uv"), "checks": checks,
            "stataDispatchCount": 0, "launchCount": 0, "permissionRequestCount": 0,
            "note": "Environment/identity diagnosis only; not licensed execution or visual acceptance."}
