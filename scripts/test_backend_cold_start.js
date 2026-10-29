#!/usr/bin/env node
"use strict";

// 回归：重载后首次运行的 backend 冷启动不计入 pre-run 快照/图形清单预算。
// 直接从生产 bundle 取 __codexBeginGraphRun 与冷启动 helper 运行；Stata 换成假 client，
// 其缓存语义与 bundle 的 _ensureClient 相同（同一个 promise，连上后才设 _transport）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const acorn = require("acorn");
const walk = require("acorn-walk");
const guard = require("./prerun_stage_guard");
const patch = require("./apply_backend_cold_start_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertLaterPatches } = require("./later_bundle_patches");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 1. 补丁幂等、精确可逆（还原出 Windows 上部署的 dev.5 字节），锚点 fail closed。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(fingerprint.verify(bundle).ok, true);
// Later patches are reverted exactly first; dev.6 is this patch on top of dev.5.
const dev6 = revertLaterPatches(bundle);
const dev5 = patch.revertBundle(dev6);
assert.equal(sha(dev5), "bf3e938134855456475754ceeca00600c9a295a4f1bd530b811f90377dfc23ca", "dev.5 bytes");
assert.equal(patch.patchBundle(dev5), dev6, "maintenance replay reproduces the sealed dev.6 bundle");
assert.throws(() => patch.patchBundle(bundle.replace("+ 120) * 1000", "+ 60) * 1000")), /modified/);
assert.throws(() => patch.patchBundle(dev5.replace(patch.BEGIN_BEFORE, "")), /anchor/);
assert.throws(() => patch.patchBundle(dev5 + patch.STATUS_BEFORE), /anchor/);
assert.throws(() => patch.patchBundle(dev5.replace(patch.ANCHOR, "function __codexEnsureBackendStarted(){}" + patch.ANCHOR)), /partial/);

// 2. 生产接线：四个执行入口都 await __codexBeginGraphRun，它先等 backend 再做图形清单；
//    visible-bridge 与 human-file 的快照守卫都在各自入口之后。/status 暴露 backendStart。
const sites = [...bundle.matchAll(/await __codexBeginGraphRun\([\w.]+,"([\w-]+)"/g)].map(m => [m[1], m.index]);
assert.deepEqual(sites.map(s => s[0]).sort(), ["human-file", "manual-selection", "terminal-input", "visible-bridge"]);
assert.equal(bundle.split("__codexBeginGraphRun(").length - 1, 5, "4 calls + 1 declaration");
const at = Object.fromEntries(sites);
const snapAfter = from => bundle.indexOf('guardStage("snapshot"', from);
assert.ok(at["visible-bridge"] < snapAfter(at["visible-bridge"]) && snapAfter(at["visible-bridge"]) < at["human-file"]);
assert.ok(at["human-file"] < snapAfter(at["human-file"]));
assert.equal(bundle.split(patch.STATUS_AFTER).length - 1, 1);
let begin;
walk.simple(acorn.parse(bundle, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
  FunctionDeclaration(node) {
    if (node.id?.name !== "__codexBeginGraphRun") return;
    assert.equal(begin, undefined);
    begin = bundle.slice(node.start, node.end);
  },
});
assert.ok(begin.includes(patch.BEGIN_AFTER));
assert.ok(begin.indexOf("__codexEnsureBackendStarted(") < begin.indexOf("__codexCaptureGraphInventory(cwd)"));
const helper = bundle.slice(bundle.indexOf(patch.MARKER), bundle.indexOf(patch.ANCHOR));
assert.equal(helper, patch.HELPER);

class FakeClient {
  constructor(plan) { this.plan = plan; this._clientPromise = null; this._transport = null; this.connects = 0; }
  _ensureClient() {
    if (this._clientPromise) return this._clientPromise;
    this.connects++;
    const step = this.plan.shift() || { ms: 0 };
    return (this._clientPromise = new Promise((resolve, reject) => {
      if (step.hang) return;
      setTimeout(() => {
        if (step.fail) { this._clientPromise = null; reject(new Error("fixture connect failure")); }
        else { this._transport = { pid: 4242 }; resolve(this); }
      }, step.ms);
    }));
  }
  // 与 _enqueue 相同：Stata 调用先 await _ensureClient。
  runSelection() { return this._ensureClient().then(() => ({ success: true, rc: 0 })); }
}

function harness(client, extra = {}) {
  const calls = { inventory: 0, finish: [], busy: [] };
  const ctx = {
    zg: client, setTimeout: extra.setTimeout || setTimeout, clearTimeout, process: { env: extra.env || {} },
    __codexResetGeneration: 0, __codexGraphState: { version: 0 },
    __codexPreparedGraphRuns: new Map(), __codexGraphRunBaselines: new Map(),
    __codexSetPostRunBusy: (busy, reason) => calls.busy.push([busy, reason]),
    __codexClearGraphPanel: () => {}, __codexGraphMark: () => {}, __codexGraphLog: () => {},
    __codexFinishGraphRunNoExport: (id, reason) => calls.finish.push(reason),
    __codexCaptureGraphInventory: async () => {
      assert.ok(typeof client._ensureClient !== "function" || client._transport, "inventory waits for the backend");
      calls.inventory++;
      return [];
    },
  };
  vm.createContext(ctx);
  vm.runInContext(helper + begin, ctx);
  const run = (id, baseline = true) => ctx.__codexBeginGraphRun(id, "human-file", "/w", baseline);
  return { ctx, calls, run, fail: id => run(id).then(() => assert.fail("expected failure"), e => e) };
}

// 现场形状（时间缩放）：快照守卫 80 ms，冷启动 120 ms，快照本身 10 ms；drain 能收敛（现场 drainSettled true）。
async function snapshot(client) {
  const state = guard.createStageState("snapshot", { runId: "r", sourceMode: "human-file" });
  let work;
  const result = await guard.guardStage("snapshot", () => (work = client.runSelection().then(() => delay(10))), {
    state, timeoutMs: 80, cancelDeadlineMs: 20, drainMs: 200, cancelRun: () => true, drainPromise: () => work });
  return { ok: result.ok, result: state.result };
}

(async () => {
  const cases = {};
  // a. 旧流程把冷启动算进快照守卫 → TIMED_OUT（复现 Windows dev.5 第 9 步）。
  cases.legacy = await snapshot(new FakeClient([{ ms: 120 }]));
  assert.deepEqual(cases.legacy, { ok: false, result: "TIMED_OUT" });
  // b. 新流程先等 backend，同一守卫只计快照本身 → 完成；热启动不覆盖 lastCold。
  {
    const client = new FakeClient([{ ms: 120 }]);
    const h = harness(client);
    assert.equal(h.ctx.__codexBackendStartSummary().connected, false);
    await h.run("run-cold", false);
    cases.fixed = await snapshot(client);
    assert.deepEqual(cases.fixed, { ok: true, result: "COMPLETED" });
    const cold = h.ctx.__codexBackendStartSummary();
    assert.equal(cold.connected, true);
    assert.equal(cold.current.outcome, "CONNECTED");
    assert.equal(cold.current.cold, true);
    assert.ok(cold.current.elapsedMs >= 100);
    assert.equal(cold.current.timeoutMs, 300000);
    await h.run("run-warm");
    const warm = h.ctx.__codexBackendStartSummary();
    assert.equal(warm.current.cold, false);
    assert.equal(warm.lastCold.runId, "run-cold");
    assert.equal(client.connects, 1);
    assert.equal(h.calls.inventory, 1);
    assert.equal(h.calls.finish.length, 0);
  }
  // c. backend 卡住：自身上限到期 → 504，未派发，清单不跑，UI 忙碌状态释放。
  {
    const h = harness(new FakeClient([{ hang: true }]), { setTimeout: (fn, ms) => setTimeout(fn, ms >= 300000 ? 30 : ms) });
    const error = await h.fail("run-hang");
    assert.equal(error.code, "PRE_RUN_BACKEND_START_TIMEOUT");
    assert.equal(error.__codexPreRunTimeout.status, 504);
    assert.equal(error.__codexPreRunTimeout.payloadDispatched, false);
    assert.equal(error.__codexPreRunTimeout.preRunStage, "backend-start");
    assert.equal(h.calls.inventory, 0);
    assert.deepEqual(h.calls.finish, ["graph-run-begin-error"]);
    assert.deepEqual(h.calls.busy.at(-1), [false, "graph-run-begin-error"]);
    cases.timeout = error.__codexPreRunTimeout.reasonCode;
  }
  // d. 连接失败 → 500；下一次运行重新启动成功。
  {
    const client = new FakeClient([{ ms: 5, fail: true }, { ms: 5 }]);
    const h = harness(client);
    const error = await h.fail("run-fail");
    assert.equal(error.code, "PRE_RUN_BACKEND_START_FAILED");
    assert.equal(error.__codexPreRunTimeout.status, 500);
    assert.match(error.__codexPreRunTimeout.message, /fixture connect failure/);
    await h.run("run-retry");
    assert.equal(client.connects, 2);
    assert.equal(h.calls.inventory, 1);
    cases.failed = error.__codexPreRunTimeout.reasonCode;
  }
  // e. 等待中按 Stop（soft Stop 递增 generation）→ 不派发；backend 保留给下一次运行。
  {
    const client = new FakeClient([{ ms: 40 }]);
    const h = harness(client);
    const pending = h.fail("run-stop");
    await delay(10);
    h.ctx.__codexResetGeneration = 1;
    const error = await pending;
    assert.equal(error.code, "PRE_RUN_BACKEND_START_CANCELLED");
    assert.equal(h.calls.inventory, 0);
    await h.run("run-after-stop");
    assert.equal(h.ctx.__codexBackendStartSummary().current.cold, false);
    cases.cancelled = error.__codexPreRunTimeout.reasonCode;
  }
  // f. STATA_SETUP_TIMEOUT 大于默认值时上限随之放宽；没有 _ensureClient 的替身照旧运行。
  {
    const h = harness(new FakeClient([{ ms: 1 }]), { env: { STATA_SETUP_TIMEOUT: "600" } });
    await h.run("run-env");
    assert.equal(h.ctx.__codexBackendStartSummary().current.timeoutMs, 720000);
    const bare = harness({ runSelection: () => Promise.resolve({ success: true, rc: 0 }) });
    await bare.run("run-bare");
    assert.equal(bare.calls.inventory, 1);
  }
  console.log(JSON.stringify({ verdict: "BACKEND_COLD_START_PASS", cases, liveStata: false, bundleSha256: sha(bundle) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
