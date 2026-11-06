#!/usr/bin/env node
"use strict";

// rc.7.82 review R1: runs the bundled __codexForceReset (and the installed kill
// scope helper) in a vm with a mocked child_process on win32, and checks that
// no Windows path reaches the bare-pid cleanup_mcp_stata_processes.ps1 or a
// name-based panic kill: idle and busy resets with a registered pid that is not
// this host's child, a reused pid, the panic-kill reset, a helper that failed
// to load and a failed process listing. The verified case ends exactly the tree.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_windows_kill_scope_patch");

const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const START = "globalThis.__codexForceReset=async o=>";
const END = "__state.unresolvedCleanup=globalThis.__codexUnresolvedCleanup||null;return __state};";
const at = dist.indexOf(START);
const end = dist.indexOf(END, at);
assert.ok(at > 0 && end > at && dist.split(END).length === 2, "force reset function located once");
const FORCE_RESET = dist.slice(at, end + END.length);
const [, , HELPER_AFTER] = patch.EDITS.find((e) => e[0] === "owner id helper");
const HELPER = HELPER_AFTER.slice(HELPER_AFTER.indexOf("/* codex patch rc.7.82"));

function stub() {
  const f = function () { return p; };
  const p = new Proxy(f, {
    get: (t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => 0 : p),
    set: () => true, apply: () => p, construct: () => p, has: () => true,
  });
  return p;
}

const T0 = 1_800_000_000_000;
const HOST = 100;
function table(extra = []) {
  return [
    { pid: HOST, ppid: 10, name: "Code.exe", createdMs: T0 },
    { pid: 110, ppid: HOST, name: "python.exe", createdMs: T0 + 5000, stataish: true },
    { pid: 111, ppid: 110, name: "python.exe", createdMs: T0 + 9000, stataish: true, spawnParent: 110 },
    { pid: 200, ppid: 10, name: "Code.exe", createdMs: T0 + 1000 },
    { pid: 210, ppid: 200, name: "mcp-stata.exe", createdMs: T0 + 6000, stataish: true },
    { pid: 300, ppid: 10, name: "StataMP-64.exe", createdMs: T0 + 2000, stataish: true },
  ].concat(extra);
}

async function runReset({ reason, busy = false, owned, processes, listFails = false, helperMissing = false, killReply = null, dispose = "ok", openGateThrows = false, noResult = false, ownedOverride = null, lastKillScope = null }) {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push([file, ...args]);
    if (listFails && args.includes("-ListProcesses")) throw new Error("CIM timeout");
    if (args.includes("-ListProcesses")) return JSON.stringify({ ok: true, mode: "list", processes });
    if (args.includes("-ScopedTargetCsv")) {
      const csv = args[args.indexOf("-ScopedTargetCsv") + 1];
      if (killReply) return JSON.stringify(killReply);
      return JSON.stringify({ ok: true, mode: "scoped", killed: csv.split(",").map((x) => ({ pid: Number(x.split(":")[0]) })), unresolved: [] });
    }
    return JSON.stringify({ ok: true, raw: "other" });
  };
  const known = {
    console, Promise, Date, JSON, Math, Array, Map, Set, Number, String, Boolean, Object, Error, RegExp, Symbol, Buffer,
    setTimeout: (fn, ms) => { const h = setTimeout(fn, Math.min(ms, 5)); h.unref && h.unref(); return h; }, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    process: { platform: "win32", pid: HOST, cwd: () => ".", env: {} },
    require: (m) => {
      if (m === "child_process") return { execFileSync };
      if (helperMissing && /windows_kill_scope_core/.test(m)) throw new Error("module missing");
      return require(m.startsWith(".") || path.isAbsolute(m) ? m : m);
    },
    rg: path, yC: { extensionUri: { fsPath: path.join(__dirname, "..") } }, RI: () => {},
  };
  // The transport client: dispose/cancelAll are recorded so "before dispose" is checked, not assumed.
  const zgBase = { dispose: () => { calls.push(["dispose"]); return dispose === "reject" ? Promise.reject(new Error("pipe broken")) : dispose === "hang" ? new Promise(() => {}) : Promise.resolve(); },
    cancelAll: async () => { calls.push(["cancelAll"]); }, connect: async () => { calls.push(["connect"]); } };
  known.zg = new Proxy(zgBase, { get: (t, k) => (k in t ? t[k] : k === "then" ? undefined : stub()), set: () => true });
  const ctx = new Proxy(known, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : (t[k] = stub())),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  vm.createContext(ctx);
  ctx.globalThis = ctx;
  ctx.__codexOwnedBackendPids = new Map(owned.map((o) => [o.pid, { pid: o.pid, startedAt: new Date(o.startedAtMs).toISOString() }]));
  ctx.__codexBridgeState = { busy, postRunBusy: false };
  ctx.__codexResetGeneration = 0;
  const events = [];
  ctx.__codexRecoveryState = { required: false };
  ctx.__current = () => ({ busy: false });
  // Globals the patch reads must start undefined/null, not as the permissive stub.
  ctx.__codexUnresolvedCleanup = null; ctx.__codexLastKillScope = null; ctx.__codexKillScopeGeneration = null; ctx.__codexSoftStopInFlight = false;
  ctx.__codexContinuityLost = null;
  ctx.__codexWindowsKillScopeRef = undefined; ctx.__codexWindowsKillScope = undefined; ctx.__codexWindowsKillScopeError = undefined;
  ctx.__codexControl = { ensureRecoveryState: (x) => x || { required: false }, requestRecovery: (st, why) => { events.push(["requestRecovery", why]); return { required: true, reason: why }; } };
  ctx.__codexGraphMark = (m) => events.push(["graphMark", m.readinessState, m.readinessReason]);
  ctx.__codexRestoreReadinessRef = { reset: (w) => events.push(["restoreReset", w]) };
  ctx.__codexPendingOutcomesRef = { clear: (w) => events.push(["pendingClear", w]) };
  vm.runInContext(HELPER, ctx);
  if (openGateThrows) ctx.__codexWindowsKillScopeRef = { ...ctx.__codexWindowsKillScopeRef, openGate: () => { throw new Error("openGate broke"); } };
  if (noResult) ctx.__codexWindowsKillScopeRun = () => undefined;
  if (ownedOverride) ctx.__codexOwnedBackendPids = ownedOverride;
  if (lastKillScope) ctx.__codexLastKillScope = lastKillScope;
  vm.runInContext(FORCE_RESET, ctx);
  let state = null;
  await Promise.race([ctx.__codexForceReset(reason).then((s) => { state = s; }, () => {}), new Promise((r) => setTimeout(r, 1500))]);
  return { calls, state, ctx, events };
}

const unsafe = (calls) => calls.filter((c) => c.some((a) => /cleanup_mcp_stata_processes\.ps1|-OwnedPidCsv|-IncludeStataGui/.test(String(a)))
  || (c.some((a) => /panic_kill_stata_chain\.ps1/.test(String(a))) && !c.includes("-ListProcesses") && !c.includes("-ScopedTargetCsv")));
const kills = (calls) => calls.filter((c) => c.includes("-ScopedTargetCsv"));

let pass = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("  PASS " + name); } catch (e) { failures.push(name); console.log("  FAIL " + name + ": " + (e && e.stack || e)); }
}

(async () => {
  const foreign = [{ pid: 210, startedAtMs: T0 + 50000 }];
  await t("idle reset, registered pid belongs to another window: no unsafe cleanup, no kill", async () => {
    const r = await runReset({ reason: "soft-stop escalation", owned: foreign, processes: table() });
    assert.deepEqual(unsafe(r.calls), []);
    assert.deepEqual(kills(r.calls), []);
    assert.ok(r.calls.some((c) => c.includes("-ListProcesses")), "the scoped helper did run");
  });
  await t("busy reset, registered pid belongs to another window: no unsafe cleanup, no kill", async () => {
    const r = await runReset({ reason: "watchdog", busy: true, owned: foreign, processes: table() });
    assert.deepEqual(unsafe(r.calls), []);
    assert.deepEqual(kills(r.calls), []);
  });
  await t("reused pid (created after registration): no unsafe cleanup, no kill", async () => {
    const procs = table().map((p) => (p.pid === 110 ? { ...p, createdMs: T0 + 90000 } : p));
    const r = await runReset({ reason: "watchdog", busy: true, owned: [{ pid: 110, startedAtMs: T0 + 50000 }], processes: procs });
    assert.deepEqual(unsafe(r.calls), []);
    assert.deepEqual(kills(r.calls), []);
  });
  await t("panic-kill reset (KILL fail-closed branch): no list, no kill, no unsafe cleanup", async () => {
    const r = await runReset({ reason: "panic-kill-command scope unverified", owned: foreign, processes: table() });
    assert.deepEqual(r.calls.filter((c) => !["dispose", "cancelAll", "connect"].includes(c[0])), []);
    assert.ok(r.calls.some((c) => c[0] === "dispose"), "the transport is disposed");
  });
  await t("helper failed to load: nothing runs", async () => {
    const r = await runReset({ reason: "watchdog", busy: true, owned: foreign, processes: table(), helperMissing: true });
    assert.deepEqual(r.calls.filter((c) => !["dispose", "cancelAll", "connect"].includes(c[0])), []);
  });
  await t("process listing fails: no kill, no unsafe cleanup", async () => {
    const r = await runReset({ reason: "watchdog", owned: [{ pid: 110, startedAtMs: T0 + 50000 }], processes: table(), listFails: true });
    assert.deepEqual(unsafe(r.calls), []);
    assert.deepEqual(kills(r.calls), []);
  });
  await t("mixed roots (one ours, one foreign): fail-closed ends nothing", async () => {
    const r = await runReset({ reason: "watchdog", owned: [{ pid: 110, startedAtMs: T0 + 50000 }, ...foreign], processes: table() });
    assert.deepEqual(kills(r.calls), []);
    assert.deepEqual(unsafe(r.calls), []);
  });
  await t("verified idle reset ends exactly this window's tree, once, before dispose", async () => {
    const r = await runReset({ reason: "soft-stop escalation", owned: [{ pid: 110, startedAtMs: T0 + 50000 }], processes: table() });
    assert.deepEqual(unsafe(r.calls), []);
    const k = kills(r.calls);
    assert.equal(k.length, 1);
    assert.deepEqual(k[0][k[0].indexOf("-ScopedTargetCsv") + 1].split(","), ["110:" + (T0 + 5000), "111:" + (T0 + 9000)]);
    const killAt = r.calls.indexOf(k[0]), disposeAt = r.calls.findIndex((c) => c[0] === "dispose");
    assert.ok(disposeAt > killAt && killAt >= 0, "scoped kill ran before dispose (" + killAt + " < " + disposeAt + ")");
  });
  await t("verified busy reset ends the tree once (escalation, not again before dispose)", async () => {
    const r = await runReset({ reason: "watchdog", busy: true, owned: [{ pid: 110, startedAtMs: T0 + 50000 }], processes: table() });
    assert.equal(kills(r.calls).length, 1);
    assert.deepEqual(unsafe(r.calls), []);
  });
  // Review 3 R1: an incomplete scoped cleanup keeps READY closed and is not cleared by reconnect.
  const ours = [{ pid: 110, startedAtMs: T0 + 50000 }];
  for (const [label, reply] of [
    ["termination not confirmed (code 5)", { ok: false, mode: "scoped", results: [{ pid: 110, code: 5 }, { pid: 111, code: 0 }], unresolved: [], scanOk: true }],
    ["terminate failed (code 4)", { ok: false, mode: "scoped", results: [{ pid: 110, code: 0 }, { pid: 111, code: 4 }], unresolved: [], scanOk: true }],
    ["unknown child left behind", { ok: false, mode: "scoped", results: [{ pid: 110, code: 0 }, { pid: 111, code: 0 }], unresolved: [{ pid: 120, name: "python.exe", createdMs: null, reason: "x" }], scanOk: true }],
    ["child scan failed", { ok: false, mode: "scoped", results: [{ pid: 110, code: 0 }, { pid: 111, code: 0 }], unresolved: [], scanOk: false }],
  ]) {
    await t("R1 gate: " + label + " keeps READY closed after a successful reconnect", async () => {
      const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), killReply: reply });
      assert.ok(r.calls.some((c) => c[0] === "connect"), "the new transport connected");
      assert.ok(r.ctx.__codexUnresolvedCleanup && r.ctx.__codexUnresolvedCleanup.open, "gate open");
      const marks = r.events.filter((e) => e[0] === "graphMark");
      assert.ok(marks.length && marks.every((e) => e[1] !== "ready"), JSON.stringify(marks));
      assert.ok(!r.events.some((e) => e[0] === "restoreReset" || e[0] === "pendingClear"), "pending outcomes are kept");
      assert.ok(r.events.some((e) => e[0] === "requestRecovery"), "recovery is required");
    });
  }
  await t("R1 gate: a complete scoped cleanup still reaches READY", async () => {
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table() });
    assert.ok(!(r.ctx.__codexUnresolvedCleanup && r.ctx.__codexUnresolvedCleanup.open));
    assert.ok(r.events.some((e) => e[0] === "graphMark" && e[1] === "ready"));
  });
  await t("R1 gate: only a re-check of the original identity clears it", async () => {
    const reply = { ok: false, mode: "scoped", results: [{ pid: 110, code: 5 }, { pid: 111, code: 0 }], unresolved: [], scanOk: true };
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), killReply: reply });
    const gate = r.ctx.__codexUnresolvedCleanup;
    const core = require("./windows_kill_scope_core");
    const still = core.recheckGate(gate, { processes: table().map((p) => ({ ...p, cimCreatedMs: p.createdMs, handleCreatedMs: p.createdMs })) });
    assert.equal(still.open, true, "same pid, same creation time: still open");
    const reused = (rows) => core.recheckGate(gate, { processes: rows.map((p) => (p.pid === 110 ? { ...p, cimCreatedMs: T0 + 99000, handleCreatedMs: T0 + 99000 } : { ...p, cimCreatedMs: p.createdMs, handleCreatedMs: p.createdMs })) });
    assert.equal(reused(table()).open, true, "pid now another process but its old child 111 is still there: open");
    assert.equal(reused(table().filter((p) => p.pid !== 111)).open, false, "pid now another process, no child from its lifetime: cleared");
    assert.equal(core.recheckGate(gate, { processes: table().filter((p) => p.pid !== 110) }).open, true, "pid gone, child 111 left: open");
    assert.equal(core.recheckGate(gate, { processes: table().filter((p) => p.pid !== 110 && p.pid !== 111) }).open, false, "pid and child gone: cleared");
    assert.equal(core.recheckGate(gate, { error: "CIM timeout" }).open, true, "a failed listing does not clear it");
  });
  // Review 4 R2: the gate does not depend on the helper module; a broken gate stays unknown.
  const keepsPending = (r, label) => {
    assert.ok(r.ctx.__codexUnresolvedCleanup && r.ctx.__codexUnresolvedCleanup.open, label + ": gate open " + JSON.stringify(r.ctx.__codexUnresolvedCleanup));
    const marks = r.events.filter((e) => e[0] === "graphMark");
    assert.ok(marks.length && marks.every((e) => e[1] !== "ready" && e[2] !== "force-reset-complete"), label + ": " + JSON.stringify(marks));
    assert.ok(!r.events.some((e) => e[0] === "restoreReset" || e[0] === "pendingClear"), label + ": readiness/pending kept");
    assert.ok(r.events.some((e) => e[0] === "requestRecovery"), label + ": recovery required");
  };
  await t("R4-R2 helper module missing: cleanup unknown keeps readiness and pending, gate is unknown", async () => {
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), helperMissing: true });
    assert.equal(r.state.cleanup.ok, false);
    keepsPending(r, "module missing");
    const items = r.ctx.__codexUnresolvedCleanup.items;
    assert.ok(items.length === 1 && items[0].check === "unknown" && /module missing/.test(items[0].error), JSON.stringify(items));
    assert.equal(r.ctx.__codexUnresolvedCleanupRecheck().open, true, "a re-check cannot clear it without the helper");
  });
  await t("R4-R2 openGate throws: the gate stays open as unknown, not swallowed", async () => {
    const reply = { ok: false, mode: "scoped", results: [{ pid: 110, code: 5 }, { pid: 111, code: 0 }], unresolved: [], scanOk: true };
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), killReply: reply, openGateThrows: true });
    keepsPending(r, "openGate throws");
    assert.ok(r.ctx.__codexUnresolvedCleanup.items.some((i) => i.check === "unknown" && /openGate broke/.test(i.error)));
  });
  await t("R4-R2 the scoped run returns no result: readiness and pending kept", async () => {
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), noResult: true });
    assert.notEqual(r.state.cleanup.ok, true);
    keepsPending(r, "no result");
  });
  await t("R4-R2 no gate at all but cleanup not ok: __needsSmoke still holds readiness", async () => {
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), helperMissing: true });
    r.ctx.__codexUnresolvedCleanup = null;
    assert.equal(r.ctx.__codexCleanupBlocks({ ok: null }), true);
    assert.ok(r.ctx.__codexUnresolvedCleanup && r.ctx.__codexUnresolvedCleanup.open, "and it opened the gate");
    assert.equal(r.ctx.__codexCleanupBlocks({ ok: true }), true, "an open gate keeps blocking");
    r.ctx.__codexUnresolvedCleanup = null;
    assert.equal(r.ctx.__codexCleanupBlocks({ ok: true }), false, "a complete cleanup with no gate does not block");
  });
  await t("R4-R2 the cleanup step throws before it can open the gate: readiness still held", async () => {
    const r = await runReset({ reason: "watchdog", owned: ours, processes: table(), ownedOverride: { keys: () => { throw new Error("registry broke"); } } });
    assert.equal(r.state.cleanup.ok, false);
    assert.match(String(r.state.cleanup.error), /registry broke/);
    keepsPending(r, "cleanup threw");
  });
  // V3-KW (rc.7.90): after a successful scoped KILL the command resets with a
  // "panic-kill" reason. The real force reset must reuse that scoped result:
  // no second listing or kill, dispose before connect, and readiness held for
  // the command's own recovery smoke.
  const scopedOk = { ok: true, failClosed: false, dryRun: false, scope: "this-session", source: "panic-kill command",
    targets: [{ pid: 110, createdMs: T0 + 5000 }, { pid: 111, createdMs: T0 + 9000 }], ended: [{ pid: 110 }, { pid: 111 }] };
  await t("V3-KW KILL success reset reuses the scoped result: no second list or kill, dispose then connect", async () => {
    const r = await runReset({ reason: "panic-kill-command windows scoped tree ended", owned: ours, processes: table(), lastKillScope: scopedOk });
    assert.deepEqual(r.calls.filter((c) => !["dispose", "cancelAll", "connect"].includes(c[0])), [], "no process listing, no kill");
    const disposeAt = r.calls.findIndex((c) => c[0] === "dispose"), connectAt = r.calls.findIndex((c) => c[0] === "connect");
    assert.ok(disposeAt >= 0 && connectAt > disposeAt, "old transport disposed, then a new one connected");
    assert.equal(r.state.cleanup.ok, true);
    assert.equal(r.state.cleanup.mode, "scoped-tree");
    assert.ok(!(r.ctx.__codexUnresolvedCleanup && r.ctx.__codexUnresolvedCleanup.open), "no cleanup gate");
    // A panic-kill reset leaves readiness stale until the command's own smoke passes.
    assert.ok(r.events.some((e) => e[0] === "graphMark" && e[1] === "stale" && /force-reset-needs-smoke/.test(e[2])), "readiness waits for the smoke");
    assert.ok(!r.events.some((e) => e[0] === "graphMark" && e[1] === "ready"), "not READY before the smoke");
    assert.equal(r.ctx.__codexResetGeneration, 1, "the reset generation advanced");
  });
  await t("V3-KW control: the same reset without 'panic-kill' in its reason would run the kill scope again", async () => {
    const r = await runReset({ reason: "windows scoped tree ended", owned: ours, processes: table(), lastKillScope: scopedOk });
    assert.ok(r.calls.some((c) => c.includes("-ListProcesses")), "a second scope run lists the processes");
  });
  // Review 3 R3: dispose evidence.
  for (const [mode, ok, settled] of [["ok", true, true], ["reject", false, true], ["hang", false, false]]) {
    await t("R3 dispose " + mode + " is reported as ok=" + ok + " settled=" + settled, async () => {
      const r = await runReset({ reason: "panic-kill-command scope unverified", owned: ours, processes: table(), dispose: mode });
      assert.ok(r.state && r.state.dispose, "force reset returns dispose evidence");
      assert.equal(r.state.dispose.attempted, true);
      assert.equal(r.state.dispose.ok, ok);
      assert.equal(r.state.dispose.settled, settled);
      const core = require("./windows_kill_scope_core");
      const msg = core.failClosedMessage({ failClosed: true, reasons: ["x"] }, { disposed: r.state.dispose.ok, disposeAttempted: true, disposeError: r.state.dispose.error });
      if (ok) assert.match(msg, /It closed its own connection/);
      else { assert.doesNotMatch(msg, /It closed its own connection/); assert.match(msg, /tried to close its own connection/); }
    });
  }
  console.log(`windows kill scope reset: ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
