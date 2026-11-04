#!/usr/bin/env node
"use strict";

// rc.7.87: the progress toast's Cancel goes through Terminal Stop only for the
// same visible run. Runs the real HELPER text in a VM with a fake bridge,
// TerminalPanel and token, then checks the bundle edits on the real dist.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_progress_cancel_stop_patch");
const fingerprint = require("./finalize_bundle_identity");

function harness(helper = patch.HELPER) {
  const ctx = { stops: 0, logs: [], Promise };
  ctx.globalThis = ctx;
  ctx.RI = (m) => ctx.logs.push(m);
  ctx.Gg = { _handleCancelRun: () => { ctx.stops += 1; return Promise.resolve(); } };
  vm.runInNewContext(helper, ctx);
  const token = () => { const t = { fire: null, onCancellationRequested(fn) { t.fire = fn; return { dispose() {} }; } }; return t; };
  return { ctx, token };
}
const flush = () => new Promise((r) => setImmediate(r));

async function behaviour(helper) {
  const out = {};
  // 1. same run still active -> Terminal Stop once, logged as acted
  let { ctx, token } = harness(helper);
  ctx.__codexBridgeState = { busy: true, source: "human-file", startedAt: 1000, runId: "r1" };
  let t = token();
  ctx.__codexProgressCancelStop(t, "human-file");
  t.fire(); await flush();
  out.sameRun = { stops: ctx.stops, acted: ctx.__codexLastProgressCancel && ctx.__codexLastProgressCancel.acted };
  // 2. the run ended and another run of the same source started -> ignored
  ({ ctx, token } = harness(helper));
  ctx.__codexBridgeState = { busy: true, source: "human-file", startedAt: 1000 };
  t = token(); ctx.__codexProgressCancelStop(t, "human-file");
  ctx.__codexBridgeState = { busy: true, source: "human-file", startedAt: 2000 };
  t.fire(); await flush();
  out.newerRun = { stops: ctx.stops, acted: ctx.__codexLastProgressCancel.acted };
  // 3. an agent run took over -> ignored
  ({ ctx, token } = harness(helper));
  ctx.__codexBridgeState = { busy: true, source: "human-selection", startedAt: 1000 };
  t = token(); ctx.__codexProgressCancelStop(t, "human-selection");
  ctx.__codexBridgeState = { busy: true, source: "agent", startedAt: 1000 };
  t.fire(); await flush();
  out.agentRun = ctx.stops;
  // 4. bridge idle -> ignored
  ({ ctx, token } = harness(helper));
  ctx.__codexBridgeState = { busy: true, source: "human-file", startedAt: 1000 };
  t = token(); ctx.__codexProgressCancelStop(t, "human-file");
  ctx.__codexBridgeState = { busy: false, source: "human-file", startedAt: 1000 };
  t.fire(); await flush();
  out.idle = ctx.stops;
  // 5. not registered when the bridge does not hold this source; bad token is harmless
  ({ ctx, token } = harness(helper));
  ctx.__codexBridgeState = { busy: true, source: "agent", startedAt: 1000 };
  t = token(); out.wrongSourceReturn = ctx.__codexProgressCancelStop(t, "human-file"); out.wrongSourceFire = t.fire;
  out.badToken = ctx.__codexProgressCancelStop({}, "human-file");
  return out;
}

function expectGood(out) {
  assert.deepEqual(out.sameRun, { stops: 1, acted: true }, "same run: toast Cancel -> one Terminal Stop");
  assert.deepEqual(out.newerRun, { stops: 0, acted: false }, "a newer run of the same source is not stopped");
  assert.equal(out.agentRun, 0, "an agent run that took over is not stopped");
  assert.equal(out.idle, 0, "idle bridge: nothing to stop");
  assert.equal(out.wrongSourceReturn, null, "not registered when the bridge does not hold this source");
  assert.equal(out.wrongSourceFire, null, "no listener registered");
  assert.equal(out.badToken, null, "a token without onCancellationRequested is ignored");
}

(async () => {
  expectGood(await behaviour());
  console.log("PROGRESS_CANCEL_BEHAVIOUR_PASS");

  // Mutants: each must break at least one assertion.
  const mutants = {
    noStartedAtCheck: ["&&__n.startedAt===__at", ""],
    noSourceCheck: ["&&__n.source===__src&&__n.startedAt", "&&__n.startedAt"],
    noBusyCheck: ["let __n=globalThis.__codexBridgeState||{},__same=__n.busy===true&&", "let __n=globalThis.__codexBridgeState||{},__same="],
    alwaysAct: ["if(__same)Promise", "if(true)Promise"],
    registerAnySource: ["||__b.source!==__src)return null", ")return null"],
  };
  for (const [name, [from, to]] of Object.entries(mutants)) {
    assert.equal(patch.HELPER.split(from).length - 1, 1, `mutant anchor ${name}`);
    let killed = false;
    try { expectGood(await behaviour(patch.HELPER.replace(from, to))); } catch (e) { killed = e instanceof assert.AssertionError; }
    assert.ok(killed, `mutant survived: ${name}`);
  }
  console.log("PROGRESS_CANCEL_MUTANTS_KILLED " + Object.keys(mutants).length);

  // Bundle edits on the real dist (patched by the replay chain).
  const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
  assert.ok(dist.includes(patch.MARKER), "dist carries rc.7.87");
  for (const [name, , after] of patch.EDITS) assert.equal(dist.split(after).length - 1, 1, `dist edit ${name}`);
  const base = patch.revertBundle(dist);
  assert.ok(!base.includes("__codexProgressCancelStop"), "revert removes every trace");
  for (const [name, before] of patch.EDITS) assert.equal(base.split(before).length - 1, 1, `base anchor ${name}`);
  assert.equal(patch.patchBundle(base), fingerprint.finalize(dist).text, "patch(revert(dist)) == dist");
  assert.equal(patch.patchBundle(dist), fingerprint.finalize(dist).text, "idempotent on dist");
  assert.throws(() => patch.patchBundle(base.replace(patch.EDITS[2][1], "")), /anchor: run file toast/);
  assert.throws(() => patch.patchBundle(base + "__codexProgressCancelStop"), /partial/);
  assert.throws(() => patch.revertBundle(base), /anchor/);
  // The connection test's IP() stays unhooked.
  assert.ok(/await IP\("Testing MCP server",async g=>\{let A=await __codexGuardWrap/.test(dist), "connection test IP unchanged");
  new vm.Script(dist.replace(/^#!.*\n/, ""), { filename: "extension.js" });
  console.log("PROGRESS_CANCEL_BUNDLE_PASS");
})().catch((e) => { console.error(e); process.exit(1); });
