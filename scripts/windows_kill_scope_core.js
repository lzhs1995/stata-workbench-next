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

// A listing row's parent/name come from the CIM row; its creation time from a
// handle opened afterwards. They describe the same process only if the CIM row's
// own CreationDate equals the handle's (to the millisecond; CIM keeps
// microseconds). Otherwise the pid was reused in between: the row's identity is
// uncertain and its createdMs is withheld, so it can never become a target.
const IDENTITY_TOLERANCE_MS = 1;
function normalize(proc) {
  const cim = toNumber(proc && proc.cimCreatedMs);
  const handle = toNumber(proc && proc.handleCreatedMs);
  const both = proc && ("cimCreatedMs" in proc || "handleCreatedMs" in proc);
  const uncertain = !!(both && cim != null && handle != null && Math.abs(cim - handle) > IDENTITY_TOLERANCE_MS);
  return {
    pid: toNumber(proc && proc.pid),
    ppid: toNumber(proc && proc.ppid),
    name: String((proc && proc.name) || ""),
    createdMs: both ? (uncertain || cim == null ? null : handle) : toNumber(proc && proc.createdMs),
    identityUncertain: uncertain,
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

  // A row whose CIM ancestry points into the tree but whose handle is another
  // process instance is never selected; it makes the whole result fail closed.
  const uncertainChildren = procs.filter((p) => p.identityUncertain && targets.has(p.ppid) && !targets.has(p.pid))
    .map((p) => ({ pid: p.pid, name: p.name, ppid: p.ppid }));
  if (uncertainChildren.length) {
    reasons.push(`${uncertainChildren.length} process(es) under this window's backend changed identity while being listed (pid ${uncertainChildren.map((p) => p.pid).join(", ")}); nothing was targeted`);
  }

  // A child under the tree whose creation time cannot be read (no handle, or no
  // CIM CreationDate) is neither ended nor ignored: it is reported as unknown,
  // the verifiable rest of the tree is still ended, and the result is not ok.
  const unknownChildren = procs.filter((p) => !p.identityUncertain && p.createdMs == null && targets.has(p.ppid) && !targets.has(p.pid)
    && p.pid !== toNumber(hostPid) && !isProtected(p))
    .map((p) => ({ pid: p.pid, name: p.name, ppid: p.ppid, reason: "creation time could not be read; not ended" }));

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
    uncertainChildren,
    unknownChildren,
    suspectedOrphans,
    census,
  };
}

// Native EndIfSame codes from panic_kill_stata_chain.ps1 -ScopedTargetCsv.
const KILL_CODES = { 0: "ended", 1: "already exited", 2: "creation time changed (pid reused)", 3: "TerminateProcess failed",
  4: "cannot open process", 5: "termination requested but not confirmed within 5 s", 6: "termination requested but the wait failed" };
// The verdict is rebuilt from the raw per-target codes, not from the script's own
// summary: only a signalled handle (0) counts as ended; 1 and 2 mean the target
// is gone or was never ours; 5 and 6 are pending; anything else failed.
function classifyKill(kill) {
  const k = kill || {};
  const out = { killed: [], skipped: [], pending: [], failed: [], unresolved: Array.isArray(k.unresolved) ? k.unresolved : [],
    scanOk: k.scanOk !== false, error: k.error || null };
  if (Array.isArray(k.results)) {
    for (const r of k.results) {
      const item = { pid: toNumber(r.pid), name: r.name || null, code: toNumber(r.code), reason: KILL_CODES[r.code] || "unknown result " + r.code };
      if (r.code === 0) out.killed.push(item);
      else if (r.code === 1 || r.code === 2) out.skipped.push(item);
      else if (r.code === 5 || r.code === 6) out.pending.push(item);
      else out.failed.push(item);
    }
  } else {
    out.killed = Array.isArray(k.killed) ? k.killed : [];
    out.skipped = Array.isArray(k.skipped) ? k.skipped : [];
    out.pending = Array.isArray(k.pending) ? k.pending : [];
    out.failed = Array.isArray(k.failed) ? k.failed.map((f) => ({ ...f, reason: f.reason || f.error })) : [];
  }
  out.complete = k.ok !== false && !out.error && !out.pending.length && !out.failed.length && !out.unresolved.length && out.scanOk;
  return out;
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
  function list() {
    let listing = null;
    try {
      listing = parseJson(deps.execFileSync("powershell.exe", [...base(), "-ListProcesses"], opts));
    } catch (error) {
      listing = parseJson(error && error.stdout);
      if (!listing || !Array.isArray(listing.processes)) listing = { error: String((error && error.message) || error) };
    }
    return listing && Array.isArray(listing.processes) ? listing : { error: String((listing && listing.error) || "invalid output") };
  }
  function recheck(gate) {
    if (deps.platform !== "win32") return gate;
    return recheckGate(gate, list());
  }
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
    if ((selection.unknownChildren || []).length) { result.ok = false; result.unresolved = selection.unknownChildren.slice(); }
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
    const verdict = classifyKill(kill);
    result.ended = verdict.killed;
    result.pending = verdict.pending;
    result.failed = verdict.failed;
    result.unresolved = verdict.unresolved.concat(selection.unknownChildren || []);
    result.scanOk = verdict.scanOk;
    result.ok = selection.ok && verdict.complete && !(selection.unknownChildren || []).length;
    try { deps.log && deps.log(`${source}: ended ${verdict.killed.length} of ${selection.targets.length} process(es) in this window's backend tree; pending ${verdict.pending.length}, failed ${verdict.failed.length}, unresolved ${verdict.unresolved.length}`); } catch {}
    return result;
  }
  return { run, recheck, list };
}

// rc.7.82 review 3 R1: a scoped result that is not ok (pending, failed,
// unresolved, unknown identity, scan failed, fail-closed, or no result at all)
// opens an "unresolved cleanup" gate. Readiness stays closed while it is open.
// A new connection or a passing smoke on the new backend does not close it;
// only a re-check of the original processes does: each item is resolved when
// its pid is gone, or now carries a different creation time ("identity"/"root"
// items), and items with no known creation time only when the pid is gone.
function gateItemsFrom(result, owned) {
  const r = result || {};
  const items = [];
  const add = (x, check, why) => { const pid = toNumber(x && x.pid); if (pid > 1) items.push({ pid, name: (x && x.name) || null, createdMs: toNumber(x && x.createdMs), check, why }); };
  const created = new Map((r.targets || []).map((t) => [t.pid, t.createdMs]));
  for (const x of r.pending || []) add({ ...x, createdMs: created.get(toNumber(x.pid)) }, "identity", x.reason || "termination not confirmed");
  for (const x of r.failed || []) add({ ...x, createdMs: created.get(toNumber(x.pid)) }, "identity", x.reason || "not ended");
  for (const x of r.unresolved || []) add(x, x.createdMs != null ? "identity" : "absent", x.reason || "left behind");
  for (const x of r.uncertainChildren || []) add(x, "absent", "changed identity while being listed");
  for (const x of r.suspectedOrphans || []) add(x, "absent", "left over from an exited backend");
  for (const x of (r.roots || []).filter((y) => y.status === "unverified")) add(x, "absent", "registered but could not be verified");
  if (r.scanOk === false || r.ok == null || (r.failClosed && !items.length) || (!r.ok && !items.length)) {
    for (const root of rootsFromOwned(owned)) items.push({ pid: root.pid, name: null, createdMs: null, startedAtMs: root.startedAtMs, check: "root",
      why: r.scanOk === false ? "the check for processes started during the kill failed" : "no verified cleanup result" });
  }
  const seen = new Set();
  return items.filter((i) => { const k = i.pid + ":" + i.check; if (seen.has(k)) return false; seen.add(k); return true; });
}

function openGate(prev, result, owned, meta = {}) {
  const items = gateItemsFrom(result, owned);
  const keep = prev && Array.isArray(prev.items) ? prev.items : [];
  const merged = keep.concat(items.filter((i) => !keep.some((k) => k.pid === i.pid && k.check === i.check)));
  return { open: merged.length > 0, openedAt: (prev && prev.openedAt) || new Date().toISOString(), source: meta.source || (prev && prev.source) || null,
    items: merged, lastCheck: prev ? prev.lastCheck || null : null };
}

function recheckGate(gate, listing) {
  if (!gate || !gate.open) return gate || null;
  const at = new Date().toISOString();
  if (!listing || !Array.isArray(listing.processes)) return { ...gate, lastCheck: { at, ok: false, error: (listing && listing.error) || "listing failed" } };
  const byPid = new Map(listing.processes.map(normalize).filter((p) => p.pid > 0).map((p) => [p.pid, p]));
  const left = [], cleared = [];
  for (const item of gate.items) {
    const now = byPid.get(item.pid);
    let gone = !now;
    if (now && item.check === "identity" && item.createdMs != null && now.createdMs != null && now.createdMs !== item.createdMs) gone = true;
    if (now && item.check === "root" && item.startedAtMs != null && now.createdMs != null && now.createdMs > item.startedAtMs + ROOT_CLOCK_TOLERANCE_MS) gone = true;
    (gone ? cleared : left).push({ ...item, seen: now ? { name: now.name, createdMs: now.createdMs } : null });
  }
  return { ...gate, open: left.length > 0, items: left, cleared: (gate.cleared || []).concat(cleared), lastCheck: { at, ok: true, left: left.length, cleared: cleared.length } };
}

function gateMessage(gate) {
  if (!gate || !gate.open) return null;
  return "Stata Workbench is not READY: " + gate.items.length + " process(es) of this window's previous backend were not confirmed ended ("
    + gate.items.map((i) => `pid ${i.pid}${i.name ? " " + i.name : ""}: ${i.why}`).join("; ")
    + "). It re-checks them before every recovery smoke; only end one in Task Manager if you know it belongs to this window.";
}

// Text for the warning the KILL command shows when it ended nothing (fail-closed)
// or could not finish. It describes only what actually happened: whether the
// scoped terminator ran, what it ended, and whether the caller disposed this
// window's own transport (options.disposed).
function failClosedMessage(result, options = {}) {
  const r = result || {};
  const fmt = (x, why) => `pid ${x.pid} (${x.name || "?"}${x.ppid != null ? ", parent " + x.ppid : ""}): ${why || x.reason || x.error || "not ended"}`;
  const left = [].concat(
    (r.roots || []).filter((x) => x.status === "unverified").map((x) => fmt(x, "registered by this window but could not be verified")),
    (r.uncertainChildren || []).map((x) => fmt(x, "changed identity while being listed")),
    (r.suspectedOrphans || []).map((x) => fmt(x, "looks left over from this window's exited backend")),
    (r.failed || []).map((x) => fmt(x)),
    (r.pending || []).map((x) => fmt(x)),
    (r.unresolved || []).filter((x) => !(r.unknownChildren || []).some((u) => u.pid === x.pid)).map((x) => fmt(x)),
    (r.unknownChildren || []).map((x) => fmt(x)));
  const why = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join("; ") : (r.kill && r.kill.error) || (r.scanOk === false ? "the check for processes started during the kill failed" : null);
  const ended = Array.isArray(r.ended) ? r.ended.length : 0;
  const head = r.failClosed
    ? "Stata Workbench could not confirm which processes belong to this window's Stata backend, so it did not target any of them."
    : `Stata Workbench ended ${ended} of ${(r.targets || []).length} process(es) of this window's backend and could not confirm the rest.`;
  return head
    + (options.disposed ? " It closed its own connection to the backend process this window started."
      : options.disposeAttempted ? " It tried to close its own connection to the backend process this window started, but could not confirm that it closed (" + (options.disposeError || "no answer in time") + ")." : "")
    + " Other VS Code windows and Stata sessions were not touched."
    + (left.length ? " Not ended: " + left.join("; ") + ". Only end one of these in Task Manager if you know it belongs to this window." : "")
    + (why ? " Details: " + why : "");
}

module.exports = { selectSessionTree, createWindowsKillScope, rootsFromOwned, targetCsv, classifyKill, failClosedMessage, normalize,
  gateItemsFrom, openGate, recheckGate, gateMessage,
  KILL_CODES, PROTECTED, ROOT_CLOCK_TOLERANCE_MS, IDENTITY_TOLERANCE_MS };
