#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next patch F0: checkpoint restore owns READY */";
const target = path.join(__dirname, "..", "dist", "extension.js");

function once(source, name, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`F0 ${name} anchor count=${count}`);
  return source.replace(before, after);
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) return options.finalize === false ? source : fingerprint.finalize(source).text;
  let text = source;
  const editGateMarker = "/* next patch E1: agent .do edits require explicit diff acceptance */";
  text = once(text, "core initialization", editGateMarker,
    editGateMarker + 'globalThis.__codexRestoreReadinessRef=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","restore_readiness_core.js")).createRestoreReadiness();' + MARKER);
  text = once(text, "status payload", 'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,...(globalThis.__codexBundleIdentityStatus?',
    'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,restoreReadiness:globalThis.__codexRestoreReadinessRef?globalThis.__codexRestoreReadinessRef.status():null,...(globalThis.__codexBundleIdentityStatus?');
  text = once(text, "true-ready gate", '    const readiness = String(graph.readinessState || "").toLowerCase();',
    '    const __restoreReadiness = globalThis.__codexRestoreReadinessRef?globalThis.__codexRestoreReadinessRef.status():null;\n    if (__restoreReadiness && __restoreReadiness.ready !== true) return { ready: false, status: __restoreReadiness.status || "restoring", reason: __restoreReadiness.reason || "checkpoint restore not complete" };/* next F0: restore gate */\n    const readiness = String(graph.readinessState || "").toLowerCase();');
  text = once(text, "restore begin", '__s.postRunBusy=true;__s.lastPostRunBusyReason="soft-stop-cancelling";',
    '__s.postRunBusy=true;__s.lastPostRunBusyReason="soft-stop-cancelling";try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.begin(__runId)}catch{}');
  text = once(text, "restore readiness completion", 'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);',
    'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.finish(__runId,{ready:__codexStopReady.ready,reason:__codexStopReady.readinessReason,degraded:__codexStopReady.recoveryClass==="RECOVERED_DEGRADED"})}catch(__f0RestoreError){try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__f0RestoreError?.message||String(__f0RestoreError))}catch{}}');
  text = once(text, "restore failure", 'catch(__softStopError){globalThis.__codexLastSoftStop=',
    'catch(__softStopError){try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__softStopError?.message||String(__softStopError))}catch{}globalThis.__codexLastSoftStop=');
  text = once(text, "recovery smoke reset", 'globalThis.__codexRecoveryState=__codexControl.clearRecovery(globalThis.__codexRecoveryState,{runId:__internalBody.runId});',
    'globalThis.__codexRecoveryState=__codexControl.clearRecovery(globalThis.__codexRecoveryState,{runId:__internalBody.runId});try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("recovery-smoke-verified")}catch{}');
  text = once(text, "force reset reset", 'lastClientError:__needsSmoke?("force reset requires smoke after "+(__smokeReason||o||"unknown")):null})}catch{}let __state=__current();',
    'lastClientError:__needsSmoke?("force reset requires smoke after "+(__smokeReason||o||"unknown")):null});if(!__needsSmoke&&__reconnect&&__reconnect.ok===true)try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("force-reset-complete")}catch{}}catch{}let __state=__current();');
  return options.finalize === false ? text : fingerprint.finalize(text).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("F0 marker missing");
  let text = source;
  const editGateMarker = "/* next patch E1: agent .do edits require explicit diff acceptance */";
  text = text.replace('try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__softStopError?.message||String(__softStopError))}catch{}globalThis.__codexLastSoftStop=', 'globalThis.__codexLastSoftStop=');
  text = text.replace('globalThis.__codexRecoveryState=__codexControl.clearRecovery(globalThis.__codexRecoveryState,{runId:__internalBody.runId});try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("recovery-smoke-verified")}catch{}', 'globalThis.__codexRecoveryState=__codexControl.clearRecovery(globalThis.__codexRecoveryState,{runId:__internalBody.runId});');
  text = text.replace('lastClientError:__needsSmoke?("force reset requires smoke after "+(__smokeReason||o||"unknown")):null});if(!__needsSmoke&&__reconnect&&__reconnect.ok===true)try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.reset("force-reset-complete")}catch{}}catch{}let __state=__current();', 'lastClientError:__needsSmoke?("force reset requires smoke after "+(__smokeReason||o||"unknown")):null})}catch{}let __state=__current();');
  text = text.replace('try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.finish(__runId,{ready:__codexStopReady.ready,reason:__codexStopReady.readinessReason,degraded:__codexStopReady.recoveryClass==="RECOVERED_DEGRADED"})}catch(__f0RestoreError){try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.fail(__runId,__f0RestoreError?.message||String(__f0RestoreError))}catch{}}', 'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);');
  text = text.replace('__s.postRunBusy=true;__s.lastPostRunBusyReason="soft-stop-cancelling";try{globalThis.__codexRestoreReadinessRef&&globalThis.__codexRestoreReadinessRef.begin(__runId)}catch{}', '__s.postRunBusy=true;__s.lastPostRunBusyReason="soft-stop-cancelling";');
  text = text.replace('    const __restoreReadiness = globalThis.__codexRestoreReadinessRef?globalThis.__codexRestoreReadinessRef.status():null;\n    if (__restoreReadiness && __restoreReadiness.ready !== true) return { ready: false, status: __restoreReadiness.status || "restoring", reason: __restoreReadiness.reason || "checkpoint restore not complete" };/* next F0: restore gate */\n', '');
  text = text.replace('graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,restoreReadiness:globalThis.__codexRestoreReadinessRef?globalThis.__codexRestoreReadinessRef.status():null,...(globalThis.__codexBundleIdentityStatus?', 'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,...(globalThis.__codexBundleIdentityStatus?');
  text = text.replace(editGateMarker + 'globalThis.__codexRestoreReadinessRef=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","restore_readiness_core.js")).createRestoreReadiness();' + MARKER, editGateMarker);
  return fingerprint.finalize(text).text;
}

if (require.main === module) {
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { MARKER, patchBundle, revertBundle };
