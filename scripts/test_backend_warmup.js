#!/usr/bin/env node
"use strict";

// 回归：Windows rc.7.44（2026-10-30）冷启动 7 次里 2 次在派发前被拒。MCP 握手先完成，Stata 还在
// worker 里初始化（preflight + 进程内 stata_setup.config），第一次工具调用（运行前快照）替它等，
// 撞上 60 s 快照守卫（504）或 preflight 自己的 60 s（session 变 "error"，500）。
// 从生产 bundle 取 rc.7.72 helper 与 __codexBeginGraphRun 运行；假 client 模拟 session 状态时间线。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const guard = require("./prerun_stage_guard");
const patch = require("./apply_backend_warmup_patch");
const coldStart = require("./apply_backend_cold_start_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertAfter } = require("./later_bundle_patches");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 1. 幂等、精确可逆，锚点 fail closed；在 LATER 链里紧跟 prerun stop fence。
// 之后追加的层（例如 rc.7.73 单 do 分页）先撤掉，得到本补丁封口的那一层。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(fingerprint.verify(bundle).ok, true);
const sealed = revertAfter(bundle, "./apply_backend_warmup_patch");
const before = patch.revertBundle(sealed);
assert.equal(before, revertAfter(bundle, "./apply_prerun_stop_fence_patch"), "this patch directly follows the prerun stop fence");
assert.equal(patch.patchBundle(before), sealed, "replay reproduces the sealed layer");
assert.ok(!before.includes("__codexEnsureBackendWarm"), "negative control: unpatched bundle has no warm-up");
assert.throws(() => patch.patchBundle(before.replace(patch.CALL_BEFORE, "")), /anchor/);
assert.throws(() => patch.patchBundle(before + patch.STATUS_BEFORE), /anchor/);
assert.throws(() => patch.patchBundle(before + "__codexBackendWarmup"), /partial/);
assert.throws(() => patch.patchBundle(bundle.replace("pollMs = 500", "pollMs = 50")), /anchor/);

// 2. 生产接线：warm-up 紧跟 rc.7.67 的连接等待，在图形清单与任何快照之前；/status 暴露 backendWarmup。
let begin;
walk.simple(acorn.parse(bundle, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
  FunctionDeclaration(node) { if (node.id?.name === "__codexBeginGraphRun") begin = bundle.slice(node.start, node.end); },
});
assert.ok(begin.includes(patch.CALL_AFTER));
assert.ok(begin.indexOf("__codexEnsureBackendStarted(") < begin.indexOf("__codexEnsureBackendWarm(")
  && begin.indexOf("__codexEnsureBackendWarm(") < begin.indexOf("__codexCaptureGraphInventory(cwd)"));
assert.equal(bundle.split(patch.STATUS_AFTER).length - 1, 1);
const helperEnd = "globalThis.__codexWarmupSkipsQuiescence = __codexWarmupSkipsQuiescence;";
const helper = bundle.slice(bundle.indexOf(patch.MARKER), bundle.indexOf(helperEnd)) + helperEnd;
// 无快照的 soft Stop：warm-up 未见 running 时跳过 quiescence 探针（否则排在 Stata 启动之后超时、升级 force reset）。
// 跳过分支恰在原 quiescence 分支之前、同一个 __codexSoftStop 里；revert 后的包没有它（负对照）。
assert.equal(bundle.split(patch.STOP_AFTER).length - 1, 1);
const softStop = bundle.slice(bundle.indexOf("globalThis.__codexSoftStop=async __reason=>{"), bundle.indexOf(patch.STOP_AFTER) + patch.STOP_AFTER.length);
assert.ok(softStop.length < 40000 && !softStop.slice(1).includes("globalThis.__codexSoftStop=async"), "skip lives in __codexSoftStop");
assert.ok(softStop.includes("__runId=__life.runId||__s.runId||null"));
assert.ok(!before.includes("__codexWarmupSkipsQuiescence") && before.split(patch.STOP_BEFORE).length - 1 === 1, "negative control: original probe only");
assert.ok(bundle.includes("soft-stop escalation: snapshotless backend not quiescent"), "probe and escalation kept for every other case");
const coldHelper = bundle.slice(bundle.indexOf(coldStart.MARKER), bundle.indexOf(coldStart.ANCHOR));
assert.equal(coldHelper, coldStart.HELPER, "rc.7.67 helper bytes untouched");

// 假 mcp-stata：Stata 在 initMs 后进入 finalStatus；runSelection 要等 Stata 就绪（worker 管道语义）。
class FakeClient {
  constructor({ initMs = 0, finalStatus = "running", tools = ["list_sessions", "stop_session", "create_session"], listFails = 0, missing = false } = {}) {
    Object.assign(this, { initMs, finalStatus, listFails, missing });
    this._availableTools = new Set(tools);
    this._transport = null; this._clientPromise = null; this.calls = []; this.t0 = null;
  }
  _ensureClient() {
    if (!this._clientPromise) this._clientPromise = Promise.resolve().then(() => { this._transport = { pid: 7 }; this.t0 = Date.now(); return this; });
    return this._clientPromise;
  }
  status() {
    if (this.missing) return null;
    return Date.now() - this.t0 >= this.initMs ? this.finalStatus : "starting";
  }
  async _callTool(client, name, args) {
    assert.equal(client, this);
    this.calls.push(name);
    if (name === "list_sessions") {
      if (this.listFails > 0) { this.listFails--; throw new Error("fixture probe failure"); }
      const s = this.status();
      return { content: [{ type: "text", text: JSON.stringify({ sessions: s ? [{ id: "default", status: s, created_at: "x" }] : [] }) }] };
    }
    if (name === "create_session") { this.missing = false; this.t0 = Date.now(); return { content: [] }; }
    if (name === "stop_session") { this.finalStatus = "stopped"; return { content: [] }; }
    throw new Error("unexpected tool " + name);
  }
  _parseToolJson(result) { return JSON.parse(result.content[0].text); }
  async runSelection() {
    await this._ensureClient();
    while (this.status() !== "running") {
      if (this.status() === "error") throw new Error("Stata initialization failed");
      await delay(2);
    }
    return { success: true, rc: 0 };
  }
}

function harness(client, { fastClock = false } = {}) {
  const calls = { inventory: 0, finish: [] };
  let fake = Date.now();
  const FakeDate = fastClock ? class extends Date { static now() { return (fake += 100000); } } : Date;
  const ctx = {
    zg: client, process: { env: {} }, Date: FakeDate, Number, String, Array, Math, Promise, Error, Object, JSON,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 500 ? 2 : ms), clearTimeout,
    __codexResetGeneration: 0, __codexGraphState: { version: 0 },
    __codexPreparedGraphRuns: new Map(), __codexGraphRunBaselines: new Map(),
    __codexSetPostRunBusy: () => {}, __codexClearGraphPanel: () => {}, __codexGraphMark: () => {}, __codexGraphLog: () => {},
    __codexFinishGraphRunNoExport: (id, reason) => calls.finish.push(reason),
    __codexCaptureGraphInventory: async () => { calls.inventory++; return []; },
  };
  vm.createContext(ctx);
  vm.runInContext(coldHelper + helper + begin, ctx);
  const run = id => ctx.__codexBeginGraphRun(id, "human-file", "/w", true);
  return { ctx, calls, run, fail: id => run(id).then(() => assert.fail("expected refusal"), e => e) };
}

async function snapshot(client) {
  const state = guard.createStageState("snapshot", { runId: "r", sourceMode: "human-file" });
  let work;
  const result = await guard.guardStage("snapshot", () => (work = client.runSelection().then(() => delay(10))), {
    state, timeoutMs: 80, cancelDeadlineMs: 20, drainMs: 400, cancelRun: () => true, drainPromise: () => work });
  return { ok: result.ok, result: state.result };
}

(async () => {
  const cases = {};
  // a. 负对照：只等握手（rc.7.67）时，Stata 初始化落进 80 ms 快照守卫 → TIMED_OUT。
  {
    const client = new FakeClient({ initMs: 150 });
    await client._ensureClient();
    cases.legacy = await snapshot(client);
    assert.deepEqual(cases.legacy, { ok: false, result: "TIMED_OUT" });
  }
  // a2. 负对照：未打补丁的 bundle 的 __codexBeginGraphRun（只有 rc.7.67）放行后，快照同样超时。
  {
    let legacyBegin;
    walk.simple(acorn.parse(before, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
      FunctionDeclaration(node) { if (node.id?.name === "__codexBeginGraphRun") legacyBegin = before.slice(node.start, node.end); },
    });
    assert.ok(!legacyBegin.includes("__codexEnsureBackendWarm"));
    const client = new FakeClient({ initMs: 150 });
    const ctx = { zg: client, process: { env: {} }, setTimeout, clearTimeout, __codexResetGeneration: 0,
      __codexGraphState: { version: 0 }, __codexPreparedGraphRuns: new Map(), __codexGraphRunBaselines: new Map(),
      __codexSetPostRunBusy: () => {}, __codexClearGraphPanel: () => {}, __codexGraphMark: () => {}, __codexGraphLog: () => {},
      __codexFinishGraphRunNoExport: () => {}, __codexCaptureGraphInventory: async () => [] };
    vm.createContext(ctx);
    vm.runInContext(coldHelper + legacyBegin, ctx);
    await ctx.__codexBeginGraphRun("run-legacy", "human-file", "/w", true);
    cases.legacyBegin = await snapshot(client);
    assert.deepEqual(cases.legacyBegin, { ok: false, result: "TIMED_OUT" });
  }
  // b. 修复：先等 session "running"，同一守卫只计快照本身；同一 transport 第二次不再探测。
  {
    const client = new FakeClient({ initMs: 150 });
    const h = harness(client);
    await h.run("run-cold");
    const w = h.ctx.__codexBackendWarmupSummary();
    assert.equal(w.outcome, "READY");
    assert.equal(w.lastStatus, "running");
    assert.ok(w.polls >= 2 && w.elapsedMs >= 100, JSON.stringify(w));
    assert.equal(w.timeoutMs, 300000);
    cases.fixed = await snapshot(client);
    assert.deepEqual(cases.fixed, { ok: true, result: "COMPLETED" });
    const probes = client.calls.length;
    await h.run("run-warm");
    assert.equal(client.calls.length, probes, "warm transport is not probed again");
    assert.equal(h.ctx.__codexBackendWarmupSummary().runId, "run-cold");
    assert.equal(h.calls.inventory, 2);
  }
  // c. preflight 超时 → session "error"：拒绝（500，未派发），停掉死 session 供下一次重建。
  {
    const client = new FakeClient({ initMs: 20, finalStatus: "error" });
    const h = harness(client);
    const e = await h.fail("run-error");
    assert.equal(e.code, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(e.__codexPreRunTimeout.status, 500);
    assert.equal(e.__codexPreRunTimeout.payloadDispatched, false);
    assert.equal(e.__codexPreRunTimeout.preRunStage, "backend-warmup");
    assert.equal(e.__codexPreRunTimeout.recovery, "STOPPED_FAILED_SESSION");
    assert.deepEqual(client.calls.filter(n => n !== "list_sessions"), ["stop_session"]);
    assert.equal(h.calls.inventory, 0);
    assert.deepEqual(h.calls.finish, ["graph-run-begin-error"]);
    cases.error = e.__codexPreRunTimeout.reasonCode;
  }
  // d. 等待中 Stop（generation 前进）→ 409，未派发，不停 session；之后的运行重新等到 running。
  {
    const client = new FakeClient({ initMs: 120 });
    const h = harness(client);
    const pending = h.fail("run-stop");
    await delay(30);
    h.ctx.__codexResetGeneration = 1;
    const e = await pending;
    assert.equal(e.code, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(e.__codexPreRunTimeout.status, 409);
    assert.equal(e.__codexPreRunTimeout.payloadDispatched, false);
    assert.ok(!client.calls.includes("stop_session"));
    assert.equal(h.calls.inventory, 0);
    const skips = h.ctx.__codexWarmupSkipsQuiescence;
    assert.equal(skips("run-stop"), true, "cancelled before running: soft Stop skips the probe");
    assert.equal(skips("run-other"), false);
    assert.equal(skips(null), false);
    await h.run("run-after-stop");
    assert.equal(h.ctx.__codexBackendWarmupSummary().outcome, "READY");
    assert.equal(skips("run-after-stop"), false, "READY: payload may run, keep the probe");
    cases.cancelled = e.__codexPreRunTimeout.reasonCode;
    // 等待中（Stop 刚点、warm-up 还没醒来）同样跳过；见过 running 的取消不跳过。
    const c2 = new FakeClient({ initMs: 1e12 });
    const h2 = harness(c2);
    const pending2 = h2.fail("run-waiting");
    await delay(30);
    assert.equal(h2.ctx.__codexBackendWarmupSummary().outcome, "WAITING");
    assert.equal(h2.ctx.__codexWarmupSkipsQuiescence("run-waiting"), true);
    h2.ctx.__codexResetGeneration = 1;
    await pending2;
    Object.assign(h2.ctx.__codexBackendWarmupSummary(), { outcome: "CANCELLED", lastStatus: "running" });
    assert.equal(h2.ctx.__codexWarmupSkipsQuiescence("run-waiting"), false);
    cases.quiescenceSkip = "WAITING/CANCELLED-before-running only";
  }
  // e. 一直 "starting"：自身上限到期 → 504，未派发。
  {
    const h = harness(new FakeClient({ initMs: 1e12 }), { fastClock: true });
    const e = await h.fail("run-hang");
    assert.equal(e.code, "PRE_RUN_BACKEND_WARMUP_TIMEOUT");
    assert.equal(e.__codexPreRunTimeout.status, 504);
    assert.equal(e.__codexPreRunTimeout.lastStatus, "starting");
    cases.timeout = e.__codexPreRunTimeout.reasonCode;
  }
  // f. default session 缺失（上一轮被停掉）→ create_session 一次，再等到 running。
  {
    const client = new FakeClient({ initMs: 30, missing: true });
    const h = harness(client);
    await h.run("run-missing");
    const w = h.ctx.__codexBackendWarmupSummary();
    assert.equal(w.outcome, "READY");
    assert.equal(w.created, true);
    assert.equal(client.calls.filter(n => n === "create_session").length, 1);
    cases.missing = w.outcome;
  }
  // g. 偶发探测失败可恢复；连续 3 次失败 → 500 拒绝。
  {
    const ok = new FakeClient({ initMs: 10, listFails: 2 });
    await harness(ok).run("run-flaky");
    const bad = harness(new FakeClient({ listFails: 9 }));
    const e = await bad.fail("run-probe-dead");
    assert.equal(e.code, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.match(e.__codexPreRunTimeout.message, /list_sessions failed/);
    cases.probeFailure = e.__codexPreRunTimeout.reasonCode;
  }
  // h. 旧服务端没有 list_sessions、Cursor 桥（工具集为空）：跳过，行为同 rc.7.67。
  {
    for (const tools of [["run_command_background"], []]) {
      const client = new FakeClient({ tools });
      const h = harness(client);
      await h.run("run-no-probe");
      assert.equal(client.calls.length, 0);
      assert.equal(h.ctx.__codexBackendWarmupSummary(), null);
    }
    cases.skipped = "no-list_sessions";
  }
  console.log(JSON.stringify({ verdict: "BACKEND_WARMUP_PASS", cases, liveStata: false, bundleSha256: sha(bundle) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
