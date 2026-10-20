#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const patch = require("./stata_stream_lifecycle_patch");
const fixture = require("../tests/fixtures/stata_stream_lifecycle.original.json");
const factory = fixture.blocks.find(b => b.name === "log-factory-and-owned-worker").original;
const original = fixture.methods + factory;
for (const block of fixture.blocks) {
  assert.equal(crypto.createHash("sha256").update(block.original).digest("hex"), block.sha256);
}
const candidate = patch.patchClient(original);
const boundary = patch.BLOCKS.find(b => b.name === "execution-error-and-close");
const splitCandidate = candidate.replaceAll(boundary.replacement, boundary.original);
assert.equal(patch.patchClient(candidate), candidate);
assert.equal(patch.normalizeClient(original), original);
assert.equal(patch.normalizeClient(candidate), original);
for (const block of patch.BLOCKS) {
  for (const source of [original.replace(block.original, ""), original + block.original,
    original.replace(block.original, block.original.replace(/\S/, "#tamper#")),
    candidate.replace(block.replacement, block.replacement.replace(/\S/, "#tamper#")),
    original.replaceAll(block.original, block.replacement)]) {
    assert.throws(() => patch.patchClient(source), /streaming lifecycle/);
    if (source.includes(patch.BLOCKS[0].replacement)) {
      assert.throws(() => patch.normalizeClient(source), /streaming lifecycle/);
    }
  }
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_stream_lifecycle.py")], {
  input: JSON.stringify({ candidate, original, splitCandidate }), encoding: "utf8", timeout: 45000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
