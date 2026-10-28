"use strict";

// Readable source boundary for the shared execution lifecycle.  The maintained
// bundle has a larger bridge implementation; this module keeps the source
// candidate's state transitions explicit and host independent.
const VERSION = "rc7.27-source";

function at(now) {
  return new Date(now == null ? Date.now() : now).toISOString();
}

function clone(value) {
  return value ? { ...value } : null;
}

function createExecutionLifecycle({ now = Date.now, publish = () => {} } = {}) {
  let current = null;

  function emit() {
    const snapshot = status();
    try { publish(snapshot); } catch (_) { /* telemetry must not affect execution */ }
    return snapshot;
  }

  function owns(runId) {
    return !runId || !current || String(current.runId || "") === String(runId);
  }

  function begin(input = {}) {
    const runId = input.runId || input.requestId || null;
    current = {
      lifecycleVersion: VERSION,
      requestId: input.requestId || runId,
      runId,
      sourceMode: input.sourceMode || input.source || "unknown",
      phase: "acquired",
      startedAt: at(now()),
      firstLogAt: null,
      lastProgressAt: at(now()),
      releasedAt: null,
      logPath: null,
      rc: null,
      completionMarkerVerified: false,
      failure: null,
    };
    return emit();
  }

  function adopt(runId) {
    if (!current) return null;
    const previousRunId = current.runId;
    current.runId = runId ? String(runId) : current.runId;
    return emitWith({ previousRunId });
  }

  function emitWith(extra = {}) {
    const value = emit();
    return value ? { ...value, ...extra } : value;
  }

  function started(runId) {
    if (!owns(runId) || !current || current.releasedAt) return status();
    current.phase = "running";
    current.lastProgressAt = at(now());
    return emit();
  }

  function progress(runId) {
    if (!owns(runId) || !current || current.releasedAt) return status();
    current.lastProgressAt = at(now());
    if (current.phase === "acquired") current.phase = "running";
    return emit();
  }

  function logPath(value, runId) {
    if (!owns(runId) || !current || current.releasedAt || !value) return status();
    current.logPath = String(value);
    current.firstLogAt = current.firstLogAt || at(now());
    current.lastProgressAt = at(now());
    if (current.phase === "acquired") current.phase = "running";
    return emit();
  }

  function finish(runId, result = {}) {
    if (!owns(runId) || !current || current.releasedAt) return status();
    if (result.logPath) current.logPath = String(result.logPath);
    if (result.completionMarkerVerified === true) current.completionMarkerVerified = true;
    if (typeof result.rc === "number") current.rc = result.rc;
    current.failure = result.error ? String(result.error.message || result.error) : null;
    current.phase = current.failure || (typeof current.rc === "number" && current.rc !== 0)
      ? "failed" : "completed";
    current.releasedAt = at(now());
    return emit();
  }

  function fail(runId, error) {
    return finish(runId, { error });
  }

  function status() {
    return clone(current);
  }

  return { adopt, begin, fail, finish, logPath, progress, started, status };
}

module.exports = { VERSION, createExecutionLifecycle };
