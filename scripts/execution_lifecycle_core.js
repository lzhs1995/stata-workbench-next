"use strict";

const fs = require("fs");
const path = require("path");

const LIFECYCLE_VERSION = "rc7.27";

function isoNow(now) {
  return new Date(now == null ? Date.now() : now).toISOString();
}

function asTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureLifecycle(bridge) {
  const target = bridge && typeof bridge === "object" ? bridge : {};
  const current = target.lifecycle && typeof target.lifecycle === "object"
    ? target.lifecycle
    : {};
  Object.assign(current, {
    version: LIFECYCLE_VERSION,
    requestId: current.requestId || null,
    runId: current.runId || null,
    sourceMode: current.sourceMode || null,
    phase: current.phase || "idle",
    startedAt: current.startedAt || null,
    firstLogAt: current.firstLogAt || null,
    lastProgressAt: current.lastProgressAt || null,
    completionMarkerAt: current.completionMarkerAt || null,
    sessionCompletionMarkerAt: current.sessionCompletionMarkerAt || null,
    releasedAt: current.releasedAt || null,
    logPath: current.logPath || null,
    rc: typeof current.rc === "number" ? current.rc : null,
    completionMarkerVerified: current.completionMarkerVerified === true,
    perRunEvidenceRequired: current.perRunEvidenceRequired === true,
    perRunCompletionMarkerVerified: current.perRunCompletionMarkerVerified === true,
    perRunEvidenceFailure: current.perRunEvidenceFailure || null,
    failure: current.failure || null,
  });
  target.lifecycle = current;
  target.lastCompletedRun = target.lastCompletedRun || null;
  return current;
}

function beginRun(bridge, input = {}, now) {
  const target = bridge && typeof bridge === "object" ? bridge : {};
  const at = isoNow(now);
  target.lifecycle = {
    version: LIFECYCLE_VERSION,
    requestId: input.requestId || input.runId || null,
    runId: input.runId || input.requestId || null,
    sourceMode: input.sourceMode || input.source || "unknown",
    phase: "acquired",
    startedAt: at,
    firstLogAt: null,
    lastProgressAt: at,
    completionMarkerAt: null,
    sessionCompletionMarkerAt: null,
    releasedAt: null,
    logPath: null,
    rc: null,
    completionMarkerVerified: false,
    perRunEvidenceRequired: input.perRunEvidenceRequired === true,
    perRunCompletionMarkerVerified: false,
    perRunEvidenceFailure: null,
    failure: null,
  };
  return target.lifecycle;
}

function adoptRunId(bridge, runId) {
  const lifecycle = ensureLifecycle(bridge);
  const previous = lifecycle.runId;
  if (runId) lifecycle.runId = String(runId);
  return { previousRunId: previous, runId: lifecycle.runId };
}

function ownsLifecycle(lifecycle, expectedRunId) {
  return !expectedRunId || String(lifecycle.runId || "") === String(expectedRunId);
}

function recordStarted(bridge, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  lifecycle.phase = "running";
  lifecycle.lastProgressAt = isoNow(now);
  return lifecycle;
}

function recordLogPath(bridge, logPath, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  if (!logPath) return lifecycle;
  lifecycle.logPath = String(logPath);
  lifecycle.firstLogAt = lifecycle.firstLogAt || isoNow(now);
  lifecycle.lastProgressAt = isoNow(now);
  if (lifecycle.phase === "acquired") lifecycle.phase = "running";
  bridge.logPath = String(logPath);
  return lifecycle;
}

function recordProgress(bridge, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  lifecycle.lastProgressAt = isoNow(now);
  if (lifecycle.phase === "acquired") lifecycle.phase = "running";
  return lifecycle;
}

function recordCompletionMarker(bridge, now, expectedRunId) {
  return recordPerRunCompletionMarker(bridge, now, expectedRunId);
}

function recordSessionCompletionMarker(bridge, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  lifecycle.sessionCompletionMarkerAt = lifecycle.sessionCompletionMarkerAt || isoNow(now);
  lifecycle.lastProgressAt = isoNow(now);
  if (lifecycle.phase !== "failed") lifecycle.phase = "converging";
  return lifecycle;
}

function recordPerRunCompletionMarker(bridge, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  lifecycle.completionMarkerVerified = true;
  lifecycle.perRunCompletionMarkerVerified = true;
  lifecycle.perRunEvidenceFailure = null;
  lifecycle.completionMarkerAt = lifecycle.completionMarkerAt || isoNow(now);
  lifecycle.lastProgressAt = isoNow(now);
  lifecycle.phase = "completing";
  return lifecycle;
}

function recordPerRunEvidenceFailure(bridge, failure, now, expectedRunId) {
  const lifecycle = ensureLifecycle(bridge);
  if (!ownsLifecycle(lifecycle, expectedRunId) || lifecycle.releasedAt) return lifecycle;
  lifecycle.perRunEvidenceFailure = String(failure || "PER_RUN_LOG_INCOMPLETE");
  lifecycle.lastProgressAt = isoNow(now);
  lifecycle.phase = "failed";
  return lifecycle;
}

function finishRun(bridge, result = {}, now) {
  const lifecycle = ensureLifecycle(bridge);
  const completedAt = now == null ? Date.now() : now;
  const at = isoNow(completedAt);
  if (result.logPath) recordLogPath(bridge, result.logPath, completedAt);
  if (result.completionMarkerVerified === true) {
    recordPerRunCompletionMarker(bridge, completedAt);
  }
  lifecycle.rc = typeof result.rc === "number" ? result.rc : lifecycle.rc;
  lifecycle.failure = result.error ? String(result.error.message || result.error) : null;
  lifecycle.phase = lifecycle.failure || (typeof lifecycle.rc === "number" && lifecycle.rc !== 0)
    ? "failed"
    : "completed";
  lifecycle.releasedAt = at;
  const started = asTime(lifecycle.startedAt);
  const released = asTime(at);
  bridge.lastCompletedRun = {
    lifecycleVersion: LIFECYCLE_VERSION,
    requestId: lifecycle.requestId,
    runId: lifecycle.runId,
    sourceMode: lifecycle.sourceMode,
    phase: lifecycle.phase,
    startedAt: lifecycle.startedAt,
    firstLogAt: lifecycle.firstLogAt,
    lastProgressAt: lifecycle.lastProgressAt,
    completionMarkerAt: lifecycle.completionMarkerAt,
    sessionCompletionMarkerAt: lifecycle.sessionCompletionMarkerAt,
    releasedAt: lifecycle.releasedAt,
    durationMs: started == null ? null : Math.max(0, (released == null ? Date.now() : released) - started),
    logPath: lifecycle.logPath,
    rc: lifecycle.rc,
    completionMarkerVerified: lifecycle.completionMarkerVerified,
    perRunEvidenceRequired: lifecycle.perRunEvidenceRequired,
    perRunCompletionMarkerVerified: lifecycle.perRunCompletionMarkerVerified,
    perRunEvidenceFailure: lifecycle.perRunEvidenceFailure,
    failure: lifecycle.failure,
  };
  return bridge.lastCompletedRun;
}

function publicLifecycle(bridge) {
  const lifecycle = ensureLifecycle(bridge);
  return {
    lifecycleVersion: LIFECYCLE_VERSION,
    phase: lifecycle.phase,
    requestId: lifecycle.requestId,
    runId: lifecycle.runId,
    sourceMode: lifecycle.sourceMode,
    startedAt: lifecycle.startedAt,
    firstLogAt: lifecycle.firstLogAt,
    lastProgressAt: lifecycle.lastProgressAt,
    completionMarkerAt: lifecycle.completionMarkerAt,
    sessionCompletionMarkerAt: lifecycle.sessionCompletionMarkerAt,
    releasedAt: lifecycle.releasedAt,
    logPath: lifecycle.logPath,
    rc: lifecycle.rc,
    completionMarkerVerified: lifecycle.completionMarkerVerified,
    perRunEvidenceRequired: lifecycle.perRunEvidenceRequired,
    perRunCompletionMarkerVerified: lifecycle.perRunCompletionMarkerVerified,
    perRunEvidenceFailure: lifecycle.perRunEvidenceFailure,
    failure: lifecycle.failure,
    lastCompletedRun: bridge && bridge.lastCompletedRun || null,
  };
}

function resolveLogDirectories(input = {}) {
  const env = input.env || {};
  const roots = [];
  const add = (value) => {
    if (!value) return;
    const normalized = path.resolve(String(value));
    if (!roots.includes(normalized)) roots.push(normalized);
  };
  add(env.MCP_STATA_TEMP);
  add(input.cwd && path.join(input.cwd, "7_temp", "mcp-stata-temp"));
  for (const root of input.workspaceRoots || []) {
    add(path.join(root, "7_temp", "mcp-stata-temp"));
    add(path.join(root, "开题报告", "7_temp", "mcp-stata-temp"));
  }
  add(input.extensionRoot && path.join(input.extensionRoot, "7_temp", "mcp-stata-temp"));
  return roots;
}

function stripSmclPrefix(line) {
  let value = String(line || "").trim();
  while (/^\{(?:res|txt|com|err|inp)\}/i.test(value)) {
    value = value.replace(/^\{(?:res|txt|com|err|inp)\}/i, "").trim();
  }
  return value;
}

function completionMarker(runId) {
  return runId ? `___CODEX_RUN_DONE_${String(runId)}___` : null;
}

function lineIsCompletion(line, runId) {
  const marker = completionMarker(runId);
  if (!marker) return false;
  const value = stripSmclPrefix(line);
  if (!value || /^\.\s/.test(value)) return false;
  return value === marker;
}

function inspectLogText(text, runId) {
  const lines = String(text || "").split(/\r?\n/);
  let completionMarkerVerified = false;
  let endOfDoFile = false;
  let rc = null;
  let noVariablesDefined = false;
  const returnPrefix = runId ? "___CODEX_RUN_RC_" + String(runId) + "___=" : null;
  const returnRecords = [];
  const completionLines = [];
  let lineIndex = 0;
  for (const raw of lines) {
    if (lineIsCompletion(raw, runId)) {
      completionMarkerVerified = true;
      completionLines.push(lineIndex);
    }
    const line = stripSmclPrefix(raw);
    if (returnPrefix && line.startsWith(returnPrefix)) {
      const value = line.slice(returnPrefix.length).trim();
      const code = /^\d+$/.test(value) ? Number(value) : null;
      returnRecords.push({ index: lineIndex, rc: Number.isSafeInteger(code) ? code : null });
    }
    if (/^end of do-file$/i.test(line)) endOfDoFile = true;
    if (/no variables defined/i.test(line)) noVariablesDefined = true;
    const match = line.match(/^r\((\d+)\);$/i);
    if (match) rc = Number(match[1]);
    lineIndex += 1;
  }
  // A captured inner error may be intentional. The finalizer records the actual
  // do-file return before its exact completion marker. Never infer rc=0 from a
  // marker while discarding that return, or accept duplicate/misordered records.
  const finalizerReturnCodeVerified = returnRecords.length === 1
    && returnRecords[0].rc !== null
    && completionLines.length === 1
    && returnRecords[0].index < completionLines[0];
  const finalizerEvidenceInvalid = returnRecords.length > 0 && !finalizerReturnCodeVerified;
  if (finalizerReturnCodeVerified) rc = returnRecords[0].rc;
  if (finalizerEvidenceInvalid) completionMarkerVerified = false;
  return { completionMarkerVerified, endOfDoFile, rc, noVariablesDefined,
    finalizerReturnCodeVerified, finalizerEvidenceInvalid };
}

function transportSettlementDecision(result = {}, lifecycle = {}) {
  const rawError = result && result.raw && result.raw.error;
  const failed = Boolean(
    result && (
      result.success === false ||
      result.hasError === true ||
      result.error ||
      rawError ||
      (typeof result.rc === "number" && result.rc !== 0)
    )
  );
  const perRunEvidenceRequired = lifecycle && lifecycle.perRunEvidenceRequired === true;
  const completionMarkerVerified = perRunEvidenceRequired
    ? lifecycle.perRunCompletionMarkerVerified === true
    : Boolean(
      result && result.completionMarkerVerified === true ||
      lifecycle && lifecycle.completionMarkerVerified === true
    );
  return {
    failed,
    completionMarkerVerified,
    perRunEvidenceRequired,
    release: failed || completionMarkerVerified,
  };
}

function perRunLogCompletionDecision(input = {}) {
  if (input.perRunCompletionMarkerVerified === true) {
    return { state: "verified", release: true, failed: false };
  }
  const sessionMarkerAt = asTime(input.sessionCompletionMarkerAt);
  if (sessionMarkerAt == null) {
    return { state: "pending", release: false, failed: false };
  }
  const now = asTime(input.now);
  const graceMs = Number.isFinite(input.graceMs)
    ? Math.max(0, Number(input.graceMs))
    : 10000;
  if ((now == null ? Date.now() : now) - sessionMarkerAt < graceMs) {
    return { state: "converging", release: false, failed: false };
  }
  return { state: "incomplete", release: true, failed: true };
}

function verifiedTransportResult(result = {}, evidence = {}) {
  return {
    ...result,
    logPath: result.logPath || evidence.logPath || null,
    logSize: result.logSize == null ? evidence.logSize : result.logSize,
    completionMarkerVerified: true,
  };
}

function findRunLog(input = {}) {
  const runId = input.runId ? String(input.runId) : null;
  if (!runId) return null;
  const includeSessionLogs = input.includeSessionLogs === true;
  const directories = Array.isArray(input.directories)
    ? input.directories
    : resolveLogDirectories(input);
  const startedAt = asTime(input.startedAt);
  const earliestMtime = startedAt == null ? 0 : startedAt - 5000;
  const maxBytes = Number.isFinite(input.maxBytes)
    ? Math.max(1024, Number(input.maxBytes))
    : 65536;

  for (const directory of directories) {
    let candidates = [];
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!/^mcp_stata_.*\.log$/i.test(name)
            && !(includeSessionLogs && /^mcp_session_.*\.smcl$/i.test(name))) continue;
        const logPath = path.join(directory, name);
        const stat = fs.statSync(logPath);
        if (!stat.isFile() || stat.mtimeMs < earliestMtime) continue;
        candidates.push({ logPath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      continue;
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.size - left.size);
    for (const candidate of candidates) {
      try {
        const length = Math.min(candidate.size, maxBytes);
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(candidate.logPath, "r");
        try {
          if (length > 0) {
            fs.readSync(fd, buffer, 0, length, Math.max(0, candidate.size - length));
          }
        } finally {
          fs.closeSync(fd);
        }
        const inspection = inspectLogText(buffer.toString("utf8"), runId);
        if (inspection.completionMarkerVerified) {
          return {
            ...candidate,
            logKind: /^mcp_session_.*\.smcl$/i.test(path.basename(candidate.logPath))
              ? "session"
              : "per-run",
            inspection,
          };
        }
      } catch {}
    }
  }
  return null;
}

module.exports = {
  LIFECYCLE_VERSION,
  adoptRunId,
  beginRun,
  completionMarker,
  ensureLifecycle,
  findRunLog,
  finishRun,
  inspectLogText,
  lineIsCompletion,
  publicLifecycle,
  perRunLogCompletionDecision,
  recordCompletionMarker,
  recordPerRunCompletionMarker,
  recordPerRunEvidenceFailure,
  recordSessionCompletionMarker,
  recordLogPath,
  ownsLifecycle,
  recordProgress,
  recordStarted,
  resolveLogDirectories,
  stripSmclPrefix,
  transportSettlementDecision,
  verifiedTransportResult,
};
