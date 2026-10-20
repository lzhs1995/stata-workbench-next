#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_detector_sreturn_patch");
const state = require("./stata_detector_state_patch");
const errors = require("./stata_detector_error_patch");
const fixture = require("../tests/fixtures/stata_detector_errors.original.json");
const original = "class Detector:\n" + fixture.initialization + fixture.blocks.map(b => b.original +
  (b.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        return self._get_graph_timestamps([name]).get(name, '')\n\n" : "")).join("") +
  "    def should_cache_graph(self, name):\n        pass\n";
const previous = state.patchDetector(errors.patchDetector(original));
const candidate = patch.patchDetector(previous);
const legacy = candidate.replace(patch.replacement, patch.legacyReplacement);
assert.notEqual(legacy, candidate);
assert.equal(patch.patchDetector(legacy), candidate);
assert.equal(patch.normalizeDetector(legacy), previous);
assert.equal(patch.patchDetector(candidate), candidate);
assert.equal(patch.normalizeDetector(candidate), previous);
assert.equal(patch.normalizeDetector(previous), previous);
assert.equal(patch.normalizeDetector(original), original);
for (const source of [previous + patch.previous, previous.replace(patch.start, ""),
  previous.replace("result = query(Macro, run)", "result = None"),
  candidate.replace("saved_s = read_s()", "saved_s = {}")]) {
  assert.throws(() => patch.patchDetector(source), /sreturn/);
}
// Both mutations execute the same public inventory/metadata entry points.
const excised = candidate.replace("saved_s = read_s()", "saved_s = None");
const equivalent = candidate.replaceAll("saved_s", "entry_s_macros");
assert.notEqual(excised, candidate);
assert.notEqual(equivalent, candidate);
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_detector_sreturn.py")], {
  input: JSON.stringify({ candidate, previous, excised, equivalent, legacy }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
