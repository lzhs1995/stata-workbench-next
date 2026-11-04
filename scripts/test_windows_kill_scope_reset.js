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
const END = "let __state=__current();__state.cleanup=__cleanup;return __state};";
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

async function runReset({ reason, busy = false, owned, processes, listFails = false, helperMissing = false }) {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push([file, ...args]);
    if (listFails && args.includes("-ListProcesses")) throw new Error("CIM timeout");
    if (args.includes("-ListProcesses")) return JSON.stringify({ ok: true, mode: "list", processes });
    if (args.includes("-ScopedTargetCsv")) {
      const csv = args[args.indexOf("-ScopedTargetCsv") + 1];
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
  vm.runInContext(HELPER, ctx);
  vm.runInContext(FORCE_RESET, ctx);
  let state = null;
  await Promise.race([ctx.__codexForceReset(reason).then((s) => { state = s; }, () => {}), new Promise((r) => setTimeout(r, 1500))]);
  return { calls, state, ctx };
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
    assert.deepEqual(r.calls, []);
  });
  await t("helper failed to load: nothing runs", async () => {
    const r = await runReset({ reason: "watchdog", busy: true, owned: foreign, processes: table(), helperMissing: true });
    assert.deepEqual(r.calls, []);
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
  });
  await t("verified busy reset ends the tree once (escalation, not again before dispose)", async () => {
    const r = await runReset({ reason: "watchdog", busy: true, owned: [{ pid: 110, startedAtMs: T0 + 50000 }], processes: table() });
    assert.equal(kills(r.calls).length, 1);
    assert.deepEqual(unsafe(r.calls), []);
  });
  console.log(`windows kill scope reset: ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
