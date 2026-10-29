#!/usr/bin/env node
"use strict";

// 回归：dev.5 Windows 验收登记的三项（rc.7.68–7.70）。都从生产 bundle / 打包 webview 取真实代码运行；
// 不启动 Stata。1) _enqueue 连上后再查取消；2) 被 Stop 取消的 Run File 说清是 soft Stop 还是 force reset；
// 3) Data Browser 显示真实当前 frame。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const fingerprint = require("./finalize_bundle_identity");
const recheck = require("./apply_enqueue_cancel_recheck_patch");
const wording = require("./apply_stop_cancel_wording_patch");
const frame = require("./apply_data_browser_frame_patch");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 补丁幂等、精确可逆，锚点 fail closed。
for (const p of [recheck, wording]) {
  assert.equal(p.patchBundle(bundle), bundle, "byte idempotence");
  const before = p.revertBundle(bundle);
  assert.equal(p.patchBundle(before), bundle, "replay reproduces the sealed bundle");
  assert.throws(() => p.patchBundle(before + p.BEFORE), /anchor/);
}
assert.equal(fingerprint.verify(bundle).ok, true);
assert.throws(() => recheck.patchBundle(recheck.revertBundle(bundle).replace(recheck.BEFORE, "")), /anchor/);
assert.throws(() => wording.patchBundle(wording.revertBundle(bundle).replace(wording.STATUS_BEFORE, "")), /anchor/);

// 1. _enqueue：取真实方法，假 client 连接 50 ms，期间取消。
function method(source, name) {
  let found;
  walk.simple(acorn.parse(source, { ecmaVersion: "latest" }), { MethodDefinition(node) {
    if (node.key?.name !== name) return;
    assert.equal(found, undefined, "unique method " + name);
    found = source.slice(node.start, node.end);
  } });
  assert.ok(found, "missing method " + name);
  return found;
}
class TokenSource {
  constructor() { this.listeners = []; this.token = { isCancellationRequested: false,
    onCancellationRequested: fn => { this.listeners.push(fn); return { dispose() {} }; } }; }
  cancel() { this.token.isCancellationRequested = true; for (const fn of this.listeners) fn(); }
}
function enqueueHarness(source) {
  const ctx = { EE: { workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, CancellationTokenSource: TokenSource },
    CI: { startSpan: (_m, fn) => fn(), captureException() {} }, setTimeout, clearTimeout, Promise, Date, Math, String, Error };
  vm.createContext(ctx);
  const proto = vm.runInContext("({" + method(source, "_enqueue") + "," + method(source, "_withTimeout") + "," + method(source, "_isCancellationError") + "})", ctx);
  const client = { connects: 0 };
  return Object.assign(Object.create(proto), {
    _pending: 0, _active: false, _activeCancellation: null, _queue: Promise.resolve(), _cancellationSourcesByRunId: new Map(),
    _statusEmitter: { emit() {} }, _log() {}, _formatRecentStderr: () => "", _normalizeResponse: r => r, _collectGraphArtifacts: async () => [],
    _ensureClient: () => { client.connects++; return delay(50).then(() => client); },
  });
}
async function cancelDuringConnect(source) {
  const h = enqueueHarness(source);
  let body = 0;
  const run = h._enqueue("run_selection", { runId: "r1" }, async () => { body++; return { ok: true }; }, {}, false, false);
  await delay(10);
  h._cancellationSourcesByRunId.get("r1").cancel();
  const outcome = await run.then(() => "resolved", e => e.message);
  await delay(80);
  return { body, outcome, pending: h._pending };
}
async function enqueueCases() {
  const legacy = await cancelDuringConnect(recheck.revertBundle(bundle));
  assert.equal(legacy.body, 1, "legacy dispatches the body after a confirmed cancel (dev.5 job 108/109)");
  const fixed = await cancelDuringConnect(bundle);
  assert.deepEqual(fixed, { body: 0, outcome: "Request cancelled", pending: 0 });
  const h = enqueueHarness(bundle);
  assert.deepEqual(await h._enqueue("run_selection", { runId: "r2" }, async c => ({ ok: !!c }), {}, false, false), { ok: true });
  return { legacy, fixed };
}

// 2. 取真实 human-file 取消判定块运行。
const guardStart = bundle.indexOf("if(Number(globalThis.__codexResetGeneration||0)!==__codexHumanFileResetGeneration){" + wording.MARKER);
assert.ok(guardStart > 0 && bundle.split(wording.MARKER).length === 2, "one human-file cancellation guard");
const guard = bundle.slice(guardStart, bundle.indexOf("throw __codexResetError}", guardStart) + "throw __codexResetError}".length);
function cancelMessage(history, generation) {
  const ctx = { __codexHumanFileResetGeneration: 0, __codexResetGeneration: generation, __codexSupersedeHistory: history, Number, String, Error };
  vm.createContext(ctx);
  try { vm.runInContext(guard, ctx); return null; } catch (error) { return { message: error.message, code: error.code, kinds: [...error.resetKinds] }; }
}
const rec = (kind, from, to) => ({ kind, fromGeneration: from, toGeneration: to });
const wordingCases = {
  soft: cancelMessage([rec("soft-stop", 0, 1)], 1),
  force: cancelMessage([rec("force-reset", 0, 1)], 1),
  escalated: cancelMessage([rec("soft-stop", 0, 1), rec("force-reset", 1, 2)], 2),
  earlier: cancelMessage([rec("force-reset", -1, 0), rec("soft-stop", 0, 1)], 1),
  unknown: cancelMessage([], 1),
  same: cancelMessage([rec("soft-stop", 0, 1)], 0),
};
assert.deepEqual(wordingCases.soft, { message: "human-file cancelled by soft Stop (generation 1)", code: "CODEX_FORCE_RESET_CANCELLED", kinds: ["soft-stop"] });
assert.equal(wordingCases.force.message, "human-file cancelled by force reset (generation 1)");
assert.equal(wordingCases.escalated.message, "human-file cancelled by soft Stop then force reset (generation 2)");
assert.equal(wordingCases.earlier.message, "human-file cancelled by soft Stop (generation 1)", "fence advances before this run are not its cause");
assert.equal(wordingCases.unknown.message, "human-file cancelled by reset (generation 1)");
assert.equal(wordingCases.same, null, "unchanged generation does not cancel");
assert.ok(!wording.revertBundle(bundle).slice(guardStart, guardStart + 400).includes("soft Stop"), "legacy wording control");
assert.equal(bundle.split(wording.STATUS_AFTER).length - 1, 1);

// 3. Data Browser：取 src 与打包版的真实 initBrowser，/v1/dataset 返回 wb_platform。
function initBrowser(source) {
  let found;
  walk.simple(acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }), { FunctionDeclaration(node) {
    if (node.id?.name === "initBrowser") { assert.equal(found, undefined); found = source.slice(node.start, node.end); }
  } });
  assert.ok(found, "missing initBrowser");
  return found;
}
async function shownFrame(source, dataset) {
  const ctx = { dom: { frameName: { textContent: "default" } }, state: {}, console: { log() {}, error() {} },
    isInitialized: false, pendingRefresh: false, hideError() {}, showLoading() {}, hideLoading() {}, showError() {},
    log() {}, updateDataSummary() {}, populateVariableSelector() {}, getVariablesFromResponse: () => [], loadPage: async () => {},
    apiCall: async endpoint => endpoint === "/v1/dataset" ? { dataset } : { variables: [] } };
  vm.createContext(ctx);
  vm.runInContext(initBrowser(source), ctx);
  ctx.initBrowser("http://127.0.0.1:1", "token");
  await delay(5);
  return ctx.dom.frameName.textContent;
}
async function frameCases() {
  const out = {};
  for (const rel of Object.keys(frame.TARGETS)) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(frame.patchSource(rel, source), source, rel + " idempotence");
    assert.equal(frame.patchSource(rel, frame.revertSource(rel, source)), source, rel + " replay");
    assert.throws(() => frame.patchSource(rel, frame.revertSource(rel, source) + frame.TARGETS[rel].before), /anchor/);
    out[rel] = {
      legacy: await shownFrame(frame.revertSource(rel, source), { id: "d", n: 6, frame: "wb_platform" }),
      fixed: await shownFrame(source, { id: "d", n: 6, frame: "wb_platform" }),
      missing: await shownFrame(source, { id: "d", n: 6 }),
    };
    assert.deepEqual(out[rel], { legacy: "default", fixed: "wb_platform", missing: "unknown" }, rel);
  }
  return out;
}

(async () => {
  const enqueue = await enqueueCases();
  const frames = await frameCases();
  console.log(JSON.stringify({ verdict: "FINDINGS_RC768_RC770_PASS", enqueue, wording: wordingCases, frames, liveStata: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
