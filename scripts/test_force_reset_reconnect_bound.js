#!/usr/bin/env node
"use strict";

// force reset 的 reconnect 期限：Windows 冷启动 connect 34.6–42.5 s，原 30 s 必然
// 超时（2026-10-30 13:59Z stage 211343 → recovery-required）。期限与 warm-up 同源，
// macOS 不变。离线：取 dist 里真实的 reconnect 竞速语句，在 vm 里用假 connect 跑；
// 计时器缩小 1000 倍。负对照 = 修复前的期限：修复前所有平台都是 max(30 s, 15 s)，
// 即现在非 win32 的取值（不取版本库 HEAD：CI 检出的合并提交已含修复）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("./stop_checkpoint_core");
const warmup = require("./apply_backend_warmup_patch");

const root = path.join(__dirname, "..");
const dist = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const START = "let __codexFrReconnectMs=";
const END = "__reconnect.durationMs=Date.now()-__reconnectStartedAt;";
const at = dist.indexOf(START);
assert.ok(at > 0 && dist.indexOf(START, at + 1) < 0, "unique reconnect statement");
const race = dist.slice(at, dist.indexOf(END, at) + END.length);
assert.ok(race.length < 1200 && race.includes("zg.connect()"), race.slice(0, 200));

// 1. 取值：macOS/Linux 30 s 不变；win32 = warm-up 同一预算（setup + 120 s）。
assert.equal(C.forceResetReconnectTimeoutMs("darwin", {}), 30000);
assert.equal(C.forceResetReconnectTimeoutMs("darwin", { STATA_SETUP_TIMEOUT: "900" }), 30000, "Mac ignores the setup budget");
assert.equal(C.forceResetReconnectTimeoutMs("linux", {}), 30000);
assert.equal(C.forceResetReconnectTimeoutMs("win32", {}), 300000);
assert.equal(C.forceResetReconnectTimeoutMs("win32", { STATA_SETUP_TIMEOUT: "400" }), 520000);
for (const bad of ["abc", "", "-5", "60", "NaN"]) assert.equal(C.forceResetReconnectTimeoutMs("win32", { STATA_SETUP_TIMEOUT: bad }), 300000, bad);
// 与 rc.7.72 warm-up 的期限写法同源（同一公式、同一下限）。
assert.ok(warmup.HELPER.includes("let setupSeconds = 180;") && warmup.HELPER.includes("1000 * (setupSeconds + 120)"));
assert.equal(C.setupBudgetMs({}), 1000 * (180 + 120));
// 阶梯单调性在两个平台都成立。
for (const platform of ["darwin", "win32"]) {
  const l3 = C.forceResetReconnectTimeoutMs(platform, {});
  assert.ok(l3 >= C.escalationLadder(null).l2ReconnectMs && l3 >= 15000, platform);
}

// 2. 行为：dist 原句 + 假 connect（耗时按实测，缩 1000 倍）。
async function reconnect(checkpoint, platform, connectMs) {
  const ctx = {
    Promise, String, Date: { now: () => Date.now() },
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round(ms / 1000))),
    // 挂住 = 永不 settle 的 promise（不留计时器，进程可退出）
    zg: { connect: () => connectMs == null ? new Promise(() => {}) : new Promise(resolve => setTimeout(resolve, Math.round(connectMs / 1000))) },
    globalThis: { __codexStopCheckpointRef: { forceResetReconnectTimeoutMs: () => checkpoint.forceResetReconnectTimeoutMs(platform, {}) } },
  };
  vm.createContext(ctx);
  return vm.runInContext(`(async () => { ${race} return __reconnect; })()`, ctx);
}

// 修复前的函数体只有这一行；它现在只作为非 win32 的基值保留。
const src = fs.readFileSync(path.join(__dirname, "stop_checkpoint_core.js"), "utf8");
assert.equal(src.split("const base = Math.max(FORCE_RESET_RECONNECT_MS, RECONNECT_FLOOR_MS);").length - 1, 1);
const PRE_FIX_MS = C.forceResetReconnectTimeoutMs("linux", { STATA_SETUP_TIMEOUT: "900" });
assert.equal(PRE_FIX_MS, 30000);

(async () => {
  const cases = {};
  // 负对照：HEAD 的期限在 Windows 实测 42.5 s connect 下超时（复现 13:59Z）。
  const legacy = await reconnect({ forceResetReconnectTimeoutMs: () => PRE_FIX_MS }, "win32", 42500);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.timeout, true);
  assert.equal(legacy.timeoutMs, 30000);
  assert.match(legacy.error, /reconnect timed out after 30000ms/);
  cases.legacyWin42s = "TIMED_OUT";
  // 修复：同一 42.5 s connect 在 Windows 成功。
  const fixed = await reconnect(C, "win32", 42500);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.timeoutMs, 300000);
  cases.fixedWin42s = "CONNECTED";
  // macOS 不变：健康态 7.49 s 成功，挂住的 connect 仍在 30 s 收口。
  const macFast = await reconnect(C, "darwin", 7490);
  assert.equal(macFast.ok, true);
  assert.equal(macFast.timeoutMs, 30000);
  const macHang = await reconnect(C, "darwin", null);
  assert.equal(macHang.ok, false);
  assert.equal(macHang.timeoutMs, 30000);
  cases.mac = "30 s unchanged";
  // Windows 真挂住：仍有上限（300 s），不会无限等。
  const winHang = await reconnect(C, "win32", null);
  assert.equal(winHang.ok, false);
  assert.equal(winHang.timeoutMs, 300000);
  cases.winHang = "TIMED_OUT at 300 s";
  console.log(JSON.stringify({ verdict: "FORCE_RESET_RECONNECT_BOUND_PASS", cases, liveStata: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
