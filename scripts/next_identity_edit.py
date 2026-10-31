"""一次性身份改名：把 stata-workbench-shared-session 的发行身份改成隔离开发线 stata-workbench-next。

每处替换都断言命中次数，命中数不对就整体中止、不写任何文件。只改明确列出的文件。
用法：python3 -B scripts/next_identity_edit.py            # 预演，只打印
      python3 -B scripts/next_identity_edit.py --write    # 真写
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD_VER, NEW_VER = "0.1.3-rc.7.45", "0.2.0-next.1"
OLD_REPO, NEW_REPO = "github.com/lzhs1995/stata-workbench-shared-session", "github.com/lzhs1995/stata-workbench-next"

# (文件, 原文, 新文, 期望命中次数)
EDITS = [
    ("package.json", '"name": "stata-workbench-shared-session",', '"name": "stata-workbench-next",', 1),
    ("package.json", '"displayName": "Stata Workbench Shared Session",', '"displayName": "Stata Workbench Shared Session (Next)",', 1),
    ("package.json", f'"version": "{OLD_VER}",', f'"version": "{NEW_VER}",', 1),
    ("package.json", OLD_REPO, NEW_REPO, 3),
    ("package.json", '"default": 17485,', '"default": 17601,', 1),
    ("package.json",
     "(default 17485). Use 17495 for independent cold-install profile so production 17485 is undisturbed.",
     "(default 17601 in the Next development line; the stable release keeps 17485). Use a free port in 17601-17620 for each additional Next test profile.",
     1),
    ("package-lock.json", '"name": "stata-workbench-shared-session",', '"name": "stata-workbench-next",', 2),
    ("package-lock.json", f'"version": "{OLD_VER}",', f'"version": "{NEW_VER}",', 2),
    ("tools/verified_workbench.py",
     'str(Path.home() / ".stata-workbench-shared")',
     'str(Path.home() / ".stata-workbench-next" / "profiles" / "default")', 1),
    ("tools/verified_workbench.py",
     f'"extensions/lzhs1995.stata-workbench-shared-session-{OLD_VER}"',
     f'"extensions/lzhs1995.stata-workbench-next-{NEW_VER}"', 1),
    ("tools/verified_workbench.py", '"STATA_WORKBENCH_PORT", "17485"', '"STATA_WORKBENCH_PORT", "17601"', 1),
    ("tools/verified_workbench.py", f'VERSION = "{OLD_VER}"', f'VERSION = "{NEW_VER}"', 1),
    ("tools/test_verified_workbench.py", '"lzhs1995.stata-workbench-shared-session-"', '"lzhs1995.stata-workbench-next-"', 1),
    ("tools/verify_release.py", '("stata-workbench-shared-session-" + version', '("stata-workbench-next-" + version', 1),
    ("tools/workbench_doctor.py", '"stataMcp.visibleBridgePort", 17485)', '"stataMcp.visibleBridgePort", 17601)', 1),
    ("examples/platform-acceptance/stress.py", '"STATA_WORKBENCH_PORT", "17485"', '"STATA_WORKBENCH_PORT", "17601"', 1),
    ("scripts/mac/lib.sh", "默认 http://127.0.0.1:17485", "默认 http://127.0.0.1:17601", 1),
    ("scripts/mac/lib.sh", "${STATA_BRIDGE_BASE:-http://127.0.0.1:17485}", "${STATA_BRIDGE_BASE:-http://127.0.0.1:17601}", 1),
    ("scripts/patch_manager.js", 'const BRIDGE_URL = { host: "127.0.0.1", port: 17485,', 'const BRIDGE_URL = { host: "127.0.0.1", port: 17601,', 1),
    ("scripts/patch_manager.js", 'const GRAPH_STATUS_URL = { host: "127.0.0.1", port: 17485,', 'const GRAPH_STATUS_URL = { host: "127.0.0.1", port: 17601,', 1),
    ("scripts/patch_manager.js", "checking http://127.0.0.1:17485/status", "checking http://127.0.0.1:17601/status", 1),
    ("scripts/patch_manager.js", "checking http://127.0.0.1:17485/graph-status", "checking http://127.0.0.1:17601/graph-status", 1),
]
# 第二轮（首轮写入后追加）：只含首轮漏掉的点，可在已改过的树上单独跑
EDITS_ROUND2 = [
    ("scripts/patch_manager.js", " *   - visible HTTP bridge on 127.0.0.1:17485", " *   - visible HTTP bridge on 127.0.0.1:17601 (Next development line)", 1),
]


def main(write, edits):
    texts = {}
    for rel, old, new, want in edits:
        # 按字节读写：patch_manager.js 是 CRLF/LF 混排，read_text 会把 CRLF 折成 LF
        text = texts.setdefault(rel, (ROOT / rel).read_bytes().decode("utf-8"))
        got = text.count(old)
        if got != want:
            raise SystemExit(f"ABORT {rel}: expected {want} x {old!r}, found {got}; nothing written")
        texts[rel] = text.replace(old, new)
        print(f"ok {rel}: {want} x {old[:60]!r}")
    if write:
        for rel, text in texts.items():
            (ROOT / rel).write_bytes(text.encode("utf-8"))
    print("WROTE" if write else "DRY-RUN (pass --write to apply)", len(texts), "files")


if __name__ == "__main__":
    unknown = [a for a in sys.argv[1:] if a not in ("--write", "--round2")]
    if unknown:
        raise SystemExit(f"unknown arguments: {unknown}")
    main("--write" in sys.argv[1:], EDITS_ROUND2 if "--round2" in sys.argv[1:] else EDITS)
