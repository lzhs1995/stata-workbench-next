#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const core = require("./stop_checkpoint_core");
const patch = require("./apply_softstop_snapshot_presence_patch");
const previousPatch = require("./apply_softstop_incomplete_checkpoint_patch");
const fingerprint = require("./finalize_bundle_identity");
const { LATER, revertAfter } = require("./later_bundle_patches");

const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
const bundle = fs.readFileSync(bundlePath, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-softstop-presence-"));

try {
  assert.equal(fingerprint.verify(bundle).ok, true);
  const layer = patch.revertBundle(bundle);
  assert.equal(patch.patchBundle(layer), bundle, "replay reproduces the sealed layer");
  assert.equal(patch.revertBundle(bundle), layer, "inverse restores the prior layer");
  assert.equal(previousPatch.patchBundle(layer), layer, "previous patch remains byte-idempotent");

  const nonce = "a".repeat(32);
  const stateDir = path.join(tmp, "snapshot.dta.state");
  fs.mkdirSync(stateDir, { recursive: true });
  const snapshot = { path: path.join(tmp, "snapshot.dta"), stateDir, checkpointNonce: nonce };
  fs.writeFileSync(path.join(stateDir, "snapshot.ready"), `ready\t${nonce}\tdata\n`);

  assert.equal(core.classifyRestoreSnapshot(null).kind, "none");
  assert.equal(core.classifyRestoreSnapshot({}).kind, "none");
  const missing = core.classifyRestoreSnapshot(snapshot);
  assert.equal(missing.kind, "missing");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing or unreadable/);

  fs.writeFileSync(snapshot.path, Buffer.alloc(512, 1));
  assert.equal(core.classifyRestoreSnapshot(snapshot).kind, "present");
  fs.unlinkSync(snapshot.path);

  const planSource = bundle.slice(bundle.indexOf("globalThis.__codexSoftStop=async"));
  const planAt = planSource.indexOf("let __codexRestoreSnapshot=");
  const planEnd = planSource.indexOf("if(!__codexRestorePlan.dispatch)", planAt);
  assert.ok(planAt >= 0 && planEnd > planAt, "presence plan wired before restore arbitration");
  const plan = planSource.slice(planAt, planEnd);
  function evaluatePlan(target) {
    const ctx = vm.createContext({
      __snapshot: target,
      __codexPayloadAdmittedAtStop: true,
      __codexStopCheckpointRef: core,
      __codexStataString: null,
      globalThis: null,
    });
    ctx.globalThis = ctx;
    vm.runInContext(`globalThis.__testPlan=(function(){${plan}return __codexRestorePlan})()`, ctx);
    return ctx.__testPlan;
  }
  const missingPlan = evaluatePlan(snapshot);
  assert.equal(missingPlan.dispatch, false);
  assert.equal(missingPlan.restore.ok, false);
  assert.equal(missingPlan.restore.continuityLost, true);
  // Terminal/selection Stop has no pre-run snapshot.  It must retain the
  // existing quiescence/hard-reset branch rather than enter the assignment
  // path that requires __snapshot.path.
  const snapshotlessPlan = evaluatePlan(null);
  assert.equal(snapshotlessPlan.dispatch, true);
  const unreadyStateDir = path.join(tmp, "unready.dta.state");
  fs.mkdirSync(unreadyStateDir, { recursive: true });
  const unready = { path: path.join(tmp, "unready.dta"), stateDir: unreadyStateDir, checkpointNonce: nonce };
  const unreadyPlan = evaluatePlan(unready);
  assert.equal(unreadyPlan.dispatch, true);

  console.log("SOFTSTOP_SNAPSHOT_PRESENCE_PASS", JSON.stringify({ missing: "RECOVERY_FAILED", present: "restore-plan" }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
