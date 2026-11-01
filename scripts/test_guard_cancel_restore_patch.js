"use strict";

// Executes the F2 bundle segments, not string checks: the fence init block, the
// fence itself, and the trueReady gate are cut out of dist/extension.js and run
// in node:vm with stubs.  Every assertion is re-run against the pre-patch
// bundle (patch reverted = commit 4854832b bytes) as a negative control.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_guard_cancel_restore_patch");
const fingerprint = require("./finalize_bundle_identity");

const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");

assert.ok(bundle.includes(patch.MARKER), "F2 marker is in the shipped bundle");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "F2 patch is idempotent");
const reverted = patch.revertBundle(bundle);
assert.equal(reverted.includes(patch.MARKER), false, "revert removes the marker");
assert.equal(patch.patchBundle(reverted), fingerprint.finalize(bundle).text,
  "revert-then-patch reproduces the bundle byte for byte");
assert.equal(bundle.includes('"' + patch.MARKER), false, "marker is outside string literals");
assert.equal(bundle.includes(patch.MARKER + '"'), false, "marker is outside string literals");

// --- segment extraction -------------------------------------------------
function cut(source, start, end) {
  const a = source.indexOf(start);
  if (a < 0) throw new Error("segment start missing: " + start.slice(0, 40));
  if (source.indexOf(start, a + 1) >= 0) throw new Error("segment start not unique");
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw new Error("segment end missing");
  return source.slice(a, b);
}

function fenceSegment(source) {
  return cut(source, "globalThis.__codexGuardCancelRef=require(", patch.MARKER);
}

function trueReadySegment(source) {
  const start = "function __codexTrueReadyStatus(bridgeState, baseStatus)";
  const at = source.indexOf(start);
  if (at < 0) throw new Error("trueReady missing");
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error("unbalanced trueReady");
}

// --- fence harness ------------------------------------------------------
// Runs the real bundle fence with a stubbed soft Stop / control plane.
async function runFence(source, input, stop) {
  const calls = [];
  const control = {
    requestRecovery: (state, reason) => { calls.push(["requestRecovery", reason]); return { required: true, reason, generation: 1, token: "t" }; },
  };
  const sandbox = {
    globalThis: {
      __codexRestoreReadinessRef: {
        begin: (id) => calls.push(["begin", String(id)]),
        fail: (id, why) => calls.push(["fail", String(id), String(why)]),
        reset: (why) => calls.push(["reset", why]),
      },
      __codexSoftStop: async (reason) => {
        calls.push(["softStop", reason]);
        if (stop && stop.throws) throw new Error(stop.throws);
        return stop ? stop.record : null;
      },
      __codexGraphMark: (mark) => calls.push(["graphMark", mark.readinessReason, mark.readinessState]),
    },
    __codexControl: control,
    __codexGraphMark: (mark) => calls.push(["graphMark", mark.readinessReason, mark.readinessState]),
    rg: path,
    yC: { extensionUri: { fsPath: root } },
    require,
    console,
  };
  sandbox.globalThis.__codexControl = control;
  vm.runInNewContext(fenceSegment(source), sandbox);
  const g = sandbox.globalThis;
  assert.equal(typeof g.__codexGuardCancelFence, "function", "fence installed");
  const verdict = await g.__codexGuardCancelFence(input);
  return { verdict, calls, g };
}

// The Windows W-P2 input: long_boot.do, 60 s silent, cancelled at 63 s.
const WP2 = {
  policy: "PROGRESS", runId: "f2-stop1", sourceMode: "visible-bridge",
  outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED",
  state: { runId: "f2-stop1", stallReason: "IDLE", elapsedMs: 63000, error: null },
};
// The Windows W-P1 input: MCP -32001 on a cold session.
const WP1 = {
  policy: "PROGRESS", runId: "f1-cold", sourceMode: "terminal-input",
  outcome: "EXEC_REJECTED", settlement: "NOT_NEEDED",
  errorText: "MCP tool run_command_background failed: MCP error -32001: Request timed out",
  state: { runId: "f1-cold", elapsedMs: 68000 },
};
const FULL = { record: { recoveryClass: "RECOVERED_FULL", restored: true, ok: true } };
const FAILED = { record: { recoveryClass: "RECOVERY_FAILED", restored: false, ok: false } };

async function main() {
  // W-P2, snapshot present and restored: soft Stop ran, recovery smoke required.
  {
    const { verdict, calls, g } = await runFence(bundle, WP2, FULL);
    assert.equal(verdict.restore, true, "a guard cancel routes through the restore rule");
    assert.equal(verdict.restored, true);
    const kinds = calls.map((c) => c[0]);
    assert.ok(kinds.includes("begin"), "restore readiness opened before the restore");
    assert.ok(kinds.includes("softStop"), "the soft-Stop restore path executed");
    assert.ok(kinds.includes("requestRecovery"), "READY waits for the recovery smoke");
    assert.equal(g.__codexContinuityLost, undefined, "a full restore is not a continuity loss");
    assert.equal(g.__codexRecoveryState.required, true, "the next submit is refused");
    assert.match(String(calls.find((c) => c[0] === "softStop")[1]), /guard cancel/);
    assert.equal(g.__codexLastGuardCancelRestore.verdict.reasonCode, "EXEC_PRELOG_STALL");
  }

  // W-P2, restore failed: continuityLost and a failed restore readiness.
  {
    const { verdict, calls, g } = await runFence(bundle, WP2, FAILED);
    assert.equal(verdict.restored, false);
    assert.ok(g.__codexContinuityLost, "a failed restore sets continuityLost");
    assert.equal(g.__codexContinuityLost.reason, "guard-cancel-checkpoint-not-restored");
    assert.ok(calls.some((c) => c[0] === "fail"), "restore readiness is failed, not left ready");
    assert.equal(g.__codexRecoveryState.required, true);
  }

  // W-P2, no snapshot at all (soft Stop returns null): still fail closed.
  {
    const { g } = await runFence(bundle, WP2, { record: null });
    assert.equal(g.__codexContinuityLost.reason, "guard-cancel-restore-unavailable");
    assert.equal(g.__codexRecoveryState.required, true);
  }

  // W-P2, soft Stop itself throws: fail closed, never silently ready.
  {
    const { g } = await runFence(bundle, WP2, { throws: "restore exploded" });
    assert.equal(g.__codexContinuityLost.reason, "guard-cancel-restore-threw");
    assert.match(g.__codexContinuityLost.detail, /restore exploded/);
    assert.equal(g.__codexRecoveryState.required, true);
  }

  // W-P1: the transport timed out after dispatch. Outcome unknown, pending.
  {
    const { verdict, g } = await runFence(bundle, WP1, FULL);
    assert.equal(verdict.transportTimeout, true);
    assert.equal(verdict.outcomeUnknown, true, "a post-dispatch timeout is not a plain failure");
    assert.equal(verdict.reasonCode, "EXEC_OUTCOME_UNKNOWN");
    const gate = g.__codexPendingOutcomesRef.gate();
    assert.ok(gate, "the request is pending until it settles or is cancelled");
    assert.equal(gate.ready, false);
    assert.equal(gate.runId, "f1-cold");
    assert.match(gate.reason, /may still run/);
    assert.equal(g.__codexRecoveryState.required, true, "the next submit cannot run on top of it");
    // Settling the request releases the gate; the smoke path clears it too.
    g.__codexPendingOutcomesRef.settle("f1-cold", "transport-settled");
    assert.equal(g.__codexPendingOutcomesRef.gate(), null);
  }

  // A real Stata error after dispatch stays a plain failure: no restore.
  {
    const { verdict, calls, g } = await runFence(bundle, {
      ...WP1, errorText: "variable mpg not found",
    }, FULL);
    assert.equal(verdict.restore, false, "a genuine Stata error is not an unknown outcome");
    assert.equal(calls.some((c) => c[0] === "softStop"), false, "no restore for a real error");
    assert.equal(g.__codexPendingOutcomesRef.gate(), null);
    assert.equal(g.__codexRecoveryState, undefined);
  }

  // Internal guard policies must not recurse into soft Stop.
  for (const policy of ["RECOVERY", "SHORT_INTERNAL"]) {
    const { verdict, calls } = await runFence(bundle, { ...WP2, policy }, FULL);
    assert.equal(verdict.restore, false, policy + " must not restore");
    assert.equal(calls.some((c) => c[0] === "softStop"), false, policy + " must not call soft Stop");
  }

  // The trueReady gate from the bundle refuses a pending unknown outcome.
  {
    const gateText = trueReadySegment(bundle);
    const pending = require("./guard_cancel_restore_core").createPendingOutcomes();
    const bridge = { busy: false, postRunBusy: false };
    const global = {
      __codexBridgeState: bridge,
      __codexGraphPanelDiag: { readinessState: "ready", readinessRunId: "r", lastRunId: "r" },
      __codexGuardIdentityVerdict: () => null,
      __codexPendingOutcomesRef: pending,
    };
    const trueReady = new Function("globalThis", gateText + "; return __codexTrueReadyStatus;")(global);
    assert.equal(trueReady(bridge, "idle").ready, true, "a clean session is ready");
    pending.open("f1-cold", { reason: "transport timed out; it may still run in Stata" });
    const blocked = trueReady(bridge, "idle");
    assert.equal(blocked.ready, false, "a pending unknown outcome closes trueReady");
    assert.equal(blocked.status, "outcome-unknown");
    assert.match(blocked.reason, /may still run/);
    pending.clear("recovery-smoke-verified");
    assert.equal(trueReady(bridge, "idle").ready, true, "the smoke clears the gate");
    // Fail closed: an unreadable registry still blocks.
    global.__codexPendingOutcomesRef = { gate: () => { throw new Error("registry broken"); } };
    const threw = trueReady(bridge, "idle");
    assert.equal(threw.ready, false, "a throwing gate fails closed");
    assert.equal(threw.status, "outcome-unknown");
  }

  // --- negative control: the same probes on the pre-patch (4854832b) bundle --
  // The fence does not exist there, and the trueReady gate ignores a pending
  // unknown outcome, which is exactly the W-P2/W-P1 defect.
  const control = [];
  assert.throws(() => fenceSegment(reverted), /segment start missing/,
    "the pre-patch bundle has no fence segment to execute");
  control.push("fence absent before the patch");
  {
    const gateText = trueReadySegment(reverted);
    const pending = require("./guard_cancel_restore_core").createPendingOutcomes();
    const bridge = { busy: false, postRunBusy: false };
    const global = {
      __codexBridgeState: bridge,
      __codexGraphPanelDiag: { readinessState: "ready", readinessRunId: "r", lastRunId: "r" },
      __codexGuardIdentityVerdict: () => null,
      __codexPendingOutcomesRef: pending,
    };
    const trueReady = new Function("globalThis", gateText + "; return __codexTrueReadyStatus;")(global);
    pending.open("f1-cold", { reason: "transport timed out; it may still run in Stata" });
    const old = trueReady(bridge, "idle");
    assert.equal(old.ready, true,
      "pre-patch trueReady stays open with a payload of unknown outcome (the defect)");
    control.push("pre-patch trueReady ignores a pending unknown outcome");
  }
  assert.equal(reverted.includes("guard_cancel_restore_core.js"), false);
  assert.equal(reverted.includes("EXEC_OUTCOME_UNKNOWN"), false);
  control.push("pre-patch bundle has neither the core require nor the unknown code");
  return control;
}

main().then((control) => {
  console.log("PASS guard cancel restore patch: fence executes the W-P2 restore rule and the W-P1 unknown outcome");
  for (const line of control) console.log("  negative control (4854832b): " + line);
}).catch((error) => { console.error(error); process.exitCode = 1; });
