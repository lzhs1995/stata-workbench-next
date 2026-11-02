#!/usr/bin/env node
"use strict";

// F fix5: W-P10 (guard cancel names its own stall) and the W-P1b / W-P9m root
// cause (an event for an unknown task is not given to another run while a run
// that never learned its task id may still execute). Cases run real bundle
// methods in node:vm; the layer before the patch must get them wrong.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_guard_attribution_patch");
const fingerprint = require("./finalize_bundle_identity");
const core = require("./guard_cancel_restore_core");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_guard_attribution_patch";
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

// ---- W-P10: core --------------------------------------------------------
const idle = core.classifyGuardFailure({ policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED",
  dispatched: true, firstLogSeen: true, stallReason: "IDLE", elapsedMs: 118200 });
assert.equal(idle.reasonCode, "EXEC_PRELOG_STALL", "the client-facing code is unchanged");
assert.equal(idle.stallReason, "IDLE");
assert.equal(core.reasonLabel(idle), "EXEC_PRELOG_STALL (IDLE)");
assert.match(idle.reason, /EXEC_PRELOG_STALL, IDLE/);
const preLog = core.classifyGuardFailure({ policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED",
  dispatched: true, firstLogSeen: true, stallReason: "PRE_LOG" });
assert.equal(core.reasonLabel(preLog), "EXEC_PRELOG_STALL", "a real pre-log stall keeps its old label");
assert.equal(core.classifyGuardFailure({ policy: "PROGRESS", outcome: "EXEC_PRELOG_STALL", settlement: "CANCELLED",
  dispatched: true, stallReason: "bogus" }).stallReason, null, "unknown stall reasons are not echoed");
const rec = core.failureRecord(idle, { runId: "run_wd", sourceMode: "agent", now: () => 0 });
assert.deepEqual([rec.runId, rec.sourceMode, rec.stallReason, rec.elapsedMs, rec.label],
  ["run_wd", "agent", "IDLE", 118200, "EXEC_PRELOG_STALL (IDLE)"]);

// ---- W-P10: the real fence, W3 watchdog shape ---------------------------
// A Terminal PRE_LOG failure is on record; then an agent IDLE cancel arrives.
async function fence(source, input, g) {
  const seg = cut(source, "globalThis.__codexGuardCancelFence=async(__fenceInput)=>{",
    "if(!__verdict.restore)return __verdict;", "guard-cancel fence head");
  const ctx = { out: null, Number, String, Date, globalThis: g };
  vm.createContext(ctx);
  g.__codexGuardCancelRef = core;
  vm.runInContext("(function(globalThis){" + seg + "return __verdict};out=globalThis.__codexGuardCancelFence})(globalThis)", ctx);
  return ctx.out(input);
}
(async () => {
  const W3_TERMINAL = { reasonCode: "EXEC_PRELOG_STALL", runId: "debug_terminal_1793627424813_vnq9kysi32j", elapsedMs: 120917 };
  const input = { policy: "PROGRESS", runId: "run_mvzcrqzk_x5vhrrjn", sourceMode: "agent", outcome: "EXEC_PRELOG_STALL",
    settlement: "CANCELLED", state: { firstLogAt: 1793628000000, stallReason: "IDLE", elapsedMs: 118200 } };
  const g = { __codexLastTerminalFailure: { ...W3_TERMINAL } };
  const v = await fence(bundle, input, g);
  assert.equal(v.stallReason, "IDLE", "the fence passes the guard's stall reason");
  assert.equal(g.__codexLastGuardFailure.runId, "run_mvzcrqzk_x5vhrrjn", "lastGuardFailure is this cancel");
  assert.equal(g.__codexLastGuardFailure.elapsedMs, 118200, "with its own elapsedMs, not the Terminal 120917");
  assert.equal(g.__codexLastGuardFailure.label, "EXEC_PRELOG_STALL (IDLE)");
  assert.equal(g.__codexLastTerminalFailure.supersededBy.runId, "run_mvzcrqzk_x5vhrrjn", "the old Terminal record says it is not current");
  const gOld = { __codexLastTerminalFailure: { ...W3_TERMINAL } };
  const vOld = await fence(before, input, gOld);
  assert.equal(vOld.stallReason, null, "the previous fence dropped the stall reason");
  assert.equal(gOld.__codexLastGuardFailure, undefined, "the previous fence kept no per-cancel record");
  // The Stop and recovery reasons use the label.
  assert.ok(bundle.includes(patch.NEW_STOP_REASON) && bundle.includes(patch.NEW_RECOVERY_REASON));
  assert.ok(bundle.includes("lastGuardFailure:globalThis.__codexLastGuardFailure||null,"), "/status shows lastGuardFailure");

  // ---- attribution: real client methods, W3 cold-start event order ------
  // Real methods: _onLoggingMessage (whole), _withActiveRun, _awaitBackgroundResult and,
  // in the patched layer, the orphan helpers. Their neighbours are stubbed.
  function method(source, start, nextStart) {
    const at = source.indexOf(start);
    assert.ok(at >= 0 && source.indexOf(start, at + 1) < 0, "method missing or not unique: " + start);
    const end = source.indexOf(nextStart, at + start.length);
    assert.ok(end > at, "method end missing: " + start);
    return source.slice(at, end);
  }
  function onLogging(source) {
    const at = source.indexOf("_onLoggingMessage(A,I){");
    const end = source.indexOf("},yF=null;", at);
    assert.ok(at >= 0 && end > at, "_onLoggingMessage bounds");
    // "},yF=null;" is the class's closing brace; the slice stops before it.
    return source.slice(at, end);
  }
  function client(source) {
    const patched = source.includes("_orphanOpen(A){");
    const parts = [onLogging(source),
      method(source, "async _withActiveRun(A,I){", "_appendBounded(A,I,Q){"),
      method(source, "async _awaitBackgroundResult(A,I,Q,B){", patched ? "_orphanOpen(A){" : "_trackRunForTask(A,I){")];
    if (patched) parts.push(method(source, "_orphanOpen(A){", "_trackRunForTask(A,I){"));
    const log = [];
    const ctx = { out: null, String, Date, JSON, Error, Math, Promise, CI: { captureException() {} } };
    vm.createContext(ctx);
    vm.runInContext("out=class{" + parts.join("") + "}", ctx);
    const c = new ctx.out();
    Object.assign(c, { _runsByTaskId: new Map(), _activeRun: null, _log: m => log.push(m), _maxLogBufferChars: 1e6,
      _tryParseJson: t => { try { return JSON.parse(t); } catch { return null; } },
      _appendBounded: (x, y) => String(x || "") + String(y || ""),
      _scheduleRunCleanup() {}, _attachTaskCancellation() {}, _filterLogChunk: t => t,
      _trackRunForTask(id, run) { this._runsByTaskId.set(String(id), run); },
      _extractLogPathFromResponse: r => (r && r.log_path) || null,
      _extractTaskIdFromResponse: r => (r && r.task_id) || null,
      _parseToolJson: r => r,
      _awaitTaskDone: async (_c, run) => run._taskDonePayload || null,
      _ensureLogTail: async (_c, run, p) => { run.tailed = (run.tailed || []).concat(p); } });
    c.log = log;
    return c;
  }
  const ev = (event, task, p) => ({ params: { data: JSON.stringify({ event, task_id: task, path: p }) } });
  const COLD = "81eae0c32e6e46538ab2d59c2d25f6a0", PROBE = "d99e721e3a6a43e4ba2bdf0de0b1c28f";
  async function w3(source) {
    const c = client(source);
    // The cold-start command is cut off before its response: no task id.
    const cold = { _runId: "debug_terminal_1793627424813" };
    await c._withActiveRun(cold, async () => { throw new Error("Request cancelled"); }).catch(() => {});
    // The quiescence probe: the cancelled command's late log_path arrives first,
    // then the probe's own log_path and task_done, then its response.
    const probe = { _runId: "soft-stop-quiescence-debug_terminal_1793627424813" };
    const result = await c._withActiveRun(probe, async () => {
      c._onLoggingMessage({}, ev("log_path", COLD, "C:/mcp-temp/mcp_stata__vd0tjcs.log"));
      c._onLoggingMessage({}, ev("log_path", PROBE, "C:/mcp-temp/mcp_stata_0s7qnmwq.log"));
      c._onLoggingMessage({}, ev("task_done", PROBE, "C:/mcp-temp/mcp_stata_0s7qnmwq.log"));
      return c._awaitBackgroundResult({}, probe, { task_id: PROBE, log_path: "C:/mcp-temp/mcp_stata_0s7qnmwq.log" }, {});
    });
    return { c, probe, result };
  }
  const fixed = await w3(bundle);
  assert.ok(fixed.c.log.some(m => m.includes("cancelled before it learned its task id")), "the cut-off run is recorded as an orphan");
  assert.ok(!fixed.probe.tailed.includes("C:/mcp-temp/mcp_stata__vd0tjcs.log"), "the probe never tails the cancelled command's log");
  assert.equal(fixed.probe.tailed[0], "C:/mcp-temp/mcp_stata_0s7qnmwq.log", "the probe tails its own log");
  assert.ok(fixed.c.log.some(m => m.includes("dropped log_path for task " + COLD)), "the foreign event is logged as dropped");
  assert.equal(fixed.probe._taskDoneTaskId, PROBE, "the probe's own early task_done is replayed once its id is known");
  assert.equal(fixed.result && fixed.result.task_id, PROBE);
  const old = await w3(before);
  assert.equal(old.probe.tailed[0], "C:/mcp-temp/mcp_stata__vd0tjcs.log", "the previous client gave the probe the cancelled command's log");

  // A run that holds an event of its own gets it on replay.
  const own = client(bundle); own._orphanOpen("x");
  const run = { _runId: "r", taskId: null }; own._activeRun = run;
  own._onLoggingMessage({}, ev("log_path", PROBE, "C:/own.log"));
  assert.equal(run.tailed, undefined, "held, not yet applied");
  run.taskId = PROBE; own._runsByTaskId.set(PROBE, run); own._replayHeld({}, run);
  assert.deepEqual(run.tailed, ["C:/own.log"], "its own held event is applied once the id is known");
  // Without an orphan nothing changes: the active run gets an unknown-id log_path as before.
  const plain = client(bundle); const pr = { _runId: "p", taskId: null }; plain._activeRun = pr;
  plain._onLoggingMessage({}, ev("log_path", PROBE, "C:/p.log"));
  assert.deepEqual(pr.tailed, ["C:/p.log"], "no orphan: old fallback unchanged");
  // The orphan's task_done (seen as a foreign event) ends strict mode.
  const settle = client(bundle); settle._orphanOpen("x");
  const known = { _runId: "k", taskId: PROBE }; settle._activeRun = known; settle._runsByTaskId.set(PROBE, known);
  settle._onLoggingMessage({}, ev("task_done", COLD, null));
  assert.equal(settle._orphanStrict(), false, "the orphan settled on its task_done");

  console.log("test_guard_attribution: OK");
})().catch(e => { console.error(e); process.exit(1); });
