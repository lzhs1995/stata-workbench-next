"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const patch = require("./stata_session_health_patch");
const original = fs.readFileSync(path.join(__dirname, "../tests/fixtures/stata_sessions.original.py"), "utf8");
const candidate = patch.patchSessions(original);
assert.notEqual(candidate, original);
assert.equal(patch.patchSessions(candidate), candidate);
assert.equal(patch.patchSessions(original.replace(patch.ORIGINAL, patch.LEGACY_REPLACEMENT)), candidate);
assert.throws(() => patch.patchSessions(candidate + patch.LEGACY_REPLACEMENT), /unsupported/);
assert.throws(() => patch.patchSessions(original + patch.ORIGINAL), /unsupported/);
assert.throws(() => patch.patchSessions(original.replace("self._process.daemon = True", "self._process.daemon = False")), /unsupported/);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stata-session-test-"));
try {
  const file = path.join(dir, "candidate.py");
  fs.writeFileSync(file, candidate);
  const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin" ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
  const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_session_health.py")], {
    env: { ...process.env, STATA_SESSION_MODULE: file }, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.doesNotMatch(result.stderr, /Exception ignored|Traceback|BufferError/);
  console.log(result.stderr.trim());
  assert.equal(patch.patchServer(patch.SERVER_ORIGINAL), patch.SERVER_REPLACEMENT);
  assert.equal(patch.patchServer(patch.SERVER_REPLACEMENT), patch.SERVER_REPLACEMENT);
  assert.throws(() => patch.patchServer(patch.SERVER_ORIGINAL + patch.SERVER_ORIGINAL), /unsupported/);
  const loop = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_server_loop.py")], {
    input: JSON.stringify({old: patch.SERVER_ORIGINAL, new: patch.SERVER_REPLACEMENT}),
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(loop.status, 0, loop.stderr || loop.error?.message);
  console.log(loop.stdout.trim());
  console.log("STATA_SESSION_HEALTH_PASS; spawned stub workers; no native Stata");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
