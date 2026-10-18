#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const patch = require("./stata_stream_state_patch");
const original = fs.readFileSync(path.join(__dirname, "../tests/fixtures/stata_streaming_blocking.original.py"), "utf8");
const source = original + "    def _resolve_do_file_path(self):\n        pass\n";
const candidate = patch.patchClient(source);
assert.equal(patch.patchClient(candidate), candidate);
for (const bad of [source + source, source.replace("rc = -1", "rc = 99"),
  candidate.replace("set more off", "set more on"), source.replace("def _run_streaming_blocking", "def missing")]) {
  assert.throws(() => patch.patchClient(bad));
}
// A real Python interpreter checks/executes the isolated methods, without
// importing sfi or initializing Stata. Honor an explicit CI interpreter.
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_stream_state.py")], {
  input: JSON.stringify({ original, candidate: patch.REPLACEMENT }), encoding: "utf8", timeout: 20000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
