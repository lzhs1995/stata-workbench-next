#!/usr/bin/env node
"use strict";

// soft Stop 的 L1 完整 restore 期限：Windows 2026-10-31 integ smoke（job 405，
// 160 estimates + 80 graphs）在 45 s 天花板被切断，L2 只恢复数据集 + 全局，
// 丢掉全部 estimates/graphs（RECOVERED_DEGRADED → continuity-lost → 423）。
// job 443 计数：45 s 内 160/160 个 estimates 与 16 个 graphs 完成。
// L1 有两道期限：外层竞速 restoreTimeoutMs()，内层 RECOVERY guard（默认 60 s）。
// 离线：取 dist 里真实的 L1 竞速语句，guard 用真实 execution_guard.guardFixed
// （在 vm 里按平台加载），假 runSelection 按 job 405 的形状逐条计时；计时器缩小
// SCALE 倍。负对照 = 修复前：外层 min(45 s, 30 s + n×250 ms)（即现在非 win32 的
// 取值），guard 60 s（即现在非 win32 的 RECOVERY 默认）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("./stop_checkpoint_core");
const G = require("./execution_guard");

const SCALE = 200;
const root = path.join(__dirname, "..");
const dist = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const START = "let __restoreTimeoutMs=globalThis.__codexStopCheckpointRef.restoreTimeoutMs(__snapshot),";
const END = 'if(!__restoreAttempt.settled)throw new Error("soft-stop dataset restore timed out after "+String(__restoreTimeoutMs)+"ms");';
const at = dist.indexOf(START);
assert.ok(at > 0 && dist.indexOf(START, at + 1) < 0, "unique L1 restore statement");
const race = dist.slice(at, dist.indexOf(END, at) + END.length);
assert.ok(race.length < 1000 && race.includes("zg.runSelection(__restoreCode"), race.slice(0, 200));
// L1 不给 guard 传 timeoutMs：guard 用 RECOVERY 的默认上限。
assert.ok(race.includes('{sourceMode:"recovery"})'), "L1 guard options");

const JOB405 = Object.freeze({ estimateCount: 160, graphCount: 80 });
// job 443：45 s 内 160 个 estimates + 16 个 graphs。取 estimate 0.05 s、graph 2.3 s
// （45 = 160×0.05 + 16×2.3 + 0.2），完整 restore ≈ 192 s；最坏拆分 graph 2.8 s ≈ 224 s。
const EST_MS = 50;
const GRAPH_MS = 2300;
const graphsDoneBy = (ms) => Math.max(0, Math.floor((ms - 160 * EST_MS) / GRAPH_MS));
assert.equal(graphsDoneBy(45000), 16, "calibration reproduces job 443 (16 graphs in 45 s)");
const FULL_MS = 160 * EST_MS + 80 * GRAPH_MS;
assert.ok(FULL_MS > 45000 && FULL_MS < 300000 && 45000 + 64 * (45000 / 16) < 300000, String(FULL_MS));

// 1. 取值：macOS/Linux 与修复前逐值相同；win32 按类型计、上限 300 s。
const PRE_FIX = (snap) => Math.min(45000, 30000 + ((Number(snap && snap.estimateCount) > 0 ? Number(snap.estimateCount) : 0)
  + (Number(snap && snap.graphCount) > 0 ? Number(snap.graphCount) : 0)) * 250);
for (let e = 0; e <= 200; e += 13) {
  for (let g = 0; g <= 200; g += 17) {
    for (const platform of ["darwin", "linux"]) {
      assert.equal(C.restoreTimeoutMs({ estimateCount: e, graphCount: g }, platform), PRE_FIX({ estimateCount: e, graphCount: g }));
    }
  }
}
assert.equal(C.restoreTimeoutMs(JOB405, "darwin"), 45000);
assert.equal(C.restoreTimeoutMs(JOB405, "win32"), 300000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 4, graphCount: 8 }, "win32"), 30000 + 4 * 400 + 8 * 3000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 10, graphCount: 0 }, "win32"), 34000);
assert.equal(C.restoreTimeoutMs(null, "win32"), 30000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 1e6, graphCount: 1e6 }, "win32"), C.WIN32_RESTORE_CEILING_MS);
for (const bad of [{ estimateCount: -1, graphCount: "bad" }, { estimateCount: NaN }, {}]) {
  assert.equal(C.restoreTimeoutMs(bad, "win32"), 30000, JSON.stringify(bad));
}
// RECOVERY guard：win32 不小于外层上限，其他平台与其他策略不变。
assert.equal(G.defaultFixedLimitMs(G.POLICY.RECOVERY, "win32"), C.WIN32_RESTORE_CEILING_MS);
for (const platform of ["darwin", "linux"]) {
  assert.equal(G.defaultFixedLimitMs(G.POLICY.RECOVERY, platform), 60000);
  assert.ok(G.defaultFixedLimitMs(G.POLICY.RECOVERY, platform) >= C.restoreTimeoutMs({ estimateCount: 1e6, graphCount: 1e6 }, platform));
}
for (const platform of ["darwin", "linux", "win32"]) {
  assert.equal(G.defaultFixedLimitMs(G.POLICY.SHORT_INTERNAL, platform), 30000);
  assert.equal(G.defaultFixedLimitMs(G.POLICY.ABSOLUTE, platform), 60000);
}
// 阶梯在两个平台、整个输入域上仍单调，L2 严格放宽。
for (const platform of ["darwin", "win32"]) {
  for (let e = 0; e <= 400; e += 23) {
    for (let g = 0; g <= 400; g += 29) {
      const snap = { estimateCount: e, graphCount: g };
      const l = C.escalationLadder(snap, platform, {});
      assert.equal(l.l1RestoreMs, C.restoreTimeoutMs(snap, platform));
      assert.ok(l.monotonic === true && l.l2RestoreMs > l.l1RestoreMs, JSON.stringify({ platform, e, g, l }));
      assert.ok(l.l3ReconnectMs >= l.l2ReconnectMs, JSON.stringify({ platform, e, g, l }));
    }
  }
}
assert.deepEqual(C.escalationLadder(JOB405, "darwin", {}),
  { l1RestoreMs: 45000, l2ReconnectMs: 15000, l2RestoreMs: 67500, l3ReconnectMs: 30000, monotonic: true });
assert.deepEqual(C.escalationLadder(JOB405, "win32", {}),
  { l1RestoreMs: 300000, l2ReconnectMs: 100000, l2RestoreMs: 450000, l3ReconnectMs: 300000, monotonic: true });
// 2. 行为：dist 的 L1 原句 + 真 guardFixed（按平台在 vm 里加载）+ 假 runSelection。
const scaledTimeout = (fn, ms) => setTimeout(fn, Math.max(1, Math.round(ms / SCALE)));
function loadGuard(platform) {
  const mod = { exports: {} };
  const ctx = { module: mod, exports: mod.exports, process: { platform, env: {} },
    setTimeout: scaledTimeout, clearTimeout, Date, Promise, Symbol, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "execution_guard.js"), "utf8"), ctx);
  return mod.exports;
}

// 与 dist 的 __codexGuardWrap 同形：guardFixed 失败即抛，成功返回 value。
function guardWrapWith(EG) {
  return async (pol, rid, work, o) => {
    const so = o || {};
    const st = EG.createState(pol, { runId: rid, sourceMode: so.sourceMode || null, generation: 0 });
    const r = await EG.guardFixed(pol, work, Object.assign({ state: st, log: () => {} },
      so.timeoutMs ? { timeoutMs: so.timeoutMs } : {}));
    if (!r.ok) throw new Error(r.outcome ? r.outcome.code : "EXEC_GUARD_FAILED");
    return r.value;
  };
}

async function l1({ budget, guardPlatform, restoreMs }) {
  const calls = [];
  const ctx = {
    Promise, String, Date: { now: () => Date.now() }, setTimeout: scaledTimeout,
    __snapshot: JOB405, __runId: "run_test", __restoreCode: "use \"x.dta\", clear\n",
    __codexGuardWrap: guardWrapWith(loadGuard(guardPlatform)),
    zg: {
      runSelection: (code, opts) => {
        calls.push({ code, runId: opts.runId });
        // 挂住 = 永不 settle 的 promise
        return restoreMs == null ? new Promise(() => {}) : new Promise(resolve =>
          scaledTimeout(() => resolve({ success: true, rc: 0 }), restoreMs));
      },
    },
    globalThis: {
      __codexStopCheckpointRef: { restoreTimeoutMs: budget },
      __codexExecGuardRef: { POLICY: { RECOVERY: "RECOVERY" } },
    },
  };
  vm.createContext(ctx);
  const started = Date.now();
  try {
    const attempt = await vm.runInContext(`(async () => { ${race} return __restoreAttempt; })()`, ctx);
    return { attempt, calls, ms: (Date.now() - started) * SCALE };
  } catch (error) {
    return { error: error.message, calls, ms: (Date.now() - started) * SCALE };
  }
}

const darwinBudget = (snap) => C.restoreTimeoutMs(snap, "darwin");
const win32Budget = (snap) => C.restoreTimeoutMs(snap, "win32");

(async () => {
  // 负对照 1（修复前，job 405）：外层 45 s 先到，restore 只做完 16 个图。
  const negative = await l1({ budget: PRE_FIX, guardPlatform: "linux", restoreMs: FULL_MS });
  assert.equal(negative.error, "soft-stop dataset restore timed out after 45000ms", "negative control reproduces job 405");
  assert.equal(negative.calls.length, 1);
  assert.equal(graphsDoneBy(45000), 16);

  // 负对照 2（只放宽外层）：60 s 的 RECOVERY guard 先切断 —— 外层期限单独不够。
  const guardOnly = await l1({ budget: win32Budget, guardPlatform: "linux", restoreMs: FULL_MS });
  assert.equal(guardOnly.attempt && guardOnly.attempt.settled, true, JSON.stringify(guardOnly));
  assert.ok(guardOnly.attempt.error, "60 s guard cut the restore: " + JSON.stringify(guardOnly.attempt));
  assert.ok(guardOnly.ms < 120000, String(guardOnly.ms));

  // 修复：win32 外层 300 s + win32 guard 300 s，同一 restore 完成，rc 0。
  const fixed = await l1({ budget: win32Budget, guardPlatform: "win32", restoreMs: FULL_MS });
  assert.equal(fixed.error, undefined, fixed.error);
  assert.equal(fixed.attempt.settled, true);
  assert.equal(fixed.attempt.error, undefined, String(fixed.attempt.error));
  assert.deepEqual(fixed.attempt.result, { success: true, rc: 0 });
  assert.equal(fixed.calls.length, 1);
  assert.equal(fixed.calls[0].runId, "soft-stop-restore-run_test");

  // 期限仍有界：挂住的 restore 在 win32 期限到时照样升级到 L2。
  const hung = await l1({ budget: win32Budget, guardPlatform: "win32", restoreMs: null });
  assert.equal(hung.error, "soft-stop dataset restore timed out after 300000ms");

  // macOS 不变：同一 Windows 耗时在 darwin 上仍按 45 s 升级。
  const mac = await l1({ budget: darwinBudget, guardPlatform: "darwin", restoreMs: FULL_MS });
  assert.equal(mac.error, "soft-stop dataset restore timed out after 45000ms");

  // 成功的快速 restore 不受期限影响。
  const quick = await l1({ budget: win32Budget, guardPlatform: "win32", restoreMs: 5000 });
  assert.equal(quick.attempt.settled, true);
  assert.deepEqual(quick.attempt.result, { success: true, rc: 0 });

  console.log("PASS softstop restore budget win32 (job405 negative, guard-only negative, fix, hung, darwin, quick)");
})().catch((error) => { console.error(error); process.exit(1); });
