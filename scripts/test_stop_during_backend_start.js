#!/usr/bin/env node
"use strict";
// rc.7.83: a soft Stop during backend start-up (rc.7.67 WAITING/CANCELLED, warm-up not started)
// skips the snapshotless quiescence probe; after connect + READY warm-up the probe still runs.
// Runs the real helper bytes from dist/extension.js in a vm (no Stata, no network).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_stop_during_backend_start_patch");
const warm = require("./apply_backend_warmup_patch");

const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
assert.equal(dist.split(patch.MARKER).length - 1, 1, "marker once in dist");
assert.equal(patch.patchBundle(dist, { finalize: false }), dist, "idempotent on sealed dist");
const reverted = patch.revertBundle(dist);
assert.ok(!reverted.includes(patch.MARKER) && !reverted.includes("__codexStopDuringStartSkipsQuiescence"), "revert removes the layer");
assert.equal(patch.patchBundle(reverted), dist, "revert then patch is byte-exact");
// The soft Stop branch still asks the global predicate (rc.7.72 call site unchanged).
assert.equal(dist.split(warm.STOP_AFTER).length - 1, 1, "soft Stop call site intact");

function predicate(source) {
  const from = source.indexOf(warm.HELPER.trim().split("\n")[0]);
  const end = source.includes(patch.MARKER) ? source.indexOf(patch.HELPER) + patch.HELPER.length
    : source.indexOf(patch.HELPER_ANCHOR) + patch.HELPER_ANCHOR.length;
  assert.ok(from >= 0 && end > from, "helper slice found");
  const ctx = { __codexBackendWarmup: null, __codexWarmTransport: null, zg: {}, process, setTimeout, clearTimeout, Promise };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source.slice(from, end), ctx);
  return (state) => {
    ctx.__codexBackendWarmup = state.warm || null;
    ctx.__codexBackendStartSummary = () => ({ connected: null, current: state.start || null, lastCold: null });
    return ctx.globalThis.__codexWarmupSkipsQuiescence(state.runId);
  };
}
const after = predicate(dist);
const before = predicate(reverted);
const R = "debug_terminal_1";
const cases = [
  ["before connect: start WAITING, no warm-up", { runId: R, start: { runId: R, outcome: "WAITING" } }, true],
  ["before connect: start CANCELLED by Stop", { runId: R, start: { runId: R, outcome: "CANCELLED" } }, true],
  ["after connect, warm-up waiting (rc.7.72 case)", { runId: R, start: { runId: R, outcome: "CONNECTED" }, warm: { runId: R, outcome: "WAITING", lastStatus: "starting" } }, true],
  ["after connect, warm-up READY: probe runs", { runId: R, start: { runId: R, outcome: "CONNECTED" }, warm: { runId: R, outcome: "READY", lastStatus: "running" } }, false],
  ["start WAITING for another run: probe runs", { runId: R, start: { runId: "other", outcome: "WAITING" } }, false],
  ["start FAILED/TIMED_OUT: probe runs", { runId: R, start: { runId: R, outcome: "TIMED_OUT" } }, false],
  ["no state at all: probe runs", { runId: R }, false],
  ["null runId: probe runs", { runId: null, start: { runId: "null", outcome: "WAITING" } }, false],
];
for (const [name, state, want] of cases) assert.equal(after(state), want, name);
// Negative control: without rc.7.83 the M3 case still probed (the bug).
assert.equal(before(cases[0][1]), false, "negative control: rc.7.72 alone probes during backend start");
assert.equal(before(cases[2][1]), true, "negative control keeps rc.7.72 behaviour");
console.log(`STOP_DURING_BACKEND_START_OK checks=${cases.length + 7}`);
