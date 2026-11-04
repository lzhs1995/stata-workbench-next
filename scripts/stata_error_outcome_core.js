"use strict";

// rc.7.85 (V3-M M5): a Stata error that ran to its r(n); line is a confirmed
// outcome, not an unknown one. mcp-stata reports the failure, but the bridge
// used to keep only its message: rc and log path were dropped, the appended
// completion marker never ran (Stata stops at the error), and the run was
// released as "without verified completion evidence". The client then had to
// report EXECUTION_UNCONFIRMED although Stata had printed r(111).
//
// classify() confirms a Stata error only when every check holds. Anything
// else stays unconfirmed, so the existing UNKNOWN/payloadMayHaveRun handling
// is unchanged. Pure function; the bundle passes in the log tail it read.

// Lines as mcp-stata 1.26.1 writes them to the per-run log, checked on Mac
// 2026-11-04 (scripts/fixtures/stata-error-logs/): the error line is
// `{txt}{search r(111), local:r(111);}`, written twice, and every command,
// including the bridge's appended marker and mcp-stata's closing
// `scalar _wb_rc_<id> = _rc`, is echoed as `{com}. <command>`.
const SMCL_PREFIX = /^\{(?:res|txt|com|err|inp|error|text|result|input)\}/i;
const RC_PLAIN = /^r\((\d+)\);$/;
const RC_SEARCH = /^\{search r\((\d+)\)(?:,[^}]*)?\}$/i;

function stripSmcl(line) {
  let value = String(line || "").trim();
  while (SMCL_PREFIX.test(value)) value = value.replace(SMCL_PREFIX, "").trim();
  return value;
}

// An echoed command (`. cmd`, `{com}. cmd`, a bare `.` prompt) is input, not output.
function isEcho(line) {
  return line === "." || line.startsWith(". ");
}

// Return code of the last r(n) line, and whether real output follows it
// (a later command printed something, so it is not the run's final error).
// Echoed commands and blank lines after it do not count.
function lastReturnCode(text) {
  const lines = String(text || "").split(/\r?\n/).map(stripSmcl);
  let rc = null, at = -1;
  lines.forEach((line, index) => {
    const match = line.match(RC_PLAIN) || line.match(RC_SEARCH);
    if (match) { rc = Number(match[1]); at = index; }
  });
  if (at < 0 || !Number.isSafeInteger(rc)) return { rc: null, trailing: false };
  const trailing = lines.slice(at + 1).some((line) => line !== "" && !isEcho(line));
  return { rc, trailing };
}

// The completion marker as printed output (exact line), not as the echoed
// `display` command that never ran.
function markerPrinted(text, marker) {
  if (!marker) return false;
  return String(text || "").split(/\r?\n/).map(stripSmcl).some((line) => line === marker);
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// The one authoritative MCP return code is `raw.rc`: the rc that mcp-stata's
// task_done event carries for this task (stata_task_done_rc_patch.js). Every
// other rc field the normalizer exposes must agree with it when present; a
// missing, zero, negative or non-integer authoritative rc is not evidence.
function mcpReturnCode(result) {
  const raw = result && result.raw && typeof result.raw === "object" ? result.raw : null;
  const authoritative = raw ? raw.rc : undefined;
  const others = [result && result.rc, raw && raw.error && typeof raw.error === "object" ? raw.error.rc : undefined,
    result && result.error && typeof result.error === "object" ? result.error.rc : undefined];
  if (positiveInt(authoritative) === null) return { rc: null, reason: "mcp-rc-missing" };
  if (others.some((value) => value !== undefined && value !== null && value !== authoritative)) {
    return { rc: null, reason: "mcp-rc-conflict" };
  }
  return { rc: authoritative, reason: null };
}

// Every text the failure can carry. An object error contributes its message,
// so a wrapped Error("[object Object]") cannot hide a cancellation.
function messageText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.message === "string") return value.message;
  return "";
}
function failureTexts(input, result) {
  const raw = result && result.raw && typeof result.raw === "object" ? result.raw : {};
  return [messageText(input.error), result && result.stderr, messageText(result && result.error),
    messageText(raw.error), raw.error && typeof raw.error === "object" ? raw.error.stderr : null, raw.stderr,
    typeof raw.status === "string" && raw.status !== "done" ? "status " + raw.status : null]
    .filter((text) => typeof text === "string" && text !== "");
}

const CANCEL_TEXT = /--Break--|request cancelled|cancelled|canceled|soft-stop|watchdog|timed out|timeout|stall|status unknown/i;

// input: { runId, result, error, logPath, lifecycle, logText, cancelled, completionMarker }
function classify(input = {}) {
  const reasons = [];
  const result = input.result && typeof input.result === "object" ? input.result : null;
  const life = input.lifecycle && typeof input.lifecycle === "object" ? input.lifecycle : {};
  if (!result) reasons.push("no-mcp-result");
  else if (!(result.success === false || result.error || (result.raw && result.raw.error))) reasons.push("not-a-failure");
  if (input.cancelled) reasons.push("cancelled");
  if (result && (result.__codexWatchdogRelease || result.cancelled === true || result.controlPlaneRejected
      || result.guardFailure || result.__codexPreRunTimeout)) reasons.push("cancelled");
  if (input.error && typeof input.error === "object" && (input.error.__codexPreRunTimeout || input.error.guardFailure)) reasons.push("cancelled");
  if (failureTexts(input, result).some((text) => CANCEL_TEXT.test(text))) reasons.push("cancel-text");
  if (!input.runId || String(life.runId || "") !== String(input.runId)) reasons.push("lifecycle-not-this-run");
  const resultPath = result && typeof result.logPath === "string" ? result.logPath : null;
  const lifePath = typeof life.logPath === "string" ? life.logPath : null;
  if (!resultPath || !lifePath || resultPath !== lifePath || (input.logPath && input.logPath !== resultPath)) {
    reasons.push("log-not-bound-to-run");
  }
  if (typeof input.logText !== "string" || input.logText.length === 0) reasons.push("log-missing");
  if (markerPrinted(input.logText, input.completionMarker)) reasons.push("completion-marker-present");
  const fromLog = lastReturnCode(input.logText);
  const mcp = result ? mcpReturnCode(result) : { rc: null, reason: "mcp-rc-missing" };
  const mcpRc = mcp.rc;
  if (mcp.reason) reasons.push(mcp.reason);
  if (fromLog.rc === null) reasons.push("no-rc-line");
  else if (fromLog.trailing) reasons.push("rc-line-not-last");
  if (fromLog.rc === 1) reasons.push("break-rc");
  if (fromLog.rc !== null && fromLog.rc <= 0) reasons.push("rc-not-positive");
  if (mcpRc !== null && fromLog.rc !== null && mcpRc !== fromLog.rc) reasons.push("rc-mismatch");
  const unique = [...new Set(reasons)];
  return unique.length === 0
    ? { confirmed: true, stataRc: fromLog.rc, mcpRc, reasons: [] }
    : { confirmed: false, stataRc: null, mcpRc, logRc: fromLog.rc, reasons: unique };
}

module.exports = { classify, lastReturnCode, markerPrinted, stripSmcl, mcpReturnCode, failureTexts, messageText };
