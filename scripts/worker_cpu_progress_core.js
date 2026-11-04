"use strict";
// codex patch rc.7.84: worker CPU time as a second progress signal for the
// execution watchdog. Stata runs inside the mcp-stata multiprocessing worker
// (pystata), so a command that writes no log for a minute (bootstrap ... nodots)
// still burns worker CPU. The guard asks this module for the CPU time of this
// window's own backend tree; any failure returns null and the guard keeps its
// log-only schedule. Pure Node; no vscode.
const childProcess = require("node:child_process");

const DEFAULT_SAMPLE_TIMEOUT_MS = 4000;
const DEFAULT_SAMPLE_TIMEOUT_MS_WIN32 = 8000;
const MAX_DEPTH = 4;
const MAX_PIDS = 16;
// The root must have started near the moment this window registered it;
// otherwise the pid was reused and its children are not ours.
const ROOT_START_TOLERANCE_MS = 5000;

// ps time / etime: [[dd-]hh:]mm:ss[.cc]  ->  milliseconds, or null.
function parseCpuTime(text) {
  const s = String(text == null ? "" : text).trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const days = Number(m[1] || 0), hours = Number(m[2] || 0);
  const minutes = Number(m[3]), seconds = Number(m[4]);
  if (seconds >= 60 || (m[2] != null && minutes >= 60)) return null;
  const frac = m[5] ? Number("0." + m[5]) : 0;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds + frac) * 1000);
}

// The tracker that compares successive samples lives in execution_guard.js
// (cpuProgressTracker) so the guard module stays self-contained.

// Of the descendants, count only those that are not an ancestor of another
// descendant: the worker (and resource_tracker), never the mcp server or a
// Windows venv launcher, whose own log polling would otherwise look like work.
function leafCpu(rows, rootPid) {
  const parents = new Set(rows.map((r) => r.ppid));
  const leaves = rows.filter((r) => r.pid !== rootPid && !parents.has(r.pid));
  if (!leaves.length || leaves.some((r) => !Number.isFinite(r.cpuMs))) return null;
  return { cpuMs: leaves.reduce((a, r) => a + r.cpuMs, 0),
           pids: leaves.map((r) => r.pid).sort((a, b) => a - b) };
}

// Newest registered backend of this window that is still alive:
// {pid, registeredAtMs} or null. `owned` is __codexOwnedBackendPids.
function latestOwnedRoot(owned, isAlive) {
  if (!(owned instanceof Map)) return null;
  let best = null;
  for (const [key, entry] of owned) {
    const pid = Number((entry && entry.pid) || key);
    const at = Date.parse((entry && entry.startedAt) || "");
    if (!(pid > 1) || !Number.isFinite(at)) continue;
    if (best && at <= best.registeredAtMs) continue;
    let alive = false;
    try { alive = !!isAlive(pid); } catch { alive = false; }
    if (alive) best = { pid, registeredAtMs: at };
  }
  return best;
}

function runText(execFile, file, args, timeoutMs, okCodes) {
  return new Promise((resolve) => {
    if (!(timeoutMs > 0)) return resolve(null);
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err && !(okCodes && okCodes.includes(err.code))) return resolve(null);
          resolve(String(stdout || ""));
        });
    } catch { resolve(null); }
  });
}

function parseRows(text, allowed) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const pid = Number(f[0]), ppid = Number(f[1]);
    const cpuMs = /^\d+$/.test(f[2]) ? Number(f[2]) : parseCpuTime(f[2]);
    if (pid > 1 && ppid > 0 && (!allowed || allowed.has(pid))) rows.push({ pid, ppid, cpuMs });
  }
  return rows;
}

// macOS / Linux: pgrep -P walks only our own tree, then one ps for pid/ppid/time.
async function sampleUnix(root, execFile, timeoutMs, now) {
  const deadline = now() + timeoutMs, left = () => deadline - now();
  const et = await runText(execFile, "ps", ["-o", "etime=", "-p", String(root.pid)], left());
  const etMs = parseCpuTime(et);
  if (etMs == null) return null;
  if (Number.isFinite(root.registeredAtMs) &&
      now() - etMs > root.registeredAtMs + ROOT_START_TOLERANCE_MS) return null; // pid reused
  const found = new Set();
  let level = [root.pid];
  for (let d = 0; d < MAX_DEPTH && level.length && found.size < MAX_PIDS; d++) {
    const out = await runText(execFile, "pgrep", ["-P", level.join(",")], left(), [1]);
    if (out == null) return null;
    level = out.split(/\s+/).map(Number).filter((p) => p > 1 && p !== root.pid && !found.has(p));
    for (const p of level.slice(0, MAX_PIDS - found.size)) found.add(p);
  }
  if (!found.size) return null;
  const ps = await runText(execFile, "ps", ["-o", "pid=,ppid=,time=", "-p", [...found].join(",")], left(), [1]);
  if (ps == null) return null;
  return leafCpu(parseRows(ps, found), root.pid);
}

// Windows: one bounded powershell. Children older than their parent are a stale
// ParentProcessId and are skipped; CPU = KernelModeTime + UserModeTime.
function windowsScript(root) {
  const reg = Number.isFinite(root.registeredAtMs) ? Math.round(root.registeredAtMs) : -1;
  return [
    "$ErrorActionPreference='Stop'",
    `$root=${Number(root.pid)};$reg=${reg};$tol=${ROOT_START_TOLERANCE_MS}`,
    "$r=Get-CimInstance Win32_Process -Filter \"ProcessId=$root\"",
    "if(-not $r){exit 3}",
    "$rc=([DateTimeOffset]$r.CreationDate).ToUnixTimeMilliseconds()",
    "if($reg -ge 0 -and $rc -gt $reg+$tol){exit 4}",
    "$level=@(@{p=$root;c=$rc});$n=0",
    `for($d=0;$d -lt ${MAX_DEPTH} -and $level.Count -gt 0 -and $n -lt ${MAX_PIDS};$d++){$next=@()`,
    " foreach($q in $level){foreach($c in @(Get-CimInstance Win32_Process -Filter \"ParentProcessId=$($q.p)\")){",
    "  $cc=([DateTimeOffset]$c.CreationDate).ToUnixTimeMilliseconds();if($cc -lt $q.c){continue}",
    `  $n++;if($n -gt ${MAX_PIDS}){break}`,
    "  $ms=[math]::Round(([double]$c.KernelModeTime+[double]$c.UserModeTime)/10000)",
    "  \"$($c.ProcessId) $($q.p) $ms\";$next+=@{p=$c.ProcessId;c=$cc}}}",
    " $level=$next}",
  ].join("\n");
}

async function sampleWindows(root, execFile, timeoutMs) {
  const encoded = Buffer.from(windowsScript(root), "utf16le").toString("base64");
  const out = await runText(execFile, "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], timeoutMs);
  if (out == null) return null;
  return leafCpu(parseRows(out, null), root.pid);
}

// Returns async () => {cpuMs, pids, rootPid} | null. Never throws.
function createOwnedTreeCpuProbe(options = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || childProcess.execFile;
  const now = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs
    : (platform === "win32" ? DEFAULT_SAMPLE_TIMEOUT_MS_WIN32 : DEFAULT_SAMPLE_TIMEOUT_MS);
  const getRoot = typeof options.getRoot === "function" ? options.getRoot : () => null;
  return async function sampleOwnedTreeCpu() {
    try {
      const root = getRoot();
      if (!root || !(Number(root.pid) > 1)) return null;
      const sample = platform === "win32" ? await sampleWindows(root, execFile, timeoutMs)
        : await sampleUnix(root, execFile, timeoutMs, now);
      return sample ? Object.assign(sample, { rootPid: Number(root.pid) }) : null;
    } catch { return null; }
  };
}

module.exports = {
  parseCpuTime, leafCpu, latestOwnedRoot, parseRows,
  windowsScript, createOwnedTreeCpuProbe,
  DEFAULT_SAMPLE_TIMEOUT_MS, DEFAULT_SAMPLE_TIMEOUT_MS_WIN32, MAX_DEPTH, MAX_PIDS,
  ROOT_START_TOLERANCE_MS,
};
