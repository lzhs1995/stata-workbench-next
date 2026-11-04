#!/usr/bin/env node
"use strict";

// PLAN-V3 stage 6 (FIX6 residuals). rc.7.79 kept the warm cache per transport
// and reset generation. mcp-stata 1.26.1 can replace the default worker inside
// one transport (stop_session + create_session); list_sessions then reports a
// new pid / created_at, possibly still "starting". A cached transport now costs
// one bounded read-only list_sessions per run (a second warm-up call in the same
// run, e.g. Terminal then BeginGraphRun, reuses it): a worker that is not
// "running", not the one recorded when the cache was filled, or a probe that
// failed or ran past 5 s drops the cache, and the run goes through rc.7.72's
// bounded wait (three failed polls refuse it, nothing dispatched). After READY one
// more probe records the worker; if it is not "running" (or the probe fails), that
// READY is dropped and the run waits once more; a second miss refuses the run
// (PRE_RUN_BACKEND_WARMUP_FAILED, nothing dispatched). Only a positively seen
// worker marks the run confirmed. After every probe the current transport and the
// warm cache must still be the connection the probe used; otherwise its answer is
// treated as a miss. A Stop during any of this refuses it as CANCELLED.
//
// rc.7.79 refused Terminal input when the default worker died while starting
// ("default Stata session is error"). Its text did not match the Terminal
// handler's stopped-session pattern, so kM did not retry. That retry is not
// used here: kM's force reset runs while the run holds the lifecycle (busy) and
// on Windows then runs panic_kill_stata_chain.ps1 -IncludeStataGui, which ends
// every Stata window on the machine. Instead, Terminal input restarts only its
// own default worker once (rc.7.72 already stopped the dead one; warm-up
// creates the next) and waits again. Nothing is dispatched before "running";
// a second failure, a timeout or a Stop is refused as before. Offline bundle
// edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.81: warm cache follows the default worker; Terminal restarts a worker that died while starting";

const HELPER_ANCHOR = "globalThis.__codexTerminalWarmup = __codexTerminalWarmup;\n";
const HELPER = String.raw`
${MARKER}
var __codexWarmWorker = null, __codexWarmWorkerConfirmed = null;
var __codexWarmWorkerStats = { checks: 0, skipped: 0, drops: 0, lastDrop: null, lastProbe: null, restarts: 0, lastRestart: null };
const __codexEnsureBackendWarmByGeneration = __codexEnsureBackendWarmBound;
function __codexWarmWorkerSummary() { return { worker: __codexWarmWorker, ...__codexWarmWorkerStats }; }
globalThis.__codexWarmWorkerSummary = __codexWarmWorkerSummary;
// One read-only list_sessions; 5 s covers the client and the call. Never throws.
// null: this mcp-stata has no list_sessions, so rc.7.72 cannot wait either.
async function __codexProbeDefaultWorker() {
  if (!zg?._transport || typeof zg?._callTool !== "function" || !(zg._availableTools?.has?.("list_sessions") === true)) return null;
  const started = Date.now(), used = zg._transport;
  let timer = null, seen;
  try {
    const call = (async () => zg._parseToolJson(await zg._callTool(await zg._ensureClient(), "list_sessions", {})))();
    call.catch(() => {});
    const listed = await Promise.race([call,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker identity probe timed out after 5000 ms")), 5000); })]);
    const session = (Array.isArray(listed?.sessions) ? listed.sessions : []).find(item => item?.id === "default");
    seen = session ? { ok: true, status: String(session.status || ""), pid: session.pid ?? null, createdAt: session.created_at ?? null }
      : { ok: true, status: "missing", pid: null, createdAt: null };
  } catch (error) { seen = { ok: false, error: String(error?.message || error) }; } finally { if (timer) clearTimeout(timer); }
  // The answer describes the connection the call started on. Callers compare it
  // with the connection and warm cache after the await.
  seen.transport = used;
  __codexWarmWorkerStats.lastProbe = { at: new Date().toISOString(), ms: Date.now() - started, ok: seen.ok };
  return seen;
}
function __codexWarmWorkerCancelled(runId, source, stage, started) {
  const code = "PRE_RUN_BACKEND_WARMUP_CANCELLED", message = "Stop requested while Stata was starting";
  return Object.assign(new Error(code + ": " + message), { code, __codexPreRunTimeout: {
    ok: false, status: 409, error: code, reasonCode: code, preRunStage: "backend-warmup", runId, sourceMode: source || null,
    payloadDispatched: false, recoveryRequired: false, lastStatus: null, polls: 0, recovery: null, timeoutMs: null,
    elapsedMs: Date.now() - started, stageStartedAt: new Date(started).toISOString(), message, cancelledDuring: stage } });
}
function __codexWarmWorkerDrop(runId, reason) {
  __codexWarmTransport = null;
  __codexWarmWorker = null;
  __codexWarmWorkerConfirmed = null;
  __codexWarmWorkerStats.drops++;
  __codexWarmWorkerStats.lastDrop = { at: new Date().toISOString(), runId, reason };
}
// Worker changed twice around READY: refuse before dispatch (not the stopped-session
// text, so kM never force-resets for it).
function __codexWarmWorkerChanged(runId, source, reason, started, lastStatus) {
  const code = "PRE_RUN_BACKEND_WARMUP_FAILED", message = "Stata worker changed while this command waited (" + reason + ")";
  return Object.assign(new Error(code + ": " + message), { code, __codexPreRunTimeout: {
    ok: false, status: 500, error: code, reasonCode: code, preRunStage: "backend-warmup", runId, sourceMode: source || null,
    payloadDispatched: false, recoveryRequired: false, lastStatus, polls: 0, recovery: null, timeoutMs: null,
    elapsedMs: Date.now() - started, stageStartedAt: new Date(started).toISOString(), message, workerChanged: true } });
}
async function __codexEnsureBackendWarmWorker(runId, source) {
  const generation = Number(globalThis.__codexResetGeneration || 0), started = Date.now();
  const id = runId == null ? null : String(runId);
  const stopped = () => Number(globalThis.__codexResetGeneration || 0) !== generation;
  const transport = zg?._transport || null;
  const confirmed = __codexWarmWorkerConfirmed;
  let verified = false;
  if (transport && __codexWarmTransport === transport && id != null && confirmed
    && confirmed.runId === id && confirmed.transport === transport && confirmed.generation === generation) {
    __codexWarmWorkerStats.skipped++;
    return null;
  }
  if (transport && __codexWarmTransport === transport) {
    __codexWarmWorkerStats.checks++;
    const seen = await __codexProbeDefaultWorker();
    if (stopped()) throw __codexWarmWorkerCancelled(id, source, "worker identity probe", started);
    if (seen) {
      const known = __codexWarmWorker && __codexWarmWorker.transport === transport ? __codexWarmWorker : null;
      const changed = seen.transport !== transport || (zg?._transport || null) !== transport || __codexWarmTransport !== transport
        ? "transport changed during the probe"
        : !seen.ok ? "probe failed: " + seen.error
        : seen.status !== "running" ? "status " + seen.status
        : known && known.pid != null && seen.pid != null && known.pid !== seen.pid ? "pid " + known.pid + " -> " + seen.pid
        : known && known.createdAt != null && seen.createdAt != null && known.createdAt !== seen.createdAt ? "created_at changed" : null;
      if (changed) __codexWarmWorkerDrop(id, changed);
      else {
        if (!known) __codexWarmWorker = { transport, pid: seen.pid, createdAt: seen.createdAt };
        verified = true;
      }
    }
  }
  // Old mcp-stata without list_sessions: the probe returns null and rc.7.72 returns
  // null without waiting, so nothing can be verified. The run proceeds as before
  // rc.7.72, never marked confirmed. Every READY below comes from list_sessions.
  for (let attempt = 0; ; attempt++) {
    const result = await __codexEnsureBackendWarmByGeneration(runId, source);
    if (stopped()) throw __codexWarmWorkerCancelled(id, source, "backend warm-up", started);
    const warmed = __codexWarmTransport && __codexWarmTransport === (zg?._transport || null) ? __codexWarmTransport : null;
    if (!(result && result.outcome === "READY")) {
      if (attempt > 0) throw __codexWarmWorkerChanged(id, source, "the worker could not be confirmed after it changed", started, null);
      __codexWarmWorkerConfirmed = verified && warmed && id != null ? { runId: id, transport: warmed, generation } : null;
      return result;
    }
    if (!warmed) {
      __codexWarmWorkerDrop(id, "after READY: transport changed");
      if (attempt > 0) throw __codexWarmWorkerChanged(id, source, "after READY: transport changed", started, null);
      continue;
    }
    const seen = await __codexProbeDefaultWorker();
    if (stopped()) throw __codexWarmWorkerCancelled(id, source, "worker identity record", started);
    const same = !!seen && seen.transport === warmed && (zg?._transport || null) === warmed && __codexWarmTransport === warmed;
    if (same && seen.ok && seen.status === "running") {
      __codexWarmWorker = { transport: warmed, pid: seen.pid, createdAt: seen.createdAt };
      __codexWarmWorkerConfirmed = id != null ? { runId: id, transport: warmed, generation } : null;
      return result;
    }
    // READY was seen, but the worker right after it is starting/missing/error or
    // unknown: that READY no longer describes the worker a payload would reach.
    const why = "after READY: " + (!seen ? "probe unavailable" : !same ? "transport changed during the probe"
      : !seen.ok ? "probe failed: " + seen.error : "status " + seen.status);
    __codexWarmWorkerDrop(id, why);
    if (attempt > 0) throw __codexWarmWorkerChanged(id, source, why, started, seen && seen.ok ? seen.status : null);
  }
}
async function __codexEnsureBackendWarmRestartOnce(runId, source) {
  const generation = Number(globalThis.__codexResetGeneration || 0);
  try {
    return await __codexEnsureBackendWarmWorker(runId, source);
  } catch (error) {
    const refusal = error?.__codexPreRunTimeout;
    if (source !== "terminal-input" || !refusal || refusal.reasonCode !== "PRE_RUN_BACKEND_WARMUP_FAILED"
      || refusal.lastStatus !== "error" || refusal.recovery !== "STOPPED_FAILED_SESSION"
      || Number(globalThis.__codexResetGeneration || 0) !== generation) throw error;
    __codexWarmWorkerStats.restarts++;
    __codexWarmWorkerStats.lastRestart = { at: new Date().toISOString(), runId: runId == null ? null : String(runId), first: refusal.message || null };
    try { if (runId && Gg && Gg.appendStreamingLog) Gg.appendStreamingLog(runId, "\n[Stata Workbench] Stata stopped while loading; starting it once more before running this command...\n"); } catch {}
    try { RI("[Codex terminal-input] default worker failed while starting (" + (refusal.message || "error") + "); restarting it once, nothing dispatched"); } catch {}
    try {
      return await __codexEnsureBackendWarmWorker(runId, source);
    } catch (again) {
      if (again?.__codexPreRunTimeout) again.__codexPreRunTimeout = { ...again.__codexPreRunTimeout, restartedOnce: true, firstFailure: refusal.message || null };
      throw again;
    }
  }
}
globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmRestartOnce;
`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous warm worker identity anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, HELPER_ANCHOR + HELPER);
  } else {
    if (source.includes("__codexWarmWorker") || source.includes("__codexEnsureBackendWarmRestartOnce")) {
      throw new Error("partial warm worker identity patch");
    }
    uniqueAt(source, HELPER_ANCHOR);
    source = source.replace(HELPER_ANCHOR, () => HELPER_ANCHOR + HELPER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, HELPER_ANCHOR + HELPER);
  return fingerprint.finalize(source.replace(HELPER_ANCHOR + HELPER, () => HELPER_ANCHOR)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHOR };
