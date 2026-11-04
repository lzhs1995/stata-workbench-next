#!/usr/bin/env node
"use strict";

// PLAN-V3 stage 6: the rc.7.79 warm cache must follow the default worker
// (list_sessions pid / created_at / status), and Terminal input restarts a
// worker that died while starting once, without kM's force reset (which on
// Windows ends every Stata window while a run holds the lifecycle). The real
// bundle's Terminal handler (kM / __codexOnce), rc.7.67 start, rc.7.72 warm-up,
// rc.7.79 and rc.7.81 helpers run in node:vm on a virtual clock against a fake
// mcp-stata whose workers start, fail and are replaced on a script.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_warm_worker_identity_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_warm_worker_identity_patch";
const ROOT = path.join(__dirname, "..");
const bundle = revertAfter(fs.readFileSync(path.join(ROOT, "dist", "extension.js"), "utf8"), NAME);
const before = patch.revertBundle(bundle);

assert.equal(fingerprint.verify(bundle).ok, true, "bundle identity verifies");
assert.equal(patch.patchBundle(before), bundle, "replay reproduces the sealed layer");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "patch is byte-idempotent");
assert.ok(bundle.includes(patch.MARKER) && !before.includes(patch.MARKER), "marker only in the patched layer");
assert.throws(() => patch.patchBundle(before.replace(patch.HELPER_ANCHOR, () => patch.HELPER_ANCHOR + "var __codexWarmWorker=null;\n")), /partial/);

const M72 = "// codex patch rc.7.72: backend warm-up waits for Stata, not just the MCP handshake";
const TAIL81 = "globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmRestartOnce;\n";
function segments(source) {
  const one = (needle, label) => {
    const at = source.indexOf(needle);
    assert.ok(at >= 0 && source.indexOf(needle, at + 1) < 0, "segment not unique: " + label);
    return at;
  };
  const sa = one("async function __codexEnsureBackendStarted(runId, source) {", "backend start");
  const started = source.slice(sa, source.indexOf("\n}\n", sa) + 3);
  const tail = source.includes(patch.MARKER) ? TAIL81 : patch.HELPER_ANCHOR;
  const warm = source.slice(one(M72, "warm-up helper"), one(tail, "helper tail") + tail.length);
  const ka = one("var kM=async(g,A)=>{", "terminal handler");
  const terminal = source.slice(ka, source.indexOf(",XRA=async()=>{", ka)) + ";";
  return { started, warm, terminal };
}
// ---- virtual clock + fake mcp-stata (session map like sessions.py) ---------
function harness(source, script = {}) {
  let now = 1_800_000_000_000, seq = 0, nextPid = 4100;
  const timers = new Map();
  const schedule = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every }); return id; };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  const iso = () => new Date(now).toISOString();
  const running = (script.status || "starting") === "running";
  const sess = { present: true, status: script.status || "starting", readyAt: script.readyAt ?? 0, failStarts: script.failStarts || 0,
    pid: running ? nextPid++ : null, createdAt: iso(), created: 0, stops: 0 };
  const statusNow = () => {
    if (!sess.present) return "missing";
    if (sess.status === "starting" && now >= sess.readyAt) {
      if (sess.failStarts > 0) { sess.failStarts--; sess.status = "error"; } else { sess.status = "running"; sess.pid = nextPid++; }
    }
    return sess.status;
  };
  const replace = (opts = {}) => {
    sess.present = true; sess.createdAt = new Date(now + 1).toISOString();
    if (opts.running) { sess.status = "running"; sess.pid = opts.pid ?? nextPid++; } else { sess.status = "starting"; sess.pid = null; sess.readyAt = now + (opts.readyIn ?? 30_000); }
    if (opts.keepPid != null) sess.pid = opts.keepPid;
  };
  const counts = { probes: 0, forceResets: 0 };
  const zg = {
    _transport: { id: 1 }, connects: 0,
    _availableTools: new Set(["list_sessions", "create_session", "stop_session"]),
    async _ensureClient() { if (!this._transport) { this.connects++; this._transport = { id: 100 + this.connects }; } return { client: true }; },
    _parseToolJson(x) { return x; },
    async _callTool(_c, name) {
      if (name === "list_sessions") {
        counts.probes++;
        if (script.delayCall === counts.probes) await new Promise((r) => schedule(r, script.delayMs ?? 2000, 0));
        if (script.probeHangs > 0) { script.probeHangs--; return new Promise(() => {}); }
        if (script.probeFails > 0) { script.probeFails--; throw new Error("list_sessions transport hiccup"); }
        if (script.probeThrows) throw new Error("list_sessions transport hiccup");
        const st = statusNow();
        // Review V3-R1: the connection is replaced (reset generation unchanged) right
        // after the Nth "running" answer, before the awaiting code resumes.
        if (st === "running" && script.swapAt) {
          script.runningSeen = (script.runningSeen || 0) + 1;
          if (script.swapAt[0] === script.runningSeen) {
            script.swapAt.shift();
            const reply = { sessions: [{ id: "default", status: st, created_at: sess.createdAt, pid: sess.pid }] };
            zg._transport = { id: 900 + script.runningSeen };
            replace({ readyIn: 30_000 });
            return reply;
          }
        }
        // Review V2-R1: change the worker right after a poll that answered "running",
        // i.e. just before the next list_sessions (the post-READY record probe).
        if (st === "running" && script.afterRunning && script.afterRunning.length) {
          const reply = { sessions: [{ id: "default", status: st, created_at: sess.createdAt, pid: sess.pid }] };
          script.afterRunning.shift()();
          return reply;
        }
        if (st === "missing") return { sessions: [] };
        return { sessions: [script.noIdentity ? { id: "default", status: st } : { id: "default", status: st, created_at: sess.createdAt, pid: sess.pid }] };
      }
      if (name === "stop_session") { sess.stops++; sess.present = false; sess.status = "stopped"; if (script.stopOnStop) g.__codexResetGeneration++; return {}; }
      if (name === "create_session") { sess.created++; replace({ readyIn: script.restartMs ?? 20_000 }); return {}; }
      return {};
    },
    async runSelection(code, opts) {
      dispatches.push({ at: now, status: statusNow(), pid: sess.pid, code: String(code) });
      try { opts && opts.onStarted && opts.onStarted(); } catch {}
      return { success: true, rc: 0, stdout: "ok", contentText: "ok" };
    },
  };
  const dispatches = [], logs = [], panel = [], released = [], guards = [];
  const g = {};
  const ctx = {
    globalThis: g, Date: FakeDate, Number, String, Math, JSON, Error, Promise, Object, Array, Set, Map, WeakSet, RegExp, Boolean,
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)), clearInterval: (id) => timers.delete(id),
    process: { env: {}, cwd: () => ROOT, platform: "win32" }, require, console,
    zg, RI: (m) => logs.push(String(m)), ng: () => {},
    Gg: { appendStreamingLog: (id, t) => panel.push({ id, t: String(t) }), updateStreamingStatus: () => {}, currentPanel: {} },
    yC: { extensionUri: { fsPath: ROOT } }, rg: path, JA: fs, fF: () => () => {},
    iA: { commands: { executeCommand: async () => {} } }, dM: { show() {} }, Qn: null, __codexHandleArtifact: () => {},
  };
  Object.assign(g, {
    __codexResetGeneration: 0, __codexBridgeState: { busy: false },
    __codexControlPlane: { ensureRecoveryState: (x) => x || { required: false } }, __codexRecoveryState: { required: false },
    __codexVisibleAcquire: () => true, __codexVisibleRelease: (r) => released.push(r),
    __codexExecutionAdapter: { ensureLifecycle: () => ({}), recordStarted() {}, recordProgress() {}, recordLogPath() {} },
    __codexExecGuardRef: { POLICY: { PROGRESS: "PROGRESS" }, createState: (o) => ({ ...o, createdAt: now }),
      guardProgress: async (fn) => { guards.push({ at: now }); return { ok: true, value: await fn() }; }, publicSummary: (s) => s },
    __codexShouldIncludeGraphs: () => false, __codexPrepareGraphRunCode: (code) => ({ code, captureBaseline: false }),
    __codexBeginGraphRun: async (runId, src) => { await g.__codexEnsureBackendWarm(runId, src); },
    __codexRouteGraphManifestOrExport: async () => ({}), __codexFinishGraphRunNoExport: () => {}, __codexGraphMark: () => {},
    // kM's stopped-session retry; on Windows this would panic-kill every Stata window while busy.
    __codexForceReset: async () => { counts.forceResets++; g.__codexResetGeneration++; zg._transport = null; },
  });
  vm.createContext(ctx);
  const seg = segments(source);
  vm.runInContext("var __codexBackendStart=null,__codexLastColdBackendStart=null;\n" + seg.started + "\n" + seg.warm
    + "\n" + seg.terminal + "\nglobalThis.__kM=kM;", ctx);
  async function drive(promise) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    // Bounded by virtual time: a run that never settles (a hung mutant) stops after
    // 2 h of fake clock instead of spinning on the Terminal's 1 s progress interval.
    const until = now + 7_200_000;
    for (let i = 0; i < 400000 && !done && now < until; i++) {
      for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r));
      if (done) break;
      let next = null;
      for (const [id, t] of timers) if (!next || t.at < next[1].at) next = [id, t];
      if (!next) break;
      now = Math.max(now, next[1].at);
      if (next[1].every) next[1].at = now + next[1].every; else timers.delete(next[0]);
      try { next[1].fn(); } catch {}
    }
    if (error) return { done, error };
    return { done, value };
  }
  return {
    g, zg, sess, dispatches, guards, logs, panel, released, counts, script, replace, t0: now,
    get now() { return now; },
    run: (code, runId) => drive(g.__kM(code, { runId: runId || "debug_terminal_t", onProgress: () => {} })),
    warm: (runId, src) => drive(g.__codexEnsureBackendWarm(runId, src)),
    soonStop: (atMs) => schedule(() => { g.__codexResetGeneration++; }, atMs, 0),
    summary: () => (typeof g.__codexWarmWorkerSummary === "function" ? g.__codexWarmWorkerSummary() : null),
  };
}
// ---- cases: each throws when the layer gets it wrong ------------------------
const S = 1000;
const ok = (r) => r.value && r.value.success !== false && !r.value.error;
const refusal = (r) => (r.value && r.value.guardFailure) || {};
const CASES = {
  // Same transport, worker replaced and still starting: the next run waits for the new one.
  async rebuiltWorkerWaits(src) {
    const h = harness(src, { status: "running" });
    assert.ok(ok(await h.run("display 1", "debug_terminal_1")));
    h.replace({ readyIn: 40 * S });
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")), "second run completes");
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[1].status, "running", "dispatched only after the new worker reports running");
    assert.ok(h.dispatches[1].at >= h.t0 + 40 * S);
  },
  // The cached worker itself died (same pid, status error): never dispatch into it.
  async cachedWorkerCrashed(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.sess.status = "error";
    await h.run("display 2", "debug_terminal_2");
    assert.ok(h.dispatches.every((d) => d.status === "running"), "never dispatched into a dead worker");
  },
  // Worker replaced but already running: cache dropped once on the pid, new identity recorded.
  async replacedRunningRecorded(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    assert.ok(h.summary()?.worker?.pid != null, "identity recorded when the cache was filled");
    h.replace({ running: true });
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.summary().drops, 1, "pid change drops the cache once");
    assert.match(String(h.summary().lastDrop.reason), /^pid /);
    assert.equal(h.summary().worker.pid, h.sess.pid, "new worker recorded");
    assert.ok(ok(await h.run("display 3", "debug_terminal_3")));
    assert.equal(h.summary().drops, 1, "same worker: no further drop");
    assert.equal(h.dispatches.length, 3);
  },
  async createdAtChangeDetected(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.replace({ running: true, keepPid: h.sess.pid });
    await h.run("display 2", "debug_terminal_2");
    assert.equal(h.summary().drops, 1, "created_at change alone drops the cache");
    assert.equal(h.summary().lastDrop.reason, "created_at changed");
  },
  // Cache hit on the same worker: one read-only probe, no notice, no delay.
  async sameWorkerQuiet(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    const p = h.counts.probes, t = h.now;
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.counts.probes - p, 1, "one identity probe per cached run");
    assert.ok(h.now - t < 2 * S);
    assert.ok(!h.panel.some((x) => /Waiting for Stata/.test(x.t)));
    assert.equal(h.summary().drops, 0);
  },
  // Review P1: worker replaced (still starting) and the identity probe fails once.
  // Unknown is not "old worker fine": the run waits for the new one.
  async replacementStartingProbeError(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.replace({ readyIn: 30 * S });
    h.script.probeFails = 1;
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[1].status, "running", "not dispatched into the starting worker");
    assert.ok(h.dispatches[1].at >= h.t0 + 30 * S);
    assert.match(String(h.summary().lastDrop.reason), /^probe failed/);
  },
  // Same, but the probe hangs: dropped after its own 5 s bound, then waits.
  async replacementStartingProbeTimeout(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.replace({ readyIn: 30 * S });
    h.script.probeHangs = 1;
    const t = h.now;
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.dispatches[1].status, "running");
    assert.match(String(h.summary().lastDrop.reason), /timed out/);
    assert.ok(h.summary().lastProbe.ok === true && h.now - t < 40 * S);
  },
  // Cached worker died and the probe errors: rc.7.72 sees "error", Terminal restarts once.
  async exitedWorkerProbeError(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.sess.status = "error";
    h.script.probeFails = 1;
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[1].status, "running", "never dispatched into the dead worker");
    assert.equal(h.sess.created, 1);
    assert.equal(h.counts.forceResets, 0);
  },
  // list_sessions keeps failing: refused, nothing dispatched, no force reset.
  async probeKeepsFailingRefused(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.script.probeThrows = true;
    const r = await h.run("display 2", "debug_terminal_2");
    assert.equal(r.value.success, false);
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.counts.forceResets, 0);
    h.script.probeThrows = false;
    assert.ok(ok(await h.run("display 3", "debug_terminal_3")), "next command works");
  },
  // Stop lands while the cache-hit identity probe is in flight: refused, nothing sent.
  async stopDuringEntryProbe(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.script.delayCall = h.counts.probes + 1;
    h.soonStop(1 * S);
    const r = await h.run("display 2", "debug_terminal_2");
    assert.equal(r.value.success, false);
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.counts.forceResets, 0);
    assert.ok(ok(await h.run("display 3", "debug_terminal_3")), "next command works");
    // Agent /run-command has no Terminal guard above it: the warm-up itself refuses.
    const p = h.counts.probes;
    h.script.delayCall = p + 1;
    h.soonStop(1 * S);
    const a = await h.warm("agent_run_2", "run-command");
    assert.equal(a.error?.__codexPreRunTimeout?.reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(h.counts.probes - p, 1, "refused at the probe, no new warm-up wait");
  },
  // Stop lands during the identity record after READY: refused, nothing sent.
  async stopDuringRecordProbe(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.replace({ running: true });
    h.script.delayCall = h.counts.probes + 3;
    h.soonStop(1 * S);
    const r = await h.run("display 2", "debug_terminal_2");
    assert.equal(r.value.success, false);
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(h.dispatches.length, 1);
    assert.ok(ok(await h.run("display 3", "debug_terminal_3")), "next command works");
    h.replace({ running: true });
    h.script.delayCall = h.counts.probes + 3;
    h.soonStop(1 * S);
    const a = await h.warm("agent_run_2", "run-command");
    assert.equal(a.error?.__codexPreRunTimeout?.reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED", "agent path refused by the warm-up itself");
  },
  // V2-R1: after READY the record probe sees starting / missing / error / a rejection
  // / a timeout. That READY is dropped; the run waits again (Terminal and agent).
  async recordProbeStarting(src) { await recordCase(src, (h) => () => h.replace({ readyIn: 30 * S }), (h) => h.now >= h.t0 + 40 * S); },
  async recordProbeMissing(src) { await recordCase(src, (h) => () => { h.sess.present = false; }, (h) => h.sess.created >= 1); },
  async recordProbeRejected(src) { await recordCase(src, (h) => () => { h.script.probeFails = 1; h.replace({ readyIn: 30 * S }); }, () => true); },
  async recordProbeTimeout(src) { await recordCase(src, (h) => () => { h.script.probeHangs = 1; h.replace({ readyIn: 30 * S }); }, () => true); },
  async recordProbeError(src) {
    const t = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
    t.script.afterRunning = [() => { t.sess.status = "error"; }];
    assert.ok(ok(await t.run("display 1", "debug_terminal_1")), "Terminal: dead worker stopped, restarted once, then runs");
    assert.deepEqual(t.dispatches.map((d) => d.status), ["running"]);
    assert.equal(t.sess.created, 1);
    assert.equal(t.counts.forceResets, 0);
    const a = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
    a.script.afterRunning = [() => { a.sess.status = "error"; }];
    const r = await a.warm("agent_run_1", "visible-bridge");
    assert.equal(r.error?.__codexPreRunTimeout?.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED", "agent: refused, not run");
    assert.equal(r.error.__codexPreRunTimeout.payloadDispatched, false);
  },
  // The worker changes after both READYs: refused before dispatch, no force reset.
  async recordProbeChangesTwice(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
    h.script.afterRunning = [() => h.replace({ readyIn: 10 * S }), () => h.replace({ readyIn: 10 * S })];
    const r = await h.run("display 1", "debug_terminal_1");
    assert.equal(r.value.success, false);
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(refusal(r).workerChanged, true);
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.counts.forceResets, 0);
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")), "next command works");
    assert.equal(h.dispatches[0].status, "running");
  },
  // Stop during the wait that follows a dropped READY: CANCELLED, nothing sent.
  async stopDuringRecordRetry(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
    h.script.afterRunning = [() => { h.replace({ readyIn: 60 * S }); h.soonStop(5 * S); }];
    const r = await h.run("display 1", "debug_terminal_1");
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(h.dispatches.length, 0);
  },
  // V3-R1: the connection is replaced while the post-READY record probe is in flight.
  async transportSwapDuringRecordProbe(src) {
    for (const via of ["terminal", "agent"]) {
      const h = harness(src, { status: "running" });
      h.script.swapAt = [2];
      const r = via === "terminal" ? await h.run("display 1", "debug_terminal_1") : await h.warm("agent_run_1", "visible-bridge");
      if (via === "terminal") {
        assert.ok(ok(r), "Terminal completes");
        assert.deepEqual(h.dispatches.map((d) => d.status), ["running"], "Terminal dispatched only into a running worker");
      } else {
        assert.equal(r.value?.outcome, "READY");
        assert.equal(h.sess.status, "running", "agent would dispatch into a running worker");
      }
      assert.ok(h.now >= h.t0 + 30 * S, via + ": waited for the worker on the new connection");
      assert.equal(h.summary().worker?.transport, h.zg._transport, via + ": recorded worker is on the current connection");
      assert.match(String(h.summary().lastDrop?.reason), /transport changed during the probe/);
      assert.equal(h.g.__codexResetGeneration, 0, "no Stop/reset involved");
    }
  },
  // The connection changes during both record probes: refused, nothing dispatched.
  async transportSwapTwiceRefused(src) {
    for (const via of ["terminal", "agent"]) {
      const h = harness(src, { status: "running" });
      h.script.swapAt = [2, 4];
      const r = via === "terminal" ? await h.run("display 1", "debug_terminal_1") : await h.warm("agent_run_1", "visible-bridge");
      const f = via === "terminal" ? refusal(r) : (r.error?.__codexPreRunTimeout || {});
      assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED", via);
      assert.equal(f.payloadDispatched, false);
      assert.equal(f.workerChanged, true);
      assert.equal(h.dispatches.length, 0, via + ": nothing dispatched");
      assert.equal(h.counts.forceResets, 0);
    }
  },
  // The connection is replaced while the cache-hit entry probe is in flight.
  async transportSwapDuringEntryProbe(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    h.script.swapAt = [1];
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.dispatches[1].status, "running", "Terminal not dispatched into the worker starting on the new connection");
    assert.match(String(h.summary().lastDrop?.reason), /^transport changed during the probe/);
    assert.equal(h.summary().worker?.transport, h.zg._transport);
    const a = harness(src, { status: "running" });
    await a.warm("agent_run_1", "visible-bridge");
    a.script.swapAt = [1];
    const t = a.now, r = await a.warm("agent_run_2", "visible-bridge");
    assert.equal(r.value?.outcome, "READY");
    assert.equal(a.sess.status, "running", "agent waited for the new worker");
    assert.ok(a.now - t >= 30 * S);
  },
  // Old mcp-stata without list_sessions: nothing to verify, the run proceeds and is never "confirmed".
  async oldServerNoListSessions(src) {
    const h = harness(src, { status: "running" });
    h.zg._availableTools.delete("list_sessions");
    assert.ok(ok(await h.run("display 1", "debug_terminal_1")));
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.counts.probes, 0);
    assert.equal(h.summary().skipped, 0, "never marked confirmed");
  },
  // A second warm-up call in the same run (Terminal, then BeginGraphRun) does not probe again.
  async oneProbePerRun(src) {
    const h = harness(src, { status: "running" });
    await h.run("display 1", "debug_terminal_1");
    const p = h.counts.probes;
    await h.warm("debug_terminal_2", "terminal-input");
    await h.warm("debug_terminal_2", "terminal-input");
    assert.equal(h.counts.probes - p, 1, "same run reuses its probe");
    assert.equal(h.summary().skipped, 1);
    await h.warm("debug_terminal_3", "terminal-input");
    assert.equal(h.counts.probes - p, 2, "a new run probes again");
  },
  // list_sessions without pid/created_at: status alone decides.
  async noIdentityFields(src) {
    const h = harness(src, { status: "running", noIdentity: true });
    await h.run("display 1", "debug_terminal_1");
    h.replace({ running: true });
    assert.ok(ok(await h.run("display 2", "debug_terminal_2")));
    assert.equal(h.summary().drops, 0, "nothing to compare: a running worker keeps the cache");
    h.replace({ readyIn: 30 * S });
    assert.ok(ok(await h.run("display 3", "debug_terminal_3")));
    assert.equal(h.dispatches[2].status, "running", "status still decides");
  },
  // Default worker dies while starting: Terminal restarts it once and runs; no force reset.
  async deadWorkerRestartedOnce(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 1 });
    assert.ok(ok(await h.run('display "after restart"')), "runs after one restart");
    assert.equal(h.sess.stops, 1, "dead worker stopped (rc.7.72)");
    assert.equal(h.sess.created, 1, "one new worker");
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].status, "running");
    assert.equal(h.counts.forceResets, 0, "no force reset (Windows panic-kill path)");
    assert.equal(h.released.length, 1);
    assert.ok(h.panel.some((x) => /starting it once more/.test(x.t)), "the person is told");
    assert.equal(h.summary().restarts, 1);
  },
  // Dies twice: one refusal with the warm-up code, nothing dispatched, no force reset.
  async deadTwiceRefused(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 2 });
    const r = await h.run('display "never"');
    const f = refusal(r);
    assert.equal(r.value.success, false);
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(f.payloadDispatched, false);
    assert.equal(f.restartedOnce, true, "the refusal says it already restarted once");
    assert.equal(h.sess.created, 1, "restarted once only");
    assert.equal(h.sess.stops, 2);
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.counts.forceResets, 0);
    assert.equal(h.released.length, 1);
    assert.ok(h.panel.some((x) => /The command was not sent/.test(x.t)));
  },
  // Stop lands while the dead worker is being stopped: Stop wins, no restart.
  async stopBeforeRestart(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 1, stopOnStop: true });
    const r = await h.run('display "stopped"');
    assert.equal(r.value.success, false, "refused");
    assert.equal(h.sess.created, 0, "no restart after Stop");
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.released.length, 1);
  },
  // Agent /run-command keeps rc.7.72's contract: refused, not restarted.
  async agentNotRestarted(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 1 });
    const r = await h.warm("agent_run_1", "run-command");
    assert.equal(r.error?.__codexPreRunTimeout?.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(h.sess.created, 0, "agent path not restarted");
  },
  // A worker that never leaves "starting" is a timeout, refused once with its own bound.
  async timeoutNotRestarted(src) {
    const h = harness(src, { status: "starting", readyAt: Infinity });
    const r = await h.run('display "slow"');
    assert.equal(refusal(r).reasonCode, "PRE_RUN_BACKEND_WARMUP_TIMEOUT");
    assert.equal(refusal(r).payloadDispatched, false);
    assert.equal(h.sess.created, 0);
    assert.equal(h.dispatches.length, 0);
    assert.ok(h.now - h.t0 < 400 * S, "one 300 s bound, not two");
  },
};
// One record-probe scenario on a cold start, through Terminal and through the agent warm-up.
async function recordCase(src, change, waited) {
  const t = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
  t.script.afterRunning = [change(t)];
  assert.ok(ok(await t.run("display 1", "debug_terminal_1")), "Terminal run completes");
  assert.deepEqual(t.dispatches.map((d) => d.status), ["running"], "Terminal dispatched only into a running worker");
  assert.ok(waited(t), "Terminal waited for the new worker");
  assert.match(String(t.summary().lastDrop?.reason), /^after READY/);
  assert.equal(t.counts.forceResets, 0);
  const a = harness(src, { status: "starting", readyAt: 1_800_000_010_000 });
  a.script.afterRunning = [change(a)];
  const r = await a.warm("agent_run_1", "visible-bridge");
  assert.equal(r.error, undefined, "agent not refused");
  assert.equal(r.value?.outcome, "READY");
  assert.equal(a.sess.status, "running", "agent would dispatch into a running worker");
  assert.equal(a.summary().worker?.pid, a.sess.pid, "the current worker is the one recorded");
}
// ---- mutants of the patched layer: each must make at least one case fail ----
const MUTANTS = [
  ["cache-hit status ignored", 'seen.status !== "running" ? "status "', 'false ? "status "'],
  ["pid not compared", "known.pid !== seen.pid", "false"],
  ["created_at not compared", "known.createdAt !== seen.createdAt", "false"],
  ["probe failure keeps cache", '        : !seen.ok ? "probe failed: " + seen.error\n', "        : !seen.ok ? null\n"],
  ["probe not bounded", 'timer = setTimeout(() => reject(new Error("worker identity probe timed out after 5000 ms")), 5000);', "void reject;"],
  ["Stop during entry probe ignored", 'if (stopped()) throw __codexWarmWorkerCancelled(id, source, "worker identity probe", started);', ""],
  ["Stop during record probe ignored", 'if (stopped()) throw __codexWarmWorkerCancelled(id, source, "worker identity record", started);', ""],
  ["probe every call", "__codexWarmWorkerStats.skipped++;\n    return null;", "__codexWarmWorkerStats.skipped++;"],
  ["identity not recorded", "      __codexWarmWorker = { transport: warmed, pid: seen.pid, createdAt: seen.createdAt };\n", "      __codexWarmWorker = null;\n"],
  ["record probe ignores the connection", "const same = !!seen && seen.transport === warmed && (zg?._transport || null) === warmed && __codexWarmTransport === warmed;", "const same = !!seen;"],
  ["entry probe ignores the connection", 'const changed = seen.transport !== transport || (zg?._transport || null) !== transport || __codexWarmTransport !== transport\n        ? "transport changed during the probe"\n        : ', "const changed = "],
  ["record miss keeps stale READY", "    __codexWarmWorkerDrop(id, why);\n", "    return result;\n"],
  ["record miss retried without limit", "    if (attempt > 0) throw __codexWarmWorkerChanged(id, source, why, started, seen && seen.ok ? seen.status : null);\n", ""],
  ["no restart", "    __codexWarmWorkerStats.restarts++;\n", "    throw error;\n"],
  ["restart any source", 'source !== "terminal-input" || ', ""],
  ["restart any refusal", '!refusal || refusal.reasonCode !== "PRE_RUN_BACKEND_WARMUP_FAILED"\n      || refusal.lastStatus !== "error" || refusal.recovery !== "STOPPED_FAILED_SESSION"\n      || ', "!refusal || "],
  ["restart ignores Stop", '"STOPPED_FAILED_SESSION"\n      || Number(globalThis.__codexResetGeneration || 0) !== generation) throw error;', '"STOPPED_FAILED_SESSION") throw error;'],
  ["restart not announced", 'Gg.appendStreamingLog(runId, "\\n[Stata Workbench] Stata stopped', 'void(runId, "\\n[Stata Workbench] Stata stopped'],
  ["second failure not tagged", "restartedOnce: true, ", ""],
];

async function runAll(src) {
  const failed = [];
  for (const [name, fn] of Object.entries(CASES)) {
    try { await fn(src); } catch (e) { failed.push(name + ": " + String(e && e.message || e).split("\n")[0]); }
  }
  return failed;
}

(async () => {
  const fixed = await runAll(bundle);
  assert.deepEqual(fixed, [], "patched layer passes every case:\n" + fixed.join("\n"));
  const old = await runAll(before);
  for (const must of ["rebuiltWorkerWaits", "cachedWorkerCrashed", "deadWorkerRestartedOnce", "replacementStartingProbeError"]) {
    assert.ok(old.some((f) => f.startsWith(must + ":")), "the layer before rc.7.81 fails " + must);
  }
  const caught = [];
  for (const [name, from, to] of MUTANTS) {
    assert.equal(bundle.split(from).length, 2, "mutant anchor unique: " + name);
    const failed = await runAll(bundle.replace(from, () => to));
    assert.ok(failed.length > 0, "mutant survived: " + name);
    caught.push(name + " -> " + failed.map((f) => f.split(":")[0]).join(","));
  }
  console.log(JSON.stringify({ verdict: "WARM_WORKER_IDENTITY_PASS", cases: Object.keys(CASES).length,
    beforeFails: old.map((f) => f.split(":")[0]), mutants: `${caught.length}/${MUTANTS.length}`, caught }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
