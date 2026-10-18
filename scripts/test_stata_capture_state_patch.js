#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_capture_state_patch");
const response = require("./stata_response_rc_patch");
const fixture = require("../tests/fixtures/stata_capture_state.original.json");
const rc = require("./stata_rc_read_patch");
const source = fixture.source + "    def _exec_no_capture(self):\n        pass\n";
const candidate = patch.patchClient(source);
assert.equal(patch.patchClient(candidate), candidate);
for (const bad of [source + source, source.replace("if trace:", "if False:"),
  source.replace(patch.END, "        # missing"), candidate.replace("set more off", "set more on"),
  source.replace(patch.END, patch.END + "\n" + patch.END)]) {
  assert.throws(() => patch.patchClient(bad));
}
// The RC transform and state transform own disjoint method regions.
const block = response.BLOCKS.find(item => item.name === "_exec_with_capture");
const tailStart = fixture.source.indexOf(block.start), tailEnd = fixture.source.indexOf(block.success);
const withRc = fixture.source.slice(0, tailStart) + response.replacement(block) + fixture.source.slice(tailEnd);
assert.equal(patch.patchClient(withRc), patch.patchClient(fixture.source).replace(
  fixture.source.slice(tailStart, tailEnd), response.replacement(block)));
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_capture_state.py")], {
  input: JSON.stringify({ original: fixture.source, candidate: patch.patchClient(withRc), reader: rc.REPLACEMENT }),
  encoding: "utf8", timeout: 20000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
