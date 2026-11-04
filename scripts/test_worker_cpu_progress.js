#!/usr/bin/env node
"use strict";
// rc.7.84: worker CPU time as watchdog progress. Decisions run on an injected
// monotonic virtual clock (production intervals: poll 3 s, sample 10 s, idle 60 s),
// so timing assertions are exact and not load-sensitive. Fake CPU samples, fake
// execFile process tables, in-memory mutants. No Stata, no real process is touched.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./worker_cpu_progress_core");
const patch = require("./apply_worker_cpu_progress_patch");
const GUARD_SRC = fs.readFileSync(path.join(__dirname, "execution_guard.js"), "utf8");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const flush = () => new Promise((r) => setImmediate(r));

function vclock() {
  let t = 0;
  const timers = [];
  const at = (ms, fn) => { timers.push({ t: t + ms, fn }); timers.sort((a, b) => a.t - b.t); };
  return {
    now: () => t,
    delay: (ms) => new Promise((r) => at(ms, r)),
    sleep: async (ms) => {
      const end = t + ms;
      while (timers.length && timers[0].t <= end) { const x = timers.shift(); t = x.t; x.fn(); await flush(); }
      t = end; await flush();
    },
  };
}

const IDLE = 60000, POLL = 3000;
// One log line at t=0, silent afterwards; work resolves after workMs virtual ms.
async function run(G, workMs, extra) {
  const vc = vclock();
  const opts = Object.assign({ preLogMs: 120000, idleMs: IDLE, pollMs: POLL, now: vc.now, sleep: vc.sleep,
    probe: () => ({ logPath: "/l", logBytes: 10 }), cancelRun: () => true,
    cancelDeadlineMs: 30, drainDeadlineMs: 30 }, typeof extra === "function" ? extra(vc) : extra);
  const r = await G.guardProgress(() => vc.delay(workMs).then(() => "done"), opts);
  return { r, ms: r.state.elapsedMs };
}
const KEY = "10@1,7@2";
// CPU grows at `rate` ms per virtual ms; the sample is ready `lag` virtual ms after the call.
const cpuAt = (vc, rate, lag = 200, key = KEY) => () => vc.delay(lag).then(() => ({ cpuMs: vc.now() * rate, pids: [7], key }));

async function guardCases(G) {
  const res = {}, log = [];
  res.busy = await run(G, 200000, (vc) => ({ cpuProbe: cpuAt(vc, 1), log: (m) => log.push(m) }));
  res.busy.log = log;
  res.hung = await run(G, 400000, (vc) => ({ cpuProbe: cpuAt(vc, 0) }));
  res.none = await run(G, 400000, {});
  res.throws = await run(G, 400000, { cpuProbe: () => { throw new Error("x"); } });
  res.rejects = await run(G, 400000, { cpuProbe: () => Promise.reject(new Error("x")) });
  res.nulls = await run(G, 400000, { cpuProbe: async () => null });
  res.hangs = await run(G, 400000, { cpuProbe: () => new Promise(() => {}) });
  let k = 0;
  res.keyflip = await run(G, 400000, (vc) => ({ cpuProbe: () => vc.delay(200).then(() => ({ cpuMs: vc.now(), pids: [7], key: "10@1,7@" + (k++) })) }));
  res.trickle = await run(G, 400000, (vc) => ({ cpuProbe: cpuAt(vc, 0.01) }));
  res.budget = await run(G, 400000, (vc) => ({ cpuProbe: cpuAt(vc, 1), hardBudgetMs: 30000 }));
  res.cap = await run(G, 400000, (vc) => ({ cpuProbe: cpuAt(vc, 1), cpuMaxSilentMs: 90000 }));
  let calls = 0;
  res.long = await run(G, 400000, (vc) => ({ structuralLong: true, cpuProbe: () => { calls++; return cpuAt(vc, 1)(); } }));
  res.long.calls = calls;
  // R2a: every sample resolves after its deadline but before the next poll
  res.late = await run(G, 400000, (vc) => ({ pollMs: 15000, cpuSampleMs: 10000, cpuTimeoutMs: 1000, cpuProbe: cpuAt(vc, 1, 2000) }));
  // R2b: an old timed-out request (huge counter, same key) resolves after its replacement
  let n = 0;
  res.stale = await run(G, 400000, (vc) => ({ cpuTimeoutMs: 4000, cpuProbe: () => {
    const first = n++ === 0;
    return vc.delay(first ? 20000 : 200).then(() => ({ cpuMs: first ? 1e9 : 0, pids: [7], key: KEY }));
  } }));
  // worker computes until 30 s then freezes (SIGSTOP): cancel = last sample known busy (24 s) + idle
  res.freeze = await run(G, 400000, (vc) => ({ cpuProbe: () => vc.delay(200).then(() => ({ cpuMs: Math.min(vc.now(), 30000), pids: [7], key: KEY })) }));
  res.prelogCalls = 0;
  res.prelog = await run(G, 400000, (vc) => ({ probe: () => ({}), cpuProbe: () => { res.prelogCalls++; return cpuAt(vc, 1)(); } }));
  return res;
}

function assertGuard(G, res) {
  const IDLE_ = G.STALL.IDLE;
  ok(res.busy.r.ok === true && res.busy.r.cause === G.CAUSE.COMPLETED && res.busy.ms === 201000, "busy worker: 200 s silent run completes");
  ok(res.busy.r.state.cpuProgressCount > 0 && res.busy.r.state.cpuSamplesExpired === 0, "busy worker: CPU progress, nothing expired");
  ok(res.busy.log.some((m) => /worker CPU progress while log silent/.test(m)) &&
     res.busy.log.some((m) => /worker CPU summary .*probe=none/.test(m)), "busy: CPU lines logged (numbers only)");
  ok(res.busy.log.every((m) => !/\/|\\/.test(m)), "busy: CPU log lines carry no paths");
  // log-only schedule with poll 3 s: last log at 0, IDLE at the first poll >= 60 s
  for (const name of ["hung", "none", "throws", "rejects", "nulls", "hangs", "keyflip", "trickle", "stale"]) {
    const x = res[name];
    ok(x.r.ok === false && x.r.state.stallReason === IDLE_, name + ": cancelled as IDLE");
    ok(x.ms === 60000, name + ": cancelled exactly on the log-only schedule (" + x.ms + ")");
    ok(!x.r.state.cpuProgressCount, name + ": no CPU credit");
  }
  ok(res.hung.r.state.cpuSamples >= 3, "hung: CPU was actually sampled");
  ok(res.hangs.r.state.cpuSampleErrors >= 1, "hangs: stuck sample abandoned");
  ok(res.stale.r.state.cpuSampleErrors >= 1 && res.stale.r.state.cpuSamples >= 2, "stale: old request timed out, replacements observed");
  ok(res.late.r.state.stallReason === IDLE_ && res.late.ms === 60000, "R2: samples past their deadline give no credit (" + res.late.ms + ")");
  ok(!res.late.r.state.cpuProgressCount && res.late.r.state.cpuSamplesExpired >= 2, "R2: expired samples counted, never credited");
  ok(res.freeze.r.state.stallReason === IDLE_ && res.freeze.ms === 84000, "freeze: cancelled one idle window after the last sample known busy (" + res.freeze.ms + ")");
  ok(res.budget.r.state.stallReason === G.STALL.HARD_BUDGET && res.budget.ms === 30000, "HARD_BUDGET unchanged");
  ok(res.cap.r.state.stallReason === IDLE_ && res.cap.ms === 90000, "cap: CPU stops counting at maxSilent (" + res.cap.ms + ")");
  ok(res.long.r.state.stallReason === IDLE_ && res.long.calls === 0, "structural long: no CPU sampling at all");
  ok(res.prelog.r.state.stallReason === G.STALL.PRE_LOG && res.prelog.ms === 120000 && res.prelogCalls === 0, "PRE_LOG unchanged, no sampling");
  const pub = G.publicSummary(res.busy.r.state);
  ok(pub.cpuProgressCount > 0 && typeof pub.lastCpuProgressAt === "string" && pub.cpuSamplesExpired === 0, "publicSummary has CPU fields");
}

function trackerCases(G) {
  const t = G.cpuProgressTracker(200, 0.02);
  ok(t.observe({ cpuMs: 0, pids: [5], key: "1@1,5@2" }, 0).reason === "baseline", "first sample is a baseline");
  ok(t.observe({ cpuMs: 150, pids: [5], key: "1@1,5@2" }, 10000).progress === false, "150 ms in 10 s < 200 ms floor");
  const r = t.observe({ cpuMs: 500, pids: [5], key: "1@1,5@2" }, 20000);
  ok(r.progress === true && r.creditAt === 10000, "350 ms in 10 s counts, credited at the earlier sample");
  ok(t.observe({ cpuMs: 400, pids: [5], key: "1@1,5@2" }, 30000).reason === "negative-delta", "negative delta resets");
  ok(t.observe({ cpuMs: 90000, pids: [5], key: "1@1,5@99" }, 40000).reason === "baseline", "same pid, new worker identity: baseline, no credit");
  ok(t.observe({ cpuMs: 99000, pids: [5], key: "2@3,5@99" }, 50000).reason === "baseline", "root replaced: baseline, no credit");
  ok(t.observe(null, 60000).reason === "no-sample", "null resets");
  ok(t.observe({ cpuMs: 99900, pids: [5], key: "2@3,5@99" }, 70000).reason === "baseline", "after null: baseline again, no credit");
  const big = G.cpuProgressTracker(200, 0.02);
  big.observe({ cpuMs: 0, pids: [1], key: "a" }, 0);
  ok(big.observe({ cpuMs: 1500, pids: [1], key: "a" }, 100000).progress === false, "share: 1.5 s in 100 s < 2 %");
}

// Fake execFile over a process table {pid, ppid, time, start(ms)}. `snap` (optional)
// is the table the final ps sees, to model a pid that exits and is reused between
// discovery (pgrep) and the snapshot (ps).
// Real `LC_ALL=C ps -o lstart=` layout: "Wed Nov  4 15:22:23 2026" (local time).
const LST = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  const [wd, mo] = [d.toDateString().slice(0, 3), d.toDateString().slice(4, 7)];
  return `${wd} ${mo} ${String(d.getDate()).padStart(2, " ")} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`; };
function fakeExec(table, opts = {}) {
  const calls = [];
  const fn = (file, args, o, cb) => {
    calls.push([file, args.join(" "), o.timeout, o.env && o.env.LC_ALL]);
    if (opts.fail) return cb(Object.assign(new Error("boom"), { code: 2 }), "");
    if (file === "pgrep") {
      const kids = table.filter((r) => args[1].split(",").map(Number).includes(r.ppid)).map((r) => r.pid);
      return kids.length ? cb(null, kids.join("\n") + "\n") : cb(Object.assign(new Error("none"), { code: 1 }), "");
    }
    if (file === "ps") {
      const want = args[args.length - 1].split(",").map(Number);
      const rows = (opts.snap || table).filter((r) => want.includes(r.pid));
      return cb(null, rows.map((r) => `${r.pid} ${r.ppid} ${r.time} ${LST(r.start)}`).join("\n") + "\n");
    }
    if (file === "powershell.exe") return cb(null, opts.ps || "");
    cb(new Error("unexpected " + file), "");
  };
  return { fn, calls };
}

async function probeCases() {
  ok(core.parseCpuTime("0:01.23") === 1230 && core.parseCpuTime("2-01:02:03") === 176523000, "parseCpuTime formats");
  ok(core.parseCpuTime("1:60") === null && core.parseCpuTime("") === null, "parseCpuTime rejects junk");
  const T0 = Math.floor(Date.now() / 1000) * 1000 - 600000;   // whole seconds, like lstart
  const host = 5, root = { pid: 10, registeredAtMs: T0 + 2000, hostPid: host };
  const good = [{ pid: 10, ppid: host, time: "0:05.00", start: T0 }, { pid: 30, ppid: 10, time: "1:02.50", start: T0 + 3000 },
    { pid: 31, ppid: 10, time: "0:00.10", start: T0 + 3000 }, { pid: 99, ppid: 1, time: "9:00.00", start: T0 }];
  const mac = (tbl, o, r = root) => { const fx = fakeExec(tbl, o); return core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fx.fn, getRoot: () => r })().then((s) => ({ s, fx })); };
  let { s, fx } = await mac(good);
  ok(s && s.cpuMs === 62600 && s.pids.join() === "30,31" && s.rootPid === 10 && s.probe === core.PROBE_VERSION, "mac: verified leaves of own tree");
  ok(s.key === `10@${T0},30@${T0 + 3000},31@${T0 + 3000}`, "mac: key = root + leaf identities");
  ok(!fx.calls.some((c) => / 99\b|,99\b/.test(c[1])) && fx.calls.every((c) => c[2] > 0), "mac: no foreign pid, every call bounded");
  ok(fx.calls.filter((c) => c[0] === "ps").length === 1 && fx.calls.find((c) => c[0] === "ps")[3] === "C", "mac: one ps snapshot, C locale");
  // R1 cases (codex): final parent mismatch, root replacement, host mismatch, foreign reuse, partial, truncation
  ({ s } = await mac(good, { snap: good.map((r) => r.pid === 30 ? { ...r, ppid: 999, time: "1:00.00" } : r) }));
  ok(s === null, "R1: pgrep saw 30 under 10, ps says ppid 999 -> null");
  ({ s } = await mac(good, { snap: good.map((r) => r.pid === 30 ? { ...r, ppid: 30 } : r) }));
  ok(s === null, "R1: ppid points inside the snapshot but not reachable from the root -> null");
  ({ s } = await mac(good.map((r) => r.pid === 10 ? { ...r, start: T0 + 60000 } : r)));
  ok(s === null, "R1: root started after registration (+5 s) = replaced root -> null");
  ({ s } = await mac(good, {}, { ...root, hostPid: 6 }));
  ok(s === null, "R1: root is not a child of this extension host -> null");
  ({ s } = await mac(good, { snap: good.map((r) => r.pid === 30 ? { ...r, start: T0 - 100000 } : r) }));
  ok(s === null, "R1: foreign process older than our root reusing pid 30 -> null");
  ({ s } = await mac(good, { snap: good.filter((r) => r.pid !== 31) }));
  ok(s === null, "R1: discovered pid missing from the snapshot (partial) -> null");
  const wide = [good[0], ...Array.from({ length: 17 }, (_, i) => ({ pid: 100 + i, ppid: 10, time: "0:01.00", start: T0 + 3000 }))];
  ({ s } = await mac(wide));
  ok(s === null, "R1: more than 16 descendants (truncated topology) -> null");
  const deep = [good[0], ...Array.from({ length: 6 }, (_, i) => ({ pid: 200 + i, ppid: i ? 199 + i : 10, time: "0:01.00", start: T0 + 3000 + i }))];
  ({ s } = await mac(deep));
  ok(s === null, "R1: deeper than 4 levels (truncated topology) -> null");
  ({ s } = await mac(good, { fail: true }));
  ok(s === null, "mac: ps failure -> null");
  ok(await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: fakeExec(good).fn, getRoot: () => null })() === null, "no root -> null");
  ok(await core.createOwnedTreeCpuProbe({ platform: "darwin", execFile: () => { throw new Error("spawn"); }, getRoot: () => root })() === null, "execFile throws -> null");
  ok(core.parseUnixRows("10 5 0:01.00 garbage\n") === null, "unparsable ps row -> null");
  // same pid, replaced worker with a higher counter: key changes -> tracker baseline (see trackerCases)
  const a = (await mac(good)).s, b = (await mac(good.map((r) => r.pid === 30 ? { ...r, time: "9:59.00", start: T0 + 90000 } : r))).s;
  ok(a && b && a.key !== b.key, "R1: same-pid worker replacement changes the key");
  // Windows: one snapshot, root ppid = host, stale ppid filtered in script, truncation marker
  const winRows = `10 ${host} ${T0} 5000\r\n20 10 ${T0 + 100} 1000\r\n31 20 ${T0 + 3000} 62500\r\n32 20 ${T0 + 3000} 100\r\n`;
  let w = fakeExec([], { ps: winRows });
  s = await core.createOwnedTreeCpuProbe({ platform: "win32", execFile: w.fn, getRoot: () => root })();
  ok(s && s.cpuMs === 62600 && s.pids.join() === "31,32", "win: launcher/server excluded, verified leaves summed");
  ok(w.calls.length === 1 && w.calls[0][0] === "powershell.exe" && w.calls[0][2] === core.DEFAULT_SAMPLE_TIMEOUT_MS_WIN32, "win: one bounded powershell");
  w = fakeExec([], { ps: "T\r\n" + winRows });
  ok(await core.createOwnedTreeCpuProbe({ platform: "win32", execFile: w.fn, getRoot: () => root })() === null, "win: truncated walk -> null");
  w = fakeExec([], { ps: winRows.replace(`10 ${host} `, "10 7 ") });
  ok(await core.createOwnedTreeCpuProbe({ platform: "win32", execFile: w.fn, getRoot: () => root })() === null, "win: root not under host -> null");
  w = fakeExec([], { ps: winRows.replace(`31 20 ${T0 + 3000}`, `31 20 ${T0 - 5000}`) });
  ok(await core.createOwnedTreeCpuProbe({ platform: "win32", execFile: w.fn, getRoot: () => root })() === null, "win: child older than parent -> null");
  const script = core.windowsScript({ pid: 10 });
  ok((script.match(/Get-CimInstance/g) || []).length === 1, "win: a single Win32_Process snapshot (no parent change between queries)");
  ok(/\(Ms \$c\) -lt \(Ms \$q\)/.test(script) && !/CommandLine/.test(script), "win: stale ppid skipped in script, no command lines");
  const now = Date.now();
  const owned = new Map([[10, { pid: 10, startedAt: new Date(now - 9000).toISOString() }],
    [11, { pid: 11, startedAt: new Date(now - 1000).toISOString() }], [12, { pid: 12, startedAt: new Date(now).toISOString() }]]);
  const r = core.latestOwnedRoot(owned, (p) => p !== 12, 4242);
  ok(r && r.pid === 11 && r.hostPid === 4242, "latestOwnedRoot: newest live registered pid, carries hostPid");
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
  ok(dist.includes("},process.pid)});"), "probe root must be a child of this extension host (process.pid)");
}

const GUARD_MUTANTS = [
  ["cap ignored", "&& logIdle < cpuMaxSilentMs\n        && state.lastCpuProgressAt", "\n        && state.lastCpuProgressAt"],
  ["zero delta counts", "return delta >= Math.max(minMs, minShare * wall)", "return delta >= 0"],
  ["key change ignored", "if (!prev || prev.key !== key) return", "if (!prev) return"],
  ["rejection credits progress", "cpu.inflight = null; state.cpuSampleErrors++; cpuTracker.reset();\n    });", "cpu.inflight = null; state.cpuProgressCount++; state.lastCpuProgressAt = at;\n    });"],
  ["budget skipped while CPU busy", "if (hardBudgetMs != null && el >= hardBudgetMs) {", "if (hardBudgetMs != null && el >= hardBudgetMs && !state.cpuProgressCount) {"],
  ["no-sample keeps baseline", "if (!ok) { base = null; return", "if (!ok) { return"],
  ["R2 no deadline in fulfilment", "if (clock() > deadline) { state.cpuSampleErrors++;", "if (false) { state.cpuSampleErrors++;"],
  // "drop the seq check" is equivalent once both handlers enforce the deadline: a request is only
  // replaced after it timed out, so an older seq always resolves past its own deadline. Kept as
  // defence in depth; covered by the "stale" case together with the deadline check.
  ["long tasks sampled", "&& cpuMaxSilentMs > idleMs ? opts.cpuProbe", "? opts.cpuProbe"],
  ["credit at later sample", "state.lastCpuProgressAt = Math.max(state.lastCpuProgressAt || 0, r.creditAt);", "state.lastCpuProgressAt = at;"],
];
const CORE_SRC = fs.readFileSync(path.join(__dirname, "worker_cpu_progress_core.js"), "utf8");
const CORE_MUTANTS = [
  ["R1 ppid not checked", "      if (ok.has(r.pid) || !ok.has(r.ppid)) continue;", "      if (ok.has(r.pid)) continue;"],
  ["R1 child age not checked", "      if (r.startMs < by.get(r.ppid).startMs - slack) return null;\n", ""],
  ["R1 host not checked", "  if (Number(root.hostPid) > 1 && top.ppid !== Number(root.hostPid)) return null;\n", ""],
  ["R1 partial snapshot accepted", "    if (want.size !== by.size - 1 || [...want].some((p) => !by.has(p) || p === top.pid)) return null;\n", ""],
  ["R1 truncation accepted", "  if (truncated || !found.size) return null;", "  if (!found.size) return null;"],
  ["R1 key without identity", "    key: [top.pid + \"@\" + top.startMs, ...leaves.map((r) => r.pid + \"@\" + r.startMs)].join(\",\"),", "    key: leaves.map((r) => r.pid).join(\",\"),"],
];

async function mutantCases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v3w-mut-"));
  const caught = [];
  const saved = checks;
  try {
    for (const [name, from, to] of GUARD_MUTANTS) {
      assert.strictEqual(GUARD_SRC.split(from).length, 2, "mutant anchor unique: " + name);
      const file = path.join(dir, "g_" + name.replace(/\W+/g, "_") + ".js");
      fs.writeFileSync(file, GUARD_SRC.replace(from, () => to));
      const M = require(file);
      let killed = false;
      try { trackerCases(M); assertGuard(M, await guardCases(M)); } catch (e) { killed = true; }
      caught.push([name, killed]);
    }
    for (const [name, from, to] of CORE_MUTANTS) {
      assert.strictEqual(CORE_SRC.split(from).length, 2, "mutant anchor unique: " + name);
      const file = path.join(dir, "c_" + name.replace(/\W+/g, "_") + ".js");
      fs.writeFileSync(file, CORE_SRC.replace(from, () => to));
      const real = core;
      let killed = false;
      try {
        const M = require(file);
        for (const k of Object.keys(real)) core[k] = M[k];
        await probeCases();
      } catch (e) { killed = true; } finally { Object.assign(core, ORIGINAL_CORE); }
      caught.push([name, killed]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); checks = saved; }
  return caught;
}
const ORIGINAL_CORE = Object.assign({}, core);

(async () => {
  const G = require("./execution_guard");
  trackerCases(G);
  assertGuard(G, await guardCases(G));
  await probeCases();
  patchCases();
  const caught = await mutantCases();
  for (const [name, killed] of caught) console.log((killed ? "CAUGHT " : "SURVIVED ") + name);
  ok(caught.every(([, k]) => k), "all mutants caught");
  console.log(`WORKER_CPU_PROGRESS_OK checks=${checks} mutants=${caught.filter(([, k]) => k).length}/${caught.length}`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
