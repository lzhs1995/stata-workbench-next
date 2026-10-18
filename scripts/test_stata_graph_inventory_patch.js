#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_graph_inventory_patch");
const errors = require("./stata_detector_error_patch");
const state = require("./stata_detector_state_patch");
const sreturn = require("./stata_detector_sreturn_patch");
const fixture = require("../tests/fixtures/stata_graph_inventory.original.json");
const detectorFixture = require("../tests/fixtures/stata_detector_errors.original.json");
const original = "class Client:\n" + fixture.blocks.map(b => b.original +
  (b.name === "list_graphs" ? "    def export_graph(self):\n        pass\n\n" :
    b.name === "_capture_graph_state" ? "    async def _cache_new_graphs(self):\n        pass\n\n" :
      "    @staticmethod\n    def _end():\n        pass\n\n")).join("");
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const block of patch.BLOCKS) {
  const frozen = fixture.blocks.find(b => b.name === block.name).original;
  for (const source of [original.replace(frozen, ""), original + frozen,
    original.replace(frozen, frozen.replace(/\S/, "#tamper#")),
    candidate.replace(block.replacement, block.replacement.replace(/\S/, "#tamper#")),
    original.replace(frozen, block.replacement)]) {
    assert.throws(() => patch.patchClient(source), /graph inventory/);
  }
}
const detector = sreturn.patchDetector(state.patchDetector(errors.patchDetector("class Detector:\n" +
  detectorFixture.initialization + detectorFixture.blocks.map(b => b.original +
    (b.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        pass\n\n" : "")).join("") +
  "    def should_cache_graph(self, name):\n        pass\n")));
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_graph_inventory.py")], {
  input: JSON.stringify({ candidate, original, detector }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
