#!/usr/bin/env node
"use strict";

// F fix6 (W-P1 entry gap): an agent /run-command waits for the default Stata
// session to report "running" (rc.7.72, via __codexBeginGraphRun) before its
// payload, but Terminal input reached that wait only for graph code. A plain
// `display` started the 120 s PRE_LOG guard and runSelection while the worker
// was still initializing; on Windows (W5 w5f2, 2026-11-03) that first command
// stalled 120 s, was cancelled (504) and fenced the session. Terminal input now
// waits first, outside the payload's PRE_LOG budget, tells the person in the
// Terminal when the wait is visible, and refuses (no dispatch) if Stata never
// becomes ready. The rc.7.72 warm cache was keyed by transport only; it is now
// also tied to the reset generation, so a Stop or reset makes the next run probe
// once more. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.79: Terminal input waits for Stata start-up before its pre-log budget";

const HELPER_ANCHOR = "globalThis.__codexWarmupSkipsQuiescence = __codexWarmupSkipsQuiescence;\n";
const HELPER = String.raw`
${MARKER}
// rc.7.72 cached the transport that reached "running" for the life of that
// transport. A Stop or reset bumps __codexResetGeneration; the next run then
// probes list_sessions once more instead of trusting the old "running".
var __codexWarmGeneration = null, __codexTerminalWarmupState = null;
const __codexEnsureBackendWarmByTransport = __codexEnsureBackendWarm;
async function __codexEnsureBackendWarmBound(runId, source) {
  const generation = Number(globalThis.__codexResetGeneration || 0);
  if (__codexWarmTransport && __codexWarmGeneration !== generation) __codexWarmTransport = null;
  const result = await __codexEnsureBackendWarmByTransport(runId, source);
  if (__codexWarmTransport && __codexWarmTransport === (zg?._transport || null)) __codexWarmGeneration = generation;
  return result;
}
globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmBound;
function __codexTerminalWarmupSummary() { return __codexTerminalWarmupState; }
globalThis.__codexTerminalWarmupSummary = __codexTerminalWarmupSummary;
// Called by Terminal input before it builds its PROGRESS guard. Throws the
// rc.7.67/rc.7.72 pre-run refusal (payloadDispatched=false) on failure.
async function __codexTerminalWarmup(runId, options) {
  const started = Date.now();
  const state = { runId: runId == null ? null : String(runId), startedAt: new Date(started).toISOString(),
    outcome: "WAITING", noticeShown: false, elapsedMs: null, guaranteed: true, note: null, error: null };
  __codexTerminalWarmupState = state;
  const post = (text) => {
    try { if (runId && Gg && Gg.appendStreamingLog) Gg.appendStreamingLog(runId, "\n[Stata Workbench] " + text + "\n"); } catch {}
    try { RI("[Codex terminal-input] " + text); } catch {}
  };
  const tick = () => {
    if (!state.noticeShown && Date.now() - started >= 2000) {
      state.noticeShown = true;
      post("Waiting for Stata to finish loading before running this command...");
    }
    if (state.noticeShown) try { options?.onProgress && options.onProgress(null, null, "Waiting for Stata to finish loading"); } catch {}
  };
  const timer = setInterval(tick, 1000);
  try {
    await __codexEnsureBackendStarted(runId, "terminal-input");
    if (zg?._transport && !(zg._availableTools?.has?.("list_sessions") === true)) {
      state.guaranteed = false;
      state.note = "list_sessions is not available; Stata start-up could not be confirmed";
    }
    if (typeof globalThis.__codexEnsureBackendWarm === "function") await globalThis.__codexEnsureBackendWarm(runId, "terminal-input");
    state.outcome = "READY";
  } catch (error) {
    state.outcome = "REFUSED";
    state.error = String(error?.message || error);
    throw error;
  } finally {
    clearInterval(timer);
    state.elapsedMs = Date.now() - started;
    if (state.outcome === "READY" && state.noticeShown) post("Stata finished loading after " + Math.round(state.elapsedMs / 1000) + " s; running the command.");
    if (state.outcome === "READY" && !state.guaranteed) post("Could not confirm that Stata finished loading (" + state.note + "); running the command.");
    if (state.outcome === "REFUSED") post("The command was not sent: " + state.error);
  }
  return state;
}
globalThis.__codexTerminalWarmup = __codexTerminalWarmup;
`;

const ONCE_BEFORE = "__codexOnce=async()=>{let I=fF(),";
const ONCE_AFTER = "__codexOnce=async()=>{/* codex patch rc.7.79: Terminal input waits for Stata start-up */"
  + "if(typeof globalThis.__codexTerminalWarmup===\"function\")await globalThis.__codexTerminalWarmup(A?.runId||null,{onProgress:A?.onProgress});"
  + "let I=fF(),";

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous terminal warm-up anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, HELPER_ANCHOR + HELPER);
    uniqueAt(source, ONCE_AFTER);
  } else {
    if (source.includes("__codexTerminalWarmup") || source.includes("__codexWarmGeneration")) {
      throw new Error("partial terminal warm-up patch");
    }
    uniqueAt(source, HELPER_ANCHOR);
    uniqueAt(source, ONCE_BEFORE);
    source = source.replace(HELPER_ANCHOR, () => HELPER_ANCHOR + HELPER).replace(ONCE_BEFORE, () => ONCE_AFTER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, HELPER_ANCHOR + HELPER);
  uniqueAt(source, ONCE_AFTER);
  return fingerprint.finalize(source.replace(HELPER_ANCHOR + HELPER, () => HELPER_ANCHOR)
    .replace(ONCE_AFTER, () => ONCE_BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHOR, ONCE_BEFORE, ONCE_AFTER };
