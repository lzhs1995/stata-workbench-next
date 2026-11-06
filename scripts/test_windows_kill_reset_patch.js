#!/usr/bin/env node
"use strict";
// rc.7.90 (V3-KW): a successful Windows Stata: KILL resets the backend (dispose +
// reconnect) before its recovery smoke. Offline: checks the sealed dist, exact
// revert/replay, idempotence and anchor failures, then runs the bundled panicKill
// command in a vm with a fake transport: the smoke only passes on a client that
// was reset after the kill. The pre-fix bundle reproduces the Windows live
// failure (smoke on the old transport, transport-failed). Mutants of the patch
// must be caught.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_windows_kill_reset_patch");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
ok(dist.includes(patch.MARKER), "dist carries the rc.7.90 marker");
for (const [, after] of patch.EDITS) ok(dist.split(after).length === 2, "edit present exactly once");
const reverted = patch.revertBundle(dist);
ok(!reverted.includes(patch.MARKER) && patch.patchBundle(reverted) === dist, "revert/replay byte-exact");
ok(patch.patchBundle(dist) === dist, "patch is idempotent");
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[0][0], "X")), /anchor/); checks++;
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[0][0], patch.EDITS[0][0] + "\"panic-kill-command windows scoped tree ended\"")), /partial/); checks++;

const START = "registerCommand(\"stata-workbench.panicKill\",";
const END = "}catch(e){iA.window.showErrorMessage(\"Stata panic kill failed: \"+(e?.message||String(e)))}}";
function command(source) {
  const at = source.indexOf(START);
  const end = source.indexOf(END, at);
  assert.ok(at > 0 && end > at && source.split(START).length === 2, "panicKill command located once");
  return source.slice(at + START.length, end + END.length);
}

// Fake world: the transport generation advances only on __codexForceReset; KILL
// ends the backend's server, so a smoke on the client that was live at KILL time fails.
async function runKill(source, { platform = "win32", scope, choice = "Kill this window's Stata" }) {
  const events = [];
  const world = { clientGen: 0, serverAliveFor: 0 };
  const g = {
    console, Promise, Date, JSON, Math, Array, Map, Set, Number, String, Boolean, Object, Error, RegExp,
    process: { platform },
    RI: (line) => events.push(["log", String(line).slice(0, 60)]),
    iA: { window: {
      showWarningMessage: async (msg, opts, ...items) => (opts && opts.modal ? choice : (events.push(["warn"]), undefined)),
      showInformationMessage: (msg) => { events.push(["info", msg]); },
      showErrorMessage: (msg) => { events.push(["error", msg]); },
    } },
  };
  g.globalThis = g;
  g.__codexBridgeState = { busy: true, postRunBusy: false, current: { runId: "r1" } };
  g.__codexRecoveryState = { required: false };
  g.__codexControlPlane = { requestRecovery: (st, why) => { events.push(["requestRecovery", why]); return { required: true, reason: why }; } };
  g.__codexGraphMark = () => {};
  g.__codexWindowsKillScopeRef = { failClosedMessage: () => "fail closed" };
  g.__codexWindowsKillScopeRun = (dry, src) => {
    events.push(["scope", src]);
    if (scope.ok === true || scope.ended) world.serverAliveFor = -1; // the tree of the live client is gone
    return scope;
  };
  g.__codexForceReset = async (why) => {
    events.push(["forceReset", why]);
    await new Promise((r) => setTimeout(r, 5)); // dispose + reconnect take time; a smoke that does not wait sees the old client
    world.clientGen += 1; // dispose + reconnect: a new server for the new client
    world.serverAliveFor = world.clientGen;
    return { dispose: { attempted: true, ok: true } };
  };
  g.__codexRunRecoverySmoke = async (why) => {
    const live = world.serverAliveFor === world.clientGen;
    events.push(["smoke", why, live ? "ok" : "transport-failed"]);
    return live ? { ok: true } : { ok: false, error: "transport-failed" };
  };
  vm.createContext(g);
  const fn = vm.runInContext("(" + command(source) + ")", g);
  await fn();
  return events;
}
const kinds = (ev) => ev.map((e) => e[0]).filter((k) => k !== "log");
const smoke = (ev) => ev.find((e) => e[0] === "smoke");
const resets = (ev) => ev.filter((e) => e[0] === "forceReset");

const SCOPE_OK = { ok: true, failClosed: false, scope: "this-session", targets: [{ pid: 20300 }, { pid: 5348 }, { pid: 12068 }, { pid: 7592 }],
  ended: [{ pid: 20300 }, { pid: 5348 }] };
const SCOPE_FAIL_CLOSED = { ok: false, failClosed: true, scope: "this-session", reasons: ["could not list"], targets: [], census: [] };
const SCOPE_PARTIAL = { ok: false, failClosed: false, scope: "this-session", targets: [{ pid: 1 }, { pid: 2 }], ended: [{ pid: 1 }], pending: [{ pid: 2 }] };

async function cases(source, label) {
  const out = [];
  const t = async (name, fn) => { try { await fn(); out.push([name, true]); } catch (e) { out.push([name, false, e && e.message]); } };
  await t("win32 success: reset before the smoke, smoke passes", async () => {
    const ev = await runKill(source, { scope: SCOPE_OK });
    assert.deepEqual(kinds(ev), ["scope", "forceReset", "requestRecovery", "smoke", "info"]);
    assert.match(resets(ev)[0][1], /panic-kill/i, "reset reason keeps 'panic-kill' so the scoped result is reused");
    assert.equal(smoke(ev)[2], "ok");
    assert.match(ev.find((e) => e[0] === "info")[1], /recovery smoke passed; the session is READY/);
  });
  await t("win32 fail-closed: one reset (unchanged), warning, smoke", async () => {
    const ev = await runKill(source, { scope: SCOPE_FAIL_CLOSED });
    assert.equal(resets(ev).length, 1);
    assert.equal(resets(ev)[0][1], "panic-kill-command scope unverified");
    assert.ok(kinds(ev).includes("warn"), "fail-closed warning shown");
  });
  await t("win32 ok but flagged fail-closed: only the fail-closed reset runs", async () => {
    const ev = await runKill(source, { scope: Object.assign({}, SCOPE_OK, { failClosed: true }) });
    assert.deepEqual(resets(ev).map((e) => e[1]), ["panic-kill-command scope unverified"]);
  });
  await t("win32 incomplete kill (not ok, not fail-closed): no reset, warning, runs stay refused", async () => {
    const ev = await runKill(source, { scope: SCOPE_PARTIAL });
    assert.equal(resets(ev).length, 0);
    assert.ok(kinds(ev).includes("warn"));
    assert.ok(ev.some((e) => e[0] === "requestRecovery" && e[1] === "panic-kill-command-needs-smoke"));
  });
  await t("posix: unchanged, one platform-adapter reset then the smoke", async () => {
    const ev = await runKill(source, { platform: "darwin", scope: SCOPE_OK });
    assert.deepEqual(resets(ev).map((e) => e[1]), ["panic-kill-command platform adapter"]);
    assert.equal(smoke(ev)[2], "ok");
    assert.ok(!ev.some((e) => e[0] === "scope"), "the Windows scope is not run on posix");
  });
  await t("cancel at the confirm dialog: nothing runs", async () => {
    const ev = await runKill(source, { scope: SCOPE_OK, choice: "Cancel" });
    assert.deepEqual(kinds(ev), []);
  });
  return out;
}

(async () => {
  const fixed = await cases(dist, "fixed");
  for (const [name, pass, why] of fixed) { ok(pass, "fixed bundle: " + name + (why ? " — " + why : "")); }

  // Negative check: the pre-fix bundle reproduces the Windows live failure.
  const pre = await runKill(reverted, { scope: SCOPE_OK });
  ok(resets(pre).length === 0 && smoke(pre)[2] === "transport-failed", "pre-fix bundle: no reset, smoke on the old transport fails (live 06:41 repro)");
  ok(/did not pass/.test(pre.find((e) => e[0] === "info")[1]), "pre-fix bundle: the toast says the smoke did not pass");

  // Mutants of the inserted statement; each must make at least one fixed-bundle case fail.
  const after = patch.EDITS[0][1];
  const INSERTED = after.slice(after.indexOf("/* " + patch.MARKER + " */"), after.indexOf("try{let s=globalThis.__codexBridgeState"));
  assert.ok(INSERTED.length > 40 && after.split(INSERTED).length === 2, "inserted statement located");
  const mutate = (from, to) => after.replace(from, () => to);
  const MUTANTS = [
    ["reset removed", mutate(INSERTED, "")],
    ["reset on any scope", mutate("__codexKillScope&&__codexKillScope.ok===true&&!__codexKillScope.failClosed", "true")],
    ["reset also when fail-closed", mutate("&&!__codexKillScope.failClosed)", ")")],
    ["reason loses panic-kill", mutate("\"panic-kill-command windows scoped tree ended\"", "\"windows scoped tree ended\"")],
    ["reset not awaited", mutate("await globalThis.__codexForceReset(\"panic-kill-command windows", "globalThis.__codexForceReset(\"panic-kill-command windows")],
  ];
  let caught = 0;
  for (const [name, mutated] of MUTANTS) {
    assert.notEqual(mutated, after, "mutant " + name + " changes the edit");
    assert.equal(dist.split(after).length, 2);
    const src = dist.replace(after, () => mutated);
    let res;
    try { res = await cases(src, name); } catch (e) { res = [["threw", false, e.message]]; }
    const failed = res.filter((r) => !r[1]).map((r) => r[0]);
    if (failed.length) caught++;
    else console.log("  MUTANT SURVIVED: " + name);
  }
  ok(caught === MUTANTS.length, `mutants caught ${caught}/${MUTANTS.length}`);
  console.log(`WINDOWS_KILL_RESET_PATCH_OK checks=${checks} mutants=${caught}/${MUTANTS.length}`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
