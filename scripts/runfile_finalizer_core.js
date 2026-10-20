"use strict";

// The author/instrumented body remains a separate do-file. An exit in that file
// returns to this driver; it cannot skip the snapshot or the completion record.
// Keep this code in the product, never in a researcher's source file.
function buildFinalizerCode(input) {
  const runId = String(input.runId || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new Error("invalid finalizer runId");
  const q = input.stataString || ((value) => String(value).replace(/"/g, '""'));
  if (!input.bodyPath || !input.snapshotPath) throw new Error("missing finalizer path");
  const tick = String.fromCharCode(96);
  const local = (name) => tick + name + "'";
  return [
    'capture noisily do "' + q(input.bodyPath) + '"',
    "local __codex_body_rc = _rc",
    'capture noisily save "' + q(input.snapshotPath) + '", replace emptyok',
    "local __codex_snapshot_rc = _rc",
    "local __codex_run_rc = " + local("__codex_body_rc"),
    "if " + local("__codex_run_rc") + " == 0 local __codex_run_rc = " + local("__codex_snapshot_rc"),
    'display as text "___CODEX_BODY_RC_' + runId + '___=" %12.0f ' + local("__codex_body_rc"),
    'display as text "___CODEX_SNAPSHOT_RC_' + runId + '___=" %12.0f ' + local("__codex_snapshot_rc"),
    'display as text "___CODEX_RUN_RC_' + runId + '___=" %12.0f ' + local("__codex_run_rc"),
    'display as text "___CODEX_RUN_DONE_' + runId + '___"',
    "exit " + local("__codex_run_rc"),
    ""
  ].join("\n");
}

module.exports = { buildFinalizerCode };
