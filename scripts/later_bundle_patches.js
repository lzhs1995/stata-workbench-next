"use strict";

// Bundle patches applied after apply_backend_cold_start_patch in the replay
// chain (apply_rc7_shared_execution_patch.js), in replay order. Tests that pin
// earlier sealed bytes revert these first, newest first. Append new patches here.
const LATER = [
  "./apply_default_service_constraint_patch",
  "./apply_enqueue_cancel_recheck_patch",
  "./apply_stop_cancel_wording_patch",
  "./apply_prerun_stop_fence_patch",
  "./apply_backend_warmup_patch",
  "./apply_single_do_pagination_patch",
  "./apply_softstop_incomplete_checkpoint_patch",
  "./apply_softstop_snapshot_presence_patch",
  "./apply_next_identity_patch",
  "./apply_next_agent_identity_patch",
  "./apply_next_bridge_auth_patch",
  "./apply_edit_proposal_patch",
  "./apply_next_multi_session_patch",
  "./apply_restore_readiness_patch",
  "./apply_next_bridge_busy_notice_patch",
  "./apply_f0b_stop_button_fallback_patch",
  "./apply_guard_cancel_restore_patch",
  "./apply_download_uri_binding_patch",
];

function revertLaterPatches(source) {
  for (const name of [...LATER].reverse()) source = require(name).revertBundle(source);
  return source;
}

// Reverts only the patches replayed after `name`, giving the layer that `name` sealed.
function revertAfter(source, name) {
  const at = LATER.indexOf(name);
  if (at < 0) throw new Error(`Unknown later patch ${name}`);
  for (const later of LATER.slice(at + 1).reverse()) source = require(later).revertBundle(source);
  return source;
}

module.exports = { LATER, revertLaterPatches, revertAfter };
