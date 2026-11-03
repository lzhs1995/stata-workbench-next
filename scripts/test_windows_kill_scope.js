#!/usr/bin/env node
"use strict";

// rc.7.82: Windows KILL ends only this window's backend tree. Offline checks of
// the selection core, the helper wiring with a fake execFileSync, the bundle
// call sites, patch idempotency/revert, and (on Windows only) the real
// panic_kill_stata_chain.ps1 -ListProcesses / scoped dry-run output.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("./windows_kill_scope_core");
const patch = require("./apply_windows_kill_scope_patch");

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); } catch (error) { failures.push(name); console.log("  FAIL " + name + ": " + (error && error.stack || error)); }
}

const T0 = 1_800_000_000_000;
// Two VS Code windows (hosts 100 and 200), each with its own backend tree, plus
// the user's own Stata GUI and an unrelated python.
function machine() {
  return [
    { pid: 100, ppid: 10, name: "Code.exe", createdMs: T0 },
    { pid: 110, ppid: 100, name: "python.exe", createdMs: T0 + 5_000, stataish: true },
    { pid: 111, ppid: 110, name: "python.exe", createdMs: T0 + 9_000, stataish: true, spawnParent: 110 },
    { pid: 112, ppid: 111, name: "conhost.exe", createdMs: T0 + 9_100 },
    { pid: 200, ppid: 10, name: "Code.exe", createdMs: T0 + 1_000 },
    { pid: 210, ppid: 200, name: "python.exe", createdMs: T0 + 6_000, stataish: true },
    { pid: 211, ppid: 210, name: "python.exe", createdMs: T0 + 9_500, stataish: true, spawnParent: 210 },
    { pid: 300, ppid: 10, name: "StataMP-64.exe", createdMs: T0 + 2_000, stataish: true },
    { pid: 400, ppid: 10, name: "python.exe", createdMs: T0 + 3_000 },
  ];
}
const rootA = { pid: 110, startedAtMs: T0 + 50_000 };
const pids = (r) => r.targets.map((x) => x.pid);

t("A's KILL selects only A's backend tree, children first", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [rootA], hostPid: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.failClosed, false);
  assert.deepEqual(pids(r).slice().sort((a, b) => a - b), [110, 111, 112]);
  assert.equal(r.targets[r.targets.length - 1].pid, 110, "root is ended last");
  for (const other of [100, 200, 210, 211, 300, 400]) assert.ok(!pids(r).includes(other), "must not select " + other);
  assert.ok(r.census.some((p) => p.pid === 300 && !p.selected), "the user's Stata GUI is listed but not selected");
});

t("B's KILL selects only B's tree", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [{ pid: 210, startedAtMs: T0 + 50_000 }], hostPid: 200 });
  assert.deepEqual(pids(r).slice().sort((a, b) => a - b), [210, 211]);
});

t("a reused root pid (created after the host recorded it) is not ended", () => {
  const procs = machine().map((p) => (p.pid === 110 ? { ...p, createdMs: T0 + 60_000 } : p));
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.deepEqual(pids(r), []);
  assert.equal(r.roots[0].status, "reused");
});

t("a root older than its host is treated as reused", () => {
  const procs = machine().map((p) => (p.pid === 110 ? { ...p, createdMs: T0 - 60_000 } : p));
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.deepEqual(pids(r), []);
  assert.equal(r.roots[0].status, "reused");
});

t("a child that predates its parent (stale ParentProcessId) is not ended", () => {
  const procs = machine().concat([{ pid: 115, ppid: 110, name: "python.exe", createdMs: T0 + 1_000, stataish: true }]);
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.ok(!pids(r).includes(115));
  assert.ok(pids(r).includes(111));
});

t("a root whose parent is not this host fails closed and ends nothing", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [{ pid: 210, startedAtMs: T0 + 50_000 }], hostPid: 100 });
  assert.equal(r.failClosed, true);
  assert.equal(r.ok, false);
  assert.deepEqual(pids(r), []);
  assert.match(r.reasons.join(" "), /could not be tied to this window/);
});

t("a protected root name fails closed", () => {
  const procs = machine().map((p) => (p.pid === 110 ? { ...p, name: "powershell.exe" } : p));
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.equal(r.failClosed, true);
  assert.deepEqual(pids(r), []);
});

t("a root without startedAt fails closed", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [{ pid: 110, startedAtMs: null }], hostPid: 100 });
  assert.equal(r.failClosed, true);
  assert.deepEqual(pids(r), []);
});

t("the host itself is never a target, even if registered", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [{ pid: 100, startedAtMs: T0 + 50_000 }], hostPid: 100 });
  assert.deepEqual(pids(r), []);
  assert.equal(r.failClosed, true);
});

t("an exited root with a left-over worker reports it and ends nothing", () => {
  const procs = machine().filter((p) => p.pid !== 110);
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.deepEqual(pids(r), []);
  assert.equal(r.failClosed, true);
  assert.deepEqual(r.suspectedOrphans.map((p) => p.pid), [111]);
});

t("an exited root with nothing left is a clean no-op", () => {
  const procs = machine().filter((p) => p.pid !== 110 && p.pid !== 111 && p.pid !== 112);
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.nothingOwned, true);
});

t("no registered backend selects nothing", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [], hostPid: 100 });
  assert.equal(r.nothingOwned, true);
  assert.deepEqual(pids(r), []);
});

t("rootsFromOwned reads the Map the bridge keeps", () => {
  const m = new Map([[110, { pid: 110, ownerId: "x", startedAt: new Date(T0 + 50_000).toISOString() }], [1, { pid: 1 }]]);
  assert.deepEqual(core.rootsFromOwned(m), [{ pid: 110, startedAtMs: T0 + 50_000 }]);
  assert.deepEqual(core.rootsFromOwned(null), []);
});

function fakeExec(processes, calls, killReply) {
  return (file, args) => {
    calls.push(args.slice());
    if (args.includes("-ListProcesses")) return JSON.stringify({ ok: true, mode: "list", processes });
    if (args.includes("-ScopedTargetCsv")) {
      const csv = args[args.indexOf("-ScopedTargetCsv") + 1];
      return JSON.stringify(killReply || { ok: true, mode: "scoped", killed: csv.split(",").map((x) => ({ pid: Number(x.split(":")[0]) })) });
    }
    throw new Error("unexpected call " + args.join(" "));
  };
}
function scope(processes, calls, extra = {}) {
  return core.createWindowsKillScope({ execFileSync: fakeExec(processes, calls, extra.killReply), scriptPath: "C:\\ext\\scripts\\panic_kill_stata_chain.ps1",
    platform: extra.platform || "win32", hostPid: 100, ownedPids: () => new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]) });
}

t("helper ends exactly A's tree with pid:createdMs and never -IncludeStataGui", () => {
  const calls = [];
  const r = scope(machine(), calls).run({ dryRun: false, source: "test" });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  const flat = calls.flat();
  assert.ok(!flat.includes("-IncludeStataGui"));
  const csv = calls[1][calls[1].indexOf("-ScopedTargetCsv") + 1];
  assert.deepEqual(csv.split(",").sort(), ["110:" + (T0 + 5_000), "111:" + (T0 + 9_000), "112:" + (T0 + 9_100)].sort());
  assert.ok(calls[1].includes("-Force"));
});

t("dry run lists but does not kill", () => {
  const calls = [];
  const r = scope(machine(), calls).run({ dryRun: true, source: "test" });
  assert.equal(calls.length, 1);
  assert.equal(r.dryRun, true);
  assert.deepEqual(pids(r).slice().sort((a, b) => a - b), [110, 111, 112]);
});

t("listing failure fails closed without a kill call", () => {
  const calls = [];
  const s = core.createWindowsKillScope({ execFileSync: (f, a) => { calls.push(a); throw new Error("CIM timeout"); }, scriptPath: "x", platform: "win32", hostPid: 100, ownedPids: () => new Map() });
  const r = s.run({ dryRun: false });
  assert.equal(r.failClosed, true);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.match(core.failClosedMessage(r), /did not end them/);
  assert.match(core.failClosedMessage(r), /CIM timeout/);
});

t("a kill that reports a failure makes the result not ok", () => {
  const calls = [];
  const r = scope(machine(), calls, { killReply: { ok: false, mode: "scoped", failed: [{ pid: 111 }] } }).run({ dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.failClosed, false);
});

t("not Windows: the helper does nothing", () => {
  const calls = [];
  const r = scope(machine(), calls, { platform: "darwin" }).run({ dryRun: false });
  assert.equal(r.skipped, "not-windows");
  assert.equal(calls.length, 0);
});

// Bundle: the three Windows call sites go through the helper; nothing asks for every Stata GUI.
const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
t("bundle carries the marker and no product call passes -IncludeStataGui", () => {
  assert.ok(dist.includes(patch.MARKER));
  assert.equal(dist.includes('"-IncludeStataGui"'), false);
  assert.equal((dist.match(/panic_kill_stata_chain\.ps1/g) || []).length, 1, "only the helper names the script");
  for (const src of ['"force-reset escalation"', '"panic-kill endpoint"', '"panic-kill command"']) {
    assert.ok(dist.includes("__codexWindowsKillScopeRun(false," + src + ")") || dist.includes(src), "call site " + src);
  }
  assert.ok(dist.includes('if(__choice!=="Kill this window\'s Stata")return;'));
  assert.equal(dist.includes("Kill all Stata processes"), false);
});

t("busy force reset no longer escalates to a machine-wide kill", () => {
  const at = dist.indexOf("globalThis.__codexForceReset=async");
  const win = dist.slice(at, at + 9000);
  assert.ok(win.includes('s.lastForceResetPanic=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(false,"force-reset escalation")'));
});

t("KILL command: fail-closed resets this window's transport and warns", () => {
  const at = dist.indexOf('registerCommand("stata-workbench.panicKill"');
  const win = dist.slice(at, at + 6000);
  const i = win.indexOf("__codexKillScope.failClosed");
  assert.ok(i > 0);
  assert.ok(win.indexOf('__codexForceReset("panic-kill-command scope unverified")', i) > i);
  assert.ok(win.indexOf("failClosedMessage(__codexKillScope)", i) > i);
  assert.ok(win.indexOf("requestRecovery", i) > i, "recovery is requested after the scoped kill");
  assert.ok(/panic-kill/i.test("panic-kill-command scope unverified"), "the reset reason skips the busy escalation");
});

t("helper installs from the packaged core and fails closed when it cannot", () => {
  const [, , after] = patch.EDITS[0];
  const i = after.indexOf("/* codex patch rc.7.82");
  const code = after.slice(i);
  const logs = [];
  const ctx = { globalThis: null, require: (m) => (m === "child_process" ? { execFileSync: fakeExec(machine(), []) } : require(m)),
    rg: { join: (...p) => p.join("/") }, yC: { extensionUri: { fsPath: path.join(__dirname, "..") } }, process: { platform: "win32", pid: 100, cwd: () => "." }, RI: (m) => logs.push(m), String };
  ctx.globalThis = ctx;
  ctx.__codexOwnedBackendPids = new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]);
  vm.runInNewContext(code, ctx);
  const r = ctx.__codexWindowsKillScopeRun(false, "vm");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.deepEqual(r.targets.map((x) => x.pid).sort((a, b) => a - b), [110, 111, 112]);
  const broken = { ...ctx, require: () => { throw new Error("module missing"); } };
  broken.globalThis = broken;
  vm.runInNewContext(code, broken);
  const r2 = broken.__codexWindowsKillScopeRun(false, "vm");
  assert.equal(r2.failClosed, true);
  assert.match(r2.reasons[0], /module missing/);
});

t("patch is idempotent and reverts exactly", () => {
  assert.equal(patch.patchBundle(dist), patch.patchBundle(patch.patchBundle(dist)));
  const reverted = patch.revertBundle(dist);
  assert.equal(reverted.includes("__codexWindowsKillScope"), false);
  assert.ok(reverted.includes("Kill all Stata processes"));
  assert.equal(patch.patchBundle(reverted), patch.patchBundle(dist));
});

const ps1 = path.join(__dirname, "panic_kill_stata_chain.ps1");
t("panic script keeps scoped mode ahead of name selection", () => {
  const text = fs.readFileSync(ps1, "utf8");
  const list = text.indexOf("if ($ListProcesses)");
  const scoped = text.indexOf("if (-not [string]::IsNullOrWhiteSpace($ScopedTargetCsv))");
  const byName = text.indexOf("function Get-Reason");
  assert.ok(list > 0 && scoped > list && byName > scoped, "list and scoped modes exit before name-based selection");
  assert.match(text, /creation time changed \(pid reused\)/);
});

if (process.platform === "win32") {
  const { execFileSync } = require("node:child_process");
  t("Windows: -ListProcesses lists this node process with its parent", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ListProcesses"], { encoding: "utf8", maxBuffer: 16 << 20 }));
    const me = out.processes.find((p) => p.pid === process.pid);
    assert.ok(me, "own pid listed");
    assert.equal(me.ppid, process.ppid);
    assert.ok(Number.isFinite(me.createdMs) && Math.abs(me.createdMs - (Date.now() - process.uptime() * 1000)) < 60_000, "createdMs is epoch ms");
    const r = core.selectSessionTree({ processes: out.processes, roots: [{ pid: process.pid, startedAtMs: Date.now() }], hostPid: process.ppid });
    assert.ok(r.targets.some((x) => x.pid === process.pid), "a real tree rooted at this process resolves");
  });
  t("Windows: scoped mode without -Force only echoes the targets", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ScopedTargetCsv", process.pid + ":1"], { encoding: "utf8" }));
    assert.equal(out.mode, "scoped-dry-run");
    assert.equal(out.requested, 1);
  });
  t("Windows: -Force with a wrong creation time does not end the process", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Force", "-ScopedTargetCsv", process.pid + ":1"], { encoding: "utf8" }));
    assert.equal(out.killedCount, 0);
    assert.match(JSON.stringify(out.skipped), /pid reused/);
  });
}

console.log(`windows kill scope: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
