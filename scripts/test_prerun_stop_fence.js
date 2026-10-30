#!/usr/bin/env node
"use strict";

// 回归：Windows dev.8 stop cycle 2（rc.7.71）。Stop 落在 pre-run enrich 窗口：checkpoint 任务已
// task_done、enrich guard 返回 ok，fallback 又派一次 checkpoint，正文照常派发；soft Stop 等这条
// 没人取消的正文 transport，15 s 后升级 force reset → recovery-required。
// 从生产 bundle 取真实 pre-run 块和 soft Stop drain 块运行，配真实 stop_checkpoint_core /
// prerun_stage_guard；假 client、假时钟，不启动 Stata。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const fingerprint = require("./finalize_bundle_identity");
const fence = require("./apply_prerun_stop_fence_patch");
const core = require("./stop_checkpoint_core");
const guard = require("./prerun_stage_guard");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const legacy = fence.revertBundle(bundle);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-prerun-fence-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 补丁幂等、精确可逆，锚点 fail closed。
assert.equal(fence.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(fence.patchBundle(legacy), bundle, "replay reproduces the sealed bundle");
assert.equal(fingerprint.verify(bundle).ok, true);
assert.throws(() => fence.patchBundle(legacy + fence.ANCHORS.humanSnapshot[0]), /anchor/);
assert.throws(() => fence.patchBundle(legacy.replace(fence.ANCHORS.humanFallback[0], "")), /anchor/);
assert.throws(() => fence.patchBundle(legacy + "__codexBridgeResetGeneration"), /partial/);

function slice(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a > 0 && source.indexOf(start, a + 1) < 0, "unique start " + start.slice(0, 50));
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, "end after " + start.slice(0, 50));
  return source.slice(a, b);
}
// 栅栏与正文派发之间没有 await：栅栏放行后 generation 不可能再变。
for (const [start, end] of [[fence.ANCHORS.humanEnrich[1], "let __codexHumanFilePromise="], [fence.ANCHORS.bridgeEnrich[1], "let __codexBridgePromise="]]) {
  assert.equal(/\bawait\b/.test(slice(bundle, start, end)), false, "no await between the fence and the payload dispatch");
}
// Agent 桥：acquire 到 generation 捕获之间没有 await。
assert.equal(/\bawait\b/.test(slice(bundle, "if(!__acquire({ru", fence.ANCHORS.bridgeGeneration[1])), false);
// rc.7.13 接线钉住的 snapshot guard → runSelection 调用点原文不动。
assert.equal(bundle.split("beginAtomic({snapshot:__codexHumanFilePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),").length, 2);
assert.equal(bundle.split("beginAtomic({snapshot:__codexBridgePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),").length, 2);

const BLOCKS = {
  human: ["let __codexHumanFilePreRunSnapshot=null;try{", "/* codex patch rc.7.10: pre-run dataset snapshot for soft Stop */"],
  bridge: ["let __codexBridgePreRunSnapshot=null;try{", "/* codex patch rc.7.10.36: visible bridge snapshots pre-run dataset */"],
};
function writeSnapshot(snap) {
  fs.writeFileSync(snap.path, Buffer.alloc(600));
  fs.writeFileSync(snap.snapshotReadyPath, `ready\t${snap.checkpointNonce}\tdata\n`);
}
function writeState(snap) {
  for (const f of ["globals.b64.tsv", "estimates.txt", "graphs.txt"]) fs.writeFileSync(path.join(snap.stateDir, f), "");
  fs.writeFileSync(path.join(snap.stateDir, "default_graph_object.txt"), "0");
}
// 假 Stata：每个场景决定 checkpoint 派发怎样结束；stop() 等价于 soft Stop 推进栅栏。
const SCENARIOS = {
  noStop: async (kind, snap) => { writeSnapshot(snap); writeState(snap); return { success: true, rc: 0 }; },
  // cycle 2：snapshot 已就绪，Stop 到达时 checkpoint 已 task_done，结果不完整 → fallback 补派。
  stopThenIncomplete: async (kind, snap, stop) => {
    if (kind === "fallback") { writeState(snap); return { success: true, rc: 0 }; }
    writeSnapshot(snap); await delay(60); stop(); return { success: false, rc: 1, error: { message: "--Break--" } };
  },
  // Stop 到达时 checkpoint 已完整结束。
  stopThenComplete: async (kind, snap, stop) => { writeSnapshot(snap); await delay(60); stop(); writeState(snap); return { success: true, rc: 0 }; },
  // cycle 1：取消赶在 task_done 之前，runSelection reject。
  stopRejects: async (kind, snap, stop) => { writeSnapshot(snap); await delay(60); stop(); throw new Error("Request cancelled"); },
  // Stop 落在 generation 捕获之后、第一次 checkpoint 派发之前（例如后端冷启动等待中）。
  stopBeforeDispatch: async (kind, snap) => { writeSnapshot(snap); writeState(snap); return { success: true, rc: 0 }; },
};

let seq = 0;
async function runBlock(source, which, name) {
  const runId = `run_${which}_${name}_${++seq}`;
  const calls = [], logs = [];
  let stopSnapshot = null;
  const ctx = vm.createContext({ console, Buffer, setTimeout, clearTimeout, Promise, Date, Math, JSON, Number, String, Object, Error, Array, Map, Set, RegExp, isFinite });
  Object.assign(ctx, {
    __codexResetGeneration: 2, __codexSupersedeHistory: [],
    __codexStopCheckpointRef: core, __codexPreRunGuardRef: guard,
    __codexPreRunSnapshots: new Map(), __codexActivePreRunSnapshot: null,
    __codexGuardTransport: { cancelTask: () => false, cancelRun: () => false, cancelAll: () => false, supersedeLookup: () => null, getRunExecutionState: () => null },
    __codexFinishGraphRunNoExport() {}, __codexGraphMark() {},
    __codexStataString: v => String(v).replace(/\\/g, "/"),
    RI: m => logs.push(String(m)), JA: fs, Gg: { failStreamingEntry() {} },
    require: id => id === "node:os" ? { tmpdir: () => tmp } : require(id),
    r: runId, C: tmp, __run: runId, __cwd: tmp, __codexPreparedBridgeRun: null,
    __codexHumanFileResetGeneration: 2, __codexBridgeResetGeneration: 2,
  });
  // 与 __codexSoftStop 开头相同：generation +1、记 supersede、标记 snapshot 归 Stop 所有。
  const stop = () => {
    ctx.__codexSupersedeHistory.push({ kind: "soft-stop", fromGeneration: ctx.__codexResetGeneration, toGeneration: ctx.__codexResetGeneration + 1 });
    ctx.__codexResetGeneration += 1;
    const snap = ctx.__codexPreRunSnapshots.get(runId);
    if (snap) { snap.stopOwned = true; stopSnapshot = snap; }
  };
  if (name === "stopBeforeDispatch") stop();
  ctx.zg = { runSelection: async () => {
    const kind = calls.length ? "fallback" : "atomic";
    calls.push(kind + "@g" + ctx.__codexResetGeneration);
    return SCENARIOS[name](kind, ctx.__codexActivePreRunSnapshot, stop);
  } };
  if (source.includes(fence.MARKER)) vm.runInContext(slice(source, fence.MARKER, "globalThis.__codexGuardTransport={"), ctx);
  let error = null;
  try { await vm.runInContext("(async()=>{" + slice(source, ...BLOCKS[which]) + "})()", ctx); } catch (e) { error = e; }
  await delay(80);
  // snap = soft Stop 当时按 runId 找到的 pre-run snapshot（没有则 Stop 走无 snapshot 分支，此处不模拟）。
  return { runId, calls, logs, error, snap: stopSnapshot };
}

function outcome(run) {
  const prt = run.error && run.error.__codexPreRunTimeout;
  return {
    // 块正常结束 = 紧接着的语句就是正文派发（两者之间无 await，见上方静态断言）。
    payloadDispatched: !run.error,
    checkpointDispatches: run.calls.join(","),
    refusal: prt ? `${prt.status} ${prt.reasonCode} payloadDispatched=${prt.payloadDispatched}` : (run.error ? String(run.error.message) : null),
    refusedLog: run.logs.some(l => /refusing to dispatch payload/.test(l)),
    message: run.error ? String(run.error.message) : null,
  };
}

// 取真实 soft Stop drain 块运行。正文已派发时按原 bundle 下一条语句把正文 promise 交给
// trackTransport；被 Stop 撇下的正文没人取消，永不结算。checkpoint 任务已 task_done（cycle 2 实测）。
const drainCode = slice(bundle, "let __deadline=Date.now()+15000;if(__snapshot){", "if(!__drained){globalThis.__codexLastSoftStop=");
async function softStopDrain(run) {
  const reached = !run.error;
  if (reached) core.trackTransport(run.snap, new Promise(() => {}), { runId: run.runId, sourceMode: "payload" });
  const zg = {
    _runsByTaskId: new Map([["task_checkpoint", { _taskDonePayload: { event: "task_done", status: "done" } }]]),
    _activeRun: reached ? { _runId: run.runId, taskId: "task_payload" } : null,
    _active: reached, _pending: reached ? 1 : 0,
    _cancellationSourcesByRunId: new Map(reached ? [[run.runId, {}]] : []),
    connect: async () => {},
  };
  let now = 0;
  class FakeDate extends Date { static now() { return now; } }
  const resets = [];
  const ctx = vm.createContext({ Date: FakeDate, Promise, Error, String, Number, Object,
    setTimeout: (fn, ms) => { now += ms; return setImmediate(fn); },
    zg, __snapshot: run.snap, __taskId: "task_checkpoint", __transportDrain: null, __drained: false, __hardEscalated: false, __hardReset: null,
    __codexStopCheckpointRef: core,
    __codexForceReset: async reason => { resets.push(reason); return { ok: true, trueReady: false }; } });
  await vm.runInContext("(async()=>{" + drainCode + "})()", ctx);
  return { safeForRestore: !!(ctx.__transportDrain && ctx.__transportDrain.safeForRestore && !ctx.__transportDrain.hardResetOverride),
    transportPromiseSettled: ctx.__transportDrain.transportPromiseSettled, hardEscalated: ctx.__hardEscalated,
    forceResets: resets, waitedMs: now };
}

(async () => {
  const results = {};
  for (const which of Object.keys(BLOCKS)) for (const name of Object.keys(SCENARIOS)) {
    const row = {};
    for (const [label, source] of [["legacy", legacy], ["fixed", bundle]]) {
      const run = await runBlock(source, which, name);
      row[label] = outcome(run);
      if (run.snap) row[label].softStop = await softStopDrain(run);
    }
    results[which + "." + name] = row;
  }
  const reason = ["soft-stop escalation: transport promise did not settle"];
  for (const which of Object.keys(BLOCKS)) {
    const at = name => results[which + "." + name];
    // 不按 Stop 时两版都正常派发、只派一次 checkpoint。
    for (const label of ["legacy", "fixed"]) {
      assert.deepEqual([at("noStop")[label].payloadDispatched, at("noStop")[label].checkpointDispatches, at("noStop")[label].refusal], [true, "atomic@g2", null], which + " noStop " + label);
    }
    // 旧版复现：checkpoint 已结束时 Stop，正文照派，drain 等不到结算，升级 force reset。
    assert.equal(at("stopThenComplete").legacy.payloadDispatched, true);
    assert.deepEqual(at("stopThenComplete").legacy.softStop.forceResets, reason);
    assert.equal(at("stopBeforeDispatch").legacy.checkpointDispatches, "atomic@g3", which + " legacy dispatches after the Stop");
    // cycle 1 路径（取消赶在 task_done 前）两版一致。
    assert.deepEqual(at("stopRejects").fixed, at("stopRejects").legacy, which + " cycle 1 path unchanged");
    for (const name of Object.keys(SCENARIOS).filter(n => n !== "noStop")) {
      const fixed = at(name).fixed;
      assert.equal(fixed.payloadDispatched, false, which + " " + name + " fixed refuses the payload");
      assert.equal(fixed.refusedLog, true);
      assert.match(fixed.refusal, /payloadDispatched=false$/);
      assert.equal(/@g3/.test(fixed.checkpointDispatches), false, which + " " + name + " no checkpoint dispatch after the Stop");
      if (fixed.softStop) {
        assert.deepEqual(fixed.softStop, { safeForRestore: true, transportPromiseSettled: true, hardEscalated: false, forceResets: [], waitedMs: 0 }, which + " " + name);
      }
    }
    assert.equal(at("stopThenComplete").fixed.refusal, "409 PRE_RUN_CANCELLED_BY_STOP payloadDispatched=false");
    assert.deepEqual([at("stopBeforeDispatch").fixed.checkpointDispatches, at("stopBeforeDispatch").fixed.refusal], ["", "409 PRE_RUN_CANCELLED_BY_STOP payloadDispatched=false"], which + " Stop before the first checkpoint");
    assert.equal(at("stopThenComplete").fixed.message, (which === "human" ? "human-file" : "visible-bridge") + " pre-run cancelled by soft Stop (generation 3); payload not dispatched");
  }
  // cycle 2 原样：Run File 的 fallback 在 Stop 之后补派，正文照派，drain 只看到正文 transport 未结算。
  const cycle2 = results["human.stopThenIncomplete"].legacy;
  assert.deepEqual([cycle2.payloadDispatched, cycle2.checkpointDispatches, cycle2.softStop.transportPromiseSettled, cycle2.softStop.forceResets], [true, "atomic@g2,fallback@g3", false, reason]);
  console.log(JSON.stringify({ verdict: "PRERUN_STOP_FENCE_PASS", results, liveStata: false }));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
