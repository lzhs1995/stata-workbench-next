#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_bulk_cache_patch");
const fixture = require("./runtime/stata_bulk_cache.original.json");
const get = name => fixture.blocks.find(b => b.name === name).original;
const original = "class Client:\n" + get("get") + get("emission")
  + "    @staticmethod\n    def _extract_named_graphs(text):\n        return []\n\n"
  + get("manage") + "    def _get_content_hash(self, data):\n        return data.hex()\n\n"
  + get("exports") + "    def run_do_file(self):\n        pass\n\n";
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
assert.equal(patch.patchClient(patch.normalizeClient(candidate)), candidate);
assert.equal(patch.normalizeClient(original), original);
const upstreamEmission = require("./stata_graph_error_patch").BLOCKS.find(b => b.name === "emission");
const pristine = original.replace(get("emission"), () => upstreamEmission.original);
assert.equal(patch.normalizeClient(pristine), pristine);
assert.equal(patch.patchClient(pristine.replace(upstreamEmission.original, () => upstreamEmission.replacement)), candidate);
for (const block of patch.BLOCKS) {
  for (const source of [original.replace(block.original, ""), original + block.original,
    original.replace(block.original, () => block.original + "    # unknown original\n"),
    candidate.replace(block.replacement, () => block.replacement + "    # unknown candidate\n"),
    candidate.replace(block.end, "    def missing_boundary(")]) {
    assert.throws(() => patch.patchClient(source), /bulk cache/);
  }
  assert.throws(() => patch.normalizeClient(candidate.replace(block.replacement, () => block.original)), /mixed bulk cache/);
}
const errors = require("./stata_detector_error_patch"), state = require("./stata_detector_state_patch");
const sreturn = require("./stata_detector_sreturn_patch");
const detectorFixture = require("../tests/fixtures/stata_detector_errors.original.json");
const detector = sreturn.patchDetector(state.patchDetector(errors.patchDetector("class Detector:\n" +
  detectorFixture.initialization + detectorFixture.blocks.map(b => b.original +
    (b.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        pass\n\n" : "")).join("") +
  "    def should_cache_graph(self, name):\n        pass\n")));
const exportMethod = require("./stata_export_state_patch").BLOCK.replacement;
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_bulk_cache.py")], {
  input: JSON.stringify({candidate: candidate + exportMethod, original, detector}), encoding: "utf8", timeout: 45000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
