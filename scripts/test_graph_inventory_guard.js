#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const acorn = require("acorn");
const walk = require("acorn-walk");
const guard = require("./execution_guard");
const patch = require("./apply_graph_inventory_guard_patch");
const preRun = require("./apply_bridge_prerun_failure_patch");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist/extension.js"), "utf8");
const declarations = new Map();
let wrap, outer, snapshotCatch;
walk.simple(acorn.parse(bundle, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
  FunctionDeclaration(node) {
    if (["__codexCaptureGraphInventory", "__codexBeginGraphRun", "__codexFinishGraphRunNoExport",
      "__codexExportCurrentGraphsForPanel", "__codexBuildGraphSignatureMap",
      "__codexParseGraphInventoryFile"].includes(node.id?.name)) {
      assert.ok(!declarations.has(node.id.name));
      declarations.set(node.id.name, bundle.slice(node.start, node.end));
    }
  },
  AssignmentExpression(node) {
    if (bundle.slice(node.left.start, node.left.end) === "globalThis.__codexGuardWrap") {
      assert.equal(wrap, undefined);
      wrap = bundle.slice(node.start, node.end) + ";";
    }
  },
  CatchClause(node) {
    const source = bundle.slice(node.start, node.end);
    if (source.startsWith("catch(e){__release();let __codexOuterPrt=")) outer = source;
    if (source.includes(preRun.MARKER) && node.param?.name === "__snapshotError") snapshotCatch = source;
  },
});
assert.equal(declarations.size, 6);
assert.ok(wrap && outer && snapshotCatch);
const start = bundle.indexOf(preRun.START);
const setup = bundle.slice(start, bundle.indexOf('let __os=require("node:os")', start));
assert.match(setup, /try\{if\(__run&&globalThis\.__codexBeginGraphRun\)await __codexBeginGraphRun/);
const entry = `(async()=>{try{${setup}__checkpoint();__payload();}${snapshotCatch}}${outer}})()`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-inventory-guard-"));
const cases = [];
const probeIds = new Set();
let capturedCode;

async function run(mode, expected, opts = {}) {
  const dir = path.join(root, mode + (opts.legacy ? "-legacy" : "") + (opts.post ? "-post" : ""));
  fs.mkdirSync(dir);
  const calls = { probe: 0, checkpoint: 0, payload: 0, cancel: 0, release: 0, failed: 0 };
  let pendingResolve, state, context;
  const ctx = {
    require: name => name === "os" ? { tmpdir: () => dir } : require(name),
    rg: path,
    JA: { ...fs, mkdirSync: (...args) => {
      if (mode === "mkdir") throw new Error("fixture mkdir failure");
      return fs.mkdirSync(...args);
    } },
    // Legacy race is accelerated only to demonstrate its premature return.
    setTimeout: (fn, ms) => setTimeout(fn, ms === 20000 ? 2 : ms),
    __codexExecGuard: { ...guard, guardFixed: (policy, work, options) => {
      state = options.state;
      return guard.guardFixed(policy, work, { ...options, timeoutMs: 80, cancelDeadlineMs: 15, drainDeadlineMs: 15 });
    } },
    __codexExecGuardRef: guard,
    __codexGuardTransport: {
      cancelRun: id => {
        calls.cancel++;
        assert.equal(id, state.runId);
        if (mode !== "drain-failed") pendingResolve?.({ success: false, rc: 1 });
        return true;
      },
      cancelAll: () => { throw new Error("unexpected cancellation fallback"); },
      cancelTask: () => false,
    },
    __codexPreparedGraphRuns: new Map([["business", { mode: "fixture" }]]),
    __codexGraphRunBaselines: new Map([["business", []]]),
    __codexGraphState: { version: 0 },
    __codexSetPostRunBusy: busy => { context.busy = busy; },
    __codexClearGraphPanel: () => {},
    __codexGraphMark: value => { context.mark = value; },
    __codexGraphLog: () => {},
    RI: () => {},
    busy: false,
    __run: "business", __cwd: dir, __codexPreparedBridgeRun: { captureBaseline: true },
    __patch: "fixture", __res: {},
    __release: () => { calls.release++; },
    __send: (res, status, body) => { context.response = { status, body }; },
    Gg: { failStreamingEntry: () => { calls.failed++; } },
    __checkpoint: () => { calls.checkpoint++; },
    __payload: () => { calls.payload++; },
    zg: { runSelection: (code, options) => {
      calls.probe++;
      capturedCode = code;
      if (!opts.legacy) {
        assert.ok(options.runId && options.runId === state.runId);
        assert.ok(!probeIds.has(options.runId));
        probeIds.add(options.runId);
        assert.equal(options.includeGraphs, false);
        assert.equal(options.normalizeResult, true);
      }
      const inventoryDir = fs.readdirSync(dir).find(name => name.startsWith("codex-graph-inventory-"));
      const manifest = path.join(dir, inventoryDir, "inventory.tsv");
      const write = () => fs.writeFileSync(manifest, mode === "empty" ? "" :
        mode === "partial" ? "1\tGraph\tsignature" : mode === "duplicate" ?
          "1\tGraph\tsignature\n2\tGraph\tsignature\n" : "1\tGraph\tsignature\n");
      if (mode === "sync-throw") throw new Error("fixture sync failure");
      if (mode === "rejected") return Promise.reject(new Error("fixture rejection"));
      if (["timeout", "drain-failed"].includes(mode)) return new Promise(resolve => { pendingResolve = resolve; });
      if (mode === "slow") return new Promise(resolve => {
        setTimeout(() => { write(); resolve({ success: true, rc: 0 }); }, 30);
      });
      if (mode !== "missing") write();
      if (mode === "stata-error") return Promise.resolve({ success: false, rc: 133 });
      if (mode === "nonzero-rc") return Promise.resolve({ success: true, rc: 601 });
      if (mode === "raw-error") return Promise.resolve({ success: true, raw: { error: "fixture" } });
      if (mode === "no-result") return Promise.resolve(undefined);
      return Promise.resolve({ success: true, rc: 0 });
    } },
  };
  context = vm.createContext(ctx);
  vm.runInContext([...declarations.values()].join("\n") + "\n" + wrap, context);
  if (opts.legacy) vm.runInContext(fs.readFileSync(opts.legacy, "utf8"), context);
  let settled = false;
  const operation = vm.runInContext(opts.post ? '__codexExportCurrentGraphsForPanel("business", __cwd)' : entry, context)
    .then(() => { settled = true; });
  if (mode === "slow") {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, !!opts.legacy, "must not return before transport settles");
  }
  await operation;
  if (opts.legacy) await new Promise(resolve => setTimeout(resolve, 40));
  pendingResolve?.({ success: false, rc: 1 });
  if (opts.post) {
    assert.equal(calls.probe, 1, "failed inventory must not start graph export");
    assert.equal(calls.payload, 0);
    assert.equal(context.mark.lastBatchSource, "manual-post-export-error");
  } else {
    assert.equal(calls.payload, expected === 200 ? 1 : 0, mode);
    assert.equal(calls.checkpoint, expected === 200 ? 1 : 0, mode);
    if (expected !== 200) {
      assert.equal(context.response.status, expected, mode);
      assert.equal(context.response.body.payloadDispatched, false);
      assert.equal(calls.release, 1);
      assert.equal(calls.failed, 1);
      assert.equal(context.busy, false);
      assert.equal(context.__codexGraphRunBaselines.size, 0);
      assert.equal(context.__codexPreparedGraphRuns.size, 0);
      if (expected === 503 || expected === 504) {
        assert.equal(context.response.body.cause, state.cause);
        assert.equal(context.response.body.settlement, state.settlement);
        assert.deepEqual(context.response.body.cancelLevels, state.cancelLevels);
        assert.equal(context.response.body.recoveryRequired, state.recoveryRequired);
      }
    }
  }
  cases.push({ mode, status: expected, post: !!opts.post, legacy: !!opts.legacy, ...calls });
}

(async () => {
  try {
    const legacyAt = process.argv.indexOf("--legacy-helper");
    if (legacyAt >= 0) {
      const legacy = process.argv[legacyAt + 1];
      await run("stata-error", 200, { legacy });
      await run("slow", 200, { legacy });
      console.log(JSON.stringify({ verdict: "LEGACY_FAILURE_AND_EARLY_RETURN_REPRODUCED", cases }));
      return;
    }
    for (const [mode, expected] of [
      ["normal", 200], ["empty", 200], ["slow", 200], ["mkdir", 500],
      ["sync-throw", 500], ["rejected", 500], ["stata-error", 500], ["nonzero-rc", 500],
      ["raw-error", 500], ["no-result", 500], ["missing", 500], ["partial", 500],
      ["duplicate", 500], ["timeout", 504], ["drain-failed", 503],
    ]) await run(mode, expected);
    await run("stata-error", 200, { post: true });
    assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
    assert.equal(preRun.patchBundle(bundle), bundle, "previous patch still composes");
    assert.throws(() => patch.patchBundle(bundle.replace("timeoutMs:30000});\n    if (!result", "timeoutMs:20000});\n    if (!result")), /modified/);
    assert.throws(() => patch.patchBundle(bundle + declarations.get("__codexCaptureGraphInventory")), /ambiguous/);
    assert.match(capturedCode, /^nobreak \{/);
    assert.ok(capturedCode.indexOf("_return hold") < capturedCode.indexOf("graph dir"));
    assert.ok(capturedCode.indexOf("capture file close") < capturedCode.indexOf("_return restore"));
    assert.match(capturedCode, /capture noisily break \{/);
    assert.match(capturedCode, /tempname __codex_gi_r __codex_gi_fh/);
    console.log(JSON.stringify({ verdict: "PASS", cases, liveStata: false,
      components: ["bundle inventory", "bundle begin", "bundle bridge entry/catches", "bundle guard wrapper", "execution_guard.guardFixed", "bundle post-export"],
      bundleSha256: crypto.createHash("sha256").update(bundle).digest("hex") }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
