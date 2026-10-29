"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VERSION, createExecutionLifecycle } = require("../../src/shared-session/execution-lifecycle");
const migration = require("../../src/migrations/terminal-preview");

const root = path.resolve(__dirname, "../..");
const extensionSource = fs.readFileSync(path.join(root, "upstream/stata-workbench/src/extension.js"), "utf8");
const transformedExtension = migration.transform("extension.js", extensionSource);
// selection, file and Terminal entries; the bridge calls the lifecycle itself.
for (const marker of ["sourceLifecycle.begin", "sourceLifecycle.started", "sourceLifecycle.finish", "sourceLifecycle.unknown"]) {
  assert.equal(transformedExtension.split(marker).length - 1, 3, marker + " must cover selection, file and Terminal paths");
}
assert.equal(transformedExtension.split("sourceLifecycle.fail").length - 1, 0, "a rejected MCP call is not a confirmed failure");
assert.equal(transformedExtension.split("runCommand: sourceTerminalRunCommand,").length - 1, 2);
assert.equal(transformedExtension.split("runCommand: terminalRunCommand,").length - 1, 0);
assert.equal(transformedExtension.split("sourceBridge.start(").length - 1, 1);
assert.equal(transformedExtension.split("await sourceBridge.close()").length - 1, 1);

let clock = 0;
const published = [];
const lifecycle = createExecutionLifecycle({ now: () => clock++, publish: value => published.push(value) });

assert.equal(VERSION, "rc7.27-source.2");
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
const failed = lifecycle.fail("run-2", new Error("stata reported failure"));
assert.equal(failed.phase, "failed");
assert.equal(failed.failure, "stata reported failure");
assert.equal(published.length >= 6, true);

// Ownership: a second begin queues; it never replaces the active owner.
const own = createExecutionLifecycle({ now: () => clock++ });
own.begin({ runId: "owner-a", sourceMode: "bridge" });
own.started("owner-a");
const queued = own.begin({ runId: "owner-b", sourceMode: "selection" });
assert.equal(queued.queued, true);
assert.equal(queued.activeRunId, "owner-a");
assert.equal(own.status().runId, "owner-a");
assert.equal(own.busy(), true);
assert.throws(() => own.begin({}), /requires a runId/);
// Unbound callbacks cannot settle or advance the owner.
own.finish(undefined, { rc: 0 });
own.finish("", { rc: 0 });
own.started(null);
assert.equal(own.status().releasedAt, null);
assert.equal(own.status().phase, "running");
// The queued backend start may arrive before the owner's settlement callback.
own.started("owner-b");
assert.equal(own.status().runId, "owner-a");
const ownerA = own.finish("owner-a", { rc: 0, success: true });
assert.equal(ownerA.runId, "owner-a", "finish returns the settled record, not the promoted one");
assert.equal(ownerA.phase, "completed");
assert.equal(own.status().runId, "owner-b");
assert.equal(own.status().phase, "running");
assert.equal(own.get("owner-a").phase, "completed");
assert.equal(own.finish("owner-b", { rc: 0 }).phase, "completed");
assert.equal(own.busy(), false);

// Results: explicit failure releases as failed; missing result and thrown
// dispatch keep the owner held with an unknown outcome.
const res = createExecutionLifecycle({ now: () => clock++ });
res.begin({ runId: "explicit" });
const explicit = res.finish("explicit", { success: false, stderr: "r(198)" });
assert.equal(explicit.phase, "failed");
assert.equal(explicit.releasedAt != null, true);
res.begin({ runId: "missing" });
const missing = res.finish("missing", undefined);
assert.equal(missing.phase, "unknown");
assert.equal(missing.releasedAt, null);
assert.equal(res.busy(), true);
assert.equal(res.unknown("missing", new Error("still unknown")).releasedAt, null);
const blocked = res.begin({ runId: "after-missing" });
assert.equal(blocked.queued, true, "an unknown owner is not released by later work");
// A queued run that settles before promotion leaves the owner untouched.
assert.equal(res.finish("after-missing", { rc: 0 }).phase, "completed");
assert.equal(res.status().runId, "missing");
// Settled history is bounded.
const hist = createExecutionLifecycle({ now: () => clock++ });
for (let i = 0; i < 40; i++) { hist.begin({ runId: "h" + i }); hist.finish("h" + i, { rc: 0 }); }
assert.equal(hist.get("h0"), null);
assert.equal(hist.get("h39").phase, "completed");
console.log(JSON.stringify({ verdict: "PASS_SOURCE_EXECUTION_LIFECYCLE", version: VERSION, publications: published.length }));
