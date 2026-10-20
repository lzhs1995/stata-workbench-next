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
const core = require("./stop_checkpoint_core");
const guard = require("./prerun_stage_guard");
const { patchBundle, MARKER, START, END } = require("./apply_bridge_prerun_failure_patch");
const fingerprint = require("./finalize_bundle_identity");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const legacy = process.argv.includes("--expect-legacy");
let finish, outer;
walk.simple(acorn.parse(bundle, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
  FunctionDeclaration(node) {
    if (node.id?.name === "__codexFinishGraphRunNoExport") {
      assert.equal(finish, undefined);
      finish = bundle.slice(node.start, node.end);
    }
  },
  CatchClause(node) {
    const source = bundle.slice(node.start, node.end);
    if (source.startsWith("catch(e){__release();let __codexOuterPrt=")) {
      assert.equal(outer, undefined);
      outer = source;
    }
  },
});
assert.ok(finish && outer);
const start = bundle.indexOf(START);
assert.ok(start >= 0);
assert.equal(bundle.indexOf(START, start + START.length), -1);
const block = bundle.slice(start, bundle.indexOf(END, start));
const script = new vm.Script(finish + "\n(async()=>{try{" + block
  + "__payload();}" + outer + "})()");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-prerun-failure-"));
const datasetBytes = "fixture dataset bytes".padEnd(512, " ");
const cases = [];

async function run(mode, expected, options = {}) {
  const dir = path.join(root, mode + (options.stopOwned ? "-stop" : ""));
  fs.mkdirSync(dir);
  const calls = { checkpoint: 0, payload: 0, cleanup: 0, release: 0, cancel: 0, stat: 0, failed: 0 };
  let context, pendingResolve;
  const coreRef = {
    ...core,
    cleanup: snapshot => {
      calls.cleanup++;
      if (mode === "cleanup-throws") throw new Error("fixture cleanup failure");
      return core.cleanup(snapshot);
    },
    beginAtomic: opts => {
      if (mode === "begin-throws") throw new Error("fixture begin failure");
      return core.beginAtomic(opts);
    },
  };
  const stateMap = new Map();
  context = {
    __run: "fixture", __runId: "request-fixture", __cwd: dir, __patch: "test", __res: {},
    require: name => name === "node:os" ? { tmpdir: () => dir } : require(name),
    __codexStopCheckpointRef: coreRef,
    __codexPreRunSnapshots: new Map(),
    __codexPreRunGuardRef: {
      ...guard,
      createStageState: (stage, meta) => {
        if (mode === "enrich-setup-throws" && stage === "enrich") throw new Error("fixture stage setup failure");
        const state = guard.createStageState(stage, meta);
        stateMap.set(stage, state);
        return state;
      },
      guardStage: (stage, work, opts) => guard.guardStage(stage, work, {
        ...opts, timeoutMs: 80, cancelDeadlineMs: 20, drainMs: 20,
      }),
    },
    __codexGuardTransport: {
      cancelAll: () => {
        calls.cancel++;
        if (mode !== "drain-failed") pendingResolve?.({ success: false, rc: 1 });
        return mode !== "drain-failed";
      },
      getRunExecutionState: () => null,
    },
    zg: { runSelection: () => {
      calls.checkpoint++;
      const snapshot = context.__codexActivePreRunSnapshot;
      if (options.stopOwned) snapshot.stopOwned = true;
      if (mode === "transport-rejected") return Promise.reject(new Error("fixture transport rejection"));
      const paths = core.checkpointPaths(snapshot);
      if (mode !== "snapshot-timeout" && mode !== "drain-failed") {
        fs.writeFileSync(snapshot.path, datasetBytes);
        fs.writeFileSync(paths.snapshotReadyPath, `ready\t${snapshot.checkpointNonce}\tdata\n`);
        if (mode !== "incomplete") {
          for (const file of [paths.globalsPath, paths.estimatesPath, paths.graphsPath]) fs.writeFileSync(file, "");
          fs.writeFileSync(paths.defaultGraphObjectPath, "0\n");
        }
      }
      if (["snapshot-timeout", "enrich-timeout", "drain-failed"].includes(mode)) {
        return new Promise(resolve => { pendingResolve = resolve; });
      }
      return Promise.resolve({ success: true, rc: 0 });
    } },
    JA: { statSync: file => {
      calls.stat++;
      if (!legacy) {
        assert.equal(context.__codexActivePreRunSnapshot.transportPromiseSettled, true);
        assert.equal(context.__codexActivePreRunSnapshot.stateComplete, true);
      }
      if (mode === "stat-throws") throw new Error("fixture stat failure");
      return fs.statSync(file);
    } },
    __codexStataString: x => x,
    __codexGraphRunBaselines: new Map([["fixture", "baseline"]]),
    __codexPreparedGraphRuns: new Map([["fixture", "prepared"]]),
    __codexGraphMark: () => {},
    __codexSetPostRunBusy: busy => { context.postRunBusy = busy; },
    postRunBusy: true,
    Gg: { failStreamingEntry: () => { calls.failed++; } },
    RI: () => {},
    __release: () => { calls.release++; },
    __send: (res, status, body) => { context.response = { status, body }; },
    __payload: () => { calls.payload++; },
  };
  await script.runInNewContext(context);
  pendingResolve?.({ success: false, rc: 1 });
  const snapshot = context.__codexActivePreRunSnapshot;
  assert.equal(calls.payload, expected === 200 ? 1 : 0, mode + " payload count " + JSON.stringify(context.response));
  assert.equal(calls.checkpoint, ["cleanup-throws", "begin-throws", "enrich-setup-throws"].includes(mode) ? 0 : 1);
  assert.equal(calls.cleanup, 1, "failure must not delete checkpoint evidence");
  if (expected !== 200) {
    assert.equal(context.response.status, expected, mode);
    assert.equal(context.response.body.payloadDispatched, false);
    assert.equal(calls.release, 1);
    assert.equal(calls.failed, 1);
    assert.equal(context.postRunBusy, false);
    assert.equal(context.__codexGraphRunBaselines.size, 0);
    assert.equal(context.__codexPreparedGraphRuns.size, 0);
    if (mode.endsWith("setup-throws") || mode === "cleanup-throws") {
      assert.equal(context.response.body.reasonCode, "PRE_RUN_SETUP_FAILED");
    } else {
      const stage = context.response.body.preRunStage;
      const expectedEnvelope = guard.timeoutResponse(stage, stateMap.get(stage));
      for (const key of Object.keys(expectedEnvelope)) {
        assert.deepEqual(context.response.body[key], expectedEnvelope[key], "guard evidence " + key);
      }
    }
  }
  if (snapshot) {
    assert.equal(snapshot.fallbackDispatchCount, 0);
    if (options.stopOwned) assert.equal(snapshot.stopOwned, true);
    if (calls.stat || mode === "incomplete" || mode === "enrich-timeout") {
      assert.equal(fs.readFileSync(snapshot.path, "utf8"), datasetBytes);
      assert.equal(context.__codexPreRunSnapshots.get("fixture"), snapshot);
    }
  }
  cases.push({ mode, stopOwned: !!options.stopOwned, status: expected, ...calls });
}

(async () => {
  try {
    if (legacy) {
      assert.ok(!bundle.includes(MARKER));
      await run("stat-throws", 200);
      console.log(JSON.stringify({ verdict: "LEGACY_FAILURE_DISPATCH_REPRODUCED", cases }));
      return;
    }
    assert.ok(bundle.includes(MARKER));
    for (const [mode, status] of [
      ["normal", 200], ["cleanup-throws", 500], ["enrich-setup-throws", 500],
      ["begin-throws", 500], ["stat-throws", 500], ["transport-rejected", 500],
      ["incomplete", 500], ["snapshot-timeout", 504], ["enrich-timeout", 504], ["drain-failed", 503],
    ]) await run(mode, status);
    await run("stat-throws", 500, { stopOwned: true });
    await run("incomplete", 500, { stopOwned: true });
    assert.equal(patchBundle(bundle), bundle, "byte idempotence");
    assert.equal(fingerprint.verify(bundle).ok, true);
    assert.throws(() => patchBundle("/* " + MARKER + " */"), /anchor/);
    assert.throws(() => patchBundle(bundle + block), /ambiguous/);
    assert.throws(() => patchBundle(bundle.replace("{allowFallback:false}", "{allowFallback:true}")), /anchor/);
    console.log(JSON.stringify({ verdict: "PASS", cases, bundleSha256:
      crypto.createHash("sha256").update(bundle).digest("hex"),
      realComponents: ["bundle pre-run block", "bundle outer HTTP failure handler", "bundle graph UI cleanup", "beginAtomic", "completeAtomic", "guardStage"], liveStata: false }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
