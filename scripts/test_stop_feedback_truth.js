#!/usr/bin/env node
"use strict";

// F fix4: Stop and KILL feedback must match what they did.
// Every case runs real bundle bytes (the patched layer and the layer before it)
// inside node:vm; the "before" layer must get each case wrong, so the test
// cannot pass against a baseline that was already right.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_stop_feedback_truth_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_stop_feedback_truth_patch";
const bundle = revertAfter(fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8"), NAME);
const before = patch.revertBundle(bundle);

assert.equal(fingerprint.verify(bundle).ok, true, "bundle identity verifies");
assert.equal(patch.patchBundle(before), bundle, "replay reproduces the sealed layer");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "patch is byte-idempotent");
assert.ok(bundle.includes(patch.MARKER) && !before.includes(patch.MARKER), "marker only in the patched layer");

function cut(source, start, end, label) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, "segment missing: " + label);
  assert.equal(source.indexOf(start, a + 1), -1, "segment not unique: " + label);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, "segment end missing: " + label);
  return source.slice(a, b + end.length);
}

// ---- F-1: the probe marker must be a whole output line --------------------
function classifySegment(source) {
  // From the result binding (where F fix4 narrows it) through rc.7.76's throw.
  return cut(source, "let __quiescenceResult=__quiescenceAttempt.result;",
    "\"snapshotless soft-stop quiescence probe failed\")", "probe classification");
}
function classify(source, marker, result) {
  const ctx = { __quiescenceCode: `capture noisily display as text "${marker}"\n`, __quiescenceAttempt: { result },
    Number, String, outcome: "ACCEPTED" };
  vm.createContext(ctx);
  vm.runInContext(`try{${classifySegment(source)}}catch(e){outcome="REJECTED"}`, ctx);
  return ctx.outcome;
}
const M = "___CODEX_SOFT_STOP_QUIESCENT_run_1___";
const ECHO = `{com}. capture noisily display as text "${M}"\n`;
const PROBE_CASES = [
  // [name, result, expected after the fix, expected before]
  ["output line after a Break (rc=1)", { success: false, rc: 1, stdout: `. capture noisily display as text "${M}"\n${M}\n` }, "ACCEPTED", "ACCEPTED"],
  ["SMCL output line (Windows log shape)", { success: false, rc: 1, smcl_output: `${ECHO}{res}{txt}${M}\n` }, "ACCEPTED", "ACCEPTED"],
  ["CRLF output line", { success: false, rc: 1, stdout: `${M}\r\n` }, "ACCEPTED", "ACCEPTED"],
  ["rc 0 without any marker", { success: true, rc: 0, stdout: "" }, "ACCEPTED", "ACCEPTED"],
  ["echo only in stdout", { success: false, rc: 1, stdout: `. capture noisily display as text "${M}"\n` }, "REJECTED", "ACCEPTED"],
  ["echo only in SMCL", { success: false, rc: 1, smcl_output: ECHO }, "REJECTED", "ACCEPTED"],
  ["echo only in error.context", { success: false, rc: 1, error: { context: ECHO } }, "REJECTED", "ACCEPTED"],
  ["another run's marker", { success: false, rc: 1, stdout: "___CODEX_SOFT_STOP_QUIESCENT_run_2___\n" }, "REJECTED", "REJECTED"],
  ["cancelled, no output", { success: false, rc: -1, stderr: "Request cancelled" }, "REJECTED", "REJECTED"],
];
let beforeWrong = 0;
for (const [name, result, after, prior] of PROBE_CASES) {
  assert.equal(classify(bundle, M, result), after, "fixed matcher: " + name);
  assert.equal(classify(before, M, result), prior, "previous matcher: " + name);
  if (after !== prior) beforeWrong += 1;
}
assert.equal(beforeWrong, 3, "the previous matcher accepted exactly the three echo-only cases");
// rc.7.76's own bytes are untouched: its replay idempotence check depends on them.
assert.ok(bundle.includes(require("./apply_softstop_quiescence_rc_patch").NEW_CLASSIFY), "rc.7.76 classification kept byte-identical");
// The narrowed copy must not leak: the original result object is not mutated.
{
  const original = { success: false, rc: 1, stdout: `. capture noisily display as text "${M}"\n` };
  const snapshot = JSON.stringify(original);
  classify(bundle, M, original);
  assert.equal(JSON.stringify(original), snapshot, "the probe result object itself is not modified");
}

// ---- P10: a fenced Stop must not claim the checkpoint was restored --------
function stopToast(source, stop, continuityLost) {
  const fn = cut(source, "async function yM(){", "async function OF(g)", "terminal Stop").slice(0, -"async function OF(g)".length);
  const shown = [];
  const ctx = {
    console: { log() {}, error() {} },
    iA: { window: { showWarningMessage: m => shown.push(["warn", m]), showErrorMessage: m => shown.push(["error", m]) } },
    zg: { cancelAll: async () => true },
    String, out: null,
  };
  // Inside the context, globalThis is the sandbox object itself.
  ctx.__codexSoftStop = async () => stop;
  ctx.__codexContinuityLost = continuityLost || null;
  vm.createContext(ctx);
  vm.runInContext(fn + ";out=yM();", ctx);
  return ctx.out.then(() => shown);
}
const RESTORED = "restored the complete pre-run checkpoint";
const LOCKED = "the session is locked. Click Stata: KILL to unlock it.";

(async () => {
  const fenced = { ok: true, restored: false, recoveryClass: "RECOVERED_FULL", fenced: true, fenceReason: "snapshot-expected-not-restored" };
  const toastCases = [
    ["fenced Stop (C4 shape)", fenced, null, LOCKED, RESTORED],
    ["continuityLost set, record not tagged", { ok: true, restored: false, recoveryClass: "RECOVERED_FULL" }, { reason: "soft-stop-did-not-restore-checkpoint" }, LOCKED, RESTORED],
    ["normal restored Stop", { ok: true, restored: true, recoveryClass: "RECOVERED_FULL", fenced: false }, null, RESTORED, RESTORED],
    ["degraded and fenced", { ok: true, restored: false, recoveryClass: "RECOVERED_DEGRADED", fenced: true,
      restore: { degraded: { skippedEstimates: 2, skippedGraphs: 1 } } }, null, LOCKED, "did not restore 2 estimates"],
    ["hard recovery, not fenced", { ok: false, recoveryClass: "RECOVERY_FAILED", fenced: false }, null, "required hard recovery", "required hard recovery"],
  ];
  for (const [name, stop, lost, after, prior] of toastCases) {
    const [[kindA, textA]] = await stopToast(bundle, stop, lost);
    const [[, textB]] = await stopToast(before, stop, lost);
    assert.equal(kindA, "warn", name);
    assert.ok(textA.includes(after), `fixed toast (${name}): ${textA}`);
    assert.ok(textB.includes(prior), `previous toast (${name}): ${textB}`);
  }
  const [[, degradedText]] = await stopToast(bundle, toastCases[3][1], null);
  assert.ok(degradedText.includes("2 estimates and 1 graphs were not restored"), "degraded counts are still reported");
  const [[, fencedBefore]] = await stopToast(before, fenced, null);
  assert.ok(fencedBefore.includes(RESTORED), "the previous toast did claim a restore for a fenced Stop");

  // ---- F-5: a skipped smoke is not a passed smoke -------------------------
  function killToast(source, name, smoke) {
    const start = `iA.window.showInformationMessage(${name}&&${name}.ok`;
    const seg = cut(source, start, "retry Stata: KILL or POST /recovery-smoke.\")", "KILL toast " + name);
    const ctx = { String, shown: null, iA: { window: { showInformationMessage: m => { ctx.shown = m; } } } };
    vm.createContext(ctx);
    ctx[name] = smoke;
    vm.runInContext(seg, ctx);
    return ctx.shown;
  }
  for (const name of ["__smoke", "__winSmoke"]) {
    const passed = killToast(bundle, name, { ok: true, statusCode: 200 });
    assert.ok(passed.includes("verified recovery smoke passed"), name + " real pass");
    const skipped = killToast(bundle, name, { ok: true, skipped: "recovery not required" });
    assert.ok(!skipped.includes("smoke passed"), name + " skipped smoke must not be reported as passed: " + skipped);
    assert.ok(skipped.includes("no recovery smoke ran (recovery not required)"), name + " skipped smoke says so: " + skipped);
    assert.ok(killToast(before, name, { ok: true, skipped: "recovery not required" }).includes("smoke passed"),
      name + " the previous toast did report a skipped smoke as passed");
    const failed = killToast(bundle, name, { ok: false, error: "503" });
    assert.ok(failed.includes("did not pass (503)") && failed.includes("Runs stay refused"), name + " failure unchanged");
    assert.equal(killToast(bundle, name, null), killToast(before, name, null), name + " missing smoke unchanged");
  }
  // ---- W-P1b: the real fence passes whether Stata logged anything ----------
  const core = require("./guard_cancel_restore_core");
  async function fenceVerdict(source, state) {
    const start = "globalThis.__codexGuardCancelFence=async(__fenceInput)=>{";
    const seg = cut(source, start, "globalThis.__codexLastGuardCancelVerdict=__verdict;", "guard-cancel fence");
    const ctx = { out: null };
    ctx.__codexGuardCancelRef = core;
    vm.createContext(ctx);
    vm.runInContext(seg + "return __verdict};out=globalThis.__codexGuardCancelFence;", ctx);
    return ctx.out({ policy: "PROGRESS", runId: "r1", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED", state });
  }
  const r2 = await fenceVerdict(bundle, { firstLogAt: null, stallReason: "PRE_LOG" });
  assert.equal(r2.outcomeUnknown, true, "F-win2 R2 shape (no log before the cancel) is reported as unknown");
  assert.equal(r2.reasonCode, core.UNKNOWN_CODE);
  assert.equal((await fenceVerdict(bundle, { firstLogAt: 1793570300000, stallReason: "IDLE" })).outcomeUnknown, false,
    "a cancel after the payload logged output stays a known cancel");
  assert.equal((await fenceVerdict(bundle, {})).outcomeUnknown, false, "a state without firstLogAt keeps the old rule");
  assert.equal((await fenceVerdict(before, { firstLogAt: null, stallReason: "PRE_LOG" })).outcomeUnknown, false,
    "the previous fence reported the R2 shape as a known cancel");

  console.log("test_stop_feedback_truth: OK");
})().catch(e => { console.error(e); process.exit(1); });
