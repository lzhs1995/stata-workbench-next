"use strict";

// F0: checkpoint restore is a separate readiness dimension.  The bridge may
// have stopped executing while the dataset/state restore is still in flight.
function createRestoreReadiness(options = {}) {
  const now = options.now || (() => Date.now());
  let active = false;
  let runId = null;
  let startedAt = null;
  let finishedAt = null;
  let ready = true;
  let reason = null;

  function begin(id) {
    active = true;
    runId = id == null ? null : String(id);
    startedAt = now();
    finishedAt = null;
    ready = false;
    reason = "checkpoint restore in progress";
    return status();
  }

  function finish(id, result = {}) {
    if (runId !== null && id != null && String(id) !== runId) return status();
    active = false;
    finishedAt = now();
    const ok = result.ready === true || (result.ok === true && result.degraded !== true);
    ready = ok;
    reason = ok ? null : String(result.reason || "checkpoint restore did not establish READY");
    return status();
  }

  function fail(id, error) {
    return finish(id, { ready: false, reason: String(error || "checkpoint restore failed") });
  }

  function status() {
    return { active, ready, runId, startedAt, finishedAt, reason, status: active ? "restoring" : (ready ? "ready" : "stale") };
  }

  return { begin, finish, fail, status };
}

module.exports = { createRestoreReadiness };
