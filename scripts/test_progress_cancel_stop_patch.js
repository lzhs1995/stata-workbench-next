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

// A fake bridge shaped like rc.7 acquire: busy/source/startedAt plus the
// execution lifecycle object that beginRun creates for every acquire.
const life = (requestId, extra = {}) => ({ requestId, runId: requestId, phase: "acquired", releasedAt: null, ...extra });
const bridge = (source, lifecycle, extra = {}) => ({ busy: true, source, startedAt: 1000, runId: lifecycle ? lifecycle.runId : null, lifecycle, ...extra });

async function behaviour(helper) {
  const out = {};
  let ctx, token, t;
  const arm = (b, src) => { ({ ctx, token } = harness(helper)); ctx.__codexBridgeState = b; t = token(); return ctx.__codexProgressCancelStop(t, src); };
  const fire = async () => { if (t.fire) t.fire(); await flush(); return { stops: ctx.stops, acted: ctx.__codexLastProgressCancel ? ctx.__codexLastProgressCancel.acted : null }; };
  // 1. same run still active -> Terminal Stop once, logged as acted
  arm(bridge("human-file", life("r1")), "human-file");
  out.sameRun = await fire();
  // 2. same run after runId adoption (panel runId replaces the request id on the same lifecycle object) -> still stops
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.lifecycle.runId = "panel-run"; ctx.__codexBridgeState.runId = "panel-run";
  out.adopted = await fire();
  // 3. next acquire of the same source with the SAME startedAt and the same requestId text -> new lifecycle object, ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState = bridge("human-file", life("r1"));
  out.nextSameStamp = await fire();
  // 4. next acquire reuses the bridge object (Object.assign + beginRun): new lifecycle, other requestId, same startedAt -> ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.lifecycle = life("r2");
  out.nextOnSameBridge = await fire();
  // 5. same lifecycle object but its requestId was changed -> ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.lifecycle.requestId = "r9";
  out.requestChanged = await fire();
  // 6. the run was released (finished) but the bridge still looks busy -> ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.lifecycle.releasedAt = "t-end";
  out.released = await fire();
  // 7. an agent run took over (new lifecycle, source agent, same startedAt) -> ignored
  arm(bridge("human-selection", life("r1")), "human-selection");
  ctx.__codexBridgeState = bridge("agent", life("a1"));
  out.agentRun = await fire();
  // 7b. defence in depth: same lifecycle object but the bridge now reports another source -> ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.source = "agent";
  out.sourceChanged = await fire();
  // 8. bridge idle -> ignored
  arm(bridge("human-file", life("r1")), "human-file");
  ctx.__codexBridgeState.busy = false;
  out.idle = await fire();
  // 9. not registered: wrong source, no lifecycle, empty requestId, already released, bad token
  out.wrongSourceReturn = arm(bridge("agent", life("a1")), "human-file"); out.wrongSourceFire = t.fire;
  out.noLifecycle = arm(bridge("human-file", null), "human-file");
  out.emptyRequest = arm(bridge("human-file", life("")), "human-file");
  out.releasedAtArm = arm(bridge("human-file", life("r1", { releasedAt: "t0" })), "human-file");
  out.badToken = (arm(bridge("human-file", life("r1")), "human-file"), ctx.__codexProgressCancelStop({}, "human-file"));
  return out;
}

function expectGood(out) {
  assert.deepEqual(out.sameRun, { stops: 1, acted: true }, "same run: toast Cancel -> one Terminal Stop");
  assert.deepEqual(out.adopted, { stops: 1, acted: true }, "runId adoption keeps the same run cancellable");
  assert.deepEqual(out.nextSameStamp, { stops: 0, acted: false }, "next acquire with the same startedAt and request text is not stopped");
  assert.deepEqual(out.nextOnSameBridge, { stops: 0, acted: false }, "next acquire on the reused bridge object is not stopped");
  assert.deepEqual(out.requestChanged, { stops: 0, acted: false }, "a changed requestId is not this run");
  assert.deepEqual(out.released, { stops: 0, acted: false }, "a released run is not stopped");
  assert.deepEqual(out.agentRun, { stops: 0, acted: false }, "an agent run that took over is not stopped");
  assert.deepEqual(out.idle, { stops: 0, acted: false }, "idle bridge: nothing to stop");
  assert.deepEqual(out.sourceChanged, { stops: 0, acted: false }, "bridge source changed: not this run");
  assert.equal(out.wrongSourceReturn, null, "not registered when the bridge does not hold this source");
  assert.equal(out.wrongSourceFire, null, "no listener registered");
  assert.equal(out.noLifecycle, null, "not registered without a lifecycle identity");
  assert.equal(out.emptyRequest, null, "not registered with an empty requestId");
  assert.equal(out.releasedAtArm, null, "not registered for a released lifecycle");
  assert.equal(out.badToken, null, "a token without onCancellationRequested is ignored");
}

(async () => {
  expectGood(await behaviour());
  console.log("PROGRESS_CANCEL_BEHAVIOUR_PASS");

  // Mutants: each must break at least one assertion.
  const mutants = {
    noLifecycleIdentity: ["&&__l===__life&&", "&&"],
    noRequestIdCheck: ["&&__l.requestId===__req&&", "&&"],
    noReleasedCheckAtCancel: ["&&!__l.releasedAt;", ";"],
    noReleasedCheckAtArm: ["||!__req||__life.releasedAt)return null", "||!__req)return null"],
    noRequiredRequestId: ["||!__req||", "||"],
    noSourceCheck: ["__same=__n.busy===true&&__n.source===__src&&", "__same=__n.busy===true&&"],
    noBusyCheck: ["__same=__n.busy===true&&", "__same="],
    alwaysAct: ["if(__same)Promise", "if(true)Promise"],
    registerAnySource: ["||__b.source!==__src||", "||"],
    startedAtAsIdentity: ["&&__l===__life&&__l.requestId===__req&&", "&&__n.startedAt===__b.startedAt&&"],
  };
  for (const [name, [from, to]] of Object.entries(mutants)) {
    assert.equal(patch.HELPER.split(from).length - 1, 1, `mutant anchor ${name}`);
    let killed = false;
    try { expectGood(await behaviour(patch.HELPER.replace(from, to))); } catch (e) { killed = e instanceof assert.AssertionError || e instanceof TypeError; }
    assert.ok(killed, `mutant survived: ${name}`);
  }
  console.log("PROGRESS_CANCEL_MUTANTS_KILLED " + Object.keys(mutants).length);

  // D2: __codexStoppedBy reads only this run's own soft-stop record.
  const stoppedBy = (helper, history, rid) => {
    const ctx = { __codexSupersedeHistory: history };
    ctx.globalThis = ctx;
    vm.runInNewContext(helper, ctx);
    return ctx.__codexStoppedBy(rid);
  };
  const rec = (runId, reason, toGeneration, kind = "soft-stop") => ({ kind, runId, reason, toGeneration, at: "t" + toGeneration });
  const stoppedCases = (helper) => ({
    person: stoppedBy(helper, [rec("r1", "terminal Stop button", 1)], "r1"),
    api: stoppedBy(helper, [rec("r1", "http /soft-stop", 1)], "r1")?.by,
    watchdog: stoppedBy(helper, [rec("r1", "guard cancel: IDLE", 1)], "r1")?.by,
    other: stoppedBy(helper, [rec("r1", "something else", 1)], "r1")?.by,
    otherRun: stoppedBy(helper, [rec("r2", "terminal Stop button", 1)], "r1"),
    notSoftStop: stoppedBy(helper, [rec("r1", "terminal Stop button", 1, "force-reset")], "r1"),
    latestWins: stoppedBy(helper, [rec("r1", "http /soft-stop", 1), rec("r1", "terminal Stop button", 2)], "r1")?.generation,
    noRun: stoppedBy(helper, [rec("r1", "terminal Stop button", 1)], null),
  });
  const expectStopped = (c) => {
    assert.deepEqual(c.person && JSON.parse(JSON.stringify(c.person)), { by: "person", reason: "terminal Stop button", runId: "r1", generation: 1, at: "t1" });
    assert.equal(c.api, "api"); assert.equal(c.watchdog, "watchdog"); assert.equal(c.other, "other");
    assert.equal(c.otherRun, null, "another run's Stop is not reported");
    assert.equal(c.notSoftStop, null, "only soft-stop records count");
    assert.equal(c.latestWins, 2, "the newest record for this run wins");
    assert.equal(c.noRun, null);
  };
  expectStopped(stoppedCases(patch.STOPPED_HELPER));
  const stopMutants = {
    anyRun: ["&&String(__r.runId)===String(__rid)", ""],
    anyKind: ["__r.kind===\"soft-stop\"&&", ""],
    oldestFirst: ["for(let __i=__h.length-1;__i>=0;__i--)", "for(let __i=0;__i<__h.length;__i++)"],
    personForAll: ["by:/^terminal Stop button/.test(__why)?\"person\":", "by:true?\"person\":"],
  };
  for (const [name, [from, to]] of Object.entries(stopMutants)) {
    assert.equal(patch.STOPPED_HELPER.split(from).length - 1, 1, `stoppedBy mutant anchor ${name}`);
    let killed = false;
    try { expectStopped(stoppedCases(patch.STOPPED_HELPER.replace(from, to))); } catch (e) { killed = e instanceof assert.AssertionError; }
    assert.ok(killed, `stoppedBy mutant survived: ${name}`);
  }
  console.log("STOPPED_BY_PASS mutants=" + Object.keys(stopMutants).length);

  // Bundle edits on the real dist (patched by the replay chain).
  const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
  assert.ok(dist.includes(patch.MARKER), "dist carries rc.7.87");
  for (const [name, , after] of patch.EDITS) assert.equal(dist.split(after).length - 1, 1, `dist edit ${name}`);
  assert.equal(patch.EDITS.length, 5, "helper, agent failure stoppedBy, selection toast, run file toast, failed card title");
  assert.ok(dist.includes("run.statusTitle.textContent = success ? 'Stata Output' : 'Stata Output (failed)';"), "D7 failed card title");
  assert.equal(dist.split("run.statusTitle.textContent = 'Stata Output (failed)'").length - 1, 1, "runFailed title unchanged");
  const base = patch.revertBundle(dist);
  assert.ok(!base.includes("__codexProgressCancelStop"), "revert removes every trace");
  for (const [name, before] of patch.EDITS) assert.equal(base.split(before).length - 1, 1, `base anchor ${name}`);
  assert.equal(patch.patchBundle(base), fingerprint.finalize(dist).text, "patch(revert(dist)) == dist");
  assert.equal(patch.patchBundle(dist), fingerprint.finalize(dist).text, "idempotent on dist");
  assert.throws(() => patch.patchBundle(base.replace(patch.EDITS.find(([n]) => n === "run file toast")[1], "")), /anchor: run file toast/);
  assert.throws(() => patch.patchBundle(base + "__codexProgressCancelStop"), /partial/);
  assert.throws(() => patch.revertBundle(base), /anchor/);
  // The connection test's IP() stays unhooked.
  assert.ok(/await IP\("Testing MCP server",async g=>\{let A=await __codexGuardWrap/.test(dist), "connection test IP unchanged");
  new vm.Script(dist.replace(/^#!.*\n/, ""), { filename: "extension.js" });
  console.log("PROGRESS_CANCEL_BUNDLE_PASS");
})().catch((e) => { console.error(e); process.exit(1); });
