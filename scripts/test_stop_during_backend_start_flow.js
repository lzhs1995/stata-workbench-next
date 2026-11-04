#!/usr/bin/env node
"use strict";
// rc.7.83 flow (test only): the real rc.7.67 cold-start helper, rc.7.72 warm-up rule and rc.7.83 rule from
// dist run together in a vm with a fake transport. The soft Stop decision is driven the way the bundle's
// snapshotless branch drives it (generation+1, predicate, skip literal or probe), and the outcome goes
// through the real guard_cancel_restore_core.classifySoftStopRestore fence. No Stata, no network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const cold = require("./apply_backend_cold_start_patch");
const warm = require("./apply_backend_warmup_patch");
const patch = require("./apply_stop_during_backend_start_patch");
const core = require("./guard_cancel_restore_core");

const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
assert.equal(dist.split(cold.HELPER).length - 1, 1, "rc.7.67 helper bytes in dist");
assert.equal(dist.split(patch.HELPER).length - 1, 1, "rc.7.83 helper bytes in dist");
const warmFrom = dist.indexOf(warm.HELPER.trim().split("\n")[0]);
const warmEnd = "globalThis.__codexWarmupSkipsQuiescence = __codexWarmupSkipsQuiescence;\n";
const warmSlice = dist.slice(warmFrom, dist.indexOf(warmEnd, warmFrom) + warmEnd.length);
// The skip literal the bundle's soft Stop uses when the predicate says so.
const SKIP = { ok: true, skipped: "no pre-run dataset snapshot", quiescenceProbe: { skipped: "Stata was still starting; no payload dispatched" } };
assert.ok(warm.STOP_AFTER.includes(JSON.stringify(SKIP.quiescenceProbe.skipped)), "skip literal matches the bundle");

function world(with83 = true) {
  const waiters = []; let up = false;
  const zg = { _transport: null, dispatches: 0, forceResets: 0,
    _ensureClient() {
      if (up) { this._transport = this._transport || { pid: 7 }; return Promise.resolve(this); }
      return new Promise((ok) => waiters.push(() => { this._transport = { pid: 7 }; ok(this); }));
    },
    runSelection() { this.dispatches++; return Promise.resolve({ success: true, rc: 0 }); } };
  const ctx = { zg, process: { env: {} }, setTimeout, clearTimeout, Promise, __codexResetGeneration: 0, __codexBackendWarmup: null, __codexWarmTransport: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(cold.HELPER + warmSlice + (with83 ? patch.HELPER : ""), ctx);
  // Same order as __codexBeginGraphRun: start, warm-up (state only here), then dispatch.
  async function run(runId, warmState) {
    await ctx.__codexEnsureBackendStarted(runId, "terminal-input");
    if (warmState) ctx.__codexBackendWarmup = { runId: String(runId), ...warmState };
    return zg.runSelection();
  }
  // Snapshotless soft Stop: bump generation first (as __codexSoftStop does), then skip or probe.
  async function softStop(runId, { dispatched }) {
    ctx.__codexResetGeneration++;
    let restore, forceReset = null;
    if (ctx.__codexWarmupSkipsQuiescence(runId)) restore = SKIP;
    else {
      // The probe is a Stata command: it waits for the client like any run, and times out (5 s in the bundle).
      const probe = await Promise.race([zg._ensureClient().then(() => ({ ok: true, rc: 0 })), new Promise((ok) => setTimeout(() => ok({ ok: false, error: "timeout" }), 30))]);
      restore = { ok: probe.ok, quiescenceProbe: probe, escalated: !probe.ok };
      if (!probe.ok) { zg.forceResets++; forceReset = { reason: "soft-stop escalation: snapshotless backend not quiescent" }; }
    }
    const record = { restore, forceReset, reason: "terminal Stop button", recoveryClass: restore.ok ? null : "RECOVERY_FAILED" };
    return core.classifySoftStopRestore(record, null, { snapshotExpected: false, payloadDispatched: dispatched });
  }
  return { ctx, zg, run, softStop, connect: () => { up = true; waiters.splice(0).forEach((f) => f()); } };
}

(async () => {
  // 1. Stop while the backend start is WAITING: skip, no force reset, not fenced; the run never dispatches.
  {
    const w = world();
    const pending = w.run("debug_terminal_A").then(() => assert.fail("must not dispatch"), (e) => e);
    await new Promise((r) => setImmediate(r));
    assert.equal(w.ctx.__codexBackendStartSummary().current.outcome, "WAITING");
    const verdict = await w.softStop("debug_terminal_A", { dispatched: false });
    assert.equal(verdict.fenced, false, "start-up Stop is not fenced");
    assert.equal(verdict.warmupNoPayload, true);
    assert.equal(w.zg.forceResets, 0, "no force reset");
    w.connect();
    const err = await pending;
    assert.equal(err.code, "PRE_RUN_BACKEND_START_CANCELLED");
    assert.equal(err.__codexPreRunTimeout.payloadDispatched, false);
    assert.equal(w.zg.dispatches, 0, "no dispatch for the stopped run");
    // 2. Next run on the same backend: CONNECTED, dispatches once, rc 0; the rule no longer skips it.
    const next = await w.run("debug_terminal_B", { outcome: "READY", lastStatus: "running" });
    assert.equal(next.rc, 0);
    assert.equal(w.zg.dispatches, 1);
    assert.equal(w.ctx.__codexWarmupSkipsQuiescence("debug_terminal_B"), false, "after connect + READY the probe runs");
    assert.equal(w.ctx.__codexWarmupSkipsQuiescence("debug_terminal_A"), false, "old run id is not exempt once a newer start exists");
  }
  // 3. Stop after dispatch (backend up, warm-up READY, payload sent): probe path still runs.
  {
    const w = world();
    w.connect();
    assert.equal((await w.run("debug_terminal_C")).rc, 0);
    w.ctx.__codexBackendWarmup = { runId: "debug_terminal_C", outcome: "READY", lastStatus: "running" };
    assert.equal(w.ctx.__codexWarmupSkipsQuiescence("debug_terminal_C"), false, "dispatched run is probed");
    const verdict = await w.softStop("debug_terminal_C", { dispatched: true });
    assert.equal(verdict.quiescenceProved, true, "probe ran and proved quiescence");
    assert.equal(verdict.fenced, false);
    assert.equal(w.zg.forceResets, 0);
  }
  // 4. Stop after dispatch while the probe cannot prove quiescence: escalates and is fenced (unchanged behaviour).
  {
    const w = world();
    w.ctx.__codexBackendStartSummary = () => ({ current: { runId: "debug_terminal_D", outcome: "CONNECTED" } });
    w.ctx.__codexBackendWarmup = { runId: "debug_terminal_D", outcome: "READY", lastStatus: "running" };
    const verdict = await w.softStop("debug_terminal_D", { dispatched: true });
    assert.equal(w.zg.forceResets, 1, "probe timed out and escalated");
    assert.equal(verdict.fenced, true, "still fenced");
  }
  // 5. Negative control: without rc.7.83 the same start-up Stop probes, escalates and is fenced (V3-M M3).
  {
    const w = world(false);
    const pending = w.run("debug_terminal_E").catch((e) => e);
    await new Promise((r) => setImmediate(r));
    const verdict = await w.softStop("debug_terminal_E", { dispatched: false });
    assert.equal(w.zg.forceResets, 1, "negative control escalates");
    assert.equal(verdict.fenced, true, "negative control is fenced (the bug)");
    w.connect();
    await pending;
  }
  console.log("STOP_DURING_BACKEND_START_FLOW_OK cases=5");
})().catch((e) => { console.error(e); process.exit(1); });
