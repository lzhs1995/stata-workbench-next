"""Verify source/VSIX runtime against its versioned identity manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify(vsix=None, root=ROOT):
    manifest = json.loads((root / "release/runtime-manifest.json").read_bytes())
    checks = {}
    archive = zipfile.ZipFile(vsix) if vsix else None
    try:
        if archive:
            pkg = json.loads(archive.read("extension/package.json"))
        else:
            pkg = json.loads((root / "package.json").read_bytes())
        checks["packageVersion"] = pkg["version"] == manifest["version"]
        for rel, expected in manifest["files"].items():
            data = archive.read("extension/" + rel) if archive else (root / rel).read_bytes()
            checks[rel] = len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"]
    finally:
        if archive:
            archive.close()
    return {"verdict": "PASS" if all(checks.values()) else "FAIL", "checks": len(checks),
            "failedChecks": [k for k, ok in checks.items() if not ok],
            "scope": "runtime identity only; not fresh live acceptance"}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--vsix", type=Path)
    args = p.parse_args()
    result = verify(args.vsix)
    print(json.dumps(result))
    raise SystemExit(0 if result["verdict"] == "PASS" else 1)
