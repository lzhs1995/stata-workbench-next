"use strict";

// Readable source form of the maintained run-file finalizer. The researcher's
// file stays a separate do-file called from a product driver: an `exit` in
// that file returns to the driver, so it cannot skip the return record or the
// exact completion marker. Nothing here is written into the researcher's file.
const fs = require("node:fs");
const path = require("node:path");

const RUN_ID = /^[A-Za-z0-9_.-]+$/;
const TAIL_BYTES = 256 * 1024;

function stataString(value) {
  return String(value).replace(/"/g, '""');
}

function buildFinalizerCode({ runId, bodyPath, snapshotPath = null } = {}) {
  runId = String(runId || "");
  if (!RUN_ID.test(runId)) throw new Error("invalid finalizer runId");
  if (!bodyPath) throw new Error("missing finalizer body path");
  const local = name => "`" + name + "'";
  const lines = ['capture noisily do "' + stataString(bodyPath) + '"', "local __codex_body_rc = _rc"];
  if (snapshotPath) {
    lines.push('capture noisily save "' + stataString(snapshotPath) + '", replace emptyok',
      "local __codex_snapshot_rc = _rc",
      "local __codex_run_rc = " + local("__codex_body_rc"),
      "if " + local("__codex_run_rc") + " == 0 local __codex_run_rc = " + local("__codex_snapshot_rc"),
      'display as text "___CODEX_SNAPSHOT_RC_' + runId + '___=" %12.0f ' + local("__codex_snapshot_rc"));
  } else {
    lines.push("local __codex_run_rc = " + local("__codex_body_rc"));
  }
  lines.push('display as text "___CODEX_BODY_RC_' + runId + '___=" %12.0f ' + local("__codex_body_rc"),
    'display as text "___CODEX_RUN_RC_' + runId + '___=" %12.0f ' + local("__codex_run_rc"),
    'display as text "___CODEX_RUN_DONE_' + runId + '___"',
    // `exit 0` inside mcp-stata's include bundle skips its rc read; see the
    // maintained scripts/runfile_finalizer_core.js. Only a nonzero rc exits.
    "if " + local("__codex_run_rc") + " != 0 exit " + local("__codex_run_rc"), "");
  return lines.join("\n");
}

function stripSmcl(line) {
  let value = String(line || "").trim();
  while (/^\{(?:res|txt|com|err|inp)\}/i.test(value)) value = value.replace(/^\{(?:res|txt|com|err|inp)\}/i, "").trim();
  return value;
}

// Accept the finalizer's return only as one integer record followed by one
// exact marker. Echoed commands (". display ..."), duplicates, a record after
// the marker or another run's id do not count.
function inspectFinalizerLog(text, runId) {
  const marker = "___CODEX_RUN_DONE_" + String(runId) + "___";
  const prefix = "___CODEX_RUN_RC_" + String(runId) + "___=";
  const records = [];
  const markers = [];
  String(text || "").split(/\r?\n/).forEach((raw, index) => {
    const line = stripSmcl(raw);
    if (!line || /^\.\s/.test(line)) return;
    if (line === marker) markers.push(index);
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      records.push({ index, rc: /^\d+$/.test(value) ? Number(value) : null });
    }
  });
  const verified = records.length === 1 && Number.isSafeInteger(records[0].rc)
    && markers.length === 1 && records[0].index < markers[0];
  return {
    finalizerReturnCodeVerified: verified,
    completionMarkerVerified: verified,
    finalizerEvidenceInvalid: (records.length > 0 || markers.length > 0) && !verified,
    rc: verified ? records[0].rc : null,
  };
}

// The records are the last lines the driver prints; reading only the tail
// keeps a very long research log from being loaded whole.
function readLogTail(logPath, api = fs) {
  if (!logPath) return null;
  try {
    const size = api.statSync(logPath).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = api.openSync(logPath, "r");
    try { api.readSync(fd, buffer, 0, length, size - length); } finally { api.closeSync(fd); }
    const text = buffer.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (_) {
    return null;
  }
}

function prepareFinalizedRun({ runId, bodyPath, tempDir, api = fs } = {}) {
  const code = buildFinalizerCode({ runId, bodyPath });
  const driverPath = path.join(tempDir, "codex-run-" + runId + ".do");
  api.writeFileSync(driverPath, code, "utf8");
  return { driverPath, cleanup: () => { try { api.unlinkSync(driverPath); } catch (_) { } } };
}

// A verified finalizer record is authoritative over the transport rc, in both
// directions: a captured inner r(601) followed by RUN_RC=0 is a success, and a
// transport rc=0 cannot hide RUN_RC=601. The driver always prints the record,
// so a missing, partial or malformed record means completion is not verified;
// the transport rc is then kept as is and never upgraded.
function settleFinalizedResult(result, runId, logText) {
  const value = { ...(result || {}) };
  const evidence = inspectFinalizerLog(logText, runId);
  value.completionMarkerVerified = evidence.completionMarkerVerified;
  value.finalizerReturnCodeVerified = evidence.finalizerReturnCodeVerified;
  if (evidence.finalizerReturnCodeVerified) {
    value.rc = evidence.rc;
    value.success = evidence.rc === 0;
  } else if (evidence.finalizerEvidenceInvalid) {
    value.finalizerEvidenceInvalid = true;
  }
  return value;
}

module.exports = {
  buildFinalizerCode, inspectFinalizerLog, prepareFinalizedRun, readLogTail,
  settleFinalizedResult, stataString, TAIL_BYTES,
};