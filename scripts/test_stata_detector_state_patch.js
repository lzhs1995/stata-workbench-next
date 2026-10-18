#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const errors = require("./stata_detector_error_patch");
const state = require("./stata_detector_state_patch");
const fixture = require("../tests/fixtures/stata_detector_errors.original.json");
const bodies = fixture.blocks.map(block => block.original +
  (block.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        return self._get_graph_timestamps([name]).get(name, '')\n\n" : "")).join("");
const original = "class Detector:\n" + fixture.initialization + bodies +
  "    def should_cache_graph(self, name):\n        raise NotImplementedError\n";
const previous = errors.patchDetector(original);
const candidate = state.patchDetector(previous);
assert.equal(state.patchDetector(candidate), candidate);
assert.equal(state.normalizeDetector(candidate), previous);
assert.equal(state.normalizeDetector(previous), previous);
assert.equal(state.normalizeDetector(original), original);
assert.equal(state.patchDetector(errors.patchDetector(state.normalizeDetector(candidate))), candidate);
for (const block of state.BLOCKS) {
  for (const source of [previous.replace(block.previous, ""), previous + block.previous,
    previous.replace(block.previous, block.previous.replace(/\S/, "#tamper#")),
    candidate.replace(block.replacement, block.replacement.replace(/\S/, "#tamper#")),
    previous.replace(block.previous, block.replacement)]) {
    assert.throws(() => state.patchDetector(errors.patchDetector(state.normalizeDetector(source))), /detector (error|state)/);
  }
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_detector_state.py")], {
  input: JSON.stringify({ candidate, previous, original }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
