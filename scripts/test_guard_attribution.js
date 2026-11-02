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
    const clock = { now: Date.now() };
    class FakeDate extends Date { static now() { return clock.now; } }
    const ctx = { out: null, String, Date: FakeDate, JSON, Error, Math, Promise, WeakSet, CI: { captureException() {} } };
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
    c.log = log; c.clock = clock;
    // One backend: its transport, and the SDK client _onLoggingMessage receives.
    c._transport = { name: "backend-1" };
    c.mcp = { transport: c._transport };
    return c;
  }
  const progress = (task, text) => ({ params: { data: JSON.stringify({ event: "progress", task_id: task, text }) } });
  const ev = (event, task, p) => ({ params: { data: JSON.stringify({ event, task_id: task, path: p }) } });
  const COLD = "81eae0c32e6e46538ab2d59c2d25f6a0", PROBE = "d99e721e3a6a43e4ba2bdf0de0b1c28f";
  async function w3(source) {
    const c = client(source);
    // The cold-start command is cut off before its response: no task id.
    const cold = { _runId: "debug_terminal_1793627424813" };
    await c._withActiveRun(cold, async () => { throw new Error("Request cancelled"); }).catch(() => {});
    const M = c.mcp;
    // The quiescence probe: the cancelled command's late log_path arrives first,
    // then the probe's own log_path and task_done, then its response.
    const probe = { _runId: "soft-stop-quiescence-debug_terminal_1793627424813" };
    const result = await c._withActiveRun(probe, async () => {
      c._onLoggingMessage(M, ev("log_path", COLD, "C:/mcp-temp/mcp_stata__vd0tjcs.log"));
      c._onLoggingMessage(M, ev("log_path", PROBE, "C:/mcp-temp/mcp_stata_0s7qnmwq.log"));
      c._onLoggingMessage(M, ev("task_done", PROBE, "C:/mcp-temp/mcp_stata_0s7qnmwq.log"));
      return c._awaitBackgroundResult(M, probe, { task_id: PROBE, log_path: "C:/mcp-temp/mcp_stata_0s7qnmwq.log" }, {});
    });
    return { c, probe, result };
  }
  const fixed = await w3(bundle);
  assert.ok(fixed.c.log.some(m => m.includes("ended before it learned its task id")), "the cut-off run is recorded as an orphan");
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
  own._onLoggingMessage(own.mcp, ev("log_path", PROBE, "C:/own.log"));
  assert.equal(run.tailed, undefined, "held, not yet applied");
  run.taskId = PROBE; own._runsByTaskId.set(PROBE, run); own._replayHeld(own.mcp, run);
  assert.deepEqual(run.tailed, ["C:/own.log"], "its own held event is applied once the id is known");
  // Without an orphan nothing changes: the active run gets an unknown-id log_path as before.
  const plain = client(bundle); const pr = { _runId: "p", taskId: null }; plain._activeRun = pr;
  plain._onLoggingMessage(plain.mcp, ev("log_path", PROBE, "C:/p.log"));
  assert.deepEqual(pr.tailed, ["C:/p.log"], "no orphan: old fallback unchanged");

  // ---- review P1: no expiry. The codex-edge-repro scenario, then 24 h -----
  // A different, known task is active; the orphan's late log_path and progress
  // must never bind to it, however long ago the orphan was recorded.
  function lateForeign(source, ageMs) {
    const c = client(source);
    c._orphanOpen ? c._orphanOpen("still-running") : null;
    c.clock.now += ageMs;
    const next = { _runId: "next", taskId: PROBE }; c._activeRun = next; c._runsByTaskId.set(PROBE, next);
    c._onLoggingMessage(c.mcp, ev("log_path", COLD, "C:/foreign-late.log"));
    c._onLoggingMessage(c.mcp, progress(COLD, "foreign progress " + COLD));
    return { c, next };
  }
  for (const age of [600001, 24 * 3600 * 1000]) {
    const r = lateForeign(bundle, age);
    assert.equal(r.next.tailed, undefined, "after " + age + " ms a foreign log_path does not bind to the next task");
    assert.ok(!String(r.next._lineBuffer || "").includes(COLD), "after " + age + " ms foreign progress does not bind either");
    assert.ok(r.c.log.some(m => m.includes("dropped progress for task " + COLD)), "the dropped progress is logged");
  }
  // The previous layer (no orphan tracking) binds both: the shape the review reproduced.
  const prev = lateForeign(before, 600001);
  assert.deepEqual(prev.next.tailed, ["C:/foreign-late.log"], "the previous client bound the foreign log");
  assert.ok(String(prev.next._lineBuffer || "").includes(COLD), "and the foreign progress");

  // ---- review: settled does not decide strictness; several orphans --------
  const multi = client(bundle);
  multi._orphanOpen("o1"); multi._orphanOpen("o2"); multi._orphanOpen("o3");
  const k = { _runId: "k", taskId: PROBE }; multi._activeRun = k; multi._runsByTaskId.set(PROBE, k);
  multi._onLoggingMessage(multi.mcp, ev("task_done", "aaaa", null));
  multi._onLoggingMessage(multi.mcp, ev("task_done", "aaaa", null));
  multi._onLoggingMessage(multi.mcp, ev("task_done", "bbbb", null));
  multi._onLoggingMessage(multi.mcp, ev("task_done", "cccc", null));
  multi._onLoggingMessage(multi.mcp, ev("task_done", "dddd", null));
  assert.equal(multi._attrStrict.stats.orphans, 3);
  assert.equal(multi._attrStrict.stats.settled, 4, "four distinct unknown task_done are counted");
  assert.equal(multi._attrStrict.stats.duplicateDone, 1, "the repeated task_done is counted once as a duplicate");
  assert.equal(multi._strictFor(multi.mcp), true, "more task_done than orphans still leaves attribution strict");
  multi._onLoggingMessage(multi.mcp, ev("log_path", "eeee", "C:/foreign-after-settle.log"));
  assert.equal(k.tailed, undefined, "after every orphan 'settled', a foreign log still does not bind");
  for (let i = 0; i < 40; i++) multi._orphanOpen("n" + i);
  assert.ok(multi._attrStrict.orphans.length <= 32, "the diagnostic orphan list is capped");

  // ---- review: held events are bounded and coalesced ----------------------
  const buf = client(bundle); buf._orphanOpen("x");
  const h = { _runId: "h", taskId: null }; buf._activeRun = h;
  for (let i = 0; i < 5; i++) buf._onLoggingMessage(buf.mcp, progress(PROBE, "p" + i));
  assert.equal(h._heldEvents.length, 1, "progress of one task keeps only the newest");
  assert.ok(JSON.stringify(h._heldEvents[0].ev).includes("p4"), "the kept progress is the newest");
  assert.equal(buf._attrStrict.stats.coalesced, 4);
  buf._onLoggingMessage(buf.mcp, ev("log_path", PROBE, "C:/h.log"));
  buf._onLoggingMessage(buf.mcp, ev("task_done", PROBE, "C:/h.log"));
  for (let i = 0; i < 300; i++) buf._onLoggingMessage(buf.mcp, progress("t" + i, "q"));
  assert.ok(h._heldEvents.length <= 256, "the held buffer never exceeds 256");
  assert.ok(buf._attrStrict.stats.overflow > 0, "overflow is counted");
  assert.ok(h._heldEvents.some(x => x.e === "log_path") && h._heldEvents.some(x => x.e === "task_done"),
    "log_path and task_done survive while progress can be dropped");
  assert.ok(buf.log.some(m => m.includes("is full (256); dropped progress")), "overflow is logged");
  // A buffer of only log_path: the newest is dropped, the held ones stay.
  const full = client(bundle); full._orphanOpen("x");
  const f = { _runId: "f", taskId: null }; full._activeRun = f;
  for (let i = 0; i < 257; i++) full._onLoggingMessage(full.mcp, ev("log_path", "L" + i, "C:/l" + i + ".log"));
  assert.equal(f._heldEvents.length, 256);
  assert.equal(f._heldEvents[0].t, "L0", "the oldest log_path is kept");
  assert.equal(f._heldEvents[255].t, "L255", "the newest one is the one dropped");

  // ---- strict mode ends when the backend is replaced ----------------------
  const rs = client(bundle); rs._orphanOpen("x");
  const oldMcp = rs.mcp;
  rs._transport = { name: "backend-2" }; const newMcp = { transport: rs._transport };
  const cur = { _runId: "cur", taskId: null }; rs._activeRun = cur;
  rs._onLoggingMessage(oldMcp, ev("log_path", COLD, "C:/old-backend.log"));
  assert.equal(cur.tailed, undefined, "an event from the old backend is still held");
  rs._onLoggingMessage(newMcp, ev("log_path", PROBE, "C:/new-backend.log"));
  assert.deepEqual(cur.tailed, ["C:/new-backend.log"], "the new backend's event gets the old fallback");
  assert.equal(rs._strictFor(newMcp), false);
  assert.equal(rs._strictFor(oldMcp), true);
  // Transport unknown when the orphan was recorded: strict for every backend of this client.
  const unk = client(bundle); unk._transport = null; unk._orphanOpen("x");
  assert.equal(unk._strictFor({ transport: { name: "any" } }), true, "unknown backend: strict for the client's life");
  assert.equal(unk._strictFor({}), true);

  console.log("test_guard_attribution: OK");
})().catch(e => { console.error(e); process.exit(1); });
