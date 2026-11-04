#!/usr/bin/env node
"use strict";

// W-P1 diagnostics (rc.7.80). W5 w5f2 (2026-11-03) stalled 120 s before its first
// log line and W6 could not say where: the extension logged only connect and
// per-tool totals. This patch writes one "[wb-timing]" line, with wall and
// monotonic clocks, at each step a Terminal command takes before its first output:
// request entry, warm-up start/end, every change in the default session's status
// while warming up, the run_command_background / list_sessions call and its
// return, the matched log_path event and the first output chunk. With
// STATA_WORKBENCH_TIMING_FILE set, each line is also appended as JSON to that
// file; the manual diagnostic tool scripts/stata_timing_patch.js (run only on a
// disposable runtime copy; the product never instruments its runtime) writes its
// Python milestones to the same file, so one file orders both processes. Diagnostic observation with
// synchronous I/O cost (output channel line, optional appendFileSync): no
// control flow, return value or budget changes; every inserted statement is in
// its own try/catch so it cannot throw into the run. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.80: W-P1 timing lines for the first Terminal command (diagnostic)";

// After the rc.7.79 helper when present (main), else after the rc.7.72 helper (older builds).
const HELPER_ANCHORS = [
  "globalThis.__codexTerminalWarmup = __codexTerminalWarmup;\n",
  "globalThis.__codexWarmupSkipsQuiescence = __codexWarmupSkipsQuiescence;\n",
];
const HELPER = String.raw`
${MARKER}
// Field allowlist: each event keeps only the fields listed for it, and only
// strings (cut to 80 characters), numbers, booleans and null; objects such as
// Terminal options are dropped. Errors keep only their class and code, not the
// message. The allowed values are not content-checked.
var __codexWbT0 = Date.now();
const __codexWbFields = {
  ext_terminal_enter: ["runId"], ext_terminal_warmup_start: ["runId"], ext_backend_warm_start: ["runId"],
  ext_terminal_warmup_end: ["runId", "outcome", "ms", "errorClass", "errorCode"],
  ext_backend_warm_end: ["runId", "outcome", "ms", "errorClass", "errorCode"],
  ext_tool_send: ["tool"], ext_tool_done: ["tool", "ms"], ext_session_status: ["status"],
  ext_log_path: ["runId"], ext_first_output: ["runId", "bytes"],
};
function __codexWbErrorFields(error) {
  const out = { errorClass: null, errorCode: null };
  try { out.errorClass = String(error && error.constructor && error.constructor.name || typeof error).slice(0, 40); } catch {}
  try { if (error && error.code != null) out.errorCode = String(error.code).slice(0, 40); } catch {}
  return out;
}
// quiet: file only (list_sessions polls every 500 ms while Stata starts).
function __codexWbTiming(event, fields, quiet) {
  try {
    const record = { event, wall: Date.now() / 1000, mono: (typeof performance !== "undefined" ? performance.now() : Date.now() - __codexWbT0) / 1000, pid: process.pid, src: "ext" };
    for (const key of __codexWbFields[event] || []) {
      const value = fields ? fields[key] : undefined;
      if (value === null || typeof value === "number" || typeof value === "boolean") record[key] = value;
      else if (typeof value === "string") record[key] = value.slice(0, 80);
    }
    const line = JSON.stringify(record);
    try { if (!quiet && typeof RI === "function") RI("[wb-timing] " + line); } catch {}
    const target = process.env.STATA_WORKBENCH_TIMING_FILE;
    if (target) require("fs").appendFileSync(target, line + "\n");
  } catch {}
}
globalThis.__codexWbTiming = __codexWbTiming;
// Logs the default session's status from a list_sessions result, only when it changes.
var __codexWbLastStatus;
function __codexWbSessionStatus(result) {
  try {
    let status = "unparsed", listed = null;
    try { listed = zg && typeof zg._parseToolJson === "function" ? zg._parseToolJson(result) : null; } catch {}
    if (listed && Array.isArray(listed.sessions)) {
      const session = listed.sessions.find((item) => item && item.id === "default");
      status = session ? String(session.status || "") : "missing";
    }
    if (status !== __codexWbLastStatus) { __codexWbLastStatus = status; __codexWbTiming("ext_session_status", { status }); }
  } catch {}
}
globalThis.__codexWbSessionStatus = __codexWbSessionStatus;
function __codexWbTimedWarm(name, inner) {
  if (typeof inner !== "function" || inner.__codexWbTimed) return inner;
  const timed = async function (runId, source) {
    const started = Date.now();
    const id = () => { try { return runId == null ? null : String(runId); } catch { return null; } };
    try {
      if (name === "ext_terminal_warmup") __codexWbTiming("ext_terminal_enter", { runId: id() });
      __codexWbTiming(name + "_start", { runId: id() });
    } catch {}
    let result;
    try {
      result = await inner.apply(this, arguments);
    } catch (error) {
      try { __codexWbTiming(name + "_end", Object.assign({ runId: id(), outcome: "THREW", ms: Date.now() - started }, __codexWbErrorFields(error))); } catch {}
      throw error;
    }
    try { __codexWbTiming(name + "_end", { runId: id(), outcome: result && typeof result.outcome === "string" ? result.outcome : (result == null ? "SKIPPED" : null), ms: Date.now() - started }); } catch {}
    return result;
  };
  timed.__codexWbTimed = true;
  return timed;
}
try { if (typeof globalThis.__codexTerminalWarmup === "function") globalThis.__codexTerminalWarmup = __codexWbTimedWarm("ext_terminal_warmup", globalThis.__codexTerminalWarmup); } catch {}
try { if (typeof globalThis.__codexEnsureBackendWarm === "function") globalThis.__codexEnsureBackendWarm = __codexWbTimedWarm("ext_backend_warm", globalThis.__codexEnsureBackendWarm); } catch {}
`;

const WB = (event, fields, quiet) => `try{globalThis.__codexWbTiming&&globalThis.__codexWbTiming(${JSON.stringify(event)},${fields}${quiet ? ",!0" : ""})}catch{}`;
const TRACKED = `(E==="list_sessions"||E==="run_command_background"||E==="run_do_file_background")`;
const QUIET = `E==="list_sessions"`;

// [before, after, required]. None of these "before" strings is part of another
// patch's verified text, so earlier patches still find their own bytes intact.
// The Terminal entry line comes from the rc.7.79 warm-up wrapper on main; older
// builds without rc.7.79 still have the original __codexOnce head, timed here.
const SITES = [
  ["__codexOnce=async()=>{let I=fF(),",
    "__codexOnce=async()=>{/* codex patch rc.7.80: timing */" + WB("ext_terminal_enter", "{runId:A?.runId||null}") + "let I=fF(),", false],
  ["let e=Q??{},t=Date.now();try{let o=A;",
    "let e=Q??{},t=Date.now();" + `if(${TRACKED})` + WB("ext_tool_send", "{tool:E}", "q") .replace(",!0", `,${QUIET}`) + ";try{let o=A;", true],
  ["this._log(`[mcp-stata] tool ${I} completed in ${n}ms`),s}",
    "this._log(`[mcp-stata] tool ${I} completed in ${n}ms`)," + `(${TRACKED}&&(()=>{` + WB("ext_tool_done", "{tool:E,ms:n}", "q").replace(",!0", `,${QUIET}`)
      + `;if(${QUIET})try{globalThis.__codexWbSessionStatus&&globalThis.__codexWbSessionStatus(s)}catch{}})()),s}`, true],
  ["this._log(`[mcp-stata] log_path event matched for run ${o._runId||\"unknown\"}, path=${s}`),",
    "this._log(`[mcp-stata] log_path event matched for run ${o._runId||\"unknown\"}, path=${s}`),(()=>{" + WB("ext_log_path", "{runId:o._runId||null}") + "})(),", true],
  ["I._lastLogAt=Date.now(),I._idleLogged=!1,I._lineBuffer=(I._lineBuffer||\"\")+C;",
    "I._lastLogAt=Date.now(),I._idleLogged=!1,I._lineBuffer=(I._lineBuffer||\"\")+C;"
      + "try{if(I&&!I.__codexWbFirstOut){I.__codexWbFirstOut=!0;" + WB("ext_first_output", "{runId:I._runId||null,bytes:C.length}") + "}}catch{}", true],
];

function count(source, needle) { return source.split(needle).length - 1; }

function helperAnchor(source) {
  for (const anchor of HELPER_ANCHORS) if (count(source, anchor) === 1) return anchor;
  throw new Error("missing W-P1 timing helper anchor");
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    if (count(source, MARKER) !== 1) throw new Error("ambiguous W-P1 timing patch");
    for (const [, after, required] of SITES) {
      const n = count(source, after);
      if (n > 1 || (required && n !== 1)) throw new Error("partial W-P1 timing patch");
    }
  } else {
    if (source.includes("__codexWbTiming")) throw new Error("partial W-P1 timing patch");
    const anchor = helperAnchor(source);
    for (const [before, , required] of SITES) {
      const n = count(source, before);
      if (n > 1 || (required && n !== 1)) throw new Error("missing or ambiguous W-P1 timing anchor: " + before.slice(0, 40));
    }
    source = source.replace(anchor, () => anchor + HELPER);
    for (const [before, after] of SITES) if (count(source, before) === 1) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  if (count(source, MARKER) !== 1) throw new Error("W-P1 timing patch not applied");
  const anchor = HELPER_ANCHORS.find((a) => count(source, a + HELPER) === 1);
  if (!anchor) throw new Error("W-P1 timing helper not found");
  source = source.replace(anchor + HELPER, () => anchor);
  for (const [before, after] of SITES) if (count(source, after) === 1) source = source.replace(after, () => before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHORS, SITES };
