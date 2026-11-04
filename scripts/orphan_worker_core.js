"use strict";
// codex patch rc.7.89 (V3-W2): end this session's old Stata worker after a force
// reset (macOS / Linux). The worker is a multiprocessing spawn child of the
// mcp-stata server; a force reset ends only the server, and a server that does
// not reach a normal exit leaves the worker reparented to launchd (ppid 1),
// still holding this session's files. Before dispose we record the identity of
// the server's descendants (pid + lstart + cwd); after the transport closed we
// signal only a process whose pid, start time and cwd still match exactly and
// whose cwd is inside this session's own directories. Unknown identity -> no
// signal, report only. Windows ends the whole tree in rc.7.82; not handled here.
const childProcess = require("node:child_process");
const path = require("node:path");

const CORE_VERSION = "rc.7.89-v1";
const MAX_PIDS = 16;
const MAX_DEPTH = 4;
const STEP_TIMEOUT_MS = 4000;
const TERM_GRACE_MS = 3000;
const KILL_GRACE_MS = 1500;

function run(execFile, file, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: Object.assign({}, process.env, { LC_ALL: "C", LANG: "C" }) },
        (err, stdout) => resolve(err && !(err.code === 1) ? null : String(stdout || "")));
    } catch { resolve(null); }
  });
}

// `ps -o pid=,ppid=,lstart=` rows -> Map pid -> {pid, ppid, lstart}
function parsePs(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3].replace(/\s+/g, " ") });
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

// Identities of rootPid's descendants: [{pid, ppid, lstart, cwd, rootLstart}] or null when unreadable.
async function captureDescendants(rootPid, opts = {}) {
  const execFile = opts.execFile || childProcess.execFile;
  const t = opts.stepTimeoutMs || STEP_TIMEOUT_MS;
  if (!(Number(rootPid) > 1)) return null;
  const found = [];
  let level = [Number(rootPid)];
  for (let d = 0; level.length && d < MAX_DEPTH; d++) {
    const out = await run(execFile, "pgrep", ["-P", level.join(",")], t);
    if (out == null) return null;
    level = out.split(/\s+/).map(Number).filter((p) => p > 1 && !found.includes(p));
    for (const p of level) { if (found.length >= MAX_PIDS) return null; found.push(p); }
  }
  if (!found.length) return [];
  const ps = parsePs(await run(execFile, "ps", ["-o", "pid=,ppid=,lstart=", "-p", [Number(rootPid), ...found].join(",")], t));
  const cwd = parseCwd(await run(execFile, "lsof", ["-a", "-p", found.join(","), "-d", "cwd", "-Fpn"], t));
  const rootLstart = ps.has(Number(rootPid)) ? ps.get(Number(rootPid)).lstart : null;
  return found.filter((p) => ps.has(p)).map((p) => ({ ...ps.get(p), cwd: cwd.get(p) || null, rootPid: Number(rootPid), rootLstart }));
}

// Re-read one pid now: {pid, ppid, lstart, cwd} or null (gone / unreadable).
async function readNow(pid, opts) {
  const execFile = opts.execFile || childProcess.execFile;
  const t = opts.stepTimeoutMs || STEP_TIMEOUT_MS;
  const ps = parsePs(await run(execFile, "ps", ["-o", "pid=,ppid=,lstart=", "-p", String(pid)], t));
  if (!ps.has(pid)) return null;
  const cwd = parseCwd(await run(execFile, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fpn"], t));
  return { ...ps.get(pid), cwd: cwd.get(pid) || null };
}

// Decide for one recorded identity whether it may be signalled now. `parentNow`
// is the current {pid, lstart} of now.ppid (null if unreadable): a worker may still
// hang off the old server while that server is shutting down.
function verdict(before, now, dirs, parentNow) {
  if (!before || !before.lstart || !before.cwd) return { signal: false, reason: "identity-unknown" };
  if (!now) return { signal: false, reason: "exited" };
  if (now.lstart !== before.lstart) return { signal: false, reason: "pid-reused" };
  if (!now.cwd || now.cwd !== before.cwd) return { signal: false, reason: "cwd-changed" };
  if (!(dirs || []).some((d) => inside(d, now.cwd))) return { signal: false, reason: "cwd-outside-session" };
  if (now.ppid === 1) return { signal: true, reason: "orphaned" };
  if (now.ppid === before.rootPid && before.rootLstart && parentNow && parentNow.pid === before.rootPid
      && parentNow.lstart === before.rootLstart) return { signal: true, reason: "old-server-child" };
  return { signal: false, reason: "not-orphaned" };
}

// After the transport closed: [{pid, startedAt, ended, reason}] for every recorded
// identity that was still alive (exited ones are omitted, so a clean reset gives []).
async function parentOf(now, opts) {
  if (!now || !(now.ppid > 1)) return null;
  const execFile = opts.execFile || childProcess.execFile;
  const ps = parsePs(await run(execFile, "ps", ["-o", "pid=,ppid=,lstart=", "-p", String(now.ppid)], opts.stepTimeoutMs || STEP_TIMEOUT_MS));
  return ps.get(now.ppid) || null;
}

async function reapOrphans(captured, dirs, opts = {}) {
  const kill = opts.kill || ((pid, sig) => process.kill(pid, sig));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = [];
  if (!Array.isArray(captured)) return [{ pid: null, startedAt: null, ended: false, reason: "identity-unreadable" }];
  for (const before of captured) {
    let now = await readNow(before.pid, opts);
    const v = verdict(before, now, dirs, await parentOf(now, opts));
    if (v.reason === "exited") continue;
    const rec = { pid: before.pid, startedAt: before.lstart || null, ended: false, reason: v.reason };
    if (v.signal) {
      try { kill(before.pid, "SIGTERM"); } catch { /* raced exit */ }
      await sleep(opts.termGraceMs == null ? TERM_GRACE_MS : opts.termGraceMs);
      now = await readNow(before.pid, opts);
      if (now && verdict(before, now, dirs, await parentOf(now, opts)).signal) {
        try { kill(before.pid, "SIGKILL"); } catch { /* raced exit */ }
        await sleep(opts.killGraceMs == null ? KILL_GRACE_MS : opts.killGraceMs);
        now = await readNow(before.pid, opts);
        rec.reason = "orphaned-sigkill";
      } else rec.reason = "orphaned-sigterm";
      rec.ended = !(now && now.lstart === before.lstart);
    }
    out.push(rec);
  }
  return out;
}

// Newest registered backend pid that is still alive (__codexOwnedBackendPids), or null.
function latestRoot(owned, isAlive) {
  if (!(owned instanceof Map)) return null;
  let best = null, bestAt = -Infinity;
  for (const [key, entry] of owned) {
    const pid = Number((entry && entry.pid) || key), at = Date.parse((entry && entry.startedAt) || "");
    if (!(pid > 1) || !Number.isFinite(at) || at <= bestAt) continue;
    let alive = false;
    try { alive = !!isAlive(pid); } catch { alive = false; }
    if (alive) { best = pid; bestAt = at; }
  }
  return best;
}

// Bundle entry points (keep the bundle edit short). Never throw.
function startCapture(owned) {
  try {
    const root = latestRoot(owned, (p) => { try { process.kill(p, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } });
    if (!root) return Promise.resolve([]);
    return Promise.race([captureDescendants(root).catch(() => null), new Promise((r) => setTimeout(() => r(null), 5000))]);
  } catch { return Promise.resolve(null); }
}

async function finishReap(capturePromise, dirs, meta = {}) {
  let orphanWorkers;
  try {
    const cap = await capturePromise;
    orphanWorkers = await Promise.race([reapOrphans(cap, (dirs || []).filter(Boolean)),
      new Promise((r) => setTimeout(() => r([{ pid: null, startedAt: null, ended: false, reason: "reap-timeout" }]), 12000))]);
  } catch { orphanWorkers = [{ pid: null, startedAt: null, ended: false, reason: "reap-failed" }]; }
  return { at: new Date().toISOString(), version: CORE_VERSION, generation: meta.generation == null ? null : meta.generation,
    reason: meta.reason == null ? null : String(meta.reason).slice(0, 120), orphanWorkers };
}

module.exports = { CORE_VERSION, latestRoot, startCapture, finishReap, parsePs, parseCwd, inside, captureDescendants, readNow, verdict, reapOrphans,
  TERM_GRACE_MS, KILL_GRACE_MS, MAX_PIDS };
