"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const patch = require("./stata_graph_name_boundary_patch");
const original = fs.readFileSync(path.join(__dirname, "../tests/fixtures/stata_graph_names.original.py"), "utf8");
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const block of patch.BLOCKS) {
  assert.throws(() => patch.patchClient(original + block.original), /graph name boundary/);
  assert.throws(() => patch.patchClient(original.replace(block.original, "")), /graph name boundary/);
}
const behavior = `
import json, sys
data=json.load(sys.stdin)
old={}; new={}
exec(data['original'], old); exec(data['candidate'], new)
broken=old['Client'](); client=new['Client']()
samples=[
 'mata: st_local("__codex_global_valid", strofreal(st_isname(st_local("__codex_name"))))',
 "_estimates hold __e, copy restore nullok varname(\x60__codex_cp_esample')",
 'mata: st_isname(base64decode("YQ=="))',
 'mata: object.name("my object")',
 'mata: 中文name("my object")',
]
assert broken._maybe_rewrite_graph_name_in_command(samples[0]) != samples[0]
assert broken._maybe_rewrite_graph_name_in_command(samples[1]) != samples[1]
for code in samples:
 assert client._maybe_rewrite_graph_name_in_command(code)==code,code
 assert new['_GRAPH_NAME_PATTERN'].findall(code)==[],code
assert client._graph_name_aliases=={}
for code in ['twoway scatter y x, name(' + chr(96) + "g', replace)",
             'twoway scatter y x, name($g, replace)',
             'twoway scatter y x, name("prefix_$g", replace)']:
 assert client._maybe_rewrite_graph_name_in_command(code)==code, code
assert client._graph_name_aliases=={}
for code in ['twoway scatter y x, name("my graph", replace)',
             'twoway scatter y x, name(valid_graph, replace)',
             'twoway scatter y x, name(' + chr(96) + '"中文图"' + chr(39) + ', replace)']:
 a=old['Client'](); b=new['Client']()
 assert a._maybe_rewrite_graph_name_in_command(code)==b._maybe_rewrite_graph_name_in_command(code)
 assert new['_GRAPH_NAME_PATTERN'].findall(code)
print('GRAPH_NAME_BOUNDARY_PASS')
`;
const result = spawnSync(process.env.PYTHON || "python3", ["-I", "-B", "-c", behavior],
  { input: JSON.stringify({ original, candidate }), encoding: "utf8", timeout: 10000 });
assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
