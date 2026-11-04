"use strict";

// rc.7.82: on Windows, Stata: KILL (and a busy force reset) used to run
// panic_kill_stata_chain.ps1 -Force -IncludeStataGui, which picks targets by
// image name: every mcp-stata process and every Stata GUI on the machine, so
// one window's KILL also ended other windows' backends and the user's own
// Stata. This module picks only this extension host's backend tree:
//   root  = a pid in __codexOwnedBackendPids (spawned by this host), accepted
//           only if it is alive, its parent is this host, and it was created no
//           later than the moment the host recorded it (a reused pid is newer);
//   tree  = descendants by ParentProcessId whose creation time is not earlier
//           than their parent's (a stale ParentProcessId points at an older pid).
// Fail-closed is all-or-nothing: if any registered root cannot be tied to this
// host, or a process looks left over from an exited root, nothing is ended and
// the unresolved pids are reported (never "close python.exe"). PowerShell lists
// processes and ends each chosen pid through one handle after checking that
// handle's creation time; the choice itself is made here so it can be tested
// anywhere. Known limit: the host records startedAt after connect, not the
// process creation time, so a root is accepted up to ROOT_CLOCK_TOLERANCE_MS
// after that record (a pid reused inside that window by another child of this
// host would pass); the bridge removes a pid from the registry on exit.

const PROTECTED = new Set(["code.exe", "powershell.exe", "pwsh.exe", "explorer.exe", "copilot.exe",
  "cmd.exe", "windowsterminal.exe", "svchost.exe", "csrss.exe", "wininit.exe",
  "services.exe", "lsass.exe", "system", "idle"]);
// The host records startedAt after the MCP connect returns, so a genuine root
// is created before it; allow for clock rounding between Node and CIM.
const ROOT_CLOCK_TOLERANCE_MS = 1000;

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(proc) {
  return {
    pid: toNumber(proc && proc.pid),
    ppid: toNumber(proc && proc.ppid),
    name: String((proc && proc.name) || ""),
    createdMs: toNumber(proc && proc.createdMs),
    stataish: !!(proc && proc.stataish),
    spawnParent: toNumber(proc && proc.spawnParent),
  };
}

function isProtected(proc) {
  return PROTECTED.has(proc.name.toLowerCase());
}

function rootsFromOwned(owned) {
  const out = [];
  const values = owned instanceof Map ? Array.from(owned.entries()) : [];
  for (const [key, entry] of values) {
    const pid = toNumber(entry && entry.pid != null ? entry.pid : key);
    if (!(pid > 1)) continue;
    const startedAtMs = entry && entry.startedAt ? Date.parse(entry.startedAt) : NaN;
    out.push({ pid, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null });
  }
  return out;
}

// processes: [{pid, ppid, name, createdMs, stataish, spawnParent}]
// roots: [{pid, startedAtMs}]; hostPid: this extension host's pid.
function selectSessionTree({ processes, roots, hostPid }) {
  const procs = (Array.isArray(processes) ? processes : []).map(normalize).filter((p) => p.pid > 0);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const host = byPid.get(toNumber(hostPid)) || null;
  const reasons = [];
  const rootInfo = [];
  const targets = new Map();
  const goneRoots = new Set();

  for (const root of Array.isArray(roots) ? roots : []) {
    const pid = toNumber(root && root.pid);
    const startedAtMs = toNumber(root && root.startedAtMs);
    const proc = byPid.get(pid);
    let status;
    if (!(pid > 1)) continue;
    if (!proc) status = "gone";
    else if (proc.createdMs == null) status = "unverified";
    else if (startedAtMs != null && proc.createdMs > startedAtMs + ROOT_CLOCK_TOLERANCE_MS) status = "reused";
    else if (host && host.createdMs != null && proc.createdMs + ROOT_CLOCK_TOLERANCE_MS < host.createdMs) status = "reused";
    else if (isProtected(proc) || proc.pid === toNumber(hostPid)) status = "unverified";
    else if (startedAtMs == null) status = "unverified";
    else if (proc.ppid !== toNumber(hostPid)) status = "unverified";
    else status = "verified";
    rootInfo.push({ pid, startedAtMs, status, name: proc ? proc.name : null, ppid: proc ? proc.ppid : null });
    if (status === "gone") goneRoots.add(pid);
    if (status === "unverified") reasons.push(`backend pid ${pid} could not be tied to this window (${proc ? "parent " + proc.ppid + ", " + proc.name : "no creation time"})`);
    if (status !== "verified") continue;
    // Breadth-first over children; a child must not predate its parent.
    const queue = [{ proc, depth: 0 }];
    while (queue.length) {
      const { proc: parent, depth } = queue.shift();
      if (targets.has(parent.pid)) continue;
      targets.set(parent.pid, { pid: parent.pid, ppid: parent.ppid, name: parent.name, createdMs: parent.createdMs, depth, rootPid: pid });
      for (const child of procs) {
        if (child.ppid !== parent.pid || targets.has(child.pid) || child.pid === toNumber(hostPid)) continue;
        if (child.createdMs == null || parent.createdMs == null || child.createdMs < parent.createdMs) continue;
        if (isProtected(child)) continue;
        queue.push({ proc: child, depth: depth + 1 });
      }
    }
  }

  const suspectedOrphans = [];
  for (const proc of procs) {
    if (targets.has(proc.pid)) continue;
    if (goneRoots.has(proc.spawnParent) || (goneRoots.has(proc.ppid) && proc.stataish)) {
      suspectedOrphans.push({ pid: proc.pid, name: proc.name, ppid: proc.ppid, spawnParent: proc.spawnParent });
    }
  }
  if (suspectedOrphans.length) {
    reasons.push(`${suspectedOrphans.length} process(es) look left over from this window's exited backend (pid ${suspectedOrphans.map((p) => p.pid).join(", ")}); they were not ended because their parent is gone`);
  }

  const census = procs.filter((p) => p.stataish || targets.has(p.pid) || rootInfo.some((r) => r.pid === p.pid))
    .map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, createdMs: p.createdMs, selected: targets.has(p.pid) }));
  // Root first: once it is gone it cannot start new workers while the rest are ended.
  const ordered = Array.from(targets.values()).sort((a, b) => a.depth - b.depth || a.pid - b.pid);
  const failClosed = reasons.length > 0;
  return {
    ok: !failClosed,
    failClosed,
    scope: "this-session",
    reasons,
    roots: rootInfo,
    nothingOwned: ordered.length === 0 && !failClosed,
    targets: ordered,
    suspectedOrphans,
    census,
  };
}

function targetCsv(targets) {
  return targets.map((t) => `${t.pid}:${t.createdMs}`).join(",");
}

function parseJson(text) {
  try { return JSON.parse(String(text || "").replace(/^\uFEFF/, "")); } catch { return null; }
}

// deps: {execFileSync, scriptPath, platform, hostPid, ownedPids: () => Map, log?}
function createWindowsKillScope(deps) {
  const base = () => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", deps.scriptPath];
  const opts = { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  function run(options = {}) {
    const dryRun = !!options.dryRun;
    const source = String(options.source || "unknown");
    if (deps.platform !== "win32") return { ok: null, skipped: "not-windows", scope: "this-session", source };
    const roots = rootsFromOwned(typeof deps.ownedPids === "function" ? deps.ownedPids() : null);
    let listing = null;
    try {
      listing = parseJson(deps.execFileSync("powershell.exe", [...base(), "-ListProcesses"], opts));
    } catch (error) {
      listing = parseJson(error && error.stdout);
      if (!listing || !Array.isArray(listing.processes)) listing = { error: String((error && error.message) || error) };
    }
    if (!listing || !Array.isArray(listing.processes)) {
      return { ok: false, failClosed: true, scope: "this-session", source, dryRun, roots,
        reasons: ["could not list Windows processes: " + String((listing && listing.error) || "invalid output")],
        targets: [], suspectedOrphans: [], census: [], kill: null };
    }
    const selection = selectSessionTree({ processes: listing.processes, roots, hostPid: deps.hostPid });
    const result = { ...selection, source, dryRun, kill: null };
    // All-or-nothing: a fail-closed selection ends nothing; its targets stay as diagnostics only.
    if (dryRun || selection.failClosed || !selection.targets.length) return result;
    let kill = null;
    try {
      kill = parseJson(deps.execFileSync("powershell.exe", [...base(), "-Force", "-ScopedTargetCsv", targetCsv(selection.targets)], opts));
      if (!kill) kill = { ok: false, error: "invalid kill output" };
    } catch (error) {
      kill = parseJson(error && error.stdout) || {};
      kill.ok = false;
      kill.error = String((error && error.message) || error);
    }
    result.kill = kill;
    result.unresolved = Array.isArray(kill.unresolved) ? kill.unresolved : [];
    result.ok = selection.ok && kill.ok === true && result.unresolved.length === 0;
    try { deps.log && deps.log(`${source}: ended ${(kill.killed || []).length} of ${selection.targets.length} process(es) in this window's backend tree${selection.failClosed ? "; " + selection.reasons.join("; ") : ""}`); } catch {}
    return result;
  }
  return { run };
}

// Text for the warning the KILL command shows when it ended nothing (fail-closed) or left pids behind.
function failClosedMessage(result) {
  const r = result || {};
  const why = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join("; ") : (r.kill && r.kill.error) || "unknown reason";
  const left = [].concat(
    (r.roots || []).filter((x) => x.status === "unverified").map((x) => `pid ${x.pid} (${x.name || "?"}, parent ${x.ppid}): registered by this window but could not be verified`),
    (r.suspectedOrphans || []).map((x) => `pid ${x.pid} (${x.name}, parent ${x.ppid}): looks left over from this window's exited backend`),
    (r.unresolved || []).map((x) => `pid ${x.pid} (${x.name || "?"}): ${x.reason || "not ended"}`));
  const ended = r.kill && Array.isArray(r.kill.killed) ? r.kill.killed.length : 0;
  return (ended ? `Stata Workbench ended ${ended} process(es) of this window's backend, but could not finish the job. `
    : "Stata Workbench could not confirm which processes belong to this window's Stata backend, so it ended none of them; "
      + "it only closed its own connection to the backend process this window started. ")
    + "Other VS Code windows and Stata sessions were not touched. "
    + (left.length ? "Not ended: " + left.join("; ") + ". Only end one of these in Task Manager if you know it belongs to this window. " : "")
    + "Details: " + why;
}

module.exports = { selectSessionTree, createWindowsKillScope, rootsFromOwned, targetCsv, failClosedMessage, PROTECTED, ROOT_CLOCK_TOLERANCE_MS };
