"use strict";

// Readable source boundary for the shared execution lifecycle.  The maintained
// bundle has a larger bridge implementation; this module keeps the source
// candidate's state transitions explicit and host independent.
//
// Ownership rules (source admission audit 2026-10-29):
// - One active owner. A second begin() while it is active is queued; it never
//   replaces the active record. The serial MCP backend runs queued work later.
// - Every transition names a non-empty runId; an unbound callback changes nothing.
// - An explicit failure result settles as failed. A missing result or a thrown
//   dispatch keeps the owner held with an unknown outcome instead of releasing.
const VERSION = "rc7.27-source.2";
const SETTLED_LIMIT = 32;

function at(now) {
  return new Date(now == null ? Date.now() : now).toISOString();
}

function clone(value) {
  return value ? { ...value } : null;
}

function createExecutionLifecycle({ now = Date.now, publish = () => {} } = {}) {
  let current = null;
  const waiting = new Map();
  const settled = new Map();

  function emit() {
    const snapshot = status();
    try { publish(snapshot); } catch (_) { /* telemetry must not affect execution */ }
    return snapshot;
  }

  function key(runId) {
    return runId == null || runId === "" ? null : String(runId);
  }

  function active() {
    return !!current && !current.releasedAt;
  }

  function owns(runId) {
    const id = key(runId);
    return !!id && active() && String(current.runId) === id;
  }

  function record(input, runId, phase) {
    return {
      lifecycleVersion: VERSION,
      requestId: input.requestId || runId,
      runId,
      sourceMode: input.sourceMode || input.source || "unknown",
      phase,
      startedAt: at(now()),
      firstLogAt: null,
      lastProgressAt: at(now()),
      releasedAt: null,
      logPath: null,
      rc: null,
      completionMarkerVerified: false,
      failure: null,
    };
  }

  function begin(input = {}) {
    const runId = key(input.runId || input.requestId);
    if (!runId) throw new TypeError("execution lifecycle begin requires a runId");
    if (owns(runId)) return status();
    if (waiting.has(runId)) return { ...clone(waiting.get(runId)), queued: true, activeRunId: current.runId };
    if (active() || waiting.size) {
      const queued = record(input, runId, "queued");
      waiting.set(runId, queued);
      emit();
      return { ...clone(queued), queued: true, activeRunId: current ? current.runId : null };
    }
    current = record(input, runId, "acquired");
    return emit();
  }

  // The next queued record becomes the owner only after the active one releases.
  function promote() {
    if (active()) return;
    const next = waiting.values().next().value;
    if (!next) return;
    waiting.delete(next.runId);
    next.phase = next.phase === "queued-started" ? "running" : "acquired";
    next.lastProgressAt = at(now());
    current = next;
  }

  function adopt(runId) {
    if (!active() || !key(runId)) return null;
    const previousRunId = current.runId;
    current.runId = String(runId);
    return emitWith({ previousRunId });
  }

  function emitWith(extra = {}) {
    const value = emit();
    return value ? { ...value, ...extra } : value;
  }

  // A queued run's backend start can be observed before the previous owner's
  // settlement callback; it is recorded and applied when the record is promoted.
  function touchQueued(runId, apply) {
    const queued = waiting.get(key(runId));
    if (!queued) return null;
    apply(queued);
    queued.phase = "queued-started";
    queued.lastProgressAt = at(now());
    return emit();
  }

  function started(runId) {
    if (!owns(runId)) return touchQueued(runId, () => {}) || status();
    current.phase = "running";
    current.lastProgressAt = at(now());
    return emit();
  }

  function progress(runId) {
    if (!owns(runId)) return touchQueued(runId, () => {}) || status();
    current.lastProgressAt = at(now());
    if (current.phase === "acquired") current.phase = "running";
    return emit();
  }

  function logPath(value, runId) {
    if (!value) return status();
    const apply = target => {
      target.logPath = String(value);
      target.firstLogAt = target.firstLogAt || at(now());
    };
    if (!owns(runId)) return touchQueued(runId, apply) || status();
    apply(current);
    current.lastProgressAt = at(now());
    if (current.phase === "acquired") current.phase = "running";
    return emit();
  }

  function target(runId) {
    const id = key(runId);
    if (!id) return null;
    if (owns(id)) return current;
    return waiting.get(id) || null;
  }

  function release(record) {
    record.releasedAt = at(now());
    settled.set(record.runId, record);
    while (settled.size > SETTLED_LIMIT) settled.delete(settled.keys().next().value);
    if (record === current) promote();
    else waiting.delete(record.runId);
  }

  function finish(runId, result) {
    const record = target(runId);
    if (!record) return status();
    // No result is not evidence of completion: keep the owner and say so.
    if (!result || typeof result !== "object") return markUnknown(record, "no execution result returned");
    if (result.logPath) record.logPath = String(result.logPath);
    if (result.completionMarkerVerified === true) record.completionMarkerVerified = true;
    if (typeof result.rc === "number") record.rc = result.rc;
    record.failure = result.error ? String(result.error.message || result.error)
      : result.success === false ? String(result.stderr || "execution reported success:false") : null;
    record.outcomeUnknown = false;
    record.phase = record.failure || (typeof record.rc === "number" && record.rc !== 0) ? "failed" : "completed";
    release(record);
    emit();
    return clone(record);
  }

  function fail(runId, error) {
    return finish(runId, { error: error || new Error("execution failed") });
  }

  // A thrown dispatch (transport loss, rejected tool call) does not show
  // whether Stata ran. The owner stays held; no release time is invented.
  function unknown(runId, error) {
    const record = target(runId);
    if (!record) return status();
    return markUnknown(record, String(error?.message || error || "execution outcome unknown"));
  }

  function markUnknown(record, reason) {
    record.phase = "unknown";
    record.outcomeUnknown = true;
    record.failure = reason;
    record.lastProgressAt = at(now());
    emit();
    return clone(record);
  }

  function busy() {
    return active() || waiting.size > 0;
  }

  function get(runId) {
    const id = key(runId);
    if (!id) return null;
    if (current && String(current.runId) === id) return clone(current);
    return clone(waiting.get(id) || settled.get(id) || null);
  }

  function status() {
    return clone(current);
  }

  return { adopt, begin, busy, fail, finish, get, logPath, progress, started, status, unknown };
}

module.exports = { VERSION, createExecutionLifecycle };
