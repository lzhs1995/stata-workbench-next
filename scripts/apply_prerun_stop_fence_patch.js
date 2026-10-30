#!/usr/bin/env node
"use strict";

// Soft Stop advances __codexResetGeneration at once, but a Run File (or Agent
// run) compared that fence only after its payload had settled. A Stop that
// landed in the pre-run enrich window cancelled the checkpoint task; when that
// task had already reported task_done the guard still returned ok, the
// checkpoint fallback re-dispatched, and the payload was dispatched after the
// Stop. Soft Stop then waited on the new payload transport, which nothing had
// cancelled, and escalated to force reset (Windows dev.8 stop cycle 2,
// recovery-required). Check the fence before every pre-run dispatch and once
// more after the enrich guard; no await separates that check from the payload
// call. Offline bundle edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* codex patch rc.7.71: Stop in the pre-run window refuses the payload */";

// Shared helper: throws the pre-run refusal envelope when the fence moved.
const HELPER_BEFORE = "catch(__e){return null}};globalThis.__codexGuardTransport={";
const HELPER_AFTER = "catch(__e){return null}};" + MARKER
  + "globalThis.__codexPreRunStopFence=(__stage,__stageState,__runId,__sourceMode,__fromGeneration)=>{"
  + "let __gen=Number(globalThis.__codexResetGeneration||0);if(__gen===Number(__fromGeneration))return;"
  + "let __kinds=[];try{for(let __rec of globalThis.__codexSupersedeHistory||[])"
  + "if(__rec&&Number(__rec.fromGeneration)>=Number(__fromGeneration))__kinds.push(String(__rec.kind))}catch{}"
  + "let __cause=__kinds.length?__kinds.map(__k=>__k===\"soft-stop\"?\"soft Stop\":__k===\"force-reset\"?\"force reset\":__k).join(\" then \"):\"reset\";"
  + "let __message=__sourceMode+\" pre-run cancelled by \"+__cause+\" (generation \"+String(__gen)+\"); payload not dispatched\";"
  + "let __body=Object.assign(globalThis.__codexPreRunGuardRef.timeoutResponse(__stage,__stageState||globalThis.__codexPreRunGuardRef.createStageState(__stage,{runId:__runId,sourceMode:__sourceMode})),"
  + "{status:409,error:\"PRE_RUN_CANCELLED_BY_STOP\",reasonCode:\"PRE_RUN_CANCELLED_BY_STOP\",message:__message,runId:__runId==null?null:String(__runId),sourceMode:__sourceMode,"
  + "payloadDispatched:false,resetGeneration:__gen,runResetGeneration:Number(__fromGeneration),resetKinds:__kinds});"
  + "throw Object.assign(new Error(__message),{code:\"PRE_RUN_CANCELLED_BY_STOP\",resetKinds:__kinds,__codexPreRunTimeout:__body})};"
  + "globalThis.__codexGuardTransport={";

const BRIDGE_GEN_BEFORE = 'Gg._postMessage({type:"cleared"});/* codex patch v4: display-only clear before visible bridge run */';

// Tolerant call: fixtures that run one bundle block without activation lack the helper.
const fenceCall = (stage, state, run, mode, gen) => "globalThis.__codexPreRunStopFence&&globalThis.__codexPreRunStopFence("
  + [JSON.stringify(stage), state, run, JSON.stringify(mode), gen].join(",") + ");";
const fenceHf = (stage, state) => fenceCall(stage, state, "r", "human-file", "__codexHumanFileResetGeneration");
const fenceBr = (stage, state) => fenceCall(stage, state, "__run", "visible-bridge", "__codexBridgeResetGeneration");

// [before, after] pairs. The rc.7.13 wiring pins the text from each snapshot
// guard to its runSelection callsite, so the fences sit outside those spans.
const ANCHORS = {
  helper: [HELPER_BEFORE, HELPER_AFTER],
  // Before the atomic checkpoint: guardStage calls work() synchronously, so no
  // Stop can land between this check and the dispatch.
  humanSnapshot: ["globalThis.__codexPreRunStage=__codexHfSnapStage;let __codexHfSnapGuard=await",
    "globalThis.__codexPreRunStage=__codexHfSnapStage;" + fenceHf("snapshot", "__codexHfSnapStage") + "let __codexHfSnapGuard=await"],
  bridgeSnapshot: ["globalThis.__codexPreRunStage=__codexSnapStage;let __codexSnapGuard=await",
    "globalThis.__codexPreRunStage=__codexSnapStage;" + fenceBr("snapshot", "__codexSnapStage") + "let __codexSnapGuard=await"],
  // The Run File checkpoint fallback re-dispatches through the same transport;
  // it passes the fence first (the Agent bridge disables the fallback).
  humanFallback: ['guardStage("enrich",()=>globalThis.__codexStopCheckpointRef.completeAtomic(__codexHfAtomic),{',
    'guardStage("enrich",()=>globalThis.__codexStopCheckpointRef.completeAtomic(__codexHfAtomic,{legacyRunSelection:(__code,__options)=>('
      + fenceHf("checkpoint", "null").slice(0, -1) + ",__codexHfAtomic.runSelection(__code,__options))}),{"],
  // After the enrich guard: a checkpoint that finished despite the Stop is not
  // a pass. No await lies between this check and the payload dispatch.
  humanEnrich: ['"enrich",__codexHfEnrichStage)});', '"enrich",__codexHfEnrichStage)});' + fenceHf("enrich", "__codexHfEnrichStage")],
  bridgeEnrich: ['"enrich",__codexEnrichStage)});', '"enrich",__codexEnrichStage)});' + fenceBr("enrich", "__codexEnrichStage")],
  // The Agent bridge had no generation of its own; take it right after acquire
  // (no await lies between acquire and this point).
  bridgeGeneration: [BRIDGE_GEN_BEFORE, BRIDGE_GEN_BEFORE + "let __codexBridgeResetGeneration=Number(globalThis.__codexResetGeneration||0);"],
};
const EDITS = Object.values(ANCHORS);

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous pre-run Stop fence anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
    if (source.split("__codexPreRunStopFence(").length - 1 !== 5) throw new Error("partial pre-run Stop fence patch");
  } else {
    if (source.includes("__codexPreRunStopFence") || source.includes("__codexBridgeResetGeneration")) {
      throw new Error("partial pre-run Stop fence patch");
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
