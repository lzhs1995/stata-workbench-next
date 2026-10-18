#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_response_rc_patch");
const fixture = require("../tests/fixtures/stata_response_rc.original.json");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const wrap = block => `    ${block.name.includes("streaming") ? "async " : ""}def ${block.name}(self):\n`
  + block.source + block.success + "        return rc, success\n\n";
assert.equal(fixture.blocks.length, patch.BLOCKS.length);
for (const [index, block] of fixture.blocks.entries()) {
  assert.equal(block.name, patch.BLOCKS[index].name);
  assert.equal(sha(block.source), patch.BLOCKS[index].sha256);
  assert.equal(block.sha256, patch.BLOCKS[index].sha256);
  assert.equal(block.success, patch.BLOCKS[index].success);
}
const source = fixture.blocks.map(wrap).join("");
const candidate = patch.patchClient(source);
assert.equal(patch.patchClient(candidate), candidate);
assert.equal(candidate.split(patch.MARKER).length - 1, 4);
for (const block of fixture.blocks) {
  const method = wrap(block);
  const candidateBlock = patch.replacement(block);
  assert.throws(() => patch.patchClient(source.replace(method, "")), /RC method/);
  assert.throws(() => patch.patchClient(source + method), /RC method/);
  assert.throws(() => patch.patchClient(source.replace(block.source, block.source + "        rc = 0\n")), /RC source/);
  assert.throws(() => patch.patchClient(source.replace(block.success, "        success = True\n")), /RC decision/);
  assert.throws(() => patch.patchClient(source.replace(block.source, block.source + block.source)), /RC decision/);
  assert.throws(() => patch.patchClient(candidate.replace(candidateBlock, candidateBlock.replace("rc = 1", "rc = 0"))), /RC source/);
  assert.throws(() => patch.patchClient(candidate.replace(candidateBlock, block.source + candidateBlock)), /mixed old/);
  // Previously applied paths may coexist with exact original paths.
  assert.equal(patch.patchClient(source.replace(block.source, candidateBlock)), candidate);
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_response_rc.py")], {
  input: JSON.stringify({ blocks: fixture.blocks.map(block => ({ ...block, candidate: patch.replacement(block) })) }),
  encoding: "utf8", timeout: 20000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
