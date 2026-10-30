#!/usr/bin/env node
"use strict";

// mcp-stata 1.26.1 answers the MCP handshake before Stata is initialized: the
// server waits at most 30 s for the worker (sessions.py get_or_create_session),
// then serves while the worker still runs a 60 s pre-flight Stata and the
// in-process stata_setup.config. rc.7.67 waited only for the handshake, so the
// first run after reload still paid Stata start-up inside the 60 s snapshot
// guard. Windows rc.7.44: 2 of 7 cold starts refused (504 snapshot timeout;
// 500 after the pre-flight timed out and the session stayed in "error").
// Wait for the default session to report "running" (read-only list_sessions)
// under its own bound, before any snapshot. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.72: backend warm-up waits for Stata, not just the MCP handshake";

const HELPER_ANCHOR = "globalThis.__codexBeginGraphRun = __codexBeginGraphRun;\n";
const CALL_BEFORE = "    await __codexEnsureBackendStarted(runId, source);\n";
const CALL_AFTER = CALL_BEFORE
  + "    if (typeof globalThis.__codexEnsureBackendWarm === \"function\") await globalThis.__codexEnsureBackendWarm(runId, source);\n";
// Before rc.7.67's status entry: its own anchor runs from backendStart into preRunStageState.
const STATUS_BEFORE = 'backendStart:(typeof globalThis.__codexBackendStartSummary==="function"?globalThis.__codexBackendStartSummary():null),';
const STATUS_AFTER = 'backendWarmup:(typeof globalThis.__codexBackendWarmupSummary==="function"?globalThis.__codexBackendWarmupSummary():null),'
  + STATUS_BEFORE;
// Snapshotless soft Stop: while this run's warm-up never saw "running", nothing
// was dispatched and the quiescence probe can only queue behind Stata start-up,
// time out and force a reset (Windows 2026-10-30 13:58Z: reset, then reconnect
// timed out at 30 s and left recovery-required). Skip the probe in that case.
const STOP_BEFORE = '}}else{let __quiescenceCode=';
const STOP_AFTER = '}}else if(typeof globalThis.__codexWarmupSkipsQuiescence==="function"&&globalThis.__codexWarmupSkipsQuiescence(__runId)){'
  + '__restore={ok:true,skipped:"no pre-run dataset snapshot",quiescenceProbe:{skipped:"Stata was still starting; no payload dispatched"}}'
  + STOP_BEFORE.slice(1);
const HELPER = String.raw`
${MARKER}
// One read-only list_sessions probe per poll; the transport that reached
// "running" is not probed again. A dead default worker ("error") is stopped so
// the next run starts a fresh engine; this run is still refused, never retried.
var __codexBackendWarmup = null, __codexWarmTransport = null;
function __codexBackendWarmupSummary() { return __codexBackendWarmup; }
globalThis.__codexBackendWarmupSummary = __codexBackendWarmupSummary;
async function __codexEnsureBackendWarm(runId, source) {
  const transport = zg?._transport || null;
  if (!transport || transport === __codexWarmTransport || typeof zg?._callTool !== "function") return null;
  if (!(zg._availableTools?.has?.("list_sessions") === true)) return null;
  let setupSeconds = 180;
  try {
    const env = Number(process.env.STATA_SETUP_TIMEOUT);
    if (Number.isFinite(env) && env > setupSeconds) setupSeconds = env;
  } catch {}
  // Same bound as rc.7.67 (setup + 120 s), written apart so its tests own their text.
  const timeoutMs = 1000 * (setupSeconds + 120), pollMs = 500;
  const generation = Number(globalThis.__codexResetGeneration || 0);
  const started = Date.now(), deadline = started + timeoutMs;
  const state = { runId: String(runId), sourceMode: source || null, startedAt: new Date(started).toISOString(),
    timeoutMs, outcome: "WAITING", polls: 0, lastStatus: null, elapsedMs: null, completedAt: null,
    error: null, created: false, recovery: null };
  __codexBackendWarmup = state;
  const bounded = (promise, ms) => {
    let timer = null;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("backend warm-up probe exceeded " + ms + " ms")), Math.max(1, ms)); })])
      .finally(() => { if (timer) clearTimeout(timer); });
  };
  const cancelled = () => Number(globalThis.__codexResetGeneration || 0) !== generation;
  let probeErrors = 0;
  try {
    const client = await zg._ensureClient();
    while (state.outcome === "WAITING") {
      if (cancelled()) { state.outcome = "CANCELLED"; state.error = "Stop requested while Stata was starting"; break; }
      if (Date.now() >= deadline) { state.outcome = "TIMED_OUT"; state.error = "Stata did not finish starting in " + timeoutMs + " ms (last status " + state.lastStatus + ")"; break; }
      let status = null;
      try {
        const listed = zg._parseToolJson(await bounded(zg._callTool(client, "list_sessions", {}), Math.min(15000, deadline - Date.now())));
        const session = (Array.isArray(listed?.sessions) ? listed.sessions : []).find(item => item?.id === "default");
        status = session ? String(session.status || "") : "missing";
        probeErrors = 0;
      } catch (error) {
        if (++probeErrors >= 3) { state.outcome = "FAILED"; state.error = "list_sessions failed: " + String(error?.message || error); break; }
      }
      state.polls++;
      if (status) state.lastStatus = status;
      if (status === "running") { state.outcome = "READY"; break; }
      if (status === "error" || status === "stopped") { state.outcome = "FAILED"; state.error = "default Stata session is " + status; break; }
      if (status === "missing" && !state.created && typeof zg._availableTools?.has === "function" && zg._availableTools.has("create_session")) {
        state.created = true;
        try { await bounded(zg._callTool(client, "create_session", { session_id: "default" }), Math.max(1, deadline - Date.now())); } catch {}
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    state.outcome = "FAILED";
    state.error = String(error?.message || error);
  }
  if (state.outcome !== "CANCELLED" && cancelled()) { state.outcome = "CANCELLED"; state.error = state.error || "Stop requested while Stata was starting"; }
  state.elapsedMs = Date.now() - started;
  state.completedAt = new Date().toISOString();
  if (state.outcome === "READY") { __codexWarmTransport = transport; return state; }
  if (state.outcome === "FAILED" && state.lastStatus === "error") {
    try {
      const client = await zg._ensureClient();
      await bounded(zg._callTool(client, "stop_session", { session_id: "default" }), 10000);
      state.recovery = "STOPPED_FAILED_SESSION";
    } catch (error) { state.recovery = "STOP_FAILED: " + String(error?.message || error); }
  }
  const code = state.outcome === "TIMED_OUT" ? "PRE_RUN_BACKEND_WARMUP_TIMEOUT"
    : state.outcome === "CANCELLED" ? "PRE_RUN_BACKEND_WARMUP_CANCELLED" : "PRE_RUN_BACKEND_WARMUP_FAILED";
  throw Object.assign(new Error(code + ": " + state.error), { code, __codexPreRunTimeout: {
    ok: false, status: state.outcome === "TIMED_OUT" ? 504 : state.outcome === "CANCELLED" ? 409 : 500, error: code, reasonCode: code,
    preRunStage: "backend-warmup", runId: state.runId, sourceMode: state.sourceMode,
    payloadDispatched: false, recoveryRequired: false, lastStatus: state.lastStatus, polls: state.polls,
    recovery: state.recovery, timeoutMs, elapsedMs: state.elapsedMs, stageStartedAt: state.startedAt, message: state.error } });
}
globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarm;
// True only while this run's warm-up is waiting or was cancelled before Stata
// reported "running": the run then throws before any payload is dispatched.
function __codexWarmupSkipsQuiescence(runId) {
  const state = __codexBackendWarmup;
  return !!state && runId != null && state.runId === String(runId)
    && (state.outcome === "WAITING" || state.outcome === "CANCELLED") && state.lastStatus !== "running";
}
globalThis.__codexWarmupSkipsQuiescence = __codexWarmupSkipsQuiescence;
`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous backend warm-up anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, HELPER_ANCHOR + HELPER);
    uniqueAt(source, CALL_AFTER);
    uniqueAt(source, STATUS_AFTER);
    uniqueAt(source, STOP_AFTER);
  } else {
    if (source.includes("__codexEnsureBackendWarm") || source.includes("__codexBackendWarmup")
      || source.includes("__codexWarmupSkipsQuiescence")) {
      throw new Error("partial backend warm-up patch");
    }
    uniqueAt(source, HELPER_ANCHOR);
    uniqueAt(source, CALL_BEFORE);
    uniqueAt(source, STATUS_BEFORE);
    uniqueAt(source, STOP_BEFORE);
    source = source.replace(HELPER_ANCHOR, () => HELPER_ANCHOR + HELPER)
      .replace(CALL_BEFORE, () => CALL_AFTER).replace(STATUS_BEFORE, () => STATUS_AFTER)
      .replace(STOP_BEFORE, () => STOP_AFTER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, HELPER_ANCHOR + HELPER);
  uniqueAt(source, CALL_AFTER);
  uniqueAt(source, STATUS_AFTER);
  uniqueAt(source, STOP_AFTER);
  return fingerprint.finalize(source.replace(HELPER_ANCHOR + HELPER, () => HELPER_ANCHOR)
    .replace(CALL_AFTER, () => CALL_BEFORE).replace(STATUS_AFTER, () => STATUS_BEFORE)
    .replace(STOP_AFTER, () => STOP_BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHOR, CALL_BEFORE, CALL_AFTER, STATUS_BEFORE, STATUS_AFTER, STOP_BEFORE, STOP_AFTER };
