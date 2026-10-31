"""把一个新的 Next bundle 补丁接进现有重放链（按字节，保留原换行）。

用法：python3 -B scripts/next_wire_patch.py <模块名> <patch_manager key> <label> <marker> [--write]
  模块名如 apply_next_identity_patch（不带 ./ 和 .js）。
改三处：apply_rc7_shared_execution_patch.js 的重放调用、later_bundle_patches.js 的 LATER 列表、
patch_manager.js 的 marker 登记。每处断言锚点唯一；任一处不符整体中止、不写文件。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def once(text, anchor, what):
    n = text.count(anchor)
    if n != 1:
        raise SystemExit(f"ABORT {what}: anchor found {n} times; nothing written")
    return text.index(anchor) + len(anchor)


def main(argv):
    write = "--write" in argv
    args = [a for a in argv if a != "--write"]
    if len(args) != 4:
        raise SystemExit(__doc__)
    mod, key, label, marker = args
    files = {rel: (ROOT / rel).read_bytes() for rel in (
        "scripts/apply_rc7_shared_execution_patch.js", "scripts/later_bundle_patches.js", "scripts/patch_manager.js")}
    out = {}

    replay = files["scripts/apply_rc7_shared_execution_patch.js"].decode("utf-8")
    if f'require("./{mod}")' in replay:
        raise SystemExit(f"ABORT {mod} already wired")
    anchor = 'fs.writeFileSync(target, text, "utf8");\n'
    at = once(replay, anchor, "replay write") - len(anchor)
    out["scripts/apply_rc7_shared_execution_patch.js"] = (
        replay[:at] + f'// {label}\ntext = require("./{mod}").patchBundle(text, {{ finalize: false }});\n' + replay[at:])

    later = files["scripts/later_bundle_patches.js"].decode("utf-8")
    at = once(later, "\n];\n", "LATER list end")
    at -= len("\n];\n")
    out["scripts/later_bundle_patches.js"] = later[:at] + f'\n  "./{mod}",' + later[at:]

    pm = files["scripts/patch_manager.js"].decode("utf-8")
    anchor = 'marker: "codex patch rc.7.74: soft Stop never dispatches a refused checkpoint restore",\r\n  },\r\n'
    at = once(pm, anchor, "patch_manager rc.7.74 entry")
    entry = ("  {\r\n"
             f'    key: "{key}",\r\n'
             f'    label: "{label}",\r\n'
             '    relativePath: path.join("dist", "extension.js"),\r\n'
             f'    marker: "{marker}",\r\n'
             "  },\r\n")
    # 后续 Next 补丁接在上一个 Next 条目之后，保持重放顺序
    while True:
        nxt = pm.find('  {\r\n    key: "next', at)
        if nxt != at:
            break
        at = pm.index("  },\r\n", at) + len("  },\r\n")
    out["scripts/patch_manager.js"] = pm[:at] + entry + pm[at:]

    for rel, text in out.items():
        print("ok", rel)
        if write:
            (ROOT / rel).write_bytes(text.encode("utf-8"))
    print("WROTE" if write else "DRY-RUN (pass --write)")


if __name__ == "__main__":
    main(sys.argv[1:])
