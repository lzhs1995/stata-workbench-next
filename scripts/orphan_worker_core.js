"use strict";
// codex patch rc.7.89 (V3-W2, reworked V3-W3 after Codex review R2-R4): end this
// session's old Stata worker after a force reset (macOS / Linux). The worker is a
// multiprocessing spawn child of the mcp-stata server; a force reset ends only the
// server, and a server that does not reach a normal exit leaves the worker
// reparented to launchd (ppid 1), still holding this session's files.
// Ownership comes only from the registered backend: its pid, its registration
// time and this extension host as its parent are checked in ONE ps snapshot that
// also contains every descendant found under it (ppid links + creation order),
// the same rules as the rc.7.84 CPU probe. cwd only narrows: it never grants a
// signal. Anything missing, partial, truncated or unreadable is UNKNOWN and is
// reported as unresolved; it is never signalled and never reported as clean.
// Every read, sleep and signal checks one absolute deadline and the reset
// generation; after a timeout or a newer reset no further signal is sent.
// Limits: lstart has 1 s resolution and signals go to a bare pid, so a pid reused
// within the same second, or between the last re-read and kill(), is narrowed,
// not ruled out. Windows ends the whole tree in rc.7.82; not handled here.
const childProcess = require("node:child_process");
const path = require("node:path");

const CORE_VERSION = "rc.7.89-v2";
const MAX_PIDS = 16;
const MAX_DEPTH = 4;
const STEP_TIMEOUT_MS = 4000;
const CAPTURE_BUDGET_MS = 5000;
const REAP_BUDGET_MS = 11000;
const REAP_RACE_MS = 12000;
const TERM_GRACE_MS = 3000;
const KILL_GRACE_MS = 1500;
// Same rule as worker_cpu_progress_core.js: the registered server must have started
// no later than its registration + 5 s, else the pid was reused.
const ROOT_START_TOLERANCE_MS = 5000;
const PRESENT = "PRESENT", ABSENT = "CONFIRMED_ABSENT", UNKNOWN = "UNKNOWN";
const PS_ENV = () => Object.assign({}, process.env, { LC_ALL: "C", LANG: "C" });

// One bounded command: {ok:true, text} or {ok:false, kind}. okCodes: exit codes that
// still mean "the command ran" (pgrep / ps / lsof exit 1 when nothing matched).
function run(ctx, file, args, okCodes) {
  const left = Math.min(STEP_TIMEOUT_MS, ctx.deadline - ctx.now());
  return new Promise((resolve) => {
    if (!(left > 0)) return resolve({ ok: false, kind: "budget" });
    try {
      ctx.execFile(file, args, { timeout: left, maxBuffer: 1 << 20, env: PS_ENV() }, (err, stdout) => {
        if (err && !(okCodes && okCodes.includes(err.code))) {
          return resolve({ ok: false, kind: err.killed || err.signal ? "timeout" : (typeof err.code === "string" ? "spawn" : "exit") });
        }
        resolve({ ok: true, text: String(stdout || ""), code: err ? err.code : 0 });
      });
    } catch { resolve({ ok: false, kind: "spawn" }); }
  });
}
// `ps -o pid=,ppid=,lstart=` rows -> Map pid -> {pid, ppid, lstart, startMs}; null when
// any non-empty line does not parse or a pid repeats (a partial read is not a read).
function parsePs(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(line);
    if (!m || out.has(Number(m[1]))) return null;
    const lstart = m[3].replace(/\s+/g, " "), startMs = Date.parse(lstart);
    if (!Number.isFinite(startMs)) return null;
    out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), lstart, startMs });
  }
  return out;
}

// `lsof -a -p <list> -d cwd -Fpn` -> Map pid -> cwd
function parseCwd(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("p") && /^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid != null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

function inside(dir, p) {
  if (!dir || !p) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

// kill(pid, 0): ESRCH = confirmed absent, success / EPERM = present, anything else unknown.
function probePresence(kill, pid) {
  try { kill(pid, 0); return PRESENT; } catch (e) {
    if (e && e.code === "ESRCH") return ABSENT;
    if (e && e.code === "EPERM") return PRESENT;
    return UNKNOWN;
  }
}

function makeCtx(opts = {}, budgetMs) {
  const now = opts.now || Date.now;
  const kill = opts.kill || ((pid, sig) => process.kill(pid, sig));
  return {
    execFile: opts.execFile || childProcess.execFile, kill, now,
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    probe: opts.probe || ((pid) => probePresence(kill, pid)),
    deadline: now() + (opts.budgetMs == null ? budgetMs : opts.budgetMs),
    cancel: opts.cancel || { stopped: false, why: null },
    isCurrent: opts.isCurrent || (() => true),
    termGraceMs: opts.termGraceMs == null ? TERM_GRACE_MS : opts.termGraceMs,
    killGraceMs: opts.killGraceMs == null ? KILL_GRACE_MS : opts.killGraceMs,
  };
}

// Why this run must stop now (deadline, cancelled, superseded), or null.
function stopReason(ctx) {
  if (ctx.cancel.stopped) return ctx.cancel.why || "reap-cancelled";
  if (!ctx.isCurrent()) return "superseded";
  if (ctx.now() >= ctx.deadline) return "reap-timeout";
  return null;
}
// Re-read one pid: {state: PRESENT, pid, ppid, lstart, startMs, cwd} | {state: ABSENT} |
// {state: UNKNOWN, why}. A failed / timed-out / unparsable read is UNKNOWN, never ABSENT.
async function readNow(pid, ctx) {
  const pres = ctx.probe(pid);
  if (pres === ABSENT) return { state: ABSENT };
  if (pres !== PRESENT) return { state: UNKNOWN, why: "probe" };
  const ps = await run(ctx, "ps", ["-o", "pid=,ppid=,lstart=", "-p", String(pid)], [1]);
  if (!ps.ok) return { state: UNKNOWN, why: "ps:" + ps.kind };
  const rows = parsePs(ps.text);
  if (!rows) return { state: UNKNOWN, why: "ps:parse" };
  if (!rows.has(pid)) return ctx.probe(pid) === ABSENT ? { state: ABSENT } : { state: UNKNOWN, why: "ps:missing" };
  const lsof = await run(ctx, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fpn"], [1]);
  return { state: PRESENT, ...rows.get(pid), cwd: lsof.ok ? (parseCwd(lsof.text).get(pid) || null) : null };
}

// Newest registered backend of this window that is still alive:
// {pid, registeredAtMs, hostPid} or null. Same selection as latestOwnedRoot (rc.7.84).
function latestRoot(owned, isAlive, hostPid) {
  if (!(owned instanceof Map)) return null;
  let best = null;
  for (const [key, entry] of owned) {
    const pid = Number((entry && entry.pid) || key), at = Date.parse((entry && entry.startedAt) || "");
    if (!(pid > 1) || !Number.isFinite(at) || (best && at <= best.registeredAtMs)) continue;
    let alive = false;
    try { alive = !!isAlive(pid); } catch { alive = false; }
    if (alive) best = { pid, registeredAtMs: at, hostPid: Number(hostPid) > 1 ? Number(hostPid) : null };
  }
  return best;
}

// Descendants of the registered backend, verified in one ps snapshot:
// {state: "ok", root: {pid, lstart}, items: [{pid, ppid, lstart, startMs, cwd}]}
// or {state: "unknown", why}. The root must be the registered pid, started no later
// than registration + 5 s and (hostPid known) a direct child of this host; every
// other row hangs off it through ppid links and is not older than its parent.
async function captureDescendants(root, opts = {}) {
  const ctx = opts.ctx || makeCtx(opts, CAPTURE_BUDGET_MS);
  if (!root || !(Number(root.pid) > 1) || !Number.isFinite(root.registeredAtMs)) return { state: "unknown", why: "no-trusted-root" };
  const rootPid = Number(root.pid), found = [];
  let level = [rootPid];
  for (let d = 0; level.length; d++) {
    const out = await run(ctx, "pgrep", ["-P", level.join(",")], [1]);
    if (!out.ok) return { state: "unknown", why: "pgrep:" + out.kind };
    level = out.text.split(/\s+/).filter(Boolean).map(Number).filter((p) => p > 1 && p !== rootPid && !found.includes(p));
    if (!level.length) break;
    if (d >= MAX_DEPTH || found.length + level.length > MAX_PIDS) return { state: "unknown", why: "truncated" };
    found.push(...level);
  }
  const ps = await run(ctx, "ps", ["-o", "pid=,ppid=,lstart=", "-p", [rootPid, ...found].join(",")], [1]);
  if (!ps.ok) return { state: "unknown", why: "ps:" + ps.kind };
  const rows = parsePs(ps.text);
  if (!rows) return { state: "unknown", why: "ps:parse" };
  const top = rows.get(rootPid);
  if (!top) return { state: "unknown", why: "root-missing" };
  if (top.startMs > root.registeredAtMs + ROOT_START_TOLERANCE_MS) return { state: "unknown", why: "root-replaced" };
  if (root.hostPid && top.ppid !== root.hostPid) return { state: "unknown", why: "root-not-host-child" };
  if (rows.size !== found.length + 1 || found.some((p) => !rows.has(p))) return { state: "unknown", why: "discovery-race" };
  const ok = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows.values()) {
      if (ok.has(r.pid) || !ok.has(r.ppid)) continue;
      if (r.startMs < rows.get(r.ppid).startMs) return { state: "unknown", why: "child-older-than-parent" };
      ok.add(r.pid); changed = true;
    }
  }
  if (ok.size !== rows.size) return { state: "unknown", why: "broken-chain" };
  const rootRec = { pid: rootPid, lstart: top.lstart };
  if (!found.length) return { state: "ok", root: rootRec, items: [] };
  const lsof = await run(ctx, "lsof", ["-a", "-p", found.join(","), "-d", "cwd", "-Fpn"], [1]);
  const cwd = lsof.ok ? parseCwd(lsof.text) : new Map();
  return { state: "ok", root: rootRec, items: found.map((p) => ({ ...rows.get(p), cwd: cwd.get(p) || null })) };
}
// One recorded identity against a re-read. `parent` is the re-read of now.ppid (only
// when now.ppid is a recorded identity). Returns {act: "signal"|"ended"|"omit"|
// "unresolved", reason}. cwd can only take a signal away, never grant one.
function judge(before, now, dirs, ids, parent) {
  if (now.state === ABSENT) return { act: "ended", reason: "exited" };
  if (now.state !== PRESENT) return { act: "unresolved", reason: "identity-unknown:" + (now.why || "read") };
  if (now.lstart !== before.lstart) return { act: "ended", reason: "pid-replaced" };
  if (!now.cwd) return { act: "unresolved", reason: "cwd-unreadable" };
  if (before.cwd && now.cwd !== before.cwd) return { act: "unresolved", reason: "cwd-changed" };
  if (!(dirs || []).some((d) => inside(d, now.cwd))) return { act: "unresolved", reason: "cwd-outside-session" };
  if (now.ppid === 1) return { act: "signal", reason: "orphaned" };
  if (!ids.has(now.ppid)) return { act: "unresolved", reason: "reparented-elsewhere" };
  if (!parent || parent.state === UNKNOWN) return { act: "unresolved", reason: "parent-unknown" };
  if (parent.state === PRESENT && parent.lstart === ids.get(now.ppid)) return { act: "signal", reason: "old-tree-child" };
  return { act: "unresolved", reason: "parent-changed" };
}

async function look(before, dirs, ids, ctx) {
  const now = await readNow(before.pid, ctx);
  const parent = now.state === PRESENT && now.ppid > 1 && ids.has(now.ppid) ? await readNow(now.ppid, ctx) : null;
  return judge(before, now, dirs, ids, parent);
}

function row(before, ended, reason) {
  return { pid: before.pid, startedAt: before.lstart || null, ended, unresolved: !ended, reason };
}

// After the transport closed. `state.recs` is filled as the run goes, so a caller
// that gives up at its own deadline can still report every identity not proven
// ended. A captured identity that is gone (or whose pid now names a different
// process) before any signal is omitted: a clean reset gives [].
async function reapOrphans(captured, dirs, opts = {}, state = { recs: [] }) {
  const ctx = opts.ctx || makeCtx(opts, REAP_BUDGET_MS);
  if (!captured || captured.state !== "ok" || !Array.isArray(captured.items)) {
    state.recs = [{ pid: null, startedAt: null, ended: false, unresolved: true,
      reason: "capture-unknown:" + String((captured && captured.why) || "none").slice(0, 40) }];
    return state.recs;
  }
  if (!captured.items.length) { state.recs = []; return state.recs; }
  if (!captured.root) { state.recs = [{ pid: null, startedAt: null, ended: false, unresolved: true, reason: "capture-unknown:no-root" }]; return state.recs; }
  const ids = new Map([[captured.root.pid, captured.root.lstart], ...captured.items.map((i) => [i.pid, i.lstart])]);
  state.recs = captured.items.map((b) => row(b, false, "pending"));
  const kill = (pid, sig) => {
    try { ctx.kill(pid, sig); return "sent"; } catch (e) { return e && e.code === "ESRCH" ? "gone" : "failed"; }
  };
  for (let i = 0; i < captured.items.length; i++) {
    const before = captured.items[i], rec = state.recs[i];
    let why = stopReason(ctx);
    if (why) { rec.reason = why; continue; }
    let v = await look(before, dirs, ids, ctx);
    if (v.act === "ended") { rec.omit = true; continue; }
    if (v.act !== "signal") { rec.reason = v.reason; continue; }
    let steps = [["SIGTERM", "orphaned-sigterm", ctx.termGraceMs], ["SIGKILL", "orphaned-sigkill", ctx.killGraceMs]];
    for (const [sig, label, grace] of steps) {
      // Checked synchronously right before kill(): after a deadline / newer reset, no signal.
      why = stopReason(ctx);
      if (why) { rec.reason = rec.reason === "pending" ? why : rec.reason + "+" + why; break; }
      const k = kill(before.pid, sig);
      if (k === "gone") { rec.ended = true; rec.unresolved = false; rec.reason = label; break; }
      if (k === "failed") { rec.reason = "signal-failed:" + sig; break; }
      rec.reason = label;
      await ctx.sleep(Math.max(0, Math.min(grace, ctx.deadline - ctx.now())));
      v = await look(before, dirs, ids, ctx);
      if (v.act === "ended") { rec.ended = true; rec.unresolved = false; break; }
      if (v.act !== "signal") { rec.reason = label + "+" + v.reason; break; }
      if (sig === "SIGKILL") rec.reason = "survived-sigkill";
    }
  }
  state.recs = state.recs.filter((r) => !r.omit);
  return state.recs;
}
function aliveDefault(p) {
  try { process.kill(p, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

// Bundle entry points (the bundle edit is unchanged). Never throw.
function startCapture(owned, opts = {}) {
  try {
    const root = latestRoot(owned, opts.isAlive || aliveDefault, opts.hostPid == null ? process.pid : opts.hostPid);
    if (!root) return Promise.resolve({ state: "ok", root: null, items: [], why: "no-root" });
    const ctx = makeCtx(opts, CAPTURE_BUDGET_MS);
    return Promise.race([
      captureDescendants(root, { ctx }).catch(() => ({ state: "unknown", why: "capture-threw" })),
      new Promise((r) => setTimeout(() => r({ state: "unknown", why: "capture-timeout" }), opts.raceMs || CAPTURE_BUDGET_MS + 250)),
    ]);
  } catch { return Promise.resolve({ state: "unknown", why: "capture-threw" }); }
}

function summarize(list) {
  const unresolved = list.filter((w) => w.unresolved).length;
  return { clean: unresolved === 0, unresolved };
}

// Older generations' unresolved rows are kept (bounded) when a newer reset publishes,
// and an older reset that finishes late never replaces a newer one's result.
function publish(result, store = globalThis) {
  const cur = store.__codexOrphanReap;
  const g = Number(result.generation), cg = cur ? Number(cur.generation) : NaN;
  if (cur && Number.isFinite(cg) && Number.isFinite(g) && cg > g) {
    const carry = result.orphanWorkers.filter((w) => w.unresolved).map((w) => ({ ...w, generation: g }));
    const merged = { ...cur, orphanWorkers: [...cur.orphanWorkers, ...carry].slice(0, 32) };
    Object.assign(merged, summarize(merged.orphanWorkers));
    return merged;
  }
  if (cur && Number.isFinite(cg) && Number.isFinite(g) && cg < g) {
    const carry = (cur.orphanWorkers || []).filter((w) => w.unresolved).map((w) => ({ ...w, generation: w.generation == null ? cg : w.generation }));
    result.orphanWorkers = [...result.orphanWorkers, ...carry].slice(0, 32);
    Object.assign(result, summarize(result.orphanWorkers));
  }
  return result;
}

async function finishReap(capturePromise, dirs, meta = {}, opts = {}) {
  const gen = meta.generation == null ? null : meta.generation;
  const isCurrent = opts.isCurrent || (() => gen == null || Number(globalThis.__codexResetGeneration) === Number(gen));
  const cancel = { stopped: false, why: null };
  const state = { recs: [] };
  let orphanWorkers, timer;
  try {
    const cap = await capturePromise;
    const ctx = makeCtx({ ...opts, cancel, isCurrent }, REAP_BUDGET_MS);
    const timedOut = new Promise((r) => { timer = setTimeout(() => { cancel.stopped = true; cancel.why = "reap-timeout"; r(null); }, opts.raceMs || REAP_RACE_MS); });
    const done = await Promise.race([reapOrphans(cap, (dirs || []).filter(Boolean), { ctx }, state), timedOut]);
    orphanWorkers = done || state.recs.filter((r) => !r.omit)
      .map((r) => (r.reason === "pending" ? { ...r, reason: "reap-timeout" } : { ...r }));
  } catch {
    cancel.stopped = true; cancel.why = "reap-failed";
    orphanWorkers = state.recs.length ? state.recs.filter((r) => !r.omit).map((r) => ({ ...r, ended: !!r.ended, unresolved: !r.ended }))
      : [{ pid: null, startedAt: null, ended: false, unresolved: true, reason: "reap-failed" }];
  } finally { if (timer) clearTimeout(timer); }
  orphanWorkers = orphanWorkers.map(({ omit, ...w }) => w);
  const result = { at: new Date().toISOString(), version: CORE_VERSION, generation: gen,
    reason: meta.reason == null ? null : String(meta.reason).slice(0, 120), orphanWorkers, ...summarize(orphanWorkers) };
  return publish(result, opts.store || globalThis);
}

module.exports = { CORE_VERSION, PRESENT, ABSENT, UNKNOWN, latestRoot, startCapture, finishReap, publish, parsePs, parseCwd,
  inside, probePresence, makeCtx, stopReason, captureDescendants, readNow, judge, reapOrphans,
  TERM_GRACE_MS, KILL_GRACE_MS, MAX_PIDS, REAP_BUDGET_MS, REAP_RACE_MS, ROOT_START_TOLERANCE_MS };
