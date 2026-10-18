#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_stored_results_patch");
const fixture = require("../tests/fixtures/stata_stored_results.original.json");
assert.equal(require("node:crypto").createHash("sha256").update(fixture.original).digest("hex"), fixture.sha256);
const original = "class Client:\n" + fixture.original + "    def invalidate_graph_cache(self):\n        pass\n";
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const source of [original.replace(fixture.original, ""), original + fixture.original,
  original.replace("macro drop mcp_*", "macro drop _all"),
  candidate.replace("raise errors[0]", "return {}"), candidate.replace(patch.BLOCK.end, "    def missing(")]) {
  assert.throws(() => patch.patchClient(source), /stored-results/);
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_stored_results.py")], {
  input: JSON.stringify({ candidate, original }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
