#!/usr/bin/env node
"use strict";

// soft Stop 的 L1 完整 restore 期限：Windows 2026-10-31 integ smoke（job 405，
// 160 estimates + 80 graphs）在 45 s 天花板被切断，L2 只恢复数据集 + 全局，
// 丢掉全部 estimates/graphs（RECOVERED_DEGRADED → continuity-lost → 423）。
// 离线：取 dist 里真实的 L1 竞速语句，在 vm 里用假 runSelection 跑；计时器缩小
// 1000 倍。负对照 = 修复前的期限：修复前所有平台都是 min(45 s, 30 s + n×250 ms)，
// 即现在非 win32 的取值。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("./stop_checkpoint_core");

const root = path.join(__dirname, "..");
const dist = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const START = "let __restoreTimeoutMs=globalThis.__codexStopCheckpointRef.restoreTimeoutMs(__snapshot),";
const END = 'if(!__restoreAttempt.settled)throw new Error("soft-stop dataset restore timed out after "+String(__restoreTimeoutMs)+"ms");';
const at = dist.indexOf(START);
assert.ok(at > 0 && dist.indexOf(START, at + 1) < 0, "unique L1 restore statement");
const race = dist.slice(at, dist.indexOf(END, at) + END.length);
assert.ok(race.length < 1000 && race.includes("zg.runSelection(__restoreCode"), race.slice(0, 200));

const SMOKE = Object.freeze({ estimateCount: 160, graphCount: 80 });

// 1. 取值：macOS/Linux 不变；win32 按条 500 ms、天花板 180 s。
assert.equal(C.restoreTimeoutMs(SMOKE, "darwin"), 45000);
assert.equal(C.restoreTimeoutMs(SMOKE, "linux"), 45000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 4, graphCount: 8 }, "darwin"), 33000);
assert.equal(C.restoreTimeoutMs(SMOKE, "win32"), 150000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 4, graphCount: 8 }, "win32"), 36000);
assert.equal(C.restoreTimeoutMs(null, "win32"), 30000);
assert.equal(C.restoreTimeoutMs({ estimateCount: 1e6, graphCount: 1e6 }, "win32"), 180000);
for (const bad of [{ estimateCount: -1, graphCount: "bad" }, { estimateCount: NaN }, {}]) {
  assert.equal(C.restoreTimeoutMs(bad, "win32"), 30000, JSON.stringify(bad));
}
// 阶梯在两个平台、整个输入域上仍单调，L2 严格放宽。
for (const platform of ["darwin", "win32"]) {
  for (let e = 0; e <= 400; e += 23) {
    for (let g = 0; g <= 400; g += 29) {
      const l = C.escalationLadder({ estimateCount: e, graphCount: g }, platform, {});
      assert.equal(l.l1RestoreMs, C.restoreTimeoutMs({ estimateCount: e, graphCount: g }, platform));
      assert.ok(l.monotonic === true && l.l2RestoreMs > l.l1RestoreMs, JSON.stringify({ platform, e, g, l }));
      assert.ok(l.l3ReconnectMs >= l.l2ReconnectMs, JSON.stringify({ platform, e, g, l }));
    }
  }
}
assert.deepEqual(C.escalationLadder(SMOKE, "darwin", {}),
  { l1RestoreMs: 45000, l2ReconnectMs: 15000, l2RestoreMs: 67500, l3ReconnectMs: 30000, monotonic: true });

// 修复前的公式只有这一种；它现在只作为非 win32 的取值保留。
const PRE_FIX = (snap) => C.restoreTimeoutMs(snap, "linux");
assert.equal(PRE_FIX(SMOKE), 45000);

// 2. 行为：dist 原句 + 假 runSelection（耗时缩 1000 倍）。
async function l1(budget, restoreMs) {
  const calls = [];
  const ctx = {
    Promise, String, Date: { now: () => Date.now() },
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round(ms / 1000))),
    __snapshot: SMOKE, __runId: "run_test", __restoreCode: "use \"x.dta\", clear\n",
    __codexGuardWrap: (_policy, _id, fn) => fn(),
    zg: {
      runSelection: (code, opts) => {
        calls.push({ code, runId: opts.runId });
        // 挂住 = 永不 settle 的 promise（不留计时器，进程可退出）
        return restoreMs == null ? new Promise(() => {}) : new Promise(resolve =>
          setTimeout(() => resolve({ success: true, rc: 0 }), Math.round(restoreMs / 1000)));
      },
    },
    globalThis: {
      __codexStopCheckpointRef: { restoreTimeoutMs: budget },
      __codexExecGuardRef: { POLICY: { RECOVERY: "recovery" } },
    },
  };
  vm.createContext(ctx);
  try {
    const attempt = await vm.runInContext(`(async () => { ${race} return __restoreAttempt; })()`, ctx);
    return { attempt, calls };
  } catch (error) {
    return { error: error.message, calls };
  }
}

(async () => {
  // Windows 完整 restore 实测 > 45 s；取 90 s 作 160+80 的代表值。
  const WIN_RESTORE_MS = 90000;
  const negative = await l1(PRE_FIX, WIN_RESTORE_MS);
  assert.equal(negative.error, "soft-stop dataset restore timed out after 45000ms", "negative control reproduces job 405");
  assert.equal(negative.calls.length, 1);

  const fixed = await l1((snap) => C.restoreTimeoutMs(snap, "win32"), WIN_RESTORE_MS);
  assert.equal(fixed.error, undefined, fixed.error);
  assert.equal(fixed.attempt.settled, true);
  assert.deepEqual(fixed.attempt.result, { success: true, rc: 0 });
  assert.equal(fixed.calls.length, 1);
  assert.equal(fixed.calls[0].runId, "soft-stop-restore-run_test");

  // 期限仍有界：挂住的 restore 在 win32 期限到时照样升级到 L2。
  const hung = await l1((snap) => C.restoreTimeoutMs(snap, "win32"), null);
  assert.equal(hung.error, "soft-stop dataset restore timed out after 150000ms");

  // macOS 不变：同一 Windows 耗时在 darwin 上仍按 45 s 升级。
  const mac = await l1((snap) => C.restoreTimeoutMs(snap, "darwin"), WIN_RESTORE_MS);
  assert.equal(mac.error, "soft-stop dataset restore timed out after 45000ms");

  // 成功的快速 restore 不受期限影响。
  const quick = await l1((snap) => C.restoreTimeoutMs(snap, "win32"), 5000);
  assert.equal(quick.attempt.settled, true);

  console.log("PASS softstop restore budget win32 (negative control, fix, hung, darwin, quick)");
})().catch((error) => { console.error(error); process.exit(1); });
