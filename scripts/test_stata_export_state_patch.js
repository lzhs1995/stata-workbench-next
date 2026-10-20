#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_export_state_patch");
const errors = require("./stata_detector_error_patch");
const state = require("./stata_detector_state_patch");
const sreturn = require("./stata_detector_sreturn_patch");
const fixture = require("../tests/fixtures/stata_export.original.json");
const detectorFixture = require("../tests/fixtures/stata_detector_errors.original.json");
const original = "class Client:\n" + fixture.original + "    def get_help(self):\n        pass\n";
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const source of [original.replace(fixture.original, ""), original + fixture.original,
  original.replace("time.sleep(0.2)", "time.sleep(0.3)"),
  candidate.replace("os.replace(staged, target)", "staged.unlink()"),
  candidate.replace(patch.BLOCK.end, "    def missing(")]) {
  assert.throws(() => patch.patchClient(source), /export/);
}
const detector = sreturn.patchDetector(state.patchDetector(errors.patchDetector("class Detector:\n" +
  detectorFixture.initialization + detectorFixture.blocks.map(b => b.original +
    (b.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        pass\n\n" : "")).join("") +
  "    def should_cache_graph(self, name):\n        pass\n")));
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_export_state.py")], {
  input: JSON.stringify({ candidate, original, detector }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
