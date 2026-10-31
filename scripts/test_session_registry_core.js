"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./session_registry_core");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stata-next-session-"));
const record = core.createSession({
  sessionId: "test-session", sessionName: "test", port: 17611, extensionHostPid: 1234,
  bundleSha: "a".repeat(64), root, randomBytes: n => Buffer.alloc(n, 7), now: () => "2026-10-31T00:00:00.000Z",
});
assert.equal(record.token.length, 64);
assert.equal(fs.statSync(record.file).mode & 0o777, 0o600);
const loaded = JSON.parse(fs.readFileSync(record.file, "utf8"));
assert.deepEqual(loaded, { sessionId: "test-session", sessionName: "test", port: 17611, token: "07".repeat(32), extensionHostPid: 1234, startedAt: "2026-10-31T00:00:00.000Z", bundleSha: "a".repeat(64) });
assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);
core.recordRejection(record, { reason: "bad-token", httpStatus: 401 });
assert.match(fs.readFileSync(record.eventLog, "utf8"), /bad-token/);
assert.throws(() => core.createSession({ sessionId: "bad/id", sessionName: "x", port: 17611, extensionHostPid: 1, bundleSha: "a".repeat(64), root }), /sessionId/);
console.log("PASS session registry: 32-byte token, atomic 0600 file, rejection event, and validation");
