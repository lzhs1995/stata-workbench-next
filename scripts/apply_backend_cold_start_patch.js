#!/usr/bin/env node
"use strict";

// mcp-stata starts lazily on the first Stata call after activation or reload.
// Windows dev.5 acceptance: a ~62 s cold start ran inside the 60 s pre-run
// snapshot budget and the first run after reload was refused. This patch waits
// for the backend in __codexBeginGraphRun, before graph inventory, snapshot or
// payload, under its own budget. Offline bundle edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.67: backend cold start";
// Inserted after the graph-run entry: the inventory patch owns the text from
// __codexCaptureGraphInventory up to that entry and rejects any added bytes.
const ANCHOR = "async function __codexExportCurrentGraphsForPanel(runId, cwd) {";
const BEGIN_BEFORE = '    if (!runId) return [];\n    __codexSetPostRunBusy(true, String(source || "run") + "-begin", runId);\n';
const BEGIN_AFTER = BEGIN_BEFORE + "    await __codexEnsureBackendStarted(runId, source);\n";
const STATUS_BEFORE = "preRunStageState:(()=>{";
const STATUS_AFTER = 'backendStart:(typeof globalThis.__codexBackendStartSummary==="function"?globalThis.__codexBackendStartSummary():null),' + STATUS_BEFORE;
const HELPER = String.raw`// codex patch rc.7.67: backend cold start is not charged to pre-run stage budgets.
// The snapshot (60 s) and inventory (30 s) guards time Stata work. Starting the
// backend has its own bound: the client's setup timeout plus 120 s for preflight
// and tool listing. A Stop during the wait fails the run before any dispatch.
var __codexBackendStart = null, __codexLastColdBackendStart = null;
function __codexBackendStartSummary() {
  let connected = null;
  try { connected = !!zg._transport; } catch {}
  return { connected, current: __codexBackendStart, lastCold: __codexLastColdBackendStart };
}
globalThis.__codexBackendStartSummary = __codexBackendStartSummary;
async function __codexEnsureBackendStarted(runId, source) {
  if (typeof zg?._ensureClient !== "function") return null;
  let setupSeconds = 180;
  try {
    const env = Number(process.env.STATA_SETUP_TIMEOUT);
    if (Number.isFinite(env) && env > setupSeconds) setupSeconds = env;
  } catch {}
  const timeoutMs = (setupSeconds + 120) * 1000;
  const generation = Number(globalThis.__codexResetGeneration || 0);
  const started = Date.now();
  const state = { runId: String(runId), sourceMode: source || null, cold: !zg._transport,
    startedAt: new Date(started).toISOString(), timeoutMs, outcome: "WAITING",
    elapsedMs: null, completedAt: null, error: null };
  __codexBackendStart = state;
  if (state.cold) __codexLastColdBackendStart = state;
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => zg._ensureClient()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("backend start exceeded " + timeoutMs + " ms"), { __codexBackendTimeout: true })), timeoutMs); }),
    ]);
    state.outcome = "CONNECTED";
  } catch (error) {
    state.outcome = error?.__codexBackendTimeout ? "TIMED_OUT" : "FAILED";
    state.error = String(error?.message || error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  state.elapsedMs = Date.now() - started;
  state.completedAt = new Date().toISOString();
  if (Number(globalThis.__codexResetGeneration || 0) !== generation) {
    state.outcome = "CANCELLED";
    state.error = state.error || "Stop requested while the backend was starting";
  }
  if (state.outcome === "CONNECTED") return state;
  const code = state.outcome === "TIMED_OUT" ? "PRE_RUN_BACKEND_START_TIMEOUT"
    : state.outcome === "CANCELLED" ? "PRE_RUN_BACKEND_START_CANCELLED" : "PRE_RUN_BACKEND_START_FAILED";
  throw Object.assign(new Error(code + ": " + state.error), { code, __codexPreRunTimeout: {
    ok: false, status: state.outcome === "TIMED_OUT" ? 504 : 500, error: code, reasonCode: code,
    preRunStage: "backend-start", runId: state.runId, sourceMode: state.sourceMode,
    payloadDispatched: false, recoveryRequired: false, cold: state.cold,
    timeoutMs, elapsedMs: state.elapsedMs, stageStartedAt: state.startedAt, message: state.error } });
}

`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous backend cold start anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  const anchor = uniqueAt(source, ANCHOR);
  if (source.includes(MARKER)) {
    const start = uniqueAt(source, MARKER);
    if (source.slice(start, anchor) !== HELPER) throw new Error("modified backend cold start helper");
    uniqueAt(source, BEGIN_AFTER);
    uniqueAt(source, STATUS_AFTER);
  } else {
    if (source.includes("__codexEnsureBackendStarted") || source.includes("__codexBackendStartSummary")) {
      throw new Error("partial backend cold start patch");
    }
    uniqueAt(source, BEGIN_BEFORE);
    uniqueAt(source, STATUS_BEFORE);
    source = source.slice(0, anchor) + HELPER + source.slice(anchor);
    source = source.replace(BEGIN_BEFORE, () => BEGIN_AFTER).replace(STATUS_BEFORE, () => STATUS_AFTER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild the sealed dev.5 bundle.
function revertBundle(source) {
  uniqueAt(source, HELPER);
  uniqueAt(source, BEGIN_AFTER);
  uniqueAt(source, STATUS_AFTER);
  return fingerprint.finalize(source.replace(HELPER, () => "").replace(BEGIN_AFTER, () => BEGIN_BEFORE)
    .replace(STATUS_AFTER, () => STATUS_BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, ANCHOR, HELPER, BEGIN_BEFORE, BEGIN_AFTER, STATUS_BEFORE, STATUS_AFTER };
