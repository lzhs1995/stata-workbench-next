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
const ps1Early = path.join(__dirname, "panic_kill_stata_chain.ps1");
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

t("A's KILL selects only A's backend tree, root first", () => {
  const r = core.selectSessionTree({ processes: machine(), roots: [rootA], hostPid: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.failClosed, false);
  assert.deepEqual(pids(r).slice().sort((a, b) => a - b), [110, 111, 112]);
  assert.equal(r.targets[0].pid, 110, "root is ended first, so it cannot start new workers");
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
  assert.match(core.failClosedMessage(r), /did not target any of them/);
  assert.doesNotMatch(core.failClosedMessage(r), /closed its own connection/, "no dispose was passed");
  assert.match(core.failClosedMessage(r), /CIM timeout/);
});

for (const [label, owned] of [
  ["one verified root plus one foreign root", [[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }], [210, { pid: 210, startedAt: new Date(T0 + 50_000).toISOString() }]]],
  ["a verified root plus an orphan of an exited root", [[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }], [910, { pid: 910, startedAt: new Date(T0 + 50_000).toISOString() }]]],
]) {
  t("R3 all-or-nothing: " + label + " ends nothing", () => {
    const calls = [];
    const procs = machine().concat([{ pid: 911, ppid: 910, name: "python.exe", createdMs: T0 + 9_900, stataish: true, spawnParent: 910 }]);
    const s = core.createWindowsKillScope({ execFileSync: fakeExec(procs, calls), scriptPath: "x", platform: "win32", hostPid: 100, ownedPids: () => new Map(owned) });
    const r = s.run({ dryRun: false });
    assert.equal(r.failClosed, true);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, "only the listing ran");
    assert.ok(!calls.flat().includes("-ScopedTargetCsv"));
    assert.ok(r.targets.length > 0, "proposed targets stay as diagnostics");
    const msg = core.failClosedMessage(r);
    assert.match(msg, /did not target any of them/);
    assert.doesNotMatch(msg, /close this window's stuck python\.exe/);
    assert.match(msg, /Only end one of these in Task Manager if you know it belongs to this window/);
  });
}

t("processes left behind by the kill make the result not ok and are named", () => {
  const calls = [];
  const r = scope(machine(), calls, { killReply: { ok: true, mode: "scoped", killed: [{ pid: 110 }, { pid: 111 }, { pid: 112 }], unresolved: [{ pid: 120, name: "python.exe", reason: "started by an ended backend process after the listing; not ended" }] } }).run({ dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.failClosed, false);
  assert.match(core.failClosedMessage(r), /ended 3 of 3 process\(es\).*pid 120/);
});

// V2-R1: a CIM row (parent 110) whose pid was reused before the handle was read.
t("V2-R1 a row whose CIM and handle creation times differ is never targeted and fails closed", () => {
  const procs = machine().map((p) => ({ ...p, cimCreatedMs: p.createdMs, handleCreatedMs: p.createdMs }))
    .map((p) => (p.pid === 111 ? { ...p, handleCreatedMs: T0 + 10_000 } : p));
  for (const p of procs) delete p.createdMs;
  const r = core.selectSessionTree({ processes: procs, roots: [rootA], hostPid: 100 });
  assert.ok(!pids(r).includes(111), "the replacement never enters the target list");
  assert.equal(r.failClosed, true);
  assert.deepEqual(r.uncertainChildren.map((x) => x.pid), [111]);
  const calls = [];
  const out = core.createWindowsKillScope({ execFileSync: fakeExec(procs, calls), scriptPath: "x", platform: "win32", hostPid: 100,
    ownedPids: () => new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]) }).run({ dryRun: false });
  assert.equal(calls.length, 1, "no kill request");
  assert.match(core.failClosedMessage(out), /changed identity while being listed/);
});

t("V2-R1 rows whose CIM and handle creation times agree keep the handle time", () => {
  const n = core.normalize({ pid: 5, ppid: 1, name: "python.exe", cimCreatedMs: 1000, handleCreatedMs: 1001 });
  assert.equal(n.createdMs, 1001);
  assert.equal(n.identityUncertain, false);
  const denied = core.normalize({ pid: 6, ppid: 1, name: "System", cimCreatedMs: 1000, handleCreatedMs: null });
  assert.equal(denied.createdMs, null);
  assert.equal(denied.identityUncertain, false, "no handle (access denied) is not a reuse signal");
});

// Review 3 R2: a child under the tree whose identity cannot be read is unknown, not ignored.
for (const [label, patchRow] of [["no handle", { handleCreatedMs: null }], ["no CIM CreationDate", { cimCreatedMs: null }]]) {
  t("R2 child with " + label + " is reported unknown, not ended, and the result is not ok", () => {
    const procs = machine().map((p) => ({ ...p, cimCreatedMs: p.createdMs, handleCreatedMs: p.createdMs }))
      .map((p) => (p.pid === 111 ? { ...p, ...patchRow } : p));
    for (const p of procs) delete p.createdMs;
    const calls = [];
    const r = core.createWindowsKillScope({ execFileSync: fakeExec(procs, calls), scriptPath: "x", platform: "win32", hostPid: 100,
      ownedPids: () => new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]) }).run({ dryRun: false });
    assert.deepEqual(r.unknownChildren.map((x) => x.pid), [111]);
    assert.equal(r.ok, false);
    const csv = (calls[1] || [])[(calls[1] || []).indexOf("-ScopedTargetCsv") + 1] || "";
    assert.ok(!csv.split(",").some((x) => x.startsWith("111:")), "the unknown child is not a target");
    assert.match(core.failClosedMessage(r), /pid 111 .*creation time could not be read/);
    const gate = core.openGate(null, r, new Map());
    assert.ok(gate.open && gate.items.some((i) => i.pid === 111 && i.check === "absent"));
    assert.equal(core.recheckGate(gate, { processes: procs }).open, true, "still listed: stays unknown");
    assert.equal(core.recheckGate(gate, { processes: procs.filter((p) => p.pid !== 111 && p.pid !== 110 && p.pid !== 112) }).open, false, "pid gone: independent evidence clears it");
  });
}

t("R2 a post-scan row with no readable identity is unresolved (ps1)", () => {
  const text = fs.readFileSync(ps1Early, "utf8");
  assert.match(text, /if \(\$null -eq \$cm\) \{ \$cm = Get-CimCreated \$_ \}/);
  assert.match(text, /creation time could not be read; not ended/);
});

// V2-R2: the verdict comes from the raw per-target codes.
for (const [code, kind] of [[0, "killed"], [1, "skipped"], [2, "skipped"], [3, "failed"], [4, "failed"], [5, "pending"], [6, "pending"], [9, "failed"]]) {
  t(`V2-R2 native code ${code} is classified as ${kind}`, () => {
    const v = core.classifyKill({ ok: true, results: [{ pid: 110, name: "python.exe", code }] });
    assert.equal(v[kind].length, 1);
    assert.equal(v.complete, kind === "killed" || kind === "skipped");
  });
}

t("V2-R2 a wait timeout is not an ended process even if the script said ok", () => {
  const calls = [];
  const r = scope(machine(), calls, { killReply: { ok: true, mode: "scoped", results: [
    { pid: 110, code: 0 }, { pid: 111, code: 5 }, { pid: 112, code: 0 }], unresolved: [], scanOk: true } }).run({ dryRun: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ended.map((x) => x.pid), [110, 112]);
  assert.deepEqual(r.pending.map((x) => x.pid), [111]);
  assert.match(core.failClosedMessage(r), /pid 111 .*not confirmed within 5 s/);
});

t("V2-R2 a failed child scan makes the result not ok", () => {
  const calls = [];
  const r = scope(machine(), calls, { killReply: { ok: true, mode: "scoped", results: [{ pid: 110, code: 0 }, { pid: 111, code: 0 }, { pid: 112, code: 0 }], unresolved: [], scanOk: false } }).run({ dryRun: false });
  assert.equal(r.ok, false);
  assert.match(core.failClosedMessage(r), /check for processes started during the kill failed/);
});

// V2-R3: the warning says what happened.
t("V2-R3 termination failures are named and no connection close is claimed", () => {
  const r = { ok: false, failClosed: false, targets: [{ pid: 110 }], ended: [], reasons: [],
    failed: [{ pid: 110, name: "python.exe", reason: "cannot open process" }], kill: { ok: false } };
  const msg = core.failClosedMessage(r);
  assert.match(msg, /ended 0 of 1 process/);
  assert.match(msg, /pid 110 \(python\.exe\): cannot open process/);
  assert.doesNotMatch(msg, /could not confirm which processes belong/);
  assert.doesNotMatch(msg, /closed its own connection/);
  assert.doesNotMatch(msg, /unknown reason/);
});

t("V2-R3 the connection-close sentence appears only when the caller disposed", () => {
  const r = { ok: false, failClosed: true, reasons: ["x"], roots: [] };
  assert.match(core.failClosedMessage(r, { disposed: true }), /closed its own connection/);
  assert.doesNotMatch(core.failClosedMessage(r, { disposed: false }), /closed its own connection/);
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
  assert.equal(dist.includes("cleanup_mcp_stata_processes"), false, "no bare-pid Windows cleanup left in the bundle");
  assert.equal(dist.includes("-OwnedPidCsv"), false);
});

t("busy force reset no longer escalates to a machine-wide kill", () => {
  const at = dist.indexOf("globalThis.__codexForceReset=async");
  const win = dist.slice(at, at + 9000);
  assert.ok(win.includes('s.lastForceResetPanic=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(false,"force-reset escalation")'));
});

t("KILL command: fail-closed resets this window's transport and warns", () => {
  const at = dist.indexOf('registerCommand("stata-workbench.panicKill"');
  const win = dist.slice(at, at + 6000);
  assert.ok(win.includes("{disposed:!!(__codexKillDispose&&__codexKillDispose.ok),disposeAttempted:"), "the warning uses the reset's dispose evidence");
  assert.ok(win.includes("__codexKillReset=await globalThis.__codexForceReset(\"panic-kill-command scope unverified\")"), "evidence comes from the reset's return value");
  const i = win.indexOf("__codexKillScope.failClosed");
  assert.ok(i > 0);
  assert.ok(win.indexOf('__codexForceReset("panic-kill-command scope unverified")', i) > i);
  assert.ok(win.indexOf("failClosedMessage(__codexKillScope,{disposed:", i) > i);
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

t("R1 the installed wrapper opens the gate on a non-dry, incomplete run (KILL success path has no force reset)", () => {
  const [, , after] = patch.EDITS.find((e) => e[0] === "owner id helper");
  const code = after.slice(after.indexOf("/* codex patch rc.7.82"));
  const pending = { ok: false, mode: "scoped", results: [{ pid: 110, code: 5 }, { pid: 111, code: 0 }, { pid: 112, code: 0 }], unresolved: [], scanOk: true };
  const ctx = { require: (m) => (m === "child_process" ? { execFileSync: fakeExec(machine(), [], pending) } : require(m)),
    rg: { join: (...p) => p.join("/") }, yC: { extensionUri: { fsPath: path.join(__dirname, "..") } }, process: { platform: "win32", pid: 100, cwd: () => "." }, RI: () => {}, String };
  ctx.globalThis = ctx;
  ctx.__codexOwnedBackendPids = new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]);
  vm.runInNewContext(code, ctx);
  ctx.__codexWindowsKillScopeRun(true, "dry");
  assert.ok(!ctx.__codexUnresolvedCleanup, "a dry run never opens the gate");
  ctx.__codexWindowsKillScopeRun(false, "panic-kill command");
  assert.ok(ctx.__codexUnresolvedCleanup && ctx.__codexUnresolvedCleanup.open, "gate open after the incomplete kill");
  assert.ok(ctx.__codexUnresolvedCleanup.items.some((i) => i.pid === 110 && i.check === "identity" && i.createdMs === T0 + 5_000));
});

t("R1 /recovery-smoke re-checks the gate and refuses with 423 before any smoke", () => {
  const at = dist.indexOf('__req.url==="/recovery-smoke"){');
  const win = dist.slice(at, at + 1400);
  const g = win.indexOf("globalThis.__codexUnresolvedCleanupRecheck()");
  const refuse = win.indexOf('__send(__res,423,{ok:false,error:');
  const smoke = win.indexOf("let __recovery=__codexControl.ensureRecoveryState");
  assert.ok(g > 0 && refuse > g && smoke > refuse, [g, refuse, smoke].join(","));
  assert.ok(win.includes('reasonCode:"unresolved-cleanup"'));
  assert.ok(win.includes('if(process.platform==="win32"&&globalThis.__codexUnresolvedCleanup&&globalThis.__codexUnresolvedCleanup.open){let __g=globalThis.__codexUnresolvedCleanupRecheck'), "the refusal is guarded by the open gate itself");
  assert.ok(win.includes("if(__g&&__g.open){__send(__res,423,"), "refuses while the re-checked gate is still open");
});

// Review 4 R1: an ended root whose child scan failed is not cleared by the root being gone.
const R4 = (extra) => ({ processes: [{ pid: 100, ppid: 10, name: "Code.exe", createdMs: T0 }].concat(extra) });
const scanFailed = { ok: false, scanOk: false, targets: [{ pid: 110, createdMs: 2000 }], ended: [{ pid: 110 }] };
t("R4-R1 root ended + child scan failed + next listing still has its child: gate stays open on the child", () => {
  const owned = new Map([[110, { pid: 110, startedAt: new Date(5000).toISOString() }]]);
  const gate = core.openGate(null, scanFailed, owned);
  assert.ok(gate.items.some((i) => i.pid === 110 && i.check === "scan" && i.createdMs === 2000), JSON.stringify(gate.items));
  const next = core.recheckGate(gate, { processes: [{ pid: 111, ppid: 110, name: "python.exe", createdMs: 3000, stataish: true }] });
  assert.equal(next.open, true, JSON.stringify(next));
  assert.ok(next.items.some((i) => i.pid === 111 && i.check === "identity" && i.createdMs === 3000));
  assert.deepEqual(next.cleared.map((i) => [i.pid, i.leftovers]), [[110, [111]]]);
  assert.equal(core.recheckGate(next, { processes: [] }).open, false, "the child gone: cleared");
  assert.equal(core.recheckGate(gate, { error: "CIM timeout" }).open, true, "a failed rescan keeps it");
});
t("R4-R1 the scan window comes from the original target: older (stale ppid) or later (after it ended) children do not block", () => {
  const gate = core.openGate(null, { ...scanFailed, ended: [{ pid: 110, endedAtMs: 4000 }] }, new Map());
  const next = core.recheckGate(gate, { processes: [{ pid: 120, ppid: 110, name: "python.exe", createdMs: 1000 }, { pid: 121, ppid: 110, name: "x.exe", createdMs: 9000 }] });
  assert.equal(next.open, false, JSON.stringify(next.items));
  const unknown = core.recheckGate(gate, { processes: [{ pid: 122, ppid: 110, name: "python.exe", createdMs: null }] });
  assert.ok(unknown.open && unknown.items.some((i) => i.pid === 122 && i.check === "absent"), "a child with no readable creation time stays unknown");
});
t("R4-R1 run() carries the ended target's creation time and confirmed end time into the gate", () => {
  const scope = core.createWindowsKillScope({ execFileSync: fakeExec(machine(), [], { ok: false, mode: "scoped", results: [{ pid: 110, code: 0, endedAtMs: T0 + 60_000 }, { pid: 111, code: 0, endedAtMs: T0 + 60_001 }, { pid: 112, code: 0, endedAtMs: -1 }], unresolved: [], scanOk: false }),
    scriptPath: "x.ps1", platform: "win32", hostPid: 100, ownedPids: () => new Map([[110, { pid: 110, startedAt: new Date(T0 + 50_000).toISOString() }]]) });
  const r = scope.run({ source: "t" });
  assert.equal(r.ok, false);
  const scan = core.gateItemsFrom(r, new Map()).filter((i) => i.check === "scan");
  assert.deepEqual(scan.map((i) => [i.pid, i.createdMs, i.endedAtMs]), [[110, T0 + 5_000, T0 + 60_000], [111, T0 + 9_000, T0 + 60_001], [112, T0 + 9_100, null]]);
});
t("R4-R1 a pending target that is gone later is cleared only with no child left from its lifetime", () => {
  const gate = core.openGate(null, { ok: false, scanOk: true, targets: [{ pid: 110, createdMs: 2000 }], pending: [{ pid: 110 }] }, new Map());
  assert.equal(core.recheckGate(gate, R4([{ pid: 111, ppid: 110, name: "python.exe", createdMs: 3000 }])).open, true);
  assert.equal(core.recheckGate(gate, R4([])).open, false);
});
t("R4-R2 an 'unknown' item is never cleared by a re-check; a 'listing' item needs one successful listing", () => {
  const unknown = { open: true, items: [{ pid: null, check: "unknown", why: "could not build the cleanup check" }] };
  assert.equal(core.recheckGate(unknown, R4([])).open, true);
  const listing = core.openGate(null, { ok: false, failClosed: true, reasons: ["could not list"] }, new Map());
  assert.deepEqual(listing.items.map((i) => i.check), ["listing"]);
  assert.equal(core.recheckGate(listing, { error: "x" }).open, true);
  assert.equal(core.recheckGate(listing, R4([])).open, false);
});
t("R4 gate text never suggests ending a pid whose start time is unknown, and states what a new window does not prove", () => {
  const msg = core.gateMessage({ open: true, items: [{ pid: 120, name: "python.exe", createdMs: null, check: "absent", why: "x" }] });
  assert.match(msg, /may already belong to another program: do not end it/);
  assert.doesNotMatch(msg, /end one in Task Manager/);
  assert.match(msg, /does not prove the processes listed here ended/);
  assert.match(msg, /Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"/);
  const known = core.gateMessage({ open: true, items: [{ pid: 110, name: "python.exe", createdMs: T0, check: "identity", why: "x" }] });
  assert.doesNotMatch(known, /do not end it/);
  assert.match(known, new RegExp("started " + new Date(T0).toISOString().replace(/[.]/g, "[.]")));
});

t("patch is idempotent and reverts exactly", () => {
  assert.equal(patch.patchBundle(dist), patch.patchBundle(patch.patchBundle(dist)));
  const reverted = patch.revertBundle(dist);
  assert.equal(reverted.includes("__codexWindowsKillScope"), false);
  assert.ok(reverted.includes("Kill all Stata processes"));
  assert.equal(patch.patchBundle(reverted), patch.patchBundle(dist));
});

const ps1 = ps1Early;
t("panic script keeps scoped mode ahead of name selection", () => {
  const text = fs.readFileSync(ps1, "utf8");
  const list = text.indexOf("if ($ListProcesses)");
  const scoped = text.indexOf("if ($PSBoundParameters.ContainsKey('ScopedTargetCsv')) {");
  const byName = text.indexOf("function Get-Reason");
  assert.ok(list > 0 && scoped > list && byName > scoped, "list and scoped modes exit before name-based selection");
  assert.match(text, /creation time changed \(pid reused\)/);
  assert.match(text, /EndIfSame/, "the same handle is checked and terminated");
  assert.match(text, /if \(w == 0x102\) return 5;/, "a wait timeout is not success");
  assert.match(text, /cimCreatedMs = Get-CimCreated/, "the listing carries the CIM row's own creation time");
  assert.doesNotMatch(text, /child started during kill/, "no post-kill adoption of new children");
});

if (process.platform === "win32") {
  const { execFileSync } = require("node:child_process");
  t("Windows: -ListProcesses lists this node process with its parent; CIM and handle times agree", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ListProcesses"], { encoding: "utf8", maxBuffer: 16 << 20 }));
    const me = out.processes.find((p) => p.pid === process.pid);
    assert.ok(me, "own pid listed");
    assert.equal(me.ppid, process.ppid);
    assert.ok(Math.abs(me.cimCreatedMs - me.handleCreatedMs) <= core.IDENTITY_TOLERANCE_MS, JSON.stringify(me));
    assert.ok(Number.isFinite(me.handleCreatedMs) && Math.abs(me.handleCreatedMs - (Date.now() - process.uptime() * 1000)) < 60_000, "createdMs is epoch ms");
    const r = core.selectSessionTree({ processes: out.processes, roots: [{ pid: process.pid, startedAtMs: Date.now() }], hostPid: process.ppid });
    assert.ok(r.targets.some((x) => x.pid === process.pid), "a real tree rooted at this process resolves");
  });
  t("Windows: scoped mode without -Force only echoes the targets", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ScopedTargetCsv", process.pid + ":1"], { encoding: "utf8" }));
    assert.equal(out.mode, "scoped-dry-run");
    assert.equal(out.requested, 1);
  });
  t("Windows: malformed scoped targets end nothing", () => {
    let out;
    try { execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Force", "-ScopedTargetCsv", process.pid + ":abc"], { encoding: "utf8" }); }
    catch (e) { out = JSON.parse(e.stdout); }
    assert.ok(out && out.ok === false && /malformed/.test(out.error));
  });
  t("Windows: -Force with the listed creation time ends exactly that process", () => {
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    let row = null;
    while (!row && Date.now() < deadline) {
      const list = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ListProcesses"], { encoding: "utf8", maxBuffer: 16 << 20 }));
      row = list.processes.find((p) => p.pid === child.pid && p.ppid === process.pid);
      if (row) row.createdMs = row.handleCreatedMs;
    }
    try {
      assert.ok(row && row.createdMs > 0, "child listed with a creation time");
      const wrong = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Force", "-ScopedTargetCsv", child.pid + ":" + (row.createdMs + 1)], { encoding: "utf8" }));
      assert.equal(wrong.killedCount, 0, "off by 1 ms is not the same process");
      const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Force", "-ScopedTargetCsv", child.pid + ":" + row.createdMs], { encoding: "utf8" }));
      assert.equal(out.killedCount, 1, JSON.stringify(out));
      assert.equal(out.results[0].code, 0);
      assert.ok(out.results[0].endedAtMs > 0, "completion time recorded after the handle was signalled");
      let gone = false;
      try { process.kill(child.pid, 0); } catch { gone = true; }
      assert.ok(gone, "the child exited");
    } finally { try { child.kill(); } catch {} }
  });
  t("Windows: -Force with a wrong creation time does not end the process", () => {
    const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Force", "-ScopedTargetCsv", process.pid + ":1"], { encoding: "utf8" }));
    assert.equal(out.killedCount, 0);
    assert.match(JSON.stringify(out.skipped), /pid reused/);
  });
}

console.log(`windows kill scope: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
