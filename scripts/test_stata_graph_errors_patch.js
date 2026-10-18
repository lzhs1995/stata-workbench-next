#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const errors = require("./stata_graph_error_patch");
const drain = require("./stata_graph_task_drain_patch");
const callbacks = require("./stata_graph_callback_patch");
const callbackFixture = require("../tests/fixtures/stata_graph_callbacks.original.json");
const fixture = require("../tests/fixtures/stata_graph_errors.original.json");
const originalClient = Object.values(fixture).join("\n");
const client = errors.patchClient(originalClient);
assert.equal(errors.patchClient(client), client);
for (const block of errors.BLOCKS) {
  assert.equal(crypto.createHash("sha256").update(block.original).digest("hex"), block.sha256);
  for (const source of [originalClient.replace(block.original, ""),
    originalClient + block.original,
    client.replace(block.replacement, block.replacement.replace(/\S/, "#tampered#"))]) {
    assert.throws(() => errors.patchClient(source), /unsupported graph error source/);
  }
}
const detector = drain.patchDetector(drain.ORIGINAL_DETECTOR);
assert.equal(drain.patchDetector(drain.PREVIOUS_DETECTOR), detector);
assert.equal(drain.patchDetector(detector), detector);
assert.throws(() => drain.patchDetector(drain.PREVIOUS_DETECTOR.repeat(2)));
assert.equal(callbackFixture.original, callbacks.ORIGINAL);
assert.equal(crypto.createHash("sha256").update(callbacks.ORIGINAL).digest("hex"), callbacks.ORIGINAL_SHA256);
assert.equal(callbacks.patchDetector(callbacks.ORIGINAL), callbacks.CANDIDATE);
assert.equal(callbacks.patchDetector(callbacks.CANDIDATE), callbacks.CANDIDATE);
for (const source of ["", callbacks.ORIGINAL.repeat(2), callbacks.CANDIDATE.repeat(2),
  callbacks.ORIGINAL + callbacks.CANDIDATE, callbacks.CANDIDATE.replace("errors.append(error)", "pass")]) {
  assert.throws(() => callbacks.patchDetector(source), /unsupported graph callback source/);
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_graph_errors.py")], {
  input: JSON.stringify({client, originalClient,
    detector: detector + callbacks.CANDIDATE,
    originalDetector: drain.PREVIOUS_DETECTOR + callbacks.ORIGINAL,
    callbacks: callbacks.CANDIDATE, originalCallbacks: callbacks.ORIGINAL}),
  encoding: "utf8", timeout: 45000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
