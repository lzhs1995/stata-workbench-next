#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_startup_state_patch");
const fixture = require("../tests/fixtures/stata_startup_state.original.json");
const blocks = [{ ...patch.BLOCKS[0], original: patch.INIT_ORIGINAL }, ...fixture.blocks];
const suffix = block => block.name === "init"
  ? block.end + "\n        self.engine_initializations += 1\n        self._initialized = True\n        self._load_startup_do_file()\n\n"
  : block.name === "load" ? block.end + "\n"
    : block.end + "self, *args, **kwargs):\n        return super()." + block.end.split("def ")[1].slice(0, -1) + "(*args, **kwargs)\n\n";
const original = "class Client:\n" + blocks.map(b => b.original + suffix(b)).join("");
for (const b of blocks) assert.equal(crypto.createHash("sha256").update(b.original).digest("hex"), b.sha256);
const candidate = patch.patchClient(original);
assert.equal(patch.patchClient(candidate), candidate);
for (const b of patch.BLOCKS) {
  assert.throws(() => patch.patchClient(candidate.replace(b.replacement, b.replacement + "    # altered\n")), /startup/);
  assert.throws(() => patch.patchClient(original + b.start), /startup/);
  assert.throws(() => patch.patchClient(original.replace(b.start, "    def missing_boundary(")), /startup/);
}
const detector = "class Detector:\n    def __init__(self, client):\n        self._stata_client = client\n"
  + "    def _graph_probe_lock(self):\n        return self._stata_client._exec_lock\n"
  + require("./stata_detector_sreturn_patch").replacement;
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_startup_state.py")], {
  input: JSON.stringify({ candidate, original, detector }), encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
