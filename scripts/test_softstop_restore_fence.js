"use strict";

// P3.  Live evidence on main 06e3886c (15:32 Taipei, f2-p3break1.json): the
// pre-run snapshot was renamed away, /soft-stop escalated with
// "soft-stop escalation: snapshotless backend not quiescent", the automatic
// force reset inside that escalation connected a fresh mcp-stata, and the
// bridge then reported trueReady=true with recoveryRequired=false.  The next
// Terminal input ran and printed `F2_PROBE c(N)=0 k=0 pre=`: the human's data
// was silently lost.
//
// This test executes the shipped soft-Stop wrapper and the shipped
// __codexTrueReadyStatus out of dist/extension.js in node:vm.  It covers all
// three callers (Stop button, HTTP /soft-stop, guard fence) because they all go
// through the one `globalThis.__codexSoftStop`, and it drives the snapshotless
// escalation including the force reset.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_guard_cancel_restore_patch");

const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const reverted = patch.revertBundle(bundle);

function cut(source, start, end, label) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, "segment missing (" + label + ")");
  assert.equal(source.indexOf(start, a + 1), -1, "segment not unique (" + label + ")");
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, "segment end missing (" + label + ")");
  return source.slice(a, b);
}

const WRAP_START = "globalThis.__codexSoftStopExpectation=";
function wrapSegment(source) {
  return cut(source, WRAP_START, patch.MARKER, "soft-stop wrapper");
}
function trueReadySegment(source) {
  const start = "function __codexTrueReadyStatus(bridgeState, baseStatus)";
  const at = source.indexOf(start);
  assert.ok(at >= 0, "trueReady missing");
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error("unbalanced trueReady");
}

// The shipped force-reset tail, from F0's reset through the statement after it.
function forceResetTail(source) {
  const needle = 'globalThis.__codexPendingOutcomesRef.clear("force-reset-complete")';
  const at = source.indexOf(needle);
  assert.ok(at >= 0, "force-reset clear is present");
  const start = source.lastIndexOf("if(!__needsSmoke&&__reconnect", at);
  const endNeedle = "}catch{}let __state=__current();";
  const end = source.indexOf(endNeedle, at) + endNeedle.length;
  assert.ok(start >= 0 && end > start, "force-reset tail bounds");
  return source.slice(start, end);
}

// Stand-in for the pre-wrapper soft Stop, reproducing the live snapshotless
// escalation: it throws, and its catch tail runs the automatic force reset,
// which reconnects and (the defect) reopens READY and clears recovery.
function makeInnerSoftStop(options, log, g, control) {
  // The real soft Stop publishes globalThis.__codexLastSoftStop before
  // returning; the wrapper annotates that record with its decision.
  const publish = (record) => { g.__codexLastSoftStop = record; return record; };
  return async (reason) => {
    log.push(["softStop", String(reason)]);
    // F-1 cases: legitimate snapshotless successes. The bundle's own branches.
    if (options.mode === "warmup") {
      // rc.7.67 warmup: __codexWarmupSkipsQuiescence() true, nothing dispatched.
      return publish({ ok: true, restored: false, recoveryClass: "RECOVERED_FULL", runId: options.runId || null,
               drained: true, restore: { ok: true, skipped: "no pre-run dataset snapshot",
                 quiescenceProbe: { skipped: "Stata was still starting; no payload dispatched" } } });
    }
    if (options.mode === "snapshotless-quiescent") {
      // rc.7.10.4: no snapshot, but the probe proved the backend idle.
      return publish({ ok: true, restored: false, recoveryClass: "RECOVERED_FULL", runId: options.runId || null,
               drained: true, restore: { ok: true, skipped: "no pre-run dataset snapshot",
                 quiescenceProbe: { ok: true, rc: 0, logPath: "/tmp/q.log" } } });
    }
    if (options.mode === "snapshotless-probe-failed") {
      // The probe could not prove quiescence: restore.ok false, escalated.
      return publish({ ok: false, restored: false, recoveryClass: "RECOVERY_FAILED", hardEscalated: true,
               runId: options.runId || null,
               restore: { ok: false, skipped: "no pre-run dataset snapshot", escalated: true,
                          initialError: "snapshotless soft-stop quiescence probe failed" } });
    }
    if (options.mode === "escalate") {
      // The real tail: restoreReadiness.fail, then __codexForceReset(...).
      try { g.__codexRestoreReadinessRef.fail(null, "snapshotless backend not quiescent"); } catch {}
      log.push(["forceReset", "soft-stop escalation: snapshotless backend not quiescent"]);
      // F0's force-reset tail, guarded by the shipped patch: needsSmoke is
      // false here because continuityLost was never set before the escalation.
      const needsSmoke = !!g.__codexContinuityLost;
      const reconnect = { ok: true };
      g.__codexRecoveryState = control.clearRecovery(g.__codexRecoveryState, { runId: null });
      if (!needsSmoke && reconnect.ok === true && !g.__codexSoftStopInFlight) {
        g.__codexRestoreReadinessRef.reset("force-reset-complete");
        log.push(["pendingCleared", "force-reset-complete"]);
      }
      return publish({ ok: false, restored: false, recoveryClass: "RECOVERY_FAILED",
               hardEscalated: true, runId: options.runId || null,
               restore: { ok: false, path: options.snapshotPath || "/tmp/pre.dta", escalated: true,
                          initialError: "snapshotless backend not quiescent" },
               error: "snapshotless backend not quiescent", reason: String(reason) });
    }
    if (options.mode === "throws") throw new Error(options.message || "soft stop exploded");
    if (options.mode === "degraded") {
      return publish({ ok: true, restored: true, recoveryClass: "RECOVERED_DEGRADED", runId: options.runId || null });
    }
    return publish({ ok: true, restored: true, recoveryClass: "RECOVERED_FULL", runId: options.runId || null });
  };
}

async function runSoftStop(source, options) {
  const log = [];
  const control = {
    requestRecovery: (state, reason) => { log.push(["requestRecovery", reason]); return { required: true, reason, generation: 2, token: "tok" }; },
    clearRecovery: (state) => { log.push(["clearRecovery"]); return { required: false, reason: null, generation: 2, token: null }; },
    ensureRecoveryState: (state) => state || { required: false, generation: 0, token: null },
  };
  const readiness = { ready: true, reason: null };
  const g = {
    __codexGuardCancelRef: require("./guard_cancel_restore_core"),
    __codexRestoreReadinessRef: {
      begin: (id) => { readiness.ready = false; log.push(["begin", String(id)]); },
      fail: (id, why) => { readiness.ready = false; readiness.reason = String(why); log.push(["fail", String(why)]); },
      reset: (why) => { readiness.ready = true; readiness.reason = null; log.push(["reset", why]); },
      status: () => ({ ready: readiness.ready, reason: readiness.reason, status: readiness.ready ? "ready" : "stale" }),
    },
    __codexGraphMark: (mark) => log.push(["graphMark", mark.readinessReason]),
    __codexBridgeState: { busy: false, postRunBusy: false },
    __codexGraphPanelDiag: { readinessState: "ready", readinessRunId: "r", lastRunId: "r" },
    __codexGuardIdentityVerdict: () => null,
  };
  g.__codexSoftStop = makeInnerSoftStop(options, log, g, control);
  // The shipped expectation helper reads the real registry, so build it here.
  // Agent visible-bridge and human-file runs register a snapshot; ordinary
  // human Terminal/selection runs do not.
  const runId = options.runId || "run-x";
  g.__codexBridgeState.runId = runId;
  g.__codexPreRunSnapshots = new Map();
  g.__codexActivePreRunSnapshot = null;
  if (options.snapshotRegistered) {
    const snapshot = { runId, path: options.snapshotPath || "/tmp/pre.dta",
                       payloadAdmitted: options.payloadAdmitted !== false };
    g.__codexPreRunSnapshots.set(runId, snapshot);
    g.__codexActivePreRunSnapshot = snapshot;
  }
  const sandbox = {
    globalThis: g, __codexControl: control, RI: () => {},
    __codexGraphMark: g.__codexGraphMark, console, require,
    // The helper resolves the lifecycle runId through this module-local.
    __codexExecution: { ensureLifecycle: (s) => ({ runId: s && s.runId }) },
  };
  g.__codexControl = control;
  vm.runInNewContext(wrapSegment(source), sandbox);
  assert.equal(typeof g.__codexSoftStopExpectation, "function", "expectation helper installed");
  assert.equal(typeof g.__codexSoftStopRestoreFence, "function", "restore fence installed");
  let threw = null;
  try { await g.__codexSoftStop(options.reason || "http /soft-stop"); }
  catch (error) { threw = String(error && error.message); }
  // Now ask the shipped trueReady gate, with the state the wrapper left behind.
  const gateText = trueReadySegment(source);
  const trueReady = new Function("globalThis", gateText + "; return __codexTrueReadyStatus;")(g);
  const verdict = trueReady(g.__codexBridgeState, "idle");
  return { log, g, threw, verdict, readiness };
}

(async () => {
  // --- the live P3 case: snapshotless soft Stop, automatic force reset -------
  for (const reason of ["http /soft-stop", "terminal Stop button", "guard cancel: EXEC_PRELOG_STALL"]) {
    const r = await runSoftStop(bundle, { mode: "escalate", reason, runId: "run_mvxiiqqf_sqas2crq",
      snapshotRegistered: true, snapshotOnDisk: false, payloadAdmitted: true });
    const kinds = r.log.map((e) => e[0]);
    assert.ok(kinds.includes("forceReset"), "the escalation ran its automatic force reset (" + reason + ")");
    assert.ok(r.g.__codexContinuityLost, "continuityLost is set after a soft Stop that did not restore (" + reason + ")");
    assert.equal(r.g.__codexContinuityLost.reason, "soft-stop-did-not-restore-checkpoint");
    assert.equal(r.g.__codexContinuityLost.requiresExplicitReset, true);
    assert.equal(r.g.__codexContinuityLost.escalated, true, "the record notes the escalation");
    assert.match(r.g.__codexContinuityLost.detail, /force reset replaced the backend, not the data/);
    assert.equal(r.g.__codexContinuityLost.source, reason, "the record names who asked");
    // The automatic force reset must not be the thing that reopens READY.
    assert.equal(r.verdict.ready, false, "trueReady stays closed (" + reason + ")");
    assert.equal(r.verdict.status, "continuity-lost");
    assert.equal(r.g.__codexRecoveryState.required, true, "the next submit is refused (" + reason + ")");
    assert.match(String(r.g.__codexRecoveryState.reason), /soft-stop-needs-smoke/);
    assert.ok(r.log.some((e) => e[0] === "fail"), "restore readiness ends failed, not reset");
    // The automatic reset happened before the fence; the fence is the last word.
    const lastReadiness = r.log.filter((e) => e[0] === "reset" || e[0] === "fail").pop();
    assert.equal(lastReadiness[0], "fail", "the last readiness write is the block, not the reset");
    // And the escalation's own force reset was not allowed to clear pending.
    assert.equal(r.log.some((e) => e[0] === "pendingCleared"), false,
      "the in-flight escalation's force reset does not count as a user reset");
  }

  // soft Stop that threw outright: same block, different reason code.
  {
    const r = await runSoftStop(bundle, { mode: "throws", message: "cancel_task never returned",
      runId: "r-throw", snapshotRegistered: true, snapshotOnDisk: true, payloadAdmitted: true });
    assert.equal(r.threw, "cancel_task never returned", "the original error still propagates");
    assert.equal(r.g.__codexContinuityLost.reason, "soft-stop-threw-without-restore");
    assert.match(r.g.__codexContinuityLost.detail, /cancel_task never returned/);
    assert.equal(r.verdict.ready, false);
    assert.equal(r.g.__codexRecoveryState.required, true);
  }

  // A degraded recovery is not a restore either (estimates/graphs lost).
  {
    const r = await runSoftStop(bundle, { mode: "degraded", runId: "r-deg",
      snapshotRegistered: true, snapshotOnDisk: true, payloadAdmitted: true });
    assert.equal(r.g.__codexContinuityLost.reason, "soft-stop-did-not-restore-checkpoint");
    assert.match(r.g.__codexContinuityLost.detail, /RECOVERED_DEGRADED/);
    assert.equal(r.verdict.ready, false);
  }

  // A real full restore must not be blocked: no false positive.
  {
    const r = await runSoftStop(bundle, { mode: "full", runId: "r-ok",
      snapshotRegistered: true, snapshotOnDisk: true, payloadAdmitted: true });
    assert.equal(r.g.__codexContinuityLost, undefined, "a full restore sets no continuityLost");
    assert.equal(r.g.__codexRecoveryState, undefined, "a full restore requests no recovery");
    assert.equal(r.verdict.ready, true, "a full restore stays ready");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.restored, true);
  }

  // --- F-1: the fence must not fire when there is nothing to lose ----------
  // (a) An ordinary human Terminal/selection run registers no pre-run snapshot
  //     (the bundle registers them only for agent visible-bridge
  //     codex_prerun_agent_state_* and human-file codex_prerun_state_* runs).
  //     A human who types a long command and presses Stop must stay READY.
  for (const reason of ["terminal Stop button", "http /soft-stop"]) {
    const r = await runSoftStop(bundle, { mode: "snapshotless-quiescent", reason,
      runId: "debug_terminal_human_1", snapshotRegistered: false });
    assert.equal(r.g.__codexSoftStopExpectation().snapshotExpected, false,
      "a human Terminal run registers no snapshot (" + reason + ")");
    assert.equal(r.g.__codexContinuityLost, undefined,
      "a human Stop with no registered snapshot is not fenced (" + reason + ")");
    assert.equal(r.g.__codexRecoveryState, undefined, "no recovery is requested (" + reason + ")");
    assert.equal(r.verdict.ready, true, "the human session stays READY (" + reason + ")");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.fenced, false);
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.fenceReason, "snapshotless-quiescence-proved");
    assert.equal(r.g.__codexLastSoftStop.fenced, false, "the decision is recorded in lastSoftStop");
    assert.equal(r.g.__codexLastSoftStop.snapshotExpected, false);
  }

  // (b) A Stop during warmup: the bundle itself says no payload was dispatched.
  {
    const r = await runSoftStop(bundle, { mode: "warmup", runId: "run-warm", snapshotRegistered: false });
    assert.equal(r.g.__codexContinuityLost, undefined, "a warmup Stop is not fenced");
    assert.equal(r.verdict.ready, true, "warmup Stop stays READY");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.fenceReason, "warmup-no-payload-dispatched");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.warmupNoPayload, true);
    assert.equal(r.g.__codexRecoveryState, undefined);
  }

  // (c) Still closed for the escalated snapshotless path: restore.ok === false.
  //     This is the case the reviewer's suggested wording would have reopened.
  {
    const r = await runSoftStop(bundle, { mode: "snapshotless-probe-failed", runId: "run-noq",
      snapshotRegistered: false });
    assert.ok(r.g.__codexContinuityLost, "a failed quiescence probe is still fenced");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.fenceReason, "restore-failed");
    assert.equal(r.verdict.ready, false);
    assert.equal(r.g.__codexRecoveryState.required, true);
  }

  // (d) A snapshot was expected for this run but is gone: fenced even though
  //     the stop reports a snapshotless success shape (the P3 shape).
  {
    const r = await runSoftStop(bundle, { mode: "snapshotless-quiescent", runId: "run_agent_1",
      snapshotRegistered: true, snapshotOnDisk: false, payloadAdmitted: true });
    const expect = r.g.__codexSoftStopExpectation();
    assert.equal(expect.snapshotExpected, true, "the registry says a snapshot was expected");
    assert.equal(expect.snapshotClass, "registered", "the registry entry is what marks it expected");
    assert.ok(r.g.__codexContinuityLost, "an expected-but-missing snapshot is fenced");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.fenceReason, "snapshot-expected-not-restored");
    assert.equal(r.verdict.ready, false);
    assert.equal(r.g.__codexRecoveryState.required, true);
  }

  // --- F-3 / M1: the automatic-vs-user reset guard, executed --------------
  // M1 (survived all 8 suites in review r1) drops `&&!globalThis
  // .__codexSoftStopInFlight` from the force-reset tail, which lets the
  // automatic force reset inside a soft-Stop escalation clear the
  // pending-outcome fence.  This runs the shipped force-reset tail twice on the
  // same state: once inside the escalation window, once as a user reset.
  {
    const tail = forceResetTail(bundle);
    function runTail(inFlight, reason) {
      const core = require("./guard_cancel_restore_core");
      const pending = core.createPendingOutcomes();
      pending.open("f1-cold", { reason: "transport timed out; it may still run in Stata" });
      const resets = [];
      const g = {
        __codexSoftStopInFlight: inFlight,
        __codexPendingOutcomesRef: pending,
        __codexRestoreReadinessRef: { reset: (why) => resets.push(why) },
        __codexControl: { requestRecovery: (s, why) => ({ required: true, reason: why }) },
      };
      const fn = new Function("globalThis", "__reconnect", "__needsSmoke", "__smokeReason",
        "__codexGraphMark", "__current", "o",
        "try{" + tail + ";return {state:__state};");
      fn(g, { ok: true }, false, reason, () => {}, () => ({ ready: true }), reason);
      return { pending: pending.status().pending, resets };
    }
    // The reason used here is outside the needs-smoke regex, so the guard is
    // the only thing that can decide (the reviewer's isolating scenario).
    const automatic = runTail("http /soft-stop", "soft-stop escalation: snapshotless backend not quiescent");
    assert.equal(automatic.pending, 1,
      "M1: the automatic force reset inside a soft-Stop escalation must not clear the pending fence");
    assert.deepEqual(automatic.resets, [],
      "M1: it must not reset restore readiness either");
    const userReset = runTail(null, "user force reset");
    assert.equal(userReset.pending, 0, "an explicit user force reset does clear it");
    assert.deepEqual(userReset.resets, ["force-reset-complete"],
      "and it does reset restore readiness");
  }

  // --- negative control: main 06e3886c / 4854832b bundle --------------------
  const control = [];
  assert.throws(() => wrapSegment(reverted), /segment missing/,
    "the pre-patch bundle has no soft-Stop restore fence");
  control.push("soft-Stop wrapper absent before the patch");
  {
    // Reproduce the live sequence against the pre-patch trueReady: the
    // escalation's force reset leaves no continuityLost and no recovery, so the
    // gate reports ready and the next submit runs on an empty dataset.
    const log = [];
    const control2 = {
      requestRecovery: (s, why) => ({ required: true, reason: why }),
      clearRecovery: () => ({ required: false, reason: null, generation: 2, token: null }),
      ensureRecoveryState: (s) => s || { required: false, generation: 0, token: null },
    };
    const g = {
      __codexBridgeState: { busy: false, postRunBusy: false },
      __codexGraphPanelDiag: { readinessState: "ready", readinessRunId: "r", lastRunId: "r" },
      __codexGuardIdentityVerdict: () => null,
      __codexRestoreReadinessRef: { status: () => ({ ready: true, reason: null, status: "ready" }) },
      __codexControlPlane: control2,
    };
    // No wrapper exists, so nothing sets continuityLost for the failed restore.
    g.__codexRecoveryState = control2.clearRecovery(null);
    const gateText = trueReadySegment(reverted);
    const trueReady = new Function("globalThis", gateText + "; return __codexTrueReadyStatus;")(g);
    const verdict = trueReady(g.__codexBridgeState, "idle");
    assert.equal(verdict.ready, true,
      "pre-patch: a soft Stop that lost the data still reports trueReady (the P3 defect)");
    assert.equal(g.__codexRecoveryState.required, false,
      "pre-patch: recoveryRequired=false, exactly as f2-p3break1.json recorded");
    control.push("pre-patch trueReady=true and recoveryRequired=false after a snapshotless soft Stop");
    void log;
  }
  assert.equal(reverted.includes("__codexSoftStopRestoreFence"), false);
  assert.equal(reverted.includes("__codexSoftStopInFlight"), false);
  control.push("pre-patch bundle has neither the fence nor the in-flight guard");

  console.log("PASS soft-stop restore fence: a soft Stop that did not restore ends continuity-lost for all three callers");
  for (const line of control) console.log("  negative control (06e3886c / 4854832b): " + line);
})().catch((error) => { console.error(error); process.exitCode = 1; });
