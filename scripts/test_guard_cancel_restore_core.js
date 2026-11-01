"use strict";

// Unit coverage for the pure F2 decision module.
const assert = require("node:assert/strict");
const core = require("./guard_cancel_restore_core");

// W-P2: the exact Windows case — PROGRESS stall (IDLE), bounded cancel confirmed.
const stall = core.classifyGuardFailure({
  policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED",
  errorText: "", dispatched: true,
});
assert.equal(stall.restore, true, "a confirmed guard cancel must restore");
assert.equal(stall.outcomeUnknown, false, "a confirmed cancel has a known outcome");
assert.equal(stall.reasonCode, "EXEC_PRELOG_STALL");

// A cancel that never confirmed leaves the outcome unknown as well.
for (const settlement of ["CANCEL_TIMEOUT", "DRAIN_FAILED", "", null]) {
  const v = core.classifyGuardFailure({
    policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement, dispatched: true,
  });
  assert.equal(v.restore, true);
  assert.equal(v.outcomeUnknown, true, "unsettled transport -> outcome unknown: " + settlement);
  assert.equal(v.reasonCode, core.UNKNOWN_CODE);
}

for (const outcome of ["PRE_RUN_STAGE_TIMEOUT", "EXEC_CANCEL_TIMEOUT", "EXEC_DRAIN_FAILED"]) {
  const v = core.classifyGuardFailure({ policy: "PROGRESS", outcome, settlement: "CANCELLED", dispatched: true });
  assert.equal(v.restore, true, outcome + " must restore");
}

// W-P1: MCP -32001 after dispatch. Rejected, never cancelled, outcome unknown.
const cold = core.classifyGuardFailure({
  policy: "PROGRESS", outcome: "EXEC_REJECTED", settlement: "NOT_NEEDED",
  errorText: "MCP tool run_command_background failed: MCP error -32001: Request timed out",
  dispatched: true,
});
assert.equal(cold.transportTimeout, true);
assert.equal(cold.restore, true, "a post-dispatch transport timeout must restore");
assert.equal(cold.outcomeUnknown, true, "a transport timeout never establishes the outcome");
assert.equal(cold.reasonCode, core.UNKNOWN_CODE);
assert.match(cold.reason, /may still run/);

// A plain Stata error after dispatch is a real failure: no restore, no unknown.
const realError = core.classifyGuardFailure({
  policy: "PROGRESS", outcome: "EXEC_REJECTED", settlement: "NOT_NEEDED",
  errorText: "variable mpg not found", dispatched: true,
});
assert.equal(realError.restore, false);
assert.equal(realError.outcomeUnknown, false);

// Internal guard policies must never re-enter the fence (recursion fence).
for (const policy of ["RECOVERY", "SHORT_INTERNAL"]) {
  const v = core.classifyGuardFailure({
    policy, outcome: "EXEC_PRELOG_STALL", settlement: "CANCEL_TIMEOUT",
    errorText: "Request timed out", dispatched: true,
  });
  assert.equal(v.restore, false, policy + " must not trigger a restore");
}
// An undispatched payload is already refused upstream.
assert.equal(core.classifyGuardFailure({
  policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED", dispatched: false,
}).restore, false);

// Restore verdict: only a full, restored, non-failed soft Stop counts.
assert.equal(core.restoreEstablished({ recoveryClass: "RECOVERED_FULL", restored: true, ok: true }), true);
assert.equal(core.restoreEstablished({ recoveryClass: "RECOVERED_DEGRADED", restored: true, ok: true }), false);
assert.equal(core.restoreEstablished({ recoveryClass: "RECOVERED_FULL", restored: false, ok: true }), false);
assert.equal(core.restoreEstablished({ recoveryClass: "RECOVERY_FAILED", restored: false }), false);
assert.equal(core.restoreEstablished(null), false, "no soft Stop record -> not restored");

// continuityNote distinguishes a failed restore from an unavailable one.
assert.equal(core.continuityNote(stall, null, null).reason, "guard-cancel-restore-unavailable");
assert.equal(core.continuityNote(stall, { recoveryClass: "RECOVERY_FAILED" }, null).reason,
  "guard-cancel-checkpoint-not-restored");
assert.equal(core.continuityNote(stall, null, "boom").reason, "guard-cancel-restore-threw");

// The client envelope says "may still run", not "failed".
const envelope = core.unknownEnvelope(cold, { policy: "PROGRESS", runId: "r1", sourceMode: "visible-bridge", status: 504, message: "Request timed out" });
assert.equal(envelope.ok, false);
assert.equal(envelope.error, core.UNKNOWN_CODE);
assert.equal(envelope.outcomeUnknown, true);
assert.equal(envelope.payloadMayHaveRun, true);
assert.equal(envelope.recoveryRequired, true);
assert.equal(envelope.status, 504);

// annotateEnvelope keeps the guard evidence and rewrites only the verdict.
const annotated = core.annotateEnvelope({ ok: false, status: 504, error: "EXEC_PRELOG_STALL", stallReason: "IDLE", cancelHitLevel: 1 }, cold);
assert.equal(annotated.error, core.UNKNOWN_CODE);
assert.equal(annotated.transportOutcome, "EXEC_PRELOG_STALL");
assert.equal(annotated.stallReason, "IDLE", "guard evidence survives");
assert.equal(annotated.recoveryRequired, true);
const known = core.annotateEnvelope({ ok: false, status: 504, error: "EXEC_PRELOG_STALL" }, stall);
assert.equal(known.error, "EXEC_PRELOG_STALL", "a known outcome keeps its code");
assert.equal(known.recoveryRequired, true);

// Pending outcomes gate: open blocks, settle and clear release, fail closed.
const pending = core.createPendingOutcomes({ now: () => 7 });
assert.equal(pending.gate(), null);
pending.open("r1", { reason: "may still run", outcome: "EXEC_REJECTED" });
const gate = pending.gate();
assert.equal(gate.ready, false);
assert.equal(gate.status, "outcome-unknown");
assert.equal(gate.runId, "r1");
pending.open("r2", { reason: "may still run" });
assert.equal(pending.gate().pending, 2);
pending.settle("r1", "transport-settled");
assert.equal(pending.gate().pending, 1);
pending.settle("missing", "noop");
assert.equal(pending.gate().pending, 1, "settling an unknown run changes nothing");
pending.clear("recovery-smoke-verified");
assert.equal(pending.gate(), null);
assert.equal(pending.status().pending, 0);
pending.open(null, { reason: "null run id still blocks" });
assert.equal(pending.gate().ready, false);

// P3: any soft Stop that did not restore the checkpoint is a continuity loss.
// The live case — snapshotless /soft-stop, escalation, automatic force reset.
const escalated = core.classifySoftStopRestore({
  ok: false, restored: false, recoveryClass: "RECOVERY_FAILED", hardEscalated: true,
  restore: { ok: false, path: "/tmp/pre.dta", escalated: true, initialError: "missing" },
  error: "snapshotless backend not quiescent",
}, null, { snapshotExpected: true, payloadDispatched: true });
assert.equal(escalated.restored, false);
assert.equal(escalated.escalated, true);
assert.equal(escalated.fenced, true);
assert.equal(escalated.fenceReason, "restore-failed");
assert.equal(escalated.continuityLost.reason, "soft-stop-did-not-restore-checkpoint");
assert.equal(escalated.continuityLost.requiresExplicitReset, true);
assert.equal(escalated.continuityLost.automaticForceResetIsNotAReset, true);
assert.match(escalated.continuityLost.detail, /force reset replaced the backend, not the data/);

// A thrown soft Stop.
const threwStop = core.classifySoftStopRestore(null, "cancel_task never returned", {});
assert.equal(threwStop.continuityLost.reason, "soft-stop-threw-without-restore");
assert.match(threwStop.continuityLost.detail, /cancel_task never returned/);

// No record at all, but a snapshot was expected for the run: fenced.
assert.equal(core.classifySoftStopRestore(null, null, { snapshotExpected: true }).continuityLost.reason,
  "soft-stop-did-not-restore-checkpoint");
// No record and nothing was expected: not fenced (F-1).
const bare = core.classifySoftStopRestore(null, null, {});
assert.equal(bare.fenced, false);
assert.equal(bare.continuityLost, null);
assert.equal(bare.fenceReason, "nothing-to-restore");

// Degraded recovery restored the dataset but lost estimates/graphs: still lost
// when a snapshot was expected for the run.
const degraded = core.classifySoftStopRestore(
  { ok: true, restored: true, recoveryClass: "RECOVERED_DEGRADED", restore: { ok: true, path: "/tmp/pre.dta" } },
  null, { snapshotExpected: true, payloadDispatched: true });
assert.equal(degraded.restored, false);
assert.equal(degraded.fenced, true);
assert.equal(degraded.fenceReason, "snapshot-expected-not-restored");
assert.match(degraded.continuityLost.detail, /RECOVERED_DEGRADED/);
assert.equal(degraded.continuityLost.escalated, false);

// F-1: the three legitimate snapshotless successes must not be fenced.
const warmupStop = core.classifySoftStopRestore({
  ok: true, restored: false, recoveryClass: "RECOVERED_FULL",
  restore: { ok: true, skipped: "no pre-run dataset snapshot",
             quiescenceProbe: { skipped: "Stata was still starting; no payload dispatched" } },
}, null, {});
assert.equal(warmupStop.fenced, false, "a warmup Stop has no payload to lose");
assert.equal(warmupStop.fenceReason, "warmup-no-payload-dispatched");
assert.equal(warmupStop.continuityLost, null);

const quiescentStop = core.classifySoftStopRestore({
  ok: true, restored: false, recoveryClass: "RECOVERED_FULL",
  restore: { ok: true, skipped: "no pre-run dataset snapshot", quiescenceProbe: { ok: true, rc: 0 } },
}, null, {});
assert.equal(quiescentStop.fenced, false, "a proven-quiescent snapshotless Stop is clean");
assert.equal(quiescentStop.fenceReason, "snapshotless-quiescence-proved");

// But the same shape with a snapshot that was expected for the run is fenced:
// this is what the reviewer's suggested wording would have reopened.
const expectedButGone = core.classifySoftStopRestore({
  ok: true, restored: false, recoveryClass: "RECOVERED_FULL",
  restore: { ok: true, skipped: "no pre-run dataset snapshot", quiescenceProbe: { ok: true, rc: 0 } },
}, null, { snapshotExpected: true, payloadDispatched: true });
assert.equal(expectedButGone.fenced, true, "an expected-but-missing snapshot is still a loss");
assert.equal(expectedButGone.fenceReason, "snapshot-expected-not-restored");

// A failed quiescence probe (restore.ok false) stays fenced with no snapshot.
const probeFailed = core.classifySoftStopRestore({
  ok: false, restored: false, recoveryClass: "RECOVERY_FAILED", hardEscalated: true,
  restore: { ok: false, skipped: "no pre-run dataset snapshot", escalated: true,
             initialError: "snapshotless soft-stop quiescence probe failed" },
}, null, {});
assert.equal(probeFailed.fenced, true, "an unproven backend is fenced even with no snapshot");
assert.equal(probeFailed.fenceReason, "restore-failed");

// F-2: the record names the real way out, both steps.
assert.match(core.RESET_STEPS, /Stata: KILL/);
assert.match(core.RESET_STEPS, /recovery smoke/);
assert.equal(expectedButGone.continuityLost.howToClear, core.RESET_STEPS);

// A genuine full restore is not blocked.
const fullStop = core.classifySoftStopRestore(
  { ok: true, restored: true, recoveryClass: "RECOVERED_FULL", restore: { ok: true, path: "/tmp/pre.dta" } },
  null, { snapshotExpected: true });
assert.equal(fullStop.restored, true);
assert.equal(fullStop.continuityLost, null);

console.log("PASS guard cancel restore core: cancel outcomes, transport timeout, recursion fence, envelopes, pending gate, soft-stop restore rule");
