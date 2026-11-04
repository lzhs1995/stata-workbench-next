#!/usr/bin/env node
"use strict";

// rc.7.86 (PLAN-V3 M2): an agent /run-command (source "visible-bridge") that
// arrives while Stata is starting waits with the same bound as Terminal input,
// and every warm-up refusal says whether a retry can help. Runs the real bundle
// segment (rc.7.72 warm-up .. rc.7.86) against a fake mcp-stata on a virtual
// clock; then the layer before rc.7.86 and mutants of it. Offline; no Stata.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_agent_warmup_refusal_patch");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_agent_warmup_refusal_patch";
const ROOT = path.join(__dirname, "..");
const bundle = revertAfter(fs.readFileSync(path.join(ROOT, "dist", "extension.js"), "utf8"), NAME);
const before = patch.revertBundle(bundle);
assert.equal(patch.patchBundle(before), bundle, "patch is the exact inverse of revert");
assert.equal(patch.patchBundle(bundle), bundle, "patch is idempotent");
assert.throws(() => patch.patchBundle(before.replace(patch.HELPER_ANCHOR, () => patch.HELPER_ANCHOR + "var __codexWarmupRetryAfterMs=1;\n")), /partial/);

const M72 = "// codex patch rc.7.72: backend warm-up waits for Stata, not just the MCP handshake";
const TAIL86 = "globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmLabelled;\n";
function segment(source) {
  const at = source.indexOf(M72);
  assert.ok(at >= 0 && source.indexOf(M72, at + 1) < 0, "warm-up segment start unique");
  const tail = source.includes(patch.MARKER) ? TAIL86 : patch.HELPER_ANCHOR;
  const end = source.indexOf(tail, at);
  assert.ok(end > at && source.indexOf(tail, end + 1) < 0, "warm-up segment end unique");
  return source.slice(at, end + tail.length);
}
function harness(source, script = {}) {
  let now = 1_800_000_000_000, seq = 0, nextPid = 5100;
  const timers = new Map();
  const schedule = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const sess = { present: true, status: script.status || "starting", readyAt: script.readyAt ?? 0, failStarts: script.failStarts || 0,
    pid: script.status === "running" ? nextPid++ : null, createdAt: new Date(now).toISOString(), created: 0, stops: 0 };
  const statusNow = () => {
    if (!sess.present) return "missing";
    if (sess.status === "starting" && now >= sess.readyAt) {
      if (sess.failStarts > 0) { sess.failStarts--; sess.status = "error"; } else { sess.status = "running"; sess.pid = nextPid++; }
    }
    return sess.status;
  };
  const replace = (opts = {}) => {
    sess.present = true; sess.createdAt = new Date(now + 1).toISOString();
    if (opts.running) { sess.status = "running"; sess.pid = nextPid++; } else { sess.status = "starting"; sess.pid = null; sess.readyAt = now + (opts.readyIn ?? 30_000); }
  };
  const counts = { probes: 0 };
  const g = { __codexResetGeneration: 0 };
  const zg = {
    _transport: { id: 1 }, _availableTools: new Set(["list_sessions", "create_session", "stop_session"]),
    async _ensureClient() { return { client: true }; }, _parseToolJson: (x) => x,
    async _callTool(_c, name) {
      if (name === "list_sessions") {
        counts.probes++;
        if (script.delayCall === counts.probes) await new Promise((r) => schedule(r, 2000));
        if (script.probeFails > 0) { script.probeFails--; throw new Error("list_sessions transport hiccup"); }
        const st = statusNow();
        return st === "missing" ? { sessions: [] } : { sessions: [{ id: "default", status: st, pid: sess.pid, created_at: sess.createdAt }] };
      }
      if (name === "stop_session") { sess.stops++; sess.present = false; sess.status = "stopped"; return {}; }
      if (name === "create_session") { sess.created++; replace({ readyIn: 20_000 }); return {}; }
      return {};
    },
  };
  const ctx = { globalThis: g, Date: FakeDate, Number, String, Math, JSON, Error, Promise, Object, Array, Set, Map, RegExp, Boolean,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms), clearInterval: (id) => timers.delete(id),
    process: { env: {}, platform: "win32" }, console, zg, RI: () => {}, Gg: { appendStreamingLog: () => {} } };
  vm.createContext(ctx);
  vm.runInContext("var __codexBackendStart=null,__codexLastColdBackendStart=null;\n" + segment(source), ctx);
  async function drive(promise) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    for (let i = 0; i < 200000 && !done; i++) {
      for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r));
      if (done) break;
      let next = null;
      for (const [id, t] of timers) if (!next || t.at < next[1].at) next = [id, t];
      if (!next) break;
      now = Math.max(now, next[1].at); timers.delete(next[0]);
      try { next[1].fn(); } catch {}
    }
    return { done, value, error };
  }
  return { g, sess, counts, script, replace, t0: now, get now() { return now; },
    warm: (runId, src = "visible-bridge") => drive(g.__codexEnsureBackendWarm(runId, src)),
    soonStop: (ms) => schedule(() => { g.__codexResetGeneration++; }, ms),
    summary: () => g.__codexWarmWorkerSummary() };
}
const S = 1000;
const refusal = (r) => r.error?.__codexPreRunTimeout || {};
const CASES = {
  // M2: agent request while Stata starts waits for "running" (no refusal, no client retry needed).
  async agentColdWaits(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_020_000 });
    const r = await h.warm("agent_1");
    assert.equal(r.error, undefined, "not refused");
    assert.equal(r.value?.outcome, "READY");
    assert.ok(h.now - h.t0 >= 20 * S);
  },
  async agentTimeoutRetryable(src) {
    const h = harness(src, { status: "starting", readyAt: Infinity });
    const f = refusal(await h.warm("agent_1"));
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_TIMEOUT");
    assert.equal(f.status, 504);
    assert.equal(f.payloadDispatched, false);
    assert.equal(f.retryable, true);
    assert.equal(f.retryAfterMs, 5000);
  },
  async agentFailedRetryable(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 1 });
    const f = refusal(await h.warm("agent_1"));
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_FAILED");
    assert.equal(f.recovery, "STOPPED_FAILED_SESSION");
    assert.equal(f.retryable, true, "the dead worker was stopped; a retry starts a fresh one");
    assert.equal(h.sess.created, 0, "agent path is not restarted in place");
  },
  async agentStopNotRetryable(src) {
    const h = harness(src, { status: "starting", readyAt: Infinity });
    h.soonStop(3 * S);
    const f = refusal(await h.warm("agent_1"));
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(f.payloadDispatched, false);
    assert.equal(f.retryable, false, "a person pressed Stop");
    assert.equal(f.retryAfterMs, null);
  },
  // rc.7.81 for the agent path: a failed identity probe drops the cache and the run waits.
  async agentProbeFailureWaits(src) {
    const h = harness(src, { status: "running" });
    assert.equal((await h.warm("agent_1")).value?.outcome, "READY");
    h.replace({ readyIn: 30 * S });
    h.script.probeFails = 1;
    const t = h.now, r = await h.warm("agent_2");
    assert.equal(r.value?.outcome, "READY", "waited for the replacement worker");
    assert.ok(h.now - t >= 30 * S);
    assert.match(String(h.summary().lastDrop.reason), /^probe failed/);
  },
  async agentStopDuringProbe(src) {
    const h = harness(src, { status: "running" });
    await h.warm("agent_1");
    h.script.delayCall = h.counts.probes + 1;
    h.soonStop(1 * S);
    const f = refusal(await h.warm("agent_2"));
    assert.equal(f.reasonCode, "PRE_RUN_BACKEND_WARMUP_CANCELLED");
    assert.equal(f.retryable, false);
  },
  // Terminal keeps rc.7.81's single restart; the final refusal is labelled too.
  async terminalTwiceRetryable(src) {
    const h = harness(src, { status: "starting", readyAt: 1_800_000_010_000, failStarts: 2 });
    const f = refusal(await h.warm("debug_terminal_1", "terminal-input"));
    assert.equal(f.restartedOnce, true);
    assert.equal(f.retryable, true);
    assert.equal(h.sess.created, 1);
  },
};
const MUTANTS = [
  ["Stop retryable", 'const retryable = refusal.reasonCode !== "PRE_RUN_BACKEND_WARMUP_CANCELLED";', "const retryable = true;"],
  ["no retry delay", "retryAfterMs: retryable ? __codexWarmupRetryAfterMs : null", "retryAfterMs: null"],
  ["not installed", TAIL86, "globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmRestartOnce;\n"],
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
  for (const must of ["agentTimeoutRetryable", "agentFailedRetryable", "agentStopNotRetryable"]) {
    assert.ok(old.some((f) => f.startsWith(must + ":")), "the layer before rc.7.86 fails " + must);
  }
  const caught = [];
  for (const [name, from, to] of MUTANTS) {
    const seg = segment(bundle);
    assert.equal(seg.split(from).length, 2, "mutant anchor unique: " + name);
    const failed = await runAll(bundle.replace(seg, () => seg.replace(from, () => to)));
    assert.ok(failed.length > 0, "mutant survived: " + name);
    caught.push(name + " -> " + failed.map((f) => f.split(":")[0]).join(","));
  }
  console.log(JSON.stringify({ verdict: "AGENT_WARMUP_REFUSAL_PASS", cases: Object.keys(CASES).length,
    beforeFails: old.map((f) => f.split(":")[0]), mutants: `${caught.length}/${MUTANTS.length}`, caught }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
