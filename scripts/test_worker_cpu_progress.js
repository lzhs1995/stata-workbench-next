#!/usr/bin/env node
"use strict";
// rc.7.84: worker CPU time as watchdog progress. Scaled clock (idle 300 ms, poll
// 10 ms, CPU sample 40 ms); fake CPU samples; fake execFile for the tree probe;
// in-memory mutants of execution_guard.js. No Stata, no real processes.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./worker_cpu_progress_core");
const patch = require("./apply_worker_cpu_progress_patch");
const GUARD_SRC = fs.readFileSync(path.join(__dirname, "execution_guard.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const IDLE = 300;
const base = { preLogMs: 5000, idleMs: IDLE, pollMs: 10, cpuSampleMs: 40, cpuTimeoutMs: 120,
  cpuMinMs: 5, cpuMinShare: 0.02, cancelDeadlineMs: 30, drainDeadlineMs: 30 };
// Log line at t=0, silent afterwards.
const logOnce = () => ({ logPath: "/l", logBytes: 10 });
// CPU grows at `rate` ms per wall ms (1 = a full core) on pids [7].
const cpuAt = (rate, t0) => async () => ({ cpuMs: Math.round((Date.now() - t0) * rate), pids: [7] });

async function run(G, workMs, extra) {
  const c = { n: 0 };
  const t0 = Date.now();
  const r = await G.guardProgress(async () => { await sleep(workMs); return "done"; },
    Object.assign({}, base, { probe: logOnce, cancelRun: () => { c.n++; return true; } },
      typeof extra === "function" ? extra(t0) : extra));
  return { r, ms: Date.now() - t0, cancels: c.n };
}

async function guardCases(G) {
  const res = {}, jobs = [];
  const add = (name, p) => jobs.push(p.then((v) => { res[name] = v; }));
  // 1 log silent + CPU growing -> not cancelled
  add("busy", run(G, 700, (t0) => ({ cpuProbe: cpuAt(1, t0) })));
  // 2 both silent -> IDLE on schedule
  add("hung", run(G, 900, (t0) => ({ cpuProbe: cpuAt(0, t0) })));
  // 3 baseline without cpuProbe
  add("none", run(G, 900, {}));
  // 4 probe throws / rejects / null / hangs -> same as baseline
  add("throws", run(G, 900, { cpuProbe: () => { throw new Error("x"); } }));
  add("rejects", run(G, 900, { cpuProbe: () => Promise.reject(new Error("x")) }));
  add("nulls", run(G, 900, { cpuProbe: async () => null }));
  add("hangs", run(G, 900, { cpuProbe: () => new Promise(() => {}) }));
  // 5 pid set changes every sample -> no credit
  let k = 0;
  add("pidflip", run(G, 900, (t0) => ({ cpuProbe: async () => ({ cpuMs: (Date.now() - t0), pids: [100 + (k++)] }) })));
  // 6 CPU below 2 % share -> no credit
  add("trickle", run(G, 900, (t0) => ({ cpuProbe: cpuAt(0.01, t0), cpuMinMs: 0 })));
  // 7 HARD_BUDGET still applies with CPU growing
  add("budget", run(G, 900, (t0) => ({ cpuProbe: cpuAt(1, t0), hardBudgetMs: 200 })));
  // 8 cap: log silent longer than cpuMaxSilentMs -> CPU no longer counts
  add("cap", run(G, 1500, (t0) => ({ cpuProbe: cpuAt(1, t0), cpuMaxSilentMs: 450 })));
  // 9 PRE_LOG untouched: no log ever, CPU growing
  const t9 = Date.now();
  add("prelog", G.guardProgress(async () => { await sleep(600); return "x"; },
    Object.assign({}, base, { preLogMs: 150, probe: () => ({}), cpuProbe: cpuAt(1, t9),
      cancelRun: () => true })).then((r) => ({ r, ms: Date.now() - t9 })));
  await Promise.all(jobs);
  return res;
}

function assertGuard(G, res) {
  ok(res.busy.r.ok === true && res.busy.r.cause === G.CAUSE.COMPLETED, "busy worker: run completes");
  ok(res.busy.r.state.cpuProgressCount > 0, "busy worker: CPU progress recorded");
  for (const name of ["hung", "none", "throws", "rejects", "nulls", "hangs", "pidflip", "trickle"]) {
    const x = res[name];
    ok(x.r.ok === false && x.r.state.stallReason === G.STALL.IDLE, name + ": cancelled as IDLE");
    ok(x.ms < IDLE + 200, name + ": cancelled on the log-only schedule (" + x.ms + " ms)");
    ok(!x.r.state.cpuProgressCount, name + ": no CPU credit");
  }
  ok(res.hung.r.state.cpuSamples >= 2, "hung: CPU was actually sampled");
  ok(res.throws.r.state.cpuSampleErrors >= 1 || res.throws.r.state.cpuSamples >= 1, "throws: counted");
  ok(res.hangs.r.state.cpuSampleErrors >= 1, "hangs: stuck sample abandoned");
  ok(res.budget.r.state.stallReason === G.STALL.HARD_BUDGET && res.budget.ms < 330, "HARD_BUDGET unchanged");
  ok(res.cap.r.ok === false && res.cap.r.state.stallReason === G.STALL.IDLE, "cap: still cancelled");
  ok(res.cap.ms >= 450 && res.cap.ms < 450 + IDLE + 250, "cap: cancelled after maxSilent+idle (" + res.cap.ms + " ms)");
  ok(res.prelog.r.state.stallReason === G.STALL.PRE_LOG && res.prelog.ms < 330, "PRE_LOG unchanged");
  ok(!res.prelog.r.state.cpuSamples, "PRE_LOG: no CPU sampling before the first log line");
  const pub = G.publicSummary(res.busy.r.state);
  ok(pub.cpuProgressCount > 0 && typeof pub.lastCpuProgressAt === "string", "publicSummary has CPU fields");
}

function trackerCases(G) {
  const t = G.cpuProgressTracker(200, 0.02);
  ok(t.observe({ cpuMs: 0, pids: [5] }, 0).reason === "baseline", "first sample is a baseline");
  ok(t.observe({ cpuMs: 150, pids: [5] }, 10000).progress === false, "150 ms in 10 s < 200 ms floor");
  ok(t.observe({ cpuMs: 500, pids: [5] }, 20000).progress === true, "350 ms in 10 s counts");
  ok(t.observe({ cpuMs: 400, pids: [5] }, 30000).reason === "negative-delta", "negative delta resets");
  ok(t.observe({ cpuMs: 9000, pids: [6] }, 40000).reason === "baseline", "pid change resets");
  ok(t.observe(null, 50000).reason === "no-sample", "null resets");
  ok(t.observe({ cpuMs: 9500, pids: [6] }, 60000).reason === "baseline", "after null: baseline again");
  const big = G.cpuProgressTracker(200, 0.02);
  big.observe({ cpuMs: 0, pids: [1] }, 0);
  ok(big.observe({ cpuMs: 1500, pids: [1] }, 100000).progress === false, "share: 1.5 s in 100 s < 2 %");
}

// Fake execFile: answers ps etime / pgrep -P / ps pid,ppid,time from a table.
function fakeExec(tree, opts = {}) {
  const calls = [];
  const fn = (file, args, o, cb) => {
    calls.push([file, args.join(" "), o.timeout]);
    if (opts.fail) return cb(Object.assign(new Error("boom"), { code: 2 }), "");
    if (file === "pgrep") {
      const kids = tree.filter((r) => args[1].split(",").map(Number).includes(r.ppid)).map((r) => r.pid);
      return kids.length ? cb(null, kids.join("\n") + "\n") : cb(Object.assign(new Error("none"), { code: 1 }), "");
    }
    if (args.includes("etime=")) return cb(null, opts.etime || "   01:00\n");
    if (file === "ps") {
      const want = args[args.length - 1].split(",").map(Number);
      return cb(null, tree.filter((r) => want.includes(r.pid)).map((r) => `${r.pid} ${r.ppid} ${r.time}`).join("\n") + "\n");
    }
    if (file === "powershell.exe") return cb(null, opts.ps || "");
    cb(new Error("unexpected " + file), "");
  };
  return { fn, calls };
}

async function probeCases() {
  ok(core.parseCpuTime("0:01.23") === 1230 && core.parseCpuTime("2-01:02:03") === 176523000, "parseCpuTime formats");
  ok(core.parseCpuTime("1:60") === null && core.parseCpuTime("") === null, "parseCpuTime rejects junk");
  const now = Date.now();
  const tree = [{ pid: 20, ppid: 10, time: "0:05.00" }, { pid: 30, ppid: 20, time: "1:02.50" },
    { pid: 31, ppid: 20, time: "0:00.10" }, { pid: 99, ppid: 1, time: "9:00.00" }];
  const root = { pid: 10, registeredAtMs: now - 55000 };
  let fx = fakeExec(tree);
  let s = await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => root })();
  ok(s && s.cpuMs === 62600 && s.pids.join() === "30,31" && s.rootPid === 10, "mac: leaves of own tree only (worker+tracker)");
  ok(!fx.calls.some((c) => c[1].includes("99")) && fx.calls.every((c) => c[2] > 0), "mac: no foreign pid, every call bounded");
  fx = fakeExec(tree, { etime: "   00:05\n" });
  s = await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => root })();
  ok(s === null, "mac: root started after registration (+5 s) = reused pid -> null");
  fx = fakeExec(tree, { fail: true });
  ok(await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => root })() === null, "mac: ps failure -> null");
  ok(await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => null })() === null, "no root -> null");
  const thrower = () => { throw new Error("spawn"); };
  ok(await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: thrower, getRoot: () => root })() === null, "execFile throws -> null");
  fx = fakeExec([{ pid: 20, ppid: 10, time: "0:01.00" }]);
  s = await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => root })();
  ok(s && s.pids.join() === "20", "mac: single child counted");
  fx = fakeExec([], { ps: "21 10 1000\r\n31 21 62500\r\n32 21 100\r\n" });
  s = await core.createOwnedTreeCpuProbe({ platform: "win32", execFile: fx.fn, getRoot: () => root })();
  ok(s && s.cpuMs === 62600 && s.pids.join() === "31,32", "win: launcher/server excluded, leaves summed");
  ok(fx.calls.length === 1 && fx.calls[0][0] === "powershell.exe" && fx.calls[0][2] === core.DEFAULT_SAMPLE_TIMEOUT_MS_WIN32, "win: one bounded powershell");
  const script = core.windowsScript({ pid: 10, registeredAtMs: 123 });
  ok(/ProcessId=\$root/.test(script) && /\$cc -lt \$q\.c/.test(script) && !/CommandLine/.test(script), "win: stale ppid skip, no command lines");
  const owned = new Map([[10, { pid: 10, startedAt: new Date(now - 9000).toISOString() }],
    [11, { pid: 11, startedAt: new Date(now - 1000).toISOString() }], [12, { pid: 12, startedAt: new Date(now).toISOString() }]]);
  const r = core.latestOwnedRoot(owned, (p) => p !== 12);
  ok(r && r.pid === 11, "latestOwnedRoot: newest live registered pid");
  ok(core.latestOwnedRoot(undefined, () => true) === null && core.latestOwnedRoot(new Map(), () => true) === null, "latestOwnedRoot: none");
}

function patchCases() {
  const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
  ok(dist.includes(patch.MARKER), "dist carries the rc.7.84 marker");
  for (const [, after] of patch.EDITS) ok(dist.split(after).length === 2, "each edit present once");
  const reverted = patch.revertBundle(dist);
  ok(!reverted.includes("__codexWorkerCpuProbe") && patch.patchBundle(reverted) === dist, "revert/replay byte-exact");
  ok(patch.patchBundle(dist) === dist, "patch is idempotent");
  assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[1][0], "X")), /anchor/); checks++;
  ok((dist.match(/cpuProbe:\(typeof globalThis\.__codexWorkerCpuProbe===/g) || []).length === 2, "both PROGRESS call sites get the probe");
}

const MUTANTS = [
  ["cap ignored", "&& logIdle < cpuMaxSilentMs\n        && state.lastCpuProgressAt > state.lastProgressAt", "\n        && state.lastCpuProgressAt > state.lastProgressAt"],
  ["zero delta counts", "return delta >= Math.max(minMs, minShare * wall)", "return delta >= 0"],
  ["pid change ignored", "if (!prev || prev.key !== key) return", "if (!prev) return"],
  ["rejection credits progress", "cpu.inflight = null; state.cpuSampleErrors++; cpuTracker.reset();\n    });", "cpu.inflight = null; state.cpuProgressCount++; state.lastCpuProgressAt = at;\n    });"],
  ["budget skipped while CPU busy", "if (hardBudgetMs != null && el >= hardBudgetMs) {", "if (hardBudgetMs != null && el >= hardBudgetMs && !state.cpuProgressCount) {"],
  ["sampling before first log", "    if (state.firstLogAt == null) {\n      if (el >= preLogMs) {", "    if (state.firstLogAt == null) {\n      if (cpuProbe && !cpu.inflight) startCpuSample();\n      if (el >= preLogMs && !state.cpuProgressCount) {"],
  ["no-sample keeps baseline", "if (!ok) { base = null; return", "if (!ok) { return"],
];

async function mutantCases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v3w-mut-"));
  const caught = [];
  try {
    for (const [name, from, to] of MUTANTS) {
      assert.strictEqual(GUARD_SRC.split(from).length, 2, "mutant anchor unique: " + name);
      const file = path.join(dir, name.replace(/\W+/g, "_") + ".js");
      fs.writeFileSync(file, GUARD_SRC.replace(from, () => to));
      const M = require(file);
      let killed = false;
      try { trackerCases(M); assertGuard(M, await guardCases(M)); } catch (e) { killed = true; }
      caught.push([name, killed]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return caught;
}

(async () => {
  const G = require("./execution_guard");
  trackerCases(G);
  assertGuard(G, await guardCases(G));
  await probeCases();
  patchCases();
  const counted = checks;
  const caught = await mutantCases();
  checks = counted;
  for (const [name, killed] of caught) { console.log((killed ? "CAUGHT " : "SURVIVED ") + name); }
  ok(caught.every(([, k]) => k), "all mutants caught");
  console.log(`WORKER_CPU_PROGRESS_OK checks=${checks} mutants=${caught.filter(([, k]) => k).length}/${caught.length}`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
