#!/usr/bin/env node
"use strict";

// Offline maintained-bundle patch. No installation or Stata connection.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch: bridge pre-run failure never dispatches payload";
const START = "let __codexBridgePreRunSnapshot=null;try{";
const END = "/* codex patch rc.7.10.36: visible bridge snapshots pre-run dataset */";
const STAT = 'Object.assign(__codexBridgePreRunSnapshot,{bytes:JA.statSync(__snapshotPath).size,at:new Date().toISOString(),provisional:false});';
const ENRICH_STATE = 'globalThis.__codexPreRunGuardRef.createStageState("enrich",{runId:__run,sourceMode:"visible-bridge",snapshotPath:__snapshotPath})';
const OLD_CATCH = '}catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI("[Codex bridge] pre-run stage timeout; refusing to dispatch payload: "+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}throw __snapshotError}try{RI("[Codex bridge] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}';
const NEW_CATCH = `}catch(__snapshotError){/* ${MARKER} */
// Preserve the guard's original 500/504/503 envelope and cancellation evidence.
let __failure=__snapshotError;
if(!(__failure&&__failure.__codexPreRunTimeout)){
  let __message=String(__snapshotError?.message||__snapshotError);
  let __pending=!!(__codexBridgePreRunSnapshot&&__codexBridgePreRunSnapshot.transportPromiseAttached&&!__codexBridgePreRunSnapshot.transportPromiseSettled);
  let __state={preRunStage:"setup",result:"SYNC_THREW",timedOut:false,error:__message,runId:__run,sourceMode:"visible-bridge",snapshotPath:__codexBridgePreRunSnapshot?.path||null,payloadDispatched:false,recoveryRequired:__pending,httpStatus:500,completedAt:new Date().toISOString()};
  globalThis.__codexPreRunStage=__state;
  __failure=Object.assign(new Error(__message),{cause:__snapshotError,__codexPreRunTimeout:{...__state,ok:false,status:500,error:"PRE_RUN_SETUP_FAILED",reasonCode:"PRE_RUN_SETUP_FAILED",message:__message}});
}
try{RI("[Codex bridge] pre-run failed; refusing to dispatch payload: "+JSON.stringify(__failure.__codexPreRunTimeout))}catch{}
// Keep checkpoint bytes and Stop ownership. This cleanup touches only JS/UI.
try{globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(__run,"visible-bridge-predispatch-error-release"):globalThis.__codexSetPostRunBusy&&__codexSetPostRunBusy(false,"visible-bridge-predispatch-error-release",__run)}catch{}
try{__run&&Gg.failStreamingEntry(__run,__failure.message)}catch{}
throw __failure;
}`;
const REPLACEMENTS = [
  // Allocate both stage records before beginAtomic can submit any code.
  ['snapshotPath:__snapshotPath});globalThis.__codexPreRunStage=__codexSnapStage;',
    'snapshotPath:__snapshotPath}),__codexEnrichStage=' + ENRICH_STATE + ';globalThis.__codexPreRunStage=__codexSnapStage;'],
  [STAT + 'let __codexEnrichStage=' + ENRICH_STATE + ';', ''],
  ['()=>globalThis.__codexStopCheckpointRef.completeAtomic(__codexBridgeAtomic)',
    'async()=>{let __checkpoint=await globalThis.__codexStopCheckpointRef.completeAtomic(__codexBridgeAtomic,{allowFallback:false});' + STAT + 'return __checkpoint}'],
  [OLD_CATCH, NEW_CATCH],
];

function uniqueAt(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous bridge pre-run failure anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  const start = uniqueAt(source, START);
  const end = source.indexOf(END, start);
  if (end < 0) throw new Error("missing bridge pre-run end anchor");
  let block = source.slice(start, end);
  if (source.includes(MARKER)) {
    uniqueAt(source, MARKER);
    for (const [, after] of REPLACEMENTS) if (after) uniqueAt(block, after);
    if (block.includes(OLD_CATCH) || block.includes('let __codexEnrichStage=')) {
      throw new Error("ambiguous bridge pre-run failure patch");
    }
  } else {
    for (const [before, after] of REPLACEMENTS) {
      const at = uniqueAt(block, before);
      block = block.slice(0, at) + after + block.slice(at + before.length);
    }
    source = source.slice(0, start) + block + source.slice(end);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { patchBundle, MARKER, START, END };
