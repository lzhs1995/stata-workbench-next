#!/usr/bin/env node
"use strict";

// FULL45 S40 (Mac rc.7.44, 2026-10-30): Stop landed 10 s into an Agent run,
// while the pre-run checkpoint was still saving 160 estimates and 50 graphs.
// The Break cut the graph-save loop, so graphs.txt ended in a half-written
// name and restoreCode() refused with its "exit 459" sentinel. Soft Stop sent
// that sentinel to Stata anyway; embedded Stata answers a top-level exit with
// "--Break-- r(1)", so the restore failed and the instance went
// continuity-lost (HTTP 500 STOP_FAILED) although the payload had never been
// dispatched. Only a force reset cleared it.
//
// Each run's pre-run snapshot now records whether it passed its last pre-run
// Stop fence (payloadAdmitted). Soft Stop reads that flag before its first
// await and asks stop_checkpoint_core.restorePlan() whether to dispatch the
// restore. A refused restore is never sent to Stata: with the payload not
// admitted the pre-run state is intact and Stop completes; otherwise the
// restore fails as before, without dispatching. Offline bundle edit; no
// install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* codex patch rc.7.74: soft Stop never dispatches a refused checkpoint restore */";

// Computed before the restore branch so the rc.7.13 guard-wiring anchor after
// `let __restoreCode=…;try{` stays byte-identical.
const RESTORE_IF = "if(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)){let __restoreCode=";
const PLAN = "let __codexRestorePlan=__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)"
  + "&&globalThis.__codexStopCheckpointRef.restorePlan"
  + "?globalThis.__codexStopCheckpointRef.restorePlan(globalThis.__codexStopCheckpointRef.restoreCode(__snapshot,__codexStataString),__codexPayloadAdmittedAtStop)"
  + ":{dispatch:true};";

// [before, after] pairs; every `before` is unique in the rc.7.73 bundle.
const ANCHORS = {
  bridgeRegister: ['sourceMode:"visible-bridge",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};',
    'sourceMode:"visible-bridge",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0,payloadAdmitted:false};'],
  bridgeAdmit: ["fallbackDispatchCount:Number(__codexBridgeAtomic.fallbackDispatchCount||0)});",
    "fallbackDispatchCount:Number(__codexBridgeAtomic.fallbackDispatchCount||0),payloadAdmitted:true});"],
  humanRegister: ['sourceMode:"human-file",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};',
    'sourceMode:"human-file",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0,payloadAdmitted:false};'],
  humanAdmit: ["fallbackDispatchCount:Number(__codexHfAtomic.fallbackDispatchCount||0)});",
    "fallbackDispatchCount:Number(__codexHfAtomic.fallbackDispatchCount||0),payloadAdmitted:true});"],
  // Soft Stop entry: read before the generation advances and before any await.
  stopEntry: ["__codexPreDispatchRestore=!!globalThis.__codexStopCheckpointRef.isSnapshotReady(__snapshot)",
    "__codexPreDispatchRestore=!!globalThis.__codexStopCheckpointRef.isSnapshotReady(__snapshot),"
      + "__codexPayloadAdmittedAtStop=__snapshot?__snapshot.payloadAdmitted:undefined" + MARKER],
  // The restore branch: plan first, dispatch only when the plan says so.
  restore: ["await new Promise(__resolve=>setTimeout(__resolve,250));" + RESTORE_IF,
    "await new Promise(__resolve=>setTimeout(__resolve,250));" + PLAN
      + "if(!__codexRestorePlan.dispatch){__restore=Object.assign({path:__snapshot.path,bytes:__snapshot.bytes||null,"
      + "payloadAdmitted:__codexPayloadAdmittedAtStop===undefined?null:__codexPayloadAdmittedAtStop},__codexRestorePlan.restore)}else "
      + RESTORE_IF],
};
const EDITS = Object.values(ANCHORS);

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous soft-stop incomplete checkpoint anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
    if (source.split("__codexPayloadAdmittedAtStop").length - 1 !== 4) {
      throw new Error("partial soft-stop incomplete checkpoint patch");
    }
  } else {
    if (source.includes("__codexPayloadAdmittedAtStop") || source.includes("payloadAdmitted:")) {
      throw new Error("partial soft-stop incomplete checkpoint patch");
    }
    for (const [before] of EDITS) uniqueAt(source, before);
    for (const [before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  for (const [, after] of EDITS) uniqueAt(source, after);
  for (const [before, after] of [...EDITS].reverse()) source = source.replace(after, () => before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, ANCHORS, EDITS };
