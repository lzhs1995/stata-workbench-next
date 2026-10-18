#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const patch = require("./stata_silent_state_patch");
const fixture = require("../tests/fixtures/stata_silent_state.original.json");
const original = "class Client:\n" + fixture.blocks.map(b => b.source + b.end + "self):\n        pass\n\n").join("");
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const [i, block] of fixture.blocks.entries()) {
  assert.equal(crypto.createHash("sha256").update(block.source).digest("hex"), patch.BLOCKS[i].sha256);
  assert.ok(candidate.includes(patch.BLOCKS[i].replacement));
  for (const anchor of [block.start, block.end]) {
    assert.throws(() => patch.patchClient(original.replace(anchor, "    def unknown(")), /boundary/);
    assert.throws(() => patch.patchClient(original + anchor), /boundary/);
  }
  assert.throws(() => patch.patchClient(original.replace(block.source, block.source + "\n")), /identity/);
  assert.throws(() => patch.patchClient(candidate.replace(patch.BLOCKS[i].replacement, patch.BLOCKS[i].replacement + "\n")), /identity/);
  assert.throws(() => patch.patchClient(original.replace(block.source, patch.BLOCKS[i].replacement)), /mixed/);
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const test = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_silent_state.py")], {
  input: JSON.stringify({ original, candidate, reader: require("./stata_rc_read_patch").REPLACEMENT }),
  encoding: "utf8", timeout: 20000,
});
assert.equal(test.status, 0, test.stderr || test.error?.message);
const report = JSON.parse(test.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
