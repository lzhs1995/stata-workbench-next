#!/usr/bin/env node
"use strict";

// PLAN-V3 stage 6 (FIX6 residuals). rc.7.79 kept the warm cache per transport
// and reset generation. mcp-stata 1.26.1 can replace the default worker inside
// one transport (stop_session + create_session); list_sessions then reports a
// new pid / created_at, possibly still "starting". A cached transport now costs
// one bounded read-only list_sessions per run: a worker that is not "running",
// or not the one recorded when the cache was filled, drops the cache and the
// run waits again. A failed probe keeps the old behaviour (the cache stands).
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
var __codexWarmWorker = null, __codexWarmWorkerStats = { checks: 0, drops: 0, lastDrop: null, restarts: 0, lastRestart: null };
const __codexEnsureBackendWarmByGeneration = __codexEnsureBackendWarmBound;
function __codexWarmWorkerSummary() { return { worker: __codexWarmWorker, ...__codexWarmWorkerStats }; }
globalThis.__codexWarmWorkerSummary = __codexWarmWorkerSummary;
async function __codexProbeDefaultWorker() {
  if (!zg?._transport || typeof zg?._callTool !== "function" || !(zg._availableTools?.has?.("list_sessions") === true)) return null;
  let timer = null;
  try {
    const client = await zg._ensureClient();
    const listed = zg._parseToolJson(await Promise.race([zg._callTool(client, "list_sessions", {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker identity probe timed out")), 5000); })]));
    const session = (Array.isArray(listed?.sessions) ? listed.sessions : []).find(item => item?.id === "default");
    return session ? { status: String(session.status || ""), pid: session.pid ?? null, createdAt: session.created_at ?? null } : { status: "missing", pid: null, createdAt: null };
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
async function __codexEnsureBackendWarmWorker(runId, source) {
  const transport = zg?._transport || null;
  if (transport && __codexWarmTransport === transport) {
    __codexWarmWorkerStats.checks++;
    const seen = await __codexProbeDefaultWorker();
    if (seen) {
      const known = __codexWarmWorker && __codexWarmWorker.transport === transport ? __codexWarmWorker : null;
      const changed = seen.status !== "running" ? "status " + seen.status
        : known && known.pid != null && seen.pid != null && known.pid !== seen.pid ? "pid " + known.pid + " -> " + seen.pid
        : known && known.createdAt != null && seen.createdAt != null && known.createdAt !== seen.createdAt ? "created_at changed" : null;
      if (changed) {
        __codexWarmTransport = null;
        __codexWarmWorker = null;
        __codexWarmWorkerStats.drops++;
        __codexWarmWorkerStats.lastDrop = { at: new Date().toISOString(), runId: runId == null ? null : String(runId), reason: changed };
      } else if (!known) __codexWarmWorker = { transport, pid: seen.pid, createdAt: seen.createdAt };
    }
  }
  const result = await __codexEnsureBackendWarmByGeneration(runId, source);
  if (result && result.outcome === "READY" && __codexWarmTransport && __codexWarmTransport === (zg?._transport || null)) {
    const seen = await __codexProbeDefaultWorker();
    __codexWarmWorker = seen && seen.status === "running" ? { transport: __codexWarmTransport, pid: seen.pid, createdAt: seen.createdAt } : null;
  }
  return result;
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
