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

const WRAP_START = "globalThis.__codexSoftStopRestoreFence=";
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

// Stand-in for the pre-wrapper soft Stop, reproducing the live snapshotless
// escalation: it throws, and its catch tail runs the automatic force reset,
// which reconnects and (the defect) reopens READY and clears recovery.
function makeInnerSoftStop(options, log, g, control) {
  return async (reason) => {
    log.push(["softStop", String(reason)]);
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
      return { ok: false, restored: false, recoveryClass: "RECOVERY_FAILED",
               hardEscalated: true, runId: options.runId || null,
               error: "snapshotless backend not quiescent", reason: String(reason) };
    }
    if (options.mode === "throws") throw new Error(options.message || "soft stop exploded");
    if (options.mode === "degraded") {
      return { ok: true, restored: true, recoveryClass: "RECOVERED_DEGRADED", runId: options.runId || null };
    }
    return { ok: true, restored: true, recoveryClass: "RECOVERED_FULL", runId: options.runId || null };
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
  const sandbox = {
    globalThis: g, __codexControl: control, RI: () => {},
    __codexGraphMark: g.__codexGraphMark, console, require,
  };
  g.__codexControl = control;
  vm.runInNewContext(wrapSegment(source), sandbox);
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
    const r = await runSoftStop(bundle, { mode: "escalate", reason, runId: "run_mvxiiqqf_sqas2crq" });
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
    const r = await runSoftStop(bundle, { mode: "throws", message: "cancel_task never returned" });
    assert.equal(r.threw, "cancel_task never returned", "the original error still propagates");
    assert.equal(r.g.__codexContinuityLost.reason, "soft-stop-threw-without-restore");
    assert.match(r.g.__codexContinuityLost.detail, /cancel_task never returned/);
    assert.equal(r.verdict.ready, false);
    assert.equal(r.g.__codexRecoveryState.required, true);
  }

  // A degraded recovery is not a restore either (estimates/graphs lost).
  {
    const r = await runSoftStop(bundle, { mode: "degraded", runId: "r-deg" });
    assert.equal(r.g.__codexContinuityLost.reason, "soft-stop-did-not-restore-checkpoint");
    assert.match(r.g.__codexContinuityLost.detail, /RECOVERED_DEGRADED/);
    assert.equal(r.verdict.ready, false);
  }

  // A real full restore must not be blocked: no false positive.
  {
    const r = await runSoftStop(bundle, { mode: "full", runId: "r-ok" });
    assert.equal(r.g.__codexContinuityLost, undefined, "a full restore sets no continuityLost");
    assert.equal(r.g.__codexRecoveryState, undefined, "a full restore requests no recovery");
    assert.equal(r.verdict.ready, true, "a full restore stays ready");
    assert.equal(r.g.__codexLastSoftStopRestoreVerdict.restored, true);
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
