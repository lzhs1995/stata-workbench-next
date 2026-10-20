"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rehearsal = require("./prepare_checkpoint_rehearsal");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-rehearsal-test-")));
try {
  const output = path.join(root, "prepared");
  const plan = rehearsal.prepare(output);
  const planFile = path.join(output, "PLAN.json");
  const original = fs.readFileSync(planFile);
  assert.strictEqual(plan.nativeExecutionVerified, false);
  assert.strictEqual(plan.completeSessionRestoreVerified, false);
  assert.strictEqual(fs.existsSync(plan.snapshot.path), false);
  assert.deepStrictEqual(fs.readdirSync(plan.snapshot.stateDir), []);
  assert.throws(() => rehearsal.prepare(output), /already exists/);
  assert.deepStrictEqual(fs.readFileSync(planFile), original);
  assert.throws(() => rehearsal.prepare(path.join(root, "$macro")), /metacharacters/);
  const restoreOutput = path.join(root, "restore");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /snapshot.ready/);
  assert.strictEqual(fs.existsSync(restoreOutput), false, "Rejected render must not publish output");

  // Deliberately synthetic files test the structural gate only. The generated
  // report must continue to deny native provenance and native acceptance.
  const state = plan.snapshot.stateDir;
  const ready = path.join(state, "snapshot.ready");
  fs.writeFileSync(ready, `ready\t${"f".repeat(32)}\tdata\n`);
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /snapshot.ready/);
  fs.writeFileSync(ready, `ready\t${plan.snapshot.checkpointNonce}\tdata\n`);
  fs.writeFileSync(plan.snapshot.path, Buffer.alloc(1024));
  fs.writeFileSync(path.join(state, "globals.b64.tsv"), "x\teA==\n");
  fs.writeFileSync(path.join(state, "estimates.txt"), "saved\n");
  fs.writeFileSync(path.join(state, "graphs.txt"), "plot\n");
  fs.writeFileSync(path.join(state, "current_graph.txt"), "plot\n");
  fs.writeFileSync(path.join(state, "default_graph_object.txt"), "0\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /ENOENT/);
  assert.strictEqual(fs.existsSync(restoreOutput), false);
  fs.writeFileSync(path.join(state, "estimate_saved.ster"), "SYNTHETIC-NOT-STATA");
  fs.writeFileSync(path.join(state, "graph_plot.gph"), "SYNTHETIC-NOT-STATA");
  fs.writeFileSync(path.join(state, "estimates.txt"), "saved\n../escape\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /Invalid or duplicate/);
  fs.writeFileSync(path.join(state, "estimates.txt"), "saved\nsaved\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /Invalid or duplicate/);
  fs.writeFileSync(path.join(state, "estimates.txt"), "saved\n");
  fs.writeFileSync(path.join(state, "current_graph.txt"), "missing\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /Current graph/);
  fs.writeFileSync(path.join(state, "current_graph.txt"), "plot\n");
  fs.writeFileSync(path.join(state, "default_graph_object.txt"), "invalid\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /validation/);
  fs.writeFileSync(path.join(state, "default_graph_object.txt"), "0\n");
  const source = path.join(output, "atomic-candidate.do");
  const sourceBytes = fs.readFileSync(source);
  fs.appendFileSync(source, "* changed\n");
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /source changed/);
  fs.writeFileSync(source, sourceBytes);
  const report = rehearsal.renderRestore(planFile, restoreOutput);
  assert.strictEqual(report.nativeArtifactProvenanceVerified, false);
  assert.strictEqual(report.nativeExecutionVerified, false);
  assert.strictEqual(report.completeSessionRestoreVerified, false);
  assert.ok(report.inputs.some((item) => item.path.endsWith("estimate_saved.ster")));
  assert.ok(report.inputs.some((item) => item.path.endsWith("graph_plot.gph")));
  assert.throws(() => rehearsal.renderRestore(planFile, restoreOutput), /already exists/);
  assert.deepStrictEqual(fs.readFileSync(planFile), original);
  console.log("PASS checkpoint rehearsal: no dispatch, no fabricated backup, no overwrite; missing/stale/malformed/changed inputs rejected; structural fixtures never claim native acceptance");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
