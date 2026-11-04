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

// Lines as mcp-stata writes them to the per-run log (plain text or SMCL).
const SMCL_PREFIX = /^\{(?:res|txt|com|err|inp|error|text|result|input)\}/i;
const RC_PLAIN = /^r\((\d+)\);$/;
const RC_SEARCH = /^\{search r\((\d+)\)(?:,[^}]*)?\}$/i;

function stripSmcl(line) {
  let value = String(line || "").trim();
  while (SMCL_PREFIX.test(value)) value = value.replace(SMCL_PREFIX, "").trim();
  return value;
}

// Return code of the last r(n); line, and whether anything but blank lines
// follows it (a later command ran, so it is not the run's final error).
function lastReturnCode(text) {
  const lines = String(text || "").split(/\r?\n/);
  let rc = null, at = -1;
  lines.forEach((raw, index) => {
    const line = stripSmcl(raw);
    const match = line.match(RC_PLAIN) || line.match(RC_SEARCH);
    if (match) { rc = Number(match[1]); at = index; }
  });
  if (at < 0 || !Number.isSafeInteger(rc)) return { rc: null, trailing: false };
  const trailing = lines.slice(at + 1).some((raw) => stripSmcl(raw) !== "");
  return { rc, trailing };
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function mcpReturnCode(result) {
  const raw = result && result.raw;
  const candidates = [result && result.rc, raw && raw.error && raw.error.rc, raw && raw.rc,
    result && result.error && result.error.rc];
  for (const value of candidates) if (positiveInt(value) !== null) return value;
  return null;
}

const CANCEL_TEXT = /--Break--|request cancelled|cancelled|canceled|soft-stop|watchdog/i;

// input: { runId, result, error, logPath, lifecycle, logText, cancelled, completionMarker }
function classify(input = {}) {
  const reasons = [];
  const result = input.result && typeof input.result === "object" ? input.result : null;
  const life = input.lifecycle && typeof input.lifecycle === "object" ? input.lifecycle : {};
  if (!result) reasons.push("no-mcp-result");
  else if (!(result.success === false || result.error || (result.raw && result.raw.error))) reasons.push("not-a-failure");
  if (input.cancelled) reasons.push("cancelled");
  if (result && (result.__codexWatchdogRelease || result.cancelled === true || result.controlPlaneRejected)) reasons.push("cancelled");
  const message = String((input.error && input.error.message) || (result && result.stderr) || "");
  if (CANCEL_TEXT.test(message)) reasons.push("cancel-text");
  if (!input.runId || String(life.runId || "") !== String(input.runId)) reasons.push("lifecycle-not-this-run");
  const resultPath = result && typeof result.logPath === "string" ? result.logPath : null;
  const lifePath = typeof life.logPath === "string" ? life.logPath : null;
  if (!resultPath || !lifePath || resultPath !== lifePath || (input.logPath && input.logPath !== resultPath)) {
    reasons.push("log-not-bound-to-run");
  }
  if (typeof input.logText !== "string" || input.logText.length === 0) reasons.push("log-missing");
  if (input.completionMarker && String(input.logText || "").includes(input.completionMarker)) reasons.push("completion-marker-present");
  const fromLog = lastReturnCode(input.logText);
  const mcpRc = result ? mcpReturnCode(result) : null;
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

module.exports = { classify, lastReturnCode, stripSmcl, mcpReturnCode };
