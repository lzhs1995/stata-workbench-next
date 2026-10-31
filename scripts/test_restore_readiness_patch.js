"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRestoreReadiness } = require("./restore_readiness_core");
const { acquireDecision } = require("./control_plane_core");
const patch = require("./apply_restore_readiness_patch");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
assert.ok(bundle.includes(patch.MARKER));
assert.ok(bundle.includes("restoreReadiness:"));
assert.ok(bundle.includes("checkpoint restore not complete"));
assert.ok(bundle.includes("__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.begin(__runId)"));
assert.ok(bundle.includes("__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.finish(__runId"));
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "F0 patch is idempotent");

function cutFunction(source, start) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, "readiness function is present");
  let brace = source.indexOf("{", at), depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error("unbalanced readiness function");
}

const gateText = cutFunction(bundle, "function __codexTrueReadyStatus(bridgeState, baseStatus)");
const gate = createRestoreReadiness({ now: () => 1 });
const globalState = {
  __codexBridgeState: { busy: false, postRunBusy: false },
  __codexGraphPanelDiag: { readinessState: "ready" },
  __codexRestoreReadinessRef: gate,
  __codexGuardIdentityVerdict: () => null,
};
const ready = new Function("globalThis", gateText + "; return __codexTrueReadyStatus;")(globalState);
assert.equal(ready(globalState.__codexBridgeState, "idle").ready, true);
gate.begin("run-1");
const restoring = ready(globalState.__codexBridgeState, "idle");
assert.equal(restoring.ready, false);
assert.equal(restoring.status, "restoring");
const blockedSubmission = acquireDecision({
  bridge: globalState.__codexBridgeState,
  readiness: restoring,
  recovery: null,
  request: { kind: "normal" },
});
assert.equal(blockedSubmission.ok, false);
assert.equal(blockedSubmission.httpStatus, 423);
assert.equal(blockedSubmission.kind, "not-ready");
gate.finish("run-1", { ready: true });
assert.equal(ready(globalState.__codexBridgeState, "idle").ready, true);
gate.begin("run-2");
gate.fail("run-2", "restore failed");
const failed = ready(globalState.__codexBridgeState, "idle");
assert.equal(failed.ready, false);
assert.match(failed.reason, /restore failed/);
console.log("PASS restore readiness patch: idempotence, status gate, completion, and failure refusal");
