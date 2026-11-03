#!/usr/bin/env node
"use strict";

// F fix6: Terminal input must wait for the default Stata session to report
// "running" before its payload (W-P1 entry gap, W5 w5f2). The real bundle's
// Terminal handler (kM / __codexOnce), rc.7.67 backend start, rc.7.72 warm-up
// and the rc.7.79 helpers run in node:vm on a virtual clock against a fake
// mcp-stata whose worker becomes ready at a scripted time. The layer before
// the patch must dispatch into a starting worker.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_terminal_warmup_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_terminal_warmup_patch";
const ROOT = path.join(__dirname, "..");
const bundle = revertAfter(fs.readFileSync(path.join(ROOT, "dist", "extension.js"), "utf8"), NAME);
const before = patch.revertBundle(bundle);

assert.equal(fingerprint.verify(bundle).ok, true, "bundle identity verifies");
assert.equal(patch.patchBundle(before), bundle, "replay reproduces the sealed layer");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "patch is byte-idempotent");
assert.ok(bundle.includes(patch.MARKER) && !before.includes(patch.MARKER), "marker only in the patched layer");

const M72 = "// codex patch rc.7.72: backend warm-up waits for Stata, not just the MCP handshake";
function segments(source) {
  const one = (needle, label) => {
    const at = source.indexOf(needle);
    assert.ok(at >= 0 && source.indexOf(needle, at + 1) < 0, "segment not unique: " + label);
    return at;
  };
  const sa = one("async function __codexEnsureBackendStarted(runId, source) {", "backend start");
  const started = source.slice(sa, source.indexOf("\n}\n", sa) + 3);
  const wa = one(M72, "warm-up helper");
  const tail = source.includes(patch.MARKER) ? "globalThis.__codexTerminalWarmup = __codexTerminalWarmup;\n" : patch.HELPER_ANCHOR;
  const warm = source.slice(wa, one(tail, "helper tail") + tail.length);
  const ka = one("var kM=async(g,A)=>{", "terminal handler");
  const terminal = source.slice(ka, source.indexOf(",XRA=async()=>{", ka)) + ";";
  return { started, warm, terminal };
}

// ---- virtual clock + fake mcp-stata ---------------------------------------
function harness(source, script) {
  let now = 1_800_000_000_000, seq = 0;
  const timers = new Map();
  const schedule = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every }); return id; };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  const sess = { status: script.status || "starting", readyAt: script.readyAt ?? 0, created: 0, stops: 0 };
  const statusNow = () => (sess.status === "starting" && now >= sess.readyAt ? (sess.status = "running") : sess.status);
  const zg = {
    _transport: script.cold ? null : { id: 1 }, connects: 0,
    _availableTools: new Set(script.noListSessions ? ["run_command_background"] : ["list_sessions", "create_session", "stop_session"]),
    async _ensureClient() { if (!this._transport) { this.connects++; this._transport = { id: 100 + this.connects }; } return { client: true }; },
    _parseToolJson(x) { return x; },
    async _callTool(_c, name) {
      if (name === "list_sessions") { script.probes = (script.probes || 0) + 1; return { sessions: [{ id: "default", status: statusNow() }] }; }
      if (name === "stop_session") { sess.stops++; sess.status = "stopped"; return {}; }
      if (name === "create_session") { sess.created++; sess.status = "starting"; return {}; }
      return {};
    },
    async runSelection(code, opts) {
      dispatches.push({ at: now, status: statusNow(), code: String(code), generation: Number(g.__codexResetGeneration || 0) });
      try { opts && opts.onStarted && opts.onStarted(); } catch {}
      return { success: true, rc: 0, stdout: "ok", contentText: "ok" };
    },
  };
  const dispatches = [], logs = [], panel = [], progress = [], released = [], begun = [];
  const g = {};
  const ctx = {
    globalThis: g, Date: FakeDate, Number, String, Math, JSON, Error, Promise, Object, Array, Set, Map, WeakSet, RegExp, Boolean,
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)), clearInterval: (id) => timers.delete(id),
    process: { env: {}, cwd: () => ROOT, platform: "darwin" }, require, console,
    zg, RI: (m) => logs.push(String(m)), ng: () => {},
    Gg: { appendStreamingLog: (id, t) => panel.push({ id, t: String(t) }), updateStreamingStatus: () => {}, currentPanel: {} },
    yC: { extensionUri: { fsPath: ROOT } }, rg: path, JA: fs, fF: () => () => {},
    iA: { commands: { executeCommand: async () => { const s = g.__codexDataBrowserStatus || { credentialRefreshes: 0 };
      g.__codexDataBrowserStatus = { credentialRefreshes: Number(s.credentialRefreshes || 0) + 1, webviewReady: true, credentialsReady: true,
        datasetK: 0, variableCount: 0, selectedVariableCount: 0, rowCount: 0, lastArrowBytes: 0, lastError: null }; } } },
    dM: { show() {} }, Qn: null, __codexHandleArtifact: () => {},
  };
  Object.assign(g, {
    __codexResetGeneration: 0, __codexBridgeState: { busy: false },
    __codexControlPlane: { ensureRecoveryState: (x) => x || { required: false } }, __codexRecoveryState: { required: false },
    __codexVisibleAcquire: () => true, __codexVisibleRelease: (r) => released.push(r),
    __codexExecutionAdapter: { ensureLifecycle: () => ({}), recordStarted() {}, recordProgress() {}, recordLogPath() {} },
    __codexExecGuardRef: { POLICY: { PROGRESS: "PROGRESS" }, createState: (o) => ({ ...o, createdAt: now }),
      guardProgress: async (fn, opts) => { guards.push({ at: now, status: statusNow() }); return { ok: true, value: await fn() }; },
      publicSummary: (s) => s },
    __codexShouldIncludeGraphs: (code) => /\bscatter\b|\bgraph\b/.test(String(code)),
    __codexPrepareGraphRunCode: (code) => ({ code, captureBaseline: false }),
    __codexBeginGraphRun: async (runId, source) => { begun.push(runId); await g.__codexEnsureBackendWarm(runId, source); },
    __codexRouteGraphManifestOrExport: async () => ({}), __codexFinishGraphRunNoExport: () => {}, __codexGraphMark: () => {},
    __codexForceReset: async () => { g.__codexResetGeneration++; zg._transport = null; },
  });
  const guards = [];
  vm.createContext(ctx);
  const seg = segments(source);
  vm.runInContext("var __codexBackendStart=null,__codexLastColdBackendStart=null;\n" + seg.started + "\n" + seg.warm
    + "\nglobalThis.__codexEnsureBackendStartedRef=__codexEnsureBackendStarted;\n" + seg.terminal + "\nglobalThis.__kM=kM;", ctx);
  async function drive(promise, untilMs) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    for (let i = 0; i < 400000 && !done; i++) {
      for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r));
      if (done) break;
      let next = null;
      for (const [id, t] of timers) if (!next || t.at < next[1].at) next = [id, t];
      if (!next) break;
      if (untilMs != null && next[1].at > untilMs) break;
      now = Math.max(now, next[1].at);
      if (next[1].every) next[1].at = now + next[1].every; else timers.delete(next[0]);
      try { next[1].fn(); } catch {}
    }
    if (error) throw error;
    return { done, value };
  }
  const t0 = now;
  return {
    g, zg, sess, dispatches, guards, logs, panel, progress, released, begun, t0, script,
    get now() { return now; },
    run: (code, opts = {}) => drive(g.__kM(code, { runId: opts.runId || "debug_terminal_t", onProgress: (...a) => progress.push({ at: now, a }), ...opts })),
    soonStop: (atMs) => schedule(() => { g.__codexResetGeneration++; }, atMs, 0),
  };
}
// ---- cases: each throws when the layer gets it wrong ------------------------
const S = 1000;
const ok = (r) => r.value && r.value.success !== false && !r.value.error;
const refusal = (r) => (r.value && r.value.guardFailure) || {};
const CASES = {
  // W5 w5f2: transport up, worker still initializing; `display` sent at once.
  async displayWaits(src) {
    const h = harness(src, { readyAt: 1_800_000_060_000 });
    const r = await h.run('display "W5D_N=" _N');
    assert.ok(r.done && ok(r), "display completes");
    assert.equal(h.dispatches.length, 1, "exactly one user dispatch");
    assert.equal(h.dispatches[0].status, "running", "dispatched only after the worker reports running");
    assert.ok(h.guards[0].at >= h.t0 + 60 * S, "the PROGRESS guard (payload PRE_LOG budget) starts after warm-up");
    assert.ok(h.panel.some((p) => /Waiting for Stata to finish loading/.test(p.t)), "the person sees the wait in the Terminal");
    assert.ok(h.panel.some((p) => /Stata finished loading after \d+ s/.test(p.t)), "and when it ended");
    assert.ok(h.progress.length >= 30, "the caller's progress hook hears the wait (outer UI watchdog)");
  },
  // loadStataOnStartup=false: no transport yet; Terminal input starts the backend first.
  async coldStarts(src) {
    const h = harness(src, { cold: true, readyAt: 1_800_000_050_000 });
    const r = await h.run('display "cold"');
    assert.ok(ok(r), "cold display completes");
    assert.equal(h.zg.connects, 1, "backend started once before dispatch");
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].status, "running", "cold dispatch waits for running");
  },
  // Graph code: a warm-up failure is a refusal, not swallowed by graph-prepare's catch.
  async graphFailureRefuses(src) {
    const h = harness(src, { status: "error" });
    const r = await h.run("scatter y x");
    const f = refusal(r);
    assert.equal(r.value.success, false, "refused");
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(f.payloadDispatched, false);
    assert.equal(h.dispatches.length, 0, "no user dispatch after a failed warm-up");
    assert.equal(h.released.length, 1, "visible lifecycle released once");
    assert.ok(h.panel.some((p) => /The command was not sent/.test(p.t)), "the person is told why");
  },
  // Terminal `browse` surrogate goes through the same gate.
  async browseWaits(src) {
    const h = harness(src, { readyAt: 1_800_000_030_000 });
    await h.run("browse");
    assert.equal(h.dispatches.length, 1, "one surrogate dispatch");
    assert.equal(h.dispatches[0].status, "running", "browse surrogate waits too");
  },
  // Worker never leaves "starting": warm-up's own bound, distinct code, no PRE_LOG spent.
  async stuckTimesOut(src) {
    const h = harness(src, { readyAt: Infinity });
    const r = await h.run('display "stuck"');
    const f = refusal(r);
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_TIMEOUT", "warm-up timeout, not EXEC_PRELOG_STALL");
    assert.equal(f.payloadDispatched, false);
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.guards.length, 0, "no payload guard was started");
    assert.ok(h.now - h.t0 >= 300 * S, "bounded by setup+120 s");
    assert.equal(h.released.length, 1);
    assert.ok(h.panel.some((p) => /The command was not sent/.test(p.t)));
  },
  // Start-up longer than 120 s: the payload's PRE_LOG budget is not consumed by it.
  async longStartNotCharged(src) {
    const h = harness(src, { readyAt: 1_800_000_150_000 });
    const r = await h.run('display "long"');
    assert.ok(ok(r));
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].status, "running");
    assert.ok(h.guards[0].at >= h.t0 + 150 * S, "guard created after the 150 s start-up");
  },
  // Stop during warm-up: cancelled refusal; the next run is not polluted.
  async stopDuringWarmup(src) {
    const h = harness(src, { readyAt: 1_800_000_100_000 });
    h.soonStop(20 * S);
    const r1 = await h.run('display "a"', { runId: "debug_terminal_a" });
    assert.equal(refusal(r1).reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(h.dispatches.length, 0, "nothing dispatched after Stop");
    assert.equal(h.released.length, 1);
    const r2 = await h.run('display "b"', { runId: "debug_terminal_b" });
    assert.ok(ok(r2), "next run proceeds");
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].status, "running");
  },
  // rc.7.72 cached "running" per transport; a Stop/reset must make the next run probe again.
  async generationRebinds(src) {
    const h = harness(src, { readyAt: 1_800_000_005_000 });
    await h.run('display "1"', { runId: "debug_terminal_1" });
    h.g.__codexResetGeneration++;
    h.sess.status = "starting"; h.sess.readyAt = h.now + 40 * S;
    await h.run('display "2"', { runId: "debug_terminal_2" });
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[1].status, "running", "after a reset the cached transport is probed again");
  },
  // Same transport, worker removed and recreated (warm-up's own stop path): next run waits for the new one.
  async sameTransportRebuild(src) {
    const h = harness(src, { status: "error" });
    const r1 = await h.run('display "x"', { runId: "debug_terminal_x" });
    assert.equal(refusal(r1).reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(h.sess.stops, 1, "failed worker stopped");
    h.sess.status = "missing";
    const origCall = h.zg._callTool.bind(h.zg);
    h.zg._callTool = async (c, name, a) => {
      if (name === "list_sessions" && h.sess.status === "missing") return { sessions: [] };
      if (name === "create_session") { h.sess.created++; h.sess.status = "starting"; h.sess.readyAt = h.now + 20 * S; return {}; }
      return origCall(c, name, a);
    };
    const r2 = await h.run('display "y"', { runId: "debug_terminal_y" });
    assert.ok(ok(r2));
    assert.equal(h.sess.created, 1, "default session recreated once");
    assert.equal(h.dispatches.length, 1);
    assert.equal(h.dispatches[0].status, "running");
  },
  // No list_sessions: not a guarantee; the command still runs and says so.
  async noListSessions(src) {
    const h = harness(src, { noListSessions: true, readyAt: 0 });
    const r = await h.run('display "n"');
    assert.ok(ok(r));
    assert.equal(h.dispatches.length, 1);
    const st = h.g.__codexTerminalWarmupSummary && h.g.__codexTerminalWarmupSummary();
    assert.ok(st && st.guaranteed === false, "recorded as not guaranteed");
    assert.ok(h.panel.some((p) => /Could not confirm that Stata finished loading/.test(p.t)), "and said in the Terminal");
  },
  // Already running: no notice, no delay worth mentioning.
  async fastPathQuiet(src) {
    const h = harness(src, { readyAt: 0 });
    const r = await h.run('display "fast"');
    assert.ok(ok(r));
    assert.equal(h.dispatches.length, 1);
    assert.ok(!h.panel.some((p) => /Waiting for Stata/.test(p.t)), "no wait notice when Stata is ready");
    assert.ok(h.now - h.t0 < 2 * S);
  },
};
// ---- mutants of the patched layer: each must make at least one case fail ----
const MUTANTS = [
  ["no terminal call", patch.ONCE_AFTER, patch.ONCE_BEFORE],
  ["warm-up error swallowed", "await globalThis.__codexTerminalWarmup(A?.runId||null,{onProgress:A?.onProgress});",
    "try{await globalThis.__codexTerminalWarmup(A?.runId||null,{onProgress:A?.onProgress})}catch{};"],
  ["no generation binding", "if (__codexWarmTransport && __codexWarmGeneration !== generation) __codexWarmTransport = null;", ""],
  ["no backend start", '    await __codexEnsureBackendStarted(runId, "terminal-input");\n', ""],
  ["no wait notice", "Date.now() - started >= 2000", "Date.now() - started >= 2e9"],
  ["no progress hook", "options?.onProgress && options.onProgress(null, null, \"Waiting for Stata to finish loading\");", ""],
  ["unguaranteed silent", "      state.guaranteed = false;\n", ""],
  ["refusal not announced", 'if (state.outcome === "REFUSED") post("The command was not sent: " + state.error);', ""],
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
  for (const must of ["displayWaits", "coldStarts", "graphFailureRefuses", "browseWaits", "stuckTimesOut", "longStartNotCharged"]) {
    assert.ok(old.some((f) => f.startsWith(must + ":")), "the layer before rc.7.79 fails " + must);
  }
  const caught = [];
  for (const [name, from, to] of MUTANTS) {
    assert.equal(bundle.split(from).length, 2, "mutant anchor unique: " + name);
    const failed = await runAll(bundle.replace(from, () => to));
    assert.ok(failed.length > 0, "mutant survived: " + name);
    caught.push(name + " -> " + failed.map((f) => f.split(":")[0]).join(","));
  }
  console.log(JSON.stringify({ verdict: "TERMINAL_WARMUP_PASS", cases: Object.keys(CASES).length,
    beforeFails: old.map((f) => f.split(":")[0]), mutants: `${caught.length}/${MUTANTS.length}`, caught }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
