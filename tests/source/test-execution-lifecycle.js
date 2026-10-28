"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VERSION, createExecutionLifecycle } = require("../../src/shared-session/execution-lifecycle");
const migration = require("../../src/migrations/terminal-preview");

const root = path.resolve(__dirname, "../..");
const extensionSource = fs.readFileSync(path.join(root, "upstream/stata-workbench/src/extension.js"), "utf8");
const transformedExtension = migration.transform("extension.js", extensionSource);
for (const marker of ["sourceLifecycle.begin", "sourceLifecycle.started", "sourceLifecycle.finish", "sourceLifecycle.fail"]) {
  assert.equal(transformedExtension.split(marker).length - 1, 2, marker + " must cover selection and file paths");
}

let clock = 0;
const published = [];
const lifecycle = createExecutionLifecycle({ now: () => clock++, publish: value => published.push(value) });

assert.equal(VERSION, "rc7.27-source");
assert.equal(lifecycle.status(), null);
const begun = lifecycle.begin({ requestId: "req-1", runId: "run-1", sourceMode: "selection" });
assert.deepEqual({ phase: begun.phase, runId: begun.runId, sourceMode: begun.sourceMode },
  { phase: "acquired", runId: "run-1", sourceMode: "selection" });
assert.equal(lifecycle.started("other-run").phase, "acquired", "foreign run cannot mutate ownership");
assert.equal(lifecycle.started("run-1").phase, "running");
assert.equal(lifecycle.logPath("C:/tmp/run-1.log", "run-1").logPath, "C:/tmp/run-1.log");
const completed = lifecycle.finish("run-1", { rc: 0, completionMarkerVerified: true });
assert.equal(completed.phase, "completed");
assert.equal(completed.releasedAt != null, true);
assert.equal(completed.completionMarkerVerified, true);
assert.equal(lifecycle.progress("run-1").phase, "completed", "released run cannot be revived");

lifecycle.begin({ runId: "run-2", sourceMode: "file" });
const failed = lifecycle.fail("run-2", new Error("transport failed"));
assert.equal(failed.phase, "failed");
assert.equal(failed.failure, "transport failed");
assert.equal(published.length >= 6, true);
console.log(JSON.stringify({ verdict: "PASS_SOURCE_EXECUTION_LIFECYCLE", version: VERSION, publications: published.length }));
