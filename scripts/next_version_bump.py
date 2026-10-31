"""Next 版本号推进：package.json、package-lock.json、tools/verified_workbench.py 的版本、
扩展目录名和 bundle SHA 一起改，然后由调用者跑 refresh_runtime_manifest.js。

用法：python3 -B scripts/next_version_bump.py <新版本> [--write]
每处断言命中次数；任一处不符整体中止、不写文件。按字节读写，保留原换行。
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv):
    write = "--write" in argv
    args = [a for a in argv if a != "--write"]
    if len(args) != 1 or not re.fullmatch(r"0\.2\.0-next\.\d+", args[0]):
        raise SystemExit(__doc__)
    new = args[0]
    old = json.loads((ROOT / "package.json").read_bytes())["version"]
    bundle = hashlib.sha256((ROOT / "dist/extension.js").read_bytes()).hexdigest()
    verified = (ROOT / "tools/verified_workbench.py").read_bytes().decode("utf-8")
    old_sha = re.search(r'BUNDLE_SHA256 = "([0-9a-f]{64})"', verified).group(1)
    edits = [
        ("package.json", f'"version": "{old}",', f'"version": "{new}",', 1),
        ("package-lock.json", f'"version": "{old}",', f'"version": "{new}",', 2),
        ("tools/verified_workbench.py", f'VERSION = "{old}"', f'VERSION = "{new}"', 1),
        ("tools/verified_workbench.py", f'lzhs1995.stata-workbench-next-{old}"', f'lzhs1995.stata-workbench-next-{new}"', 1),
        ("tools/verified_workbench.py", f'BUNDLE_SHA256 = "{old_sha}"', f'BUNDLE_SHA256 = "{bundle}"', 1),
    ]
    texts = {}
    for rel, before, after, want in edits:
        text = texts.setdefault(rel, (ROOT / rel).read_bytes().decode("utf-8"))
        got = text.count(before)
        if got != want:
            raise SystemExit(f"ABORT {rel}: expected {want} x {before!r}, found {got}; nothing written")
        texts[rel] = text.replace(before, after)
    for rel, text in texts.items():
        print("ok", rel)
        if write:
            (ROOT / rel).write_bytes(text.encode("utf-8"))
    print(f"{old} -> {new}, bundle {bundle[:16]}", "WROTE" if write else "DRY-RUN (pass --write)")


if __name__ == "__main__":
    main(sys.argv[1:])
