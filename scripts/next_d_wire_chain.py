"""阶段 D 接线：把 apply_next_multi_session_patch 登记进补丁链和校验命令，加两个设置项。
按字节读写（patch_manager.js 是 CRLF/LF 混排），每处断言命中 1 次；任一处不符整体中止、不写文件。
用法：python3 -B scripts/next_d_wire_chain.py [--write]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
C_MARK = b"next patch 0.2.0-next.3: bridge bearer authentication"
D_LABEL = b"next 0.2.0-next.4: multi-session registry and per-session temp"
D_MARK = b"next patch 0.2.0-next.4: multi-session registry and per-session temp"


def edits():
    pm_before = b'    marker: "' + C_MARK + b'",\r\n  },\r\n'
    pm_after = pm_before + (b'  {\r\n    key: "nextMultiSession",\r\n    label: "' + D_LABEL + b'",\r\n'
                            b'    relativePath: path.join("dist", "extension.js"),\r\n    marker: "' + D_MARK + b'",\r\n  },\r\n')
    rc7_before = b'text = require("./apply_next_bridge_auth_patch").patchBundle(text, { finalize: false });\n'
    rc7_after = rc7_before + (b"// " + D_LABEL + b"\n"
                              b'text = require("./apply_next_multi_session_patch").patchBundle(text, { finalize: false });\n')
    later_before = b'  "./apply_next_bridge_auth_patch",\n'
    later_after = later_before + b'  "./apply_next_multi_session_patch",\n'
    chk_before = b"node scripts/test_next_bridge_auth.js"
    chk_after = chk_before + (b" && node --check scripts/next_multi_session_core.js && node --check scripts/apply_next_multi_session_patch.js"
                              b" && node --check scripts/test_next_multi_session.js && node scripts/test_next_multi_session.js")
    return [
        ("scripts/patch_manager.js", pm_before, pm_after),
        ("scripts/apply_rc7_shared_execution_patch.js", rc7_before, rc7_after),
        ("scripts/later_bundle_patches.js", later_before, later_after),
        ("package.json", chk_before + b'"', chk_after + b'"'),
    ]


SETTINGS = {
    "stataMcp.nextSessionName": {
        "type": ["string", "null"], "default": None,
        "description": "Next multi-session: this window's session name (letters, digits, _ and -; set by tools/stata_session.py). "
                       "The STATA_WORKBENCH_NEXT_SESSION environment variable takes precedence.",
    },
    "stataMcp.nextMcpConfigPath": {
        "type": ["string", "null"], "default": None,
        "description": "Next multi-session: absolute path of this session's mcp-stata runtime config (set by tools/stata_session.py). "
                       "Used only when the MCP_STATA_CONFIG_PATH environment variable is not set.",
    },
    "stataMcp.nextProfilePath": {
        "type": ["string", "null"], "default": None,
        "description": "Next multi-session: absolute path of this window's private profile directory (set by tools/stata_session.py).",
    },
}


def main(argv):
    write = "--write" in argv
    texts = {}
    for rel, before, after in edits():
        data = texts.setdefault(rel, (ROOT / rel).read_bytes())
        got = data.count(before)
        if got != 1:
            raise SystemExit(f"ABORT {rel}: expected 1 x {before[:70]!r}, found {got}; nothing written")
        if data.count(after) != 0:
            raise SystemExit(f"ABORT {rel}: already wired; nothing written")
        texts[rel] = data.replace(before, after)
    # 设置项：在 visibleBridgePort 之后插入，保持 package.json 原有缩进
    pkg = json.loads(texts["package.json"])
    props = pkg["contributes"]["configuration"]["properties"]
    for key in SETTINGS:
        if key in props:
            raise SystemExit(f"ABORT package.json: {key} already present; nothing written")
    anchor = b'\n        "stataMcp.visibleBridgePort": {'
    if texts["package.json"].count(anchor) != 1:
        raise SystemExit("ABORT package.json: visibleBridgePort anchor not unique; nothing written")
    block = b"".join(b'\n        ' + json.dumps(k).encode() + b": " + json.dumps(v, indent=2).replace("\n", "\n        ").encode() + b","
                     for k, v in SETTINGS.items())
    texts["package.json"] = texts["package.json"].replace(anchor, block + anchor)
    pkg = json.loads(texts["package.json"])
    assert all(k in pkg["contributes"]["configuration"]["properties"] for k in SETTINGS)
    for rel, data in texts.items():
        print("ok", rel)
        if write:
            (ROOT / rel).write_bytes(data)
    print("WROTE" if write else "DRY-RUN (pass --write)")


if __name__ == "__main__":
    main(sys.argv[1:])
