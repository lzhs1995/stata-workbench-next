#!/usr/bin/env node
"use strict";

// F2: a guard cancel of a dispatched payload (W-P2) and a transport timeout
// after dispatch (W-P1) both go through the soft-Stop restore-readiness rule.
// Snapshot present -> restore, then READY only after the recovery smoke passes;
// snapshot absent or restore failed -> continuityLost, trueReady=false, the next
// submit refused until an explicit reset.  Later bundle patch with a revert.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next patch F2: guard cancel restores the pre-run checkpoint */";
const target = path.join(__dirname, "..", "dist", "extension.js");

// The F0 init line is the only place that already resolves a core module from
// the extension directory, so the fence shares its require shape.
const F0_MARKER = "/* next patch F0: checkpoint restore owns READY */";

const FENCE = 'globalThis.__codexGuardCancelRef=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","guard_cancel_restore_core.js"));globalThis.__codexPendingOutcomesRef=globalThis.__codexGuardCancelRef.createPendingOutcomes();globalThis.__codexGuardCancelFence=async(__fenceInput)=>{let __core=globalThis.__codexGuardCancelRef;if(!__core)return null;let __state=__fenceInput&&__fenceInput.state||{};let __verdict=__core.classifyGuardFailure({policy:__fenceInput&&__fenceInput.policy,outcome:__fenceInput&&__fenceInput.outcome,settlement:__fenceInput&&__fenceInput.settlement,errorText:(__fenceInput&&__fenceInput.errorText)||__state.error,dispatched:true});globalThis.__codexLastGuardCancelVerdict=__verdict;if(!__verdict.restore)return __verdict;if(globalThis.__codexGuardCancelBusy)return __verdict;globalThis.__codexGuardCancelBusy=true;let __runId=(__fenceInput&&__fenceInput.runId)!=null?__fenceInput.runId:__state.runId;try{if(__verdict.outcomeUnknown&&globalThis.__codexPendingOutcomesRef)try{globalThis.__codexPendingOutcomesRef.open(__runId,{reason:__verdict.reason,outcome:__verdict.outcome,sourceMode:(__fenceInput&&__fenceInput.sourceMode)||__state.sourceMode})}catch{}try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.begin(__runId)}catch{}let __stop=null,__stopError=null;try{__stop=globalThis.__codexSoftStop?await globalThis.__codexSoftStop("guard cancel: "+String(__verdict.reasonCode||"EXEC_GUARD_CANCEL")):null}catch(__e){__stopError=__e&&__e.message||String(__e)}__verdict.restored=__core.restoreEstablished(__stop);__verdict.stopRecoveryClass=__stop&&__stop.recoveryClass||null;if(!__verdict.restored){let __note=__core.continuityNote(__verdict,__stop,__stopError);globalThis.__codexContinuityLost={at:new Date().toISOString(),runId:__runId==null?null:String(__runId),...__note};try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__note.detail)}catch{}}try{globalThis.__codexRecoveryState=__codexControl.requestRecovery(globalThis.__codexRecoveryState,"guard-cancel-needs-smoke: "+String(__verdict.reasonCode||"EXEC_GUARD_CANCEL"))}catch{}try{globalThis.__codexGraphMark&&__codexGraphMark({readinessState:"stale",readinessReason:"guard-cancel-restore",readinessRunId:__runId==null?null:String(__runId),readinessUpdatedAt:new Date().toISOString(),lastClientError:__verdict.reason||__verdict.reasonCode})}catch{}globalThis.__codexLastGuardCancelRestore={at:new Date().toISOString(),runId:__runId==null?null:String(__runId),verdict:__verdict,stopRecoveryClass:__verdict.stopRecoveryClass,stopError:__stopError};return __verdict}finally{globalThis.__codexGuardCancelBusy=false}};' + MARKER;

// 2) Central guard wrapper: fence both the rethrown transport rejection and the
//    outcome envelope.  Anchor text is produced by rc.7.13b, reverted exactly.
const WRAP_BEFORE = 'if(!__r.ok){if(__r.error)throw __r.error;';
const WRAP_AFTER = 'if(!__r.ok){let __codexCancelVerdict=null;try{__codexCancelVerdict=await globalThis.__codexGuardCancelFence({policy:__pol,runId:__rid,sourceMode:__so.sourceMode||null,outcome:__r.outcome?__r.outcome.code:null,settlement:__r.settlement,errorText:(__r.error&&__r.error.message)||__r.error||__st.error,state:__st})}catch{}if(__r.error){if(__codexCancelVerdict&&__codexCancelVerdict.restore){try{__r.error.__codexGuardFailure=globalThis.__codexGuardCancelRef.unknownEnvelope(__codexCancelVerdict,{policy:__pol,runId:__rid,sourceMode:__so.sourceMode||null,elapsedMs:__st.elapsedMs,message:(__r.error&&__r.error.message)||String(__r.error),status:(__st.recoveryRequired?503:504)});__r.error.__codexPreRunTimeout=__r.error.__codexGuardFailure}catch{}}throw __r.error}';

// The outcome envelope is built a few statements later; annotate it in place.
const ENVELOPE_BEFORE = 'recoveryRequired:!!__st.recoveryRequired,elapsedMs:__st.elapsedMs};__e2.__codexPreRunTimeout=__e2.__codexGuardFailure;throw __e2}';
const ENVELOPE_AFTER = 'recoveryRequired:!!__st.recoveryRequired,elapsedMs:__st.elapsedMs};try{globalThis.__codexGuardCancelRef&&__codexCancelVerdict&&globalThis.__codexGuardCancelRef.annotateEnvelope(__e2.__codexGuardFailure,__codexCancelVerdict)}catch{}__e2.message=String(__e2.__codexGuardFailure.error||__code);__e2.__codexPreRunTimeout=__e2.__codexGuardFailure;throw __e2}';

// 3) Terminal input runs its own inline guard, not __codexGuardWrap.
const TERM_BEFORE = 'if(!__codexTermGuard.ok){let __codexTermCode=__codexTermGuard.outcome?__codexTermGuard.outcome.code:"EXEC_PROGRESS_STALL",__codexTermErr=new Error(__codexTermCode);';
const TERM_AFTER = 'if(!__codexTermGuard.ok){let __codexTermVerdict=null;try{__codexTermVerdict=await globalThis.__codexGuardCancelFence({policy:globalThis.__codexExecGuardRef.POLICY.PROGRESS,runId:__codexTermRunId,sourceMode:"terminal-input",outcome:__codexTermGuard.outcome?__codexTermGuard.outcome.code:null,settlement:__codexTermGuard.settlement,errorText:(__codexTermGuard.error&&__codexTermGuard.error.message)||__codexTermGuard.error||__codexTermState.error,state:__codexTermState})}catch{}let __codexTermCode=__codexTermGuard.outcome?__codexTermGuard.outcome.code:"EXEC_PROGRESS_STALL",__codexTermErr=new Error(__codexTermCode);';

const TERM_ENVELOPE_BEFORE = 'recoveryRequired:!!__codexTermState.recoveryRequired,elapsedMs:__codexTermState.elapsedMs};globalThis.__codexLastTerminalFailure=__codexTermErr.__codexPreRunTimeout;throw __codexTermErr}';
const TERM_ENVELOPE_AFTER = 'recoveryRequired:!!__codexTermState.recoveryRequired,elapsedMs:__codexTermState.elapsedMs};try{globalThis.__codexGuardCancelRef&&__codexTermVerdict&&globalThis.__codexGuardCancelRef.annotateEnvelope(__codexTermErr.__codexPreRunTimeout,__codexTermVerdict)}catch{}__codexTermErr.message=String(__codexTermErr.__codexPreRunTimeout.error||__codexTermCode);globalThis.__codexLastTerminalFailure=__codexTermErr.__codexPreRunTimeout;throw __codexTermErr}';

// 4) trueReady: an unknown outcome keeps the session closed.  Placed after the
//    F0 restore gate so the restore reason wins when both apply.
const GATE_BEFORE = '/* next F0: restore gate */\n';
const GATE_AFTER = GATE_BEFORE + '    try{const __pendingOutcome=globalThis.__codexPendingOutcomesRef?globalThis.__codexPendingOutcomesRef.gate():null;if(__pendingOutcome)return{ready:false,status:__pendingOutcome.status,reason:__pendingOutcome.reason};}catch(__pendingError){return{ready:false,status:"outcome-unknown",reason:"pending outcome gate threw: "+String((__pendingError&&__pendingError.message)||__pendingError)};}' + MARKER + '\n';

// 5) /status surfaces the pending list next to restoreReadiness.
const STATUS_BEFORE = 'restoreReadiness:globalThis.__codexRestoreReadinessRef?globalThis.__codexRestoreReadinessRef.status():null,';
const STATUS_AFTER = STATUS_BEFORE + 'pendingOutcomes:globalThis.__codexPendingOutcomesRef?globalThis.__codexPendingOutcomesRef.status():null,lastGuardCancelRestore:globalThis.__codexLastGuardCancelRestore||null,';

// 6) The two places F0 already resets READY also clear the pending list: a
//    verified recovery smoke, and a force reset that needs no smoke.
const SMOKE_BEFORE = 'globalThis.__codexRestoreReadinessRef.reset("recovery-smoke-verified")}catch{}';
const SMOKE_AFTER = 'globalThis.__codexRestoreReadinessRef.reset("recovery-smoke-verified")}catch{}try{globalThis.__codexPendingOutcomesRef&&globalThis.__codexPendingOutcomesRef.clear("recovery-smoke-verified")}catch{}';

const FORCE_BEFORE = 'if(!__needsSmoke&&__reconnect&&__reconnect.ok===true)try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("force-reset-complete")}catch{}}catch{}let __state=__current();';
// A force reset that happens *inside* a soft-Stop escalation is automatic, not
// a user reset (P3): it must not release the pending list.  The soft-Stop
// wrapper sets __codexSoftStopInFlight for exactly that window.
const FORCE_AFTER = 'if(!__needsSmoke&&__reconnect&&__reconnect.ok===true&&!globalThis.__codexSoftStopInFlight){try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("force-reset-complete")}catch{}try{globalThis.__codexPendingOutcomesRef&&globalThis.__codexPendingOutcomesRef.clear("force-reset-complete")}catch{}}' + MARKER + '}catch{}let __state=__current();';

// P3: wrap the single soft-Stop global so the rule covers every caller — the
// Terminal Stop button (yM), HTTP /soft-stop, and the guard fence — without
// editing any of their handlers.  The wrapper runs after the escalation's own
// automatic force reset has already finished (soft Stop awaits it before
// returning), so the block it sets is the last word.
const SOFTSTOP_ANCHOR = "/* codex patch rc.7.10: soft Stop preserves the pre-run dataset */";
const SOFTSTOP_WRAP = SOFTSTOP_ANCHOR + 'globalThis.__codexSoftStopRestoreFence=(__stop,__stopError,__context)=>{let __core=globalThis.__codexGuardCancelRef;if(!__core)return null;let __verdict;try{__verdict=__core.classifySoftStopRestore(__stop,__stopError)}catch(__classifyError){__verdict={restored:false,continuityLost:{reason:"soft-stop-restore-classification-threw",detail:String(__classifyError&&__classifyError.message||__classifyError),requiresExplicitReset:true}}}globalThis.__codexLastSoftStopRestoreVerdict=Object.assign({at:new Date().toISOString(),source:String((__context&&__context.source)||"soft-stop")},__verdict);if(__verdict.restored)return __verdict;let __runId=(__context&&__context.runId)!=null?__context.runId:((__stop&&__stop.runId)||null);globalThis.__codexContinuityLost={at:new Date().toISOString(),runId:__runId==null?null:String(__runId),source:String((__context&&__context.source)||"soft-stop"),...__verdict.continuityLost};globalThis.__codexContinuityNote=null;try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__verdict.continuityLost.detail)}catch{}try{globalThis.__codexRecoveryState=__codexControl.requestRecovery(globalThis.__codexRecoveryState,"soft-stop-needs-smoke: "+String(__verdict.continuityLost.reason))}catch{}try{globalThis.__codexGraphMark&&__codexGraphMark({readinessState:"stale",readinessReason:__verdict.continuityLost.reason,readinessRunId:__runId==null?null:String(__runId),readinessUpdatedAt:new Date().toISOString(),lastClientError:__verdict.continuityLost.detail})}catch{}try{RI("[Codex bridge] soft Stop did not restore the checkpoint; READY stays closed until an explicit reset: "+__verdict.continuityLost.detail)}catch{}return __verdict};globalThis.__codexSoftStop=(__codexInnerSoftStop=>async __reason=>{let __stop=null,__stopError=null;globalThis.__codexSoftStopInFlight=String(__reason||"soft-stop");try{__stop=await __codexInnerSoftStop(__reason)}catch(__e){__stopError=__e&&__e.message||String(__e)}finally{globalThis.__codexSoftStopInFlight=null}try{globalThis.__codexSoftStopRestoreFence(__stop,__stopError,{source:String(__reason||"soft-stop"),runId:(__stop&&__stop.runId)||null})}catch{}if(__stopError!=null)throw new Error(__stopError);return __stop})(globalThis.__codexSoftStop);' + MARKER;

const EDITS = [
  ["fence init", F0_MARKER, F0_MARKER + FENCE],
  ["soft-stop restore fence", SOFTSTOP_ANCHOR, SOFTSTOP_WRAP],
  ["guard wrap fence", WRAP_BEFORE, WRAP_AFTER],
  ["guard wrap envelope", ENVELOPE_BEFORE, ENVELOPE_AFTER],
  ["terminal fence", TERM_BEFORE, TERM_AFTER],
  ["terminal envelope", TERM_ENVELOPE_BEFORE, TERM_ENVELOPE_AFTER],
  ["true-ready gate", GATE_BEFORE, GATE_AFTER],
  ["status payload", STATUS_BEFORE, STATUS_AFTER],
  ["smoke clear", SMOKE_BEFORE, SMOKE_AFTER],
  ["force-reset clear", FORCE_BEFORE, FORCE_AFTER],
];

function once(source, name, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`F2 ${name} anchor count=${count}`);
  return source.replace(before, after);
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) return options.finalize === false ? source : fingerprint.finalize(source).text;
  let text = source;
  for (const [name, before, after] of EDITS) text = once(text, name, before, after);
  return options.finalize === false ? text : fingerprint.finalize(text).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) return source;
  let text = source;
  for (const [, before, after] of [...EDITS].reverse()) {
    if (!text.includes(after)) throw new Error("F2 revert anchor missing");
    text = text.replace(after, before);
  }
  if (text.includes(MARKER)) throw new Error("F2 marker survived the revert");
  return fingerprint.finalize(text).text;
}

if (require.main === module) {
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { MARKER, EDITS, patchBundle, revertBundle };
