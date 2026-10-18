#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const cp = require("node:child_process");
const patch = require("./stata_smcl_log_patch");
const fixture = require("../tests/fixtures/stata_smcl_logs.original.json");
assert.equal(crypto.createHash("sha256").update(fixture.source).digest("hex"), patch.ORIGINAL_SHA256);
assert.equal(fixture.sha256, patch.ORIGINAL_SHA256);
const source = fixture.source + "    def _restore_results_from_hold(self):\n        pass\n";
const candidate = patch.patchClient(source);
assert.equal(patch.patchClient(candidate), candidate);
for (const bad of [source + source, source.replace("return False", "return True"),
  candidate.replace("opened = False", "opened = True"), source.replace("def _open_smcl_log", "def missing")]) {
  assert.throws(() => patch.patchClient(bad));
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_smcl_log.py")], {
  input: JSON.stringify({ original: fixture.source, candidate: patch.REPLACEMENT }),
  encoding: "utf8", timeout: 20000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
