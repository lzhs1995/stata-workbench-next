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
// A child is never accepted if it started before its parent (an old orphan whose
// ppid now names a reused pid). lstart's 1 s resolution only ever turns
// "child after parent" into "equal", never into "child earlier", so no slack is
// needed; a clock that went backwards is rejected too. Same-second pid reuse is
// still beyond lstart precision: this narrows pid reuse, it does not rule it out.
const START_SLACK_MS_UNIX = 0;
const PROBE_VERSION = "rc.7.88-v3";

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


// One snapshot rows = [{pid, ppid, startMs, cpuMs}] -> verified sample or null. "One
// snapshot" is one command's capture, not an atomic freeze of the process table:
// Unix ps only reports the pids pgrep found, so a pid born after discovery is not
// seen, and a discovered pid that exited before ps makes the whole sample null.
// null always means "no credit": the guard keeps its old log-only schedule.
// The root must be the registered pid, started no later than its registration
// (+5 s) and, when hostPid is known, be a direct child of this extension host.
// Every other row must hang off the root through ppid links inside the same
// snapshot and must not be older than its parent (pid reuse / stale ppid).
// Any missing, extra or inconsistent row returns null: no credit, ever.
function verifyTree(rows, root, opts = {}) {
  if (!Array.isArray(rows) || opts.truncated) return null;
  const slack = Number.isFinite(opts.slackMs) ? opts.slackMs : 0;
  const by = new Map();
  for (const r of rows) {
    if (!r || !(r.pid > 1) || !(r.ppid > 0) || !Number.isFinite(r.startMs) || by.has(r.pid)) return null;
    by.set(r.pid, r);
  }
  const top = by.get(Number(root.pid));
  if (!top) return null;
  if (Number.isFinite(root.registeredAtMs) && top.startMs > root.registeredAtMs + ROOT_START_TOLERANCE_MS) return null;
  if (Number(root.hostPid) > 1 && top.ppid !== Number(root.hostPid)) return null;
  if (Array.isArray(opts.expect)) {
    const want = new Set(opts.expect.map(Number));
    if (want.size !== by.size - 1 || [...want].some((p) => !by.has(p) || p === top.pid)) return null;
  }
  const ok = new Set([top.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of by.values()) {
      if (ok.has(r.pid) || !ok.has(r.ppid)) continue;
      if (r.startMs < by.get(r.ppid).startMs - slack) return null;
      ok.add(r.pid); changed = true;
    }
  }
  if (ok.size !== by.size || ok.size < 2) return null;
  const parents = new Set([...by.values()].map((r) => r.ppid));
  const leaves = [...by.values()].filter((r) => r.pid !== top.pid && !parents.has(r.pid))
    .sort((a, b) => a.pid - b.pid);
  if (!leaves.length || leaves.some((r) => !Number.isFinite(r.cpuMs) || r.cpuMs < 0)) return null;
  return {
    cpuMs: leaves.reduce((a, r) => a + r.cpuMs, 0),
    pids: leaves.map((r) => r.pid),
    // Baseline key: root and leaf identities (pid + creation time), not bare pids.
    key: [top.pid + "@" + top.startMs, ...leaves.map((r) => r.pid + "@" + r.startMs)].join(","),
    probe: PROBE_VERSION,
  };
}

// Newest registered backend of this window that is still alive:
// {pid, registeredAtMs, hostPid} or null. `owned` is __codexOwnedBackendPids.
function latestOwnedRoot(owned, isAlive, hostPid) {
  if (!(owned instanceof Map)) return null;
  let best = null;
  for (const [key, entry] of owned) {
    const pid = Number((entry && entry.pid) || key);
    const at = Date.parse((entry && entry.startedAt) || "");
    if (!(pid > 1) || !Number.isFinite(at)) continue;
    if (best && at <= best.registeredAtMs) continue;
    let alive = false;
    try { alive = !!isAlive(pid); } catch { alive = false; }
    if (alive) best = { pid, registeredAtMs: at, hostPid: Number(hostPid) > 1 ? Number(hostPid) : null };
  }
  return best;
}

// rc.7.88：失败时在 why.kind 留一个短标签（命令名 + 超时/退出/启动失败），不含路径与输出
function runText(execFile, file, args, timeoutMs, okCodes, env, why) {
  const fail = (kind) => { if (why) why.kind = file + ":" + kind; return null; };
  return new Promise((resolve) => {
    if (!(timeoutMs > 0)) return resolve(fail("budget"));
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, env },
        (err, stdout) => {
          if (err && !(okCodes && okCodes.includes(err.code))) {
            return resolve(fail(err.killed || err.signal ? "timeout" : (typeof err.code === "string" ? "spawn" : "exit")));
          }
          resolve(String(stdout || ""));
        });
    } catch { resolve(fail("spawn")); }
  });
}

// `ps -o pid=,ppid=,time=,lstart=` (LC_ALL=C): "20 10 1:02.50 Wed Nov  4 15:22:23 2026"
function parseUnixRows(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(line);
    if (!m) { if (line.trim()) return null; continue; }
    const startMs = Date.parse(m[4].replace(/\s+/g, " "));
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: parseCpuTime(m[3]), startMs });
  }
  return rows;
}

// macOS / Linux: pgrep -P discovers our tree level by level, then ONE ps snapshot
// of root + every discovered pid is verified by verifyTree (ppid + lstart).
async function sampleUnix(root, execFile, timeoutMs, now, why = {}) {
  const deadline = now() + timeoutMs, left = () => deadline - now();
  const found = new Set();
  let level = [Number(root.pid)], truncated = false;
  for (let d = 0; level.length; d++) {
    const out = await runText(execFile, "pgrep", ["-P", level.join(",")], left(), [1], undefined, why);
    if (out == null) return null;
    level = out.split(/\s+/).map(Number).filter((p) => p > 1 && p !== Number(root.pid) && !found.has(p));
    if (!level.length) break;
    if (d >= MAX_DEPTH || found.size + level.length > MAX_PIDS) { truncated = true; break; }
    for (const p of level) found.add(p);
  }
  if (truncated || !found.size) { why.kind = truncated ? "truncated" : "no-children"; return null; }
  const env = Object.assign({}, process.env, { LC_ALL: "C", LANG: "C" });
  const ps = await runText(execFile, "ps", ["-o", "pid=,ppid=,time=,lstart=", "-p",
    [Number(root.pid), ...found].join(",")], left(), [1], env, why);
  const rows = ps == null ? null : parseUnixRows(ps);
  if (ps != null && !rows) why.kind = "ps:parse";
  const v = rows ? verifyTree(rows, root, { expect: [...found], slackMs: START_SLACK_MS_UNIX }) : null;
  if (rows && !v) why.kind = "verify";
  return v;
}

// Windows: ONE Win32_Process snapshot (no parent can change between queries),
// walked from the root inside the script. A child created before its parent is a
// stale ParentProcessId and is not ours. Prints "T" when the walk was truncated,
// then "pid ppid createdMs cpuMs" rows (root first). No command lines.
function windowsScript(root) {
  return [
    "$ErrorActionPreference='Stop'",
    `$root=${Number(root.pid)}`,
    "$all=@(Get-CimInstance Win32_Process)",
    "$by=@{};$kids=@{}",
    "foreach($p in $all){$by[[int]$p.ProcessId]=$p;$k=[int]$p.ParentProcessId;if(-not $kids.ContainsKey($k)){$kids[$k]=New-Object System.Collections.ArrayList};[void]$kids[$k].Add($p)}",
    "if(-not $by.ContainsKey($root)){exit 3}",
    "function Ms($p){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}",
    "function Cpu($p){[math]::Round(([double]$p.KernelModeTime+[double]$p.UserModeTime)/10000)}",
    "$r=$by[$root];$out=@(\"$($r.ProcessId) $($r.ParentProcessId) $(Ms $r) $(Cpu $r)\")",
    "$level=@($r);$n=0;$trunc=$false",
    "for($d=0;$level.Count -gt 0;$d++){$next=@()",
    " foreach($q in $level){if(-not $kids.ContainsKey([int]$q.ProcessId)){continue}",
    "  foreach($c in $kids[[int]$q.ProcessId]){if([int]$c.ProcessId -eq [int]$q.ProcessId){continue};if((Ms $c) -lt (Ms $q)){continue}",
    `   if($d -ge ${MAX_DEPTH} -or $n -ge ${MAX_PIDS}){$trunc=$true;continue}`,
    "   $n++;$out+=\"$($c.ProcessId) $($c.ParentProcessId) $(Ms $c) $(Cpu $c)\";$next+=$c}}",
    " $level=$next}",
    "if($trunc){'T'}",
    "$out",
  ].join("\n");
}

function parseWindowsRows(text) {
  const rows = [];
  let truncated = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t === "T") { truncated = true; continue; }
    const f = t.split(/\s+/);
    if (f.length !== 4 || !f.every((x) => /^\d+$/.test(x))) return null;
    rows.push({ pid: Number(f[0]), ppid: Number(f[1]), startMs: Number(f[2]), cpuMs: Number(f[3]) });
  }
  return { rows, truncated };
}

async function sampleWindows(root, execFile, timeoutMs, why = {}) {
  const encoded = Buffer.from(windowsScript(root), "utf16le").toString("base64");
  const out = await runText(execFile, "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], timeoutMs, null, undefined, why);
  const parsed = out == null ? null : parseWindowsRows(out);
  if (out != null && !parsed) why.kind = "ps:parse";
  const v = parsed ? verifyTree(parsed.rows, root, { truncated: parsed.truncated, slackMs: 0 }) : null;
  if (parsed && !v) why.kind = parsed.truncated ? "truncated" : "verify";
  return v;
}

// Returns async () => {cpuMs, pids, key, probe, rootPid} | null. Never throws.
// rc.7.88: after a null, sampleOwnedTreeCpu.lastFailure holds one short label
// (no-root / <cmd>:timeout|exit|spawn|budget / truncated / no-children / ps:parse / verify / threw).
function createOwnedTreeCpuProbe(options = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || childProcess.execFile;
  const now = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs
    : (platform === "win32" ? DEFAULT_SAMPLE_TIMEOUT_MS_WIN32 : DEFAULT_SAMPLE_TIMEOUT_MS);
  const getRoot = typeof options.getRoot === "function" ? options.getRoot : () => null;
  const sampleOwnedTreeCpu = async function sampleOwnedTreeCpu() {
    const why = { kind: null };
    try {
      const root = getRoot();
      if (!root || !(Number(root.pid) > 1)) { sampleOwnedTreeCpu.lastFailure = "no-root"; return null; }
      const sample = platform === "win32" ? await sampleWindows(root, execFile, timeoutMs, why)
        : await sampleUnix(root, execFile, timeoutMs, now, why);
      sampleOwnedTreeCpu.lastFailure = sample ? null : (why.kind || "unknown");
      return sample ? Object.assign(sample, { rootPid: Number(root.pid) }) : null;
    } catch { sampleOwnedTreeCpu.lastFailure = "threw"; return null; }
  };
  sampleOwnedTreeCpu.lastFailure = null;
  return sampleOwnedTreeCpu;
}

module.exports = {
  parseCpuTime, verifyTree, latestOwnedRoot, parseUnixRows, parseWindowsRows,
  windowsScript, createOwnedTreeCpuProbe, PROBE_VERSION,
  DEFAULT_SAMPLE_TIMEOUT_MS, DEFAULT_SAMPLE_TIMEOUT_MS_WIN32, MAX_DEPTH, MAX_PIDS,
  ROOT_START_TOLERANCE_MS, START_SLACK_MS_UNIX,
};
