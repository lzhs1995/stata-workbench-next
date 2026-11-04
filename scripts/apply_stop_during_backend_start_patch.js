#!/usr/bin/env node
"use strict";

// V3-M M3 (Mac, 2026-11-04): Stop pressed while the backend was still starting
// (rc.7.67 cold start, before the rc.7.72 warm-up had begun) locked the session as
// soft-stop-did-not-restore-checkpoint. Nothing had been dispatched, but the skip
// rule only looked at the warm-up state, so the snapshotless quiescence probe ran,
// queued behind Stata start-up, timed out at 5 s and forced a reset that ended
// RECOVERY_FAILED. Skip the probe as well while this run's backend start is still
// WAITING or was CANCELLED: rc.7.67 throws PRE_RUN_BACKEND_START_CANCELLED before
// the warm-up and before any dispatch. Every other case keeps the probe.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.83: Stop during backend start-up skips the quiescence probe";

// rc.7.79 and rc.7.80 each insert their helper right after an earlier helper's last
// line and re-find it as anchor+HELPER, so this one goes after the last of them:
// the end of the rc.7.80 helper when present, else the end of the rc.7.79 helper.
const HELPER_ANCHORS = [
  "try { if (typeof globalThis.__codexEnsureBackendWarm === \"function\") globalThis.__codexEnsureBackendWarm = __codexWbTimedWarm(\"ext_backend_warm\", globalThis.__codexEnsureBackendWarm); } catch {}\n",
  "globalThis.__codexTerminalWarmup = __codexTerminalWarmup;\n",
];
const HELPER = String.raw`${MARKER}
// Keep the rc.7.72 rule by reference: rebinding the global below must not make it call itself.
const __codexWarmupSkipsQuiescenceBase = __codexWarmupSkipsQuiescence;
function __codexStopDuringStartSkipsQuiescence(runId) {
  if (__codexWarmupSkipsQuiescenceBase(runId)) return true;
  let start = null;
  try { start = typeof globalThis.__codexBackendStartSummary === "function" ? globalThis.__codexBackendStartSummary().current : null; } catch {}
  return !!start && runId != null && start.runId === String(runId)
    && (start.outcome === "WAITING" || start.outcome === "CANCELLED");
}
globalThis.__codexWarmupSkipsQuiescence = __codexStopDuringStartSkipsQuiescence;
`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous stop-during-backend-start anchor");
  }
  return at;
}

function count(source, needle) { return source.split(needle).length - 1; }

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, HELPER);
  } else {
    if (source.includes("__codexStopDuringStartSkipsQuiescence")) throw new Error("partial stop-during-backend-start patch");
    const anchor = HELPER_ANCHORS.find((a) => count(source, a) === 1);
    if (!anchor) throw new Error("missing or ambiguous stop-during-backend-start anchor");
    source = source.replace(anchor, () => anchor + HELPER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, HELPER);
  return fingerprint.finalize(source.replace(HELPER, () => "")).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHORS };
