#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_rc_read_patch");
const fixture = require("../tests/fixtures/stata_rc_read.original.json");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
assert.equal(fixture.sha256, patch.ORIGINAL_SHA256);
assert.equal(sha(fixture.source), patch.ORIGINAL_SHA256);
const tail = "    def _parse_rc_from_text(self):\n        pass\n";
const source = "class Client:\n" + fixture.source + tail;
const candidate = patch.patchClient(source);
assert.equal(candidate, "class Client:\n" + patch.REPLACEMENT + tail);
assert.equal(patch.patchClient(candidate), candidate);
for (const anchor of [patch.START, patch.END]) {
  assert.throws(() => patch.patchClient(source.replace(anchor, "    def other(")), /RC reader boundary/);
  assert.throws(() => patch.patchClient(source + anchor), /RC reader boundary/);
}
assert.throws(() => patch.patchClient(tail + fixture.source), /boundary order/);
assert.throws(() => patch.patchClient(source.replace("return 0", "return 1")), /source identity/);
assert.throws(() => patch.patchClient(candidate.replace("return -1", "return 0")), /source identity/);
assert.throws(() => patch.patchClient(candidate.replace(tail, "        return 0\n" + tail)), /source identity/);
assert.throws(() => patch.patchClient(source.replace(tail, patch.REPLACEMENT + tail)), /RC reader boundary/);
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_rc_read.py")], {
  input: JSON.stringify({ original: fixture.source, candidate: patch.REPLACEMENT }),
  encoding: "utf8", timeout: 20000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
