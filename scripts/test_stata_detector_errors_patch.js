#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_detector_error_patch");
const fixture = require("../tests/fixtures/stata_detector_errors.original.json");

// Frozen bodies include their exact trailing boundary whitespace.
const bodies = fixture.blocks.map(block => block.original +
  (block.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        return self._get_graph_timestamps([name]).get(name, '')\n\n" : "")).join("");
const original = "class Detector:\n" + fixture.initialization + bodies +
  "    def should_cache_graph(self, name):\n        raise NotImplementedError\n";
const candidate = patch.patchDetector(original);
assert.equal(patch.patchDetector(candidate), candidate);
for (const block of fixture.blocks) {
  assert.equal(crypto.createHash("sha256").update(block.original).digest("hex"), block.sha256);
  const current = patch.BLOCKS.find(item => item.name === block.name);
  for (const source of [original.replace(block.original, ""), original + block.original,
    original.replace(block.original, block.original.replace(/\S/, "#tampered#")),
    candidate.replace(current.replacement, current.replacement.replace(/\S/, "#tampered#")),
    original.replace(block.original, current.replacement)]) {
    assert.throws(() => patch.patchDetector(source), /detector error/);
  }
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_detector_errors.py")], {
  input: JSON.stringify({candidate, original}), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
