"use strict";

// F2 W-P2 / W-P1.  Two product defects share one rule.
//
// W-P2: the execution guard cancelled an already dispatched payload
// ("[exec-guard] PROGRESS stall (IDLE); bounded cancel").  Stata was left at
// the half-run state, the pre-run checkpoint was deleted unused and trueReady
// stayed open, so the next submit ran on post-run data.
//
// W-P1: a transport timeout (MCP -32001 "Request timed out") was reported as a
// plain failure, but the payload may already have reached mcp-stata; on Windows
// the code ran in Stata 80 s after the client was told it had failed.
//
// Both mean: a dispatched payload left no trusted outcome.  Route it through
// the same restore-readiness rule as soft Stop and report the honest outcome.
//
// Pure module: no vscode, no transport, no fs.  The bundle fence injects state.

// Guard outcome codes that mean "the dispatched payload was cut short".
const CANCEL_OUTCOMES = new Set([
  "EXEC_PRELOG_STALL",     // PROGRESS stall: PRE_LOG / IDLE / HARD_BUDGET
  "PRE_RUN_STAGE_TIMEOUT", // ABSOLUTE timeout
  "EXEC_CANCEL_TIMEOUT",   // bounded cancel never confirmed
  "EXEC_DRAIN_FAILED",     // transport promise never settled
]);

// Only these guard policies wrap a payload that mcp-stata executes.  RECOVERY
// and SHORT_INTERNAL wrap the restore/quiescence work this fence itself drives;
// treating them as dispatched payloads would recurse.
const DISPATCH_POLICIES = new Set(["PROGRESS", "ABSOLUTE"]);

// Settlements that prove what happened to the payload.
const SETTLED = new Set(["CANCELLED", "DRAINED", "NOT_NEEDED"]);

const TRANSPORT_TIMEOUT = /Request timed out|-32001|RequestTimeout|ETIMEDOUT/i;

const UNKNOWN_CODE = "EXEC_OUTCOME_UNKNOWN";
const UNKNOWN_MESSAGE = "transport timed out after the payload was dispatched; it may still run in Stata";

function text(value) {
  return String(value == null ? "" : value);
}

function isTransportTimeout(value) {
  return TRANSPORT_TIMEOUT.test(text(value));
}

// Decide what a failed guard result means for readiness and for the client.
function classifyGuardFailure(input = {}) {
  const policy = text(input.policy);
  const outcome = text(input.outcome);
  const settlement = text(input.settlement);
  const errorText = text(input.errorText);
  const dispatched = input.dispatched === true;
  const verdict = {
    policy, outcome: outcome || null, settlement: settlement || null, dispatched,
    restore: false, outcomeUnknown: false, transportTimeout: isTransportTimeout(errorText),
    reasonCode: outcome || null, reason: null,
  };
  if (!DISPATCH_POLICIES.has(policy) || !dispatched) return verdict;
  const cancelled = CANCEL_OUTCOMES.has(outcome);
  if (!cancelled && !verdict.transportTimeout) return verdict;
  verdict.restore = true;
  // The payload's fate is established only by a confirmed cancel or a settled
  // transport.  A transport timeout never establishes it.
  verdict.outcomeUnknown = verdict.transportTimeout || !SETTLED.has(settlement);
  verdict.reasonCode = verdict.outcomeUnknown ? UNKNOWN_CODE : (outcome || "EXEC_GUARD_CANCEL");
  verdict.reason = verdict.outcomeUnknown
    ? UNKNOWN_MESSAGE
    : "guard cancelled the dispatched payload (" + (outcome || "unknown") + ")";
  return verdict;
}

// Did soft Stop actually put the pre-run checkpoint back?
function restoreEstablished(stopRecord) {
  if (!stopRecord) return false;
  return stopRecord.recoveryClass === "RECOVERED_FULL"
    && stopRecord.restored === true
    && stopRecord.ok !== false;
}

function continuityNote(verdict, stopRecord, stopError) {
  const why = stopError
    ? "guard-cancel-restore-threw"
    : (stopRecord ? "guard-cancel-checkpoint-not-restored" : "guard-cancel-restore-unavailable");
  const detail = stopError
    ? text(stopError)
    : (stopRecord
      ? ("guard cancel did not restore the pre-run checkpoint (" + text(stopRecord.recoveryClass || "unknown") + ")")
      : "guard cancel could not run the checkpoint restore path");
  return {
    reason: why,
    detail,
    outcome: (verdict && verdict.outcome) || null,
    outcomeUnknown: !!(verdict && verdict.outcomeUnknown),
    recoveryClass: (stopRecord && stopRecord.recoveryClass) || "RECOVERY_FAILED",
  };
}

// P3.  Any soft Stop that did not put the checkpoint back is a continuity loss,
// whoever asked for it (Stop button, HTTP /soft-stop, or the guard fence).
//
// Live evidence on main 06e3886c: the snapshot was renamed away, /soft-stop
// escalated ("soft-stop escalation: snapshotless backend not quiescent"), the
// automatic force reset inside that escalation reconnected a fresh mcp-stata,
// and because continuityLost had never been set the force reset decided no
// smoke was needed and reopened READY.  trueReady=true, recoveryRequired=false,
// and the next Terminal input printed c(N)=0 k=0: the human's data was gone.
//
// The automatic force reset inside the escalation is not a user reset, so it
// must not be what clears the block.
// F-2.  The only reset that clears this is a force reset followed by the
// recovery smoke.  The status-bar flame ("Stata: KILL") runs the force reset and
// now also runs the smoke once the reconnect succeeds, so confirming it is one
// human action.  POST /recovery-smoke alone is a no-op while continuityLost is
// set, which is what the README used to tell people to do.
const RESET_STEPS = 'click the "Stata: KILL" status-bar item and confirm '
  + "(it force-resets the backend and then runs the recovery smoke), "
  + "or POST /force-reset followed by POST /recovery-smoke";

// F-1.  Not every unrestored soft Stop has something to lose.  `restored` in
// the bundle is `!!(restore && restore.path && restore.ok)`, so it needs a
// snapshot *path*: the legitimate snapshotless successes (a Stop during warmup,
// where the bundle itself says "no payload dispatched", and a Stop whose
// quiescence probe proved the backend idle) are false by construction.  Fencing
// those would put an ordinary human Terminal/selection run — which registers no
// pre-run snapshot at all — into recovery-required until a destructive force
// reset.  That must not ship.
//
// The rule keys on whether a snapshot was *expected* for this run, not on
// whether `restore` happens to carry a path.  `expectation` is captured before
// the stop runs, from __codexPreRunSnapshots / __codexActivePreRunSnapshot.
//
// Fence when any of these holds:
//   (i)   a snapshot was expected for this run and was not restored;
//   (ii)  the stop escalated to a force reset while a payload was dispatched;
//   (iii) restore.ok === false (the P3 escalation: probe failed or restore failed).
// Do not fence when no snapshot was registered and the quiescence probe passed,
// nor when warmup reports that no payload was dispatched.
function classifySoftStopRestore(stopRecord, stopError, expectation = {}) {
  const restored = restoreEstablished(stopRecord);
  const restore = (stopRecord && stopRecord.restore) || null;
  const probe = (restore && restore.quiescenceProbe) || null;
  const snapshotExpected = expectation.snapshotExpected === true
    || !!(restore && typeof restore.path === "string" && restore.path);
  const payloadDispatched = expectation.payloadDispatched === true;
  const escalated = !!(stopRecord && (stopRecord.hardEscalated === true || stopRecord.forceReset != null))
    || !!(restore && restore.escalated === true);
  // Warmup: the bundle's own branch says Stata was still starting.
  const warmupNoPayload = !!(probe && typeof probe.skipped === "string"
    && /no payload dispatched/i.test(probe.skipped));
  // rc.7.10.4: a snapshotless Stop that proved the backend quiescent is clean.
  const quiescenceProved = !!(probe && probe.ok === true)
    && !!(restore && restore.ok === true) && !escalated;
  const restoreFailed = !!(restore && restore.ok === false) || stopError != null;

  const verdict = {
    restored,
    snapshotExpected,
    payloadDispatched,
    escalated,
    warmupNoPayload,
    quiescenceProved,
    restoreFailed,
    reason: stopRecord ? text(stopRecord.reason) || null : null,
    recoveryClass: (stopRecord && stopRecord.recoveryClass) || (stopError ? "RECOVERY_FAILED" : null),
    fenced: false,
    fenceReason: null,
    continuityLost: null,
  };
  if (restored) {
    verdict.fenceReason = "restored";
    return verdict;
  }
  // The three fence conditions, in the order they are reported.
  if (restoreFailed) verdict.fenceReason = "restore-failed";
  else if (snapshotExpected) verdict.fenceReason = "snapshot-expected-not-restored";
  else if (escalated && payloadDispatched) verdict.fenceReason = "escalated-after-dispatch";
  verdict.fenced = verdict.fenceReason != null;
  if (!verdict.fenced) {
    // Nothing was at risk: no snapshot was registered for this run and either
    // warmup never dispatched a payload or the quiescence probe passed.
    verdict.fenceReason = warmupNoPayload
      ? "warmup-no-payload-dispatched"
      : (quiescenceProved ? "snapshotless-quiescence-proved" : "nothing-to-restore");
    return verdict;
  }
  // An escalation that ended in a force reset looks "ok" to the old gate: the
  // backend is fresh and quiescent.  Freshness is not the pre-run dataset.
  const detail = stopError
    ? ("soft Stop failed and did not restore the pre-run checkpoint: " + text(stopError))
    : (stopRecord
      ? ("soft Stop ended " + text(stopRecord.recoveryClass || "without a restore")
        + " and did not restore the pre-run checkpoint"
        + (verdict.escalated ? "; the automatic force reset replaced the backend, not the data" : ""))
      : "soft Stop produced no result, so the pre-run checkpoint was not restored");
  verdict.continuityLost = {
    reason: stopError ? "soft-stop-threw-without-restore" : "soft-stop-did-not-restore-checkpoint",
    detail,
    recoveryClass: verdict.recoveryClass || "RECOVERY_FAILED",
    escalated: verdict.escalated,
    fenceReason: verdict.fenceReason,
    snapshotExpected,
    requiresExplicitReset: true,
    automaticForceResetIsNotAReset: true,
    // F-2: name the real way out, not half of it.
    howToClear: RESET_STEPS,
  };
  return verdict;
}

// Client-visible envelope for a dispatched payload with no trusted outcome.
function unknownEnvelope(verdict, context = {}) {
  return {
    ok: false,
    status: Number(context.status) || 504,
    error: UNKNOWN_CODE,
    reasonCode: UNKNOWN_CODE,
    outcome: (verdict && verdict.outcome) || null,
    outcomeUnknown: true,
    payloadDispatched: true,
    payloadMayHaveRun: true,
    message: (verdict && verdict.reason) || UNKNOWN_MESSAGE,
    transportTimeout: !!(verdict && verdict.transportTimeout),
    policy: context.policy == null ? null : String(context.policy),
    runId: context.runId == null ? null : String(context.runId),
    sourceMode: context.sourceMode == null ? null : String(context.sourceMode),
    elapsedMs: Number.isFinite(context.elapsedMs) ? context.elapsedMs : null,
    transportError: context.message == null ? null : String(context.message),
    recoveryRequired: true,
  };
}

// Rewrite an existing guard envelope in place, keeping its evidence fields.
function annotateEnvelope(envelope, verdict) {
  if (!envelope || !verdict) return envelope;
  envelope.guardCancelRestore = {
    restore: !!verdict.restore,
    restored: verdict.restored === true,
    reasonCode: verdict.reasonCode || null,
  };
  if (verdict.restore) envelope.recoveryRequired = true;
  if (!verdict.outcomeUnknown) return envelope;
  envelope.outcomeUnknown = true;
  envelope.payloadMayHaveRun = true;
  envelope.payloadDispatched = true;
  envelope.transportTimeout = !!verdict.transportTimeout;
  envelope.message = verdict.reason || UNKNOWN_MESSAGE;
  envelope.transportOutcome = envelope.error || null;
  envelope.error = UNKNOWN_CODE;
  envelope.reasonCode = UNKNOWN_CODE;
  if (!Number(envelope.status) || Number(envelope.status) < 500) envelope.status = 504;
  return envelope;
}

// Requests whose outcome is unknown keep the session closed until they settle
// or are cancelled.  Fail closed: an unreadable entry still blocks.
function createPendingOutcomes(options = {}) {
  const now = options.now || (() => Date.now());
  const entries = new Map();
  function key(runId) {
    return runId == null ? "__null__" : String(runId);
  }
  function open(runId, record = {}) {
    const id = key(runId);
    entries.set(id, {
      runId: runId == null ? null : String(runId),
      openedAt: now(),
      reason: text(record.reason) || UNKNOWN_MESSAGE,
      outcome: record.outcome == null ? null : String(record.outcome),
      sourceMode: record.sourceMode == null ? null : String(record.sourceMode),
    });
    return list();
  }
  function settle(runId, how) {
    const id = key(runId);
    if (!entries.has(id)) return list();
    entries.delete(id);
    return list();
  }
  function clear(_reason) {
    entries.clear();
    return list();
  }
  function list() {
    return [...entries.values()];
  }
  function status() {
    const open_ = list();
    return { pending: open_.length, entries: open_ };
  }
  function gate() {
    const open_ = list();
    if (open_.length === 0) return null;
    const first = open_[0];
    return {
      ready: false,
      status: "outcome-unknown",
      reason: first.reason || UNKNOWN_MESSAGE,
      runId: first.runId,
      pending: open_.length,
    };
  }
  return { open, settle, clear, list, status, gate };
}

module.exports = {
  CANCEL_OUTCOMES, DISPATCH_POLICIES, UNKNOWN_CODE, UNKNOWN_MESSAGE,
  isTransportTimeout, classifyGuardFailure, restoreEstablished, continuityNote,
  classifySoftStopRestore, RESET_STEPS, unknownEnvelope, annotateEnvelope, createPendingOutcomes,
};
