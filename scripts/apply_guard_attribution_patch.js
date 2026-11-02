#!/usr/bin/env node
"use strict";

// F fix5 (W3, 2026-11-02, Windows).
//
// W-P10. The guard-cancel fence named every PROGRESS stall EXEC_PRELOG_STALL,
// so the watchdog's IDLE cancel was locked as "guard-cancel-needs-smoke:
// EXEC_PRELOG_STALL", and /status only had lastTerminalGuardFailure, which the
// agent path never writes: it still showed the earlier Terminal cold-start
// failure (elapsedMs 120917). The fence now passes the guard's own stallReason
// and elapsedMs, labels the Stop and recovery reasons with them, and records
// every cancel, from any path, as lastGuardFailure.
//
// W-P1b / W-P9m root cause. A run_command_background cancelled before its
// response arrived never learned its task_id. mcp-stata still ran it after the
// break; its late log_path event carried that unknown task_id and the client
// matched it to whatever run was active (the quiescence probe), so the probe
// tailed the cancelled command's log. The client now remembers such orphans.
// While one is outstanding, an event whose task_id is unknown is not given to
// the active run: if that run already has its own task_id the event is dropped;
// if not, the event is held until the run learns its id, then replayed (it
// matches) or dropped (it does not). Without an orphan nothing changes.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* codex patch rc.7.78: guard cancel names its own stall and events stay with their task */";

// --- W-P10 ---------------------------------------------------------------
// The classify call itself belongs to rc.7.77, which re-checks those bytes on
// replay, so the guard's stallReason and elapsedMs are attached right after it.
const LABEL = "(__core.reasonLabel?__core.reasonLabel(__verdict):String(__verdict.reasonCode||\"EXEC_GUARD_CANCEL\"))";
const OLD_STOP_REASON = "await globalThis.__codexSoftStop(\"guard cancel: \"+String(__verdict.reasonCode||\"EXEC_GUARD_CANCEL\"))";
const NEW_STOP_REASON = "await globalThis.__codexSoftStop(\"guard cancel: \"+" + LABEL + ")";
const OLD_RECOVERY_REASON = "\"guard-cancel-needs-smoke: \"+String(__verdict.reasonCode||\"EXEC_GUARD_CANCEL\")";
const NEW_RECOVERY_REASON = "\"guard-cancel-needs-smoke: \"+" + LABEL;

// Every guard failure that reaches the fence becomes lastGuardFailure. A
// Terminal failure from earlier is marked superseded so nobody reads it as
// the current one.
const OLD_LAST_VERDICT = "globalThis.__codexLastGuardCancelVerdict=__verdict;";
const NEW_LAST_VERDICT = "try{__core.withStall&&__core.withStall(__verdict,__state)}catch{}" + OLD_LAST_VERDICT
  + "try{if(__core.failureRecord){let __rec=__core.failureRecord(__verdict,{runId:(__fenceInput&&__fenceInput.runId)!=null?__fenceInput.runId:__state.runId,"
  + "sourceMode:(__fenceInput&&__fenceInput.sourceMode)||__state.sourceMode||null});globalThis.__codexLastGuardFailure=__rec;"
  + "let __term=globalThis.__codexLastTerminalFailure;if(__term&&typeof __term===\"object\"&&__rec.sourceMode!==\"terminal-input\")"
  + "__term.supersededBy={at:__rec.at,runId:__rec.runId,sourceMode:__rec.sourceMode,label:__rec.label}}}catch{}";

const OLD_STATUS = "lastGuardCancelRestore:globalThis.__codexLastGuardCancelRestore||null,";
const NEW_STATUS = OLD_STATUS + "lastGuardFailure:globalThis.__codexLastGuardFailure||null,";

// --- event attribution ---------------------------------------------------
// _onLoggingMessage: the fallback to the active run.
const OLD_FALLBACK = "if(t&&(o=this._runsByTaskId.get(String(t))||null),!o&&this._activeRun&&(!this._activeRun.taskId||e===\"progress\"||e===\"log_path\")&&(o=this._activeRun),o&&o._cancelled&&e!==\"task_done\")return;";
// A held event is decided only when the run learns its id: a fast command's own
// task_done can arrive before its response, so it must not count as the orphan's.
const NEW_FALLBACK = "if(t&&(o=this._runsByTaskId.get(String(t))||null),!o&&t&&this._orphanStrict"
  + "&&(this._orphanStrict()||this._activeRun&&this._activeRun._replayingHeld)){"
  + "let __act=this._activeRun;"
  + "if(__act&&!__act.taskId&&!__act._replayingHeld){(__act._heldEvents=__act._heldEvents||[]).push(I);"
  + "this._log(`[mcp-stata] held ${e||\"event\"} for task ${t} until run ${__act._runId||\"unknown\"} learns its task id`);return}"
  + "if(e===\"task_done\")this._orphanSettled(String(t));"
  + "this._log(`[mcp-stata] dropped ${e||\"event\"} for task ${t}: not this client's run (active run ${__act&&__act._runId||\"none\"}, task ${__act&&__act.taskId||\"none\"})`);return}"
  + OLD_FALLBACK;

// _withActiveRun finally. Only the background tools run inside _withActiveRun,
// and their response always carries the task id, so a run that ends without one
// never saw its response: cancelled, timed out or cut off. mcp-stata may still
// run it, so it is an orphan (cancellation alone is not required: the guard's
// bounded cancel can cut the call without marking the run). Held events of a
// run that ends without an id are dropped; a held task_done still settles one
// orphan.
const OLD_RUN_FINALLY = "finally{this._activeRun=Q,A?.taskId&&this._scheduleRunCleanup(String(A.taskId))}}";
const NEW_RUN_FINALLY = "finally{this._activeRun=Q,A?.taskId&&this._scheduleRunCleanup(String(A.taskId));"
  + "if(A&&typeof A==\"object\"&&!A.taskId){let __held=A._heldEvents||[];A._heldEvents=null;"
  + "for(let __ev of __held){let __d=__ev?.params?.data;if(typeof __d===\"string\")__d=this._tryParseJson(__d);"
  + "if(__d&&__d.event===\"task_done\")this._orphanSettled(String(__d.task_id||__d.taskId||\"\"))}"
  + "if(__held.length)this._log(`[mcp-stata] dropped ${__held.length} held event(s): run ${A._runId||\"unknown\"} ended without a task id`);"
  + "this._orphanOpen(A._runId)}}}";

// _awaitBackgroundResult: once the run learns its task id, replay what was held.
const OLD_TRACK = "if(E&&(I.taskId=E,this._trackRunForTask(E,I)),this._attachTaskCancellation(A,I,B),!E)return Q;";
// The original condition is one comma expression; the replay joins it.
const NEW_TRACK = "if(E&&(I.taskId=E,this._trackRunForTask(E,I)),E&&this._replayHeld(A,I),"
  + "this._attachTaskCancellation(A,I,B),!E)return Q;";

// Helpers on the client class, next to _trackRunForTask. Orphans expire after
// ten minutes so a lost task_done cannot keep strict mode on forever.
const OLD_HELPERS = "_trackRunForTask(A,I){";
const NEW_HELPERS = "_orphanOpen(A){(this._orphans=this._orphans||[]).push({runId:A==null?null:String(A),at:Date.now()});"
  + "this._log(`[mcp-stata] run ${A||\"unknown\"} was cancelled before it learned its task id; events for unknown tasks stay off other runs until it reports done`)}"
  + "_orphanStrict(){let __now=Date.now();this._orphans=(this._orphans||[]).filter(__o=>__now-__o.at<6e5);return this._orphans.length>0}"
  + "_orphanSettled(A){if(!this._orphans||!this._orphans.length)return;let __o=this._orphans.shift();"
  + "this._log(`[mcp-stata] task ${A} reported done; counted as the cancelled run ${__o.runId||\"unknown\"}`)}"
  + "_replayHeld(A,I){let __held=I&&I._heldEvents;if(!__held||!__held.length)return;I._heldEvents=null;I._replayingHeld=!0;"
  + "try{for(let __ev of __held)this._onLoggingMessage(A,__ev)}finally{I._replayingHeld=!1}}"
  + OLD_HELPERS;

const PAIRS = [
  ["guard-cancel stop reason", OLD_STOP_REASON, NEW_STOP_REASON],
  ["guard-cancel recovery reason", OLD_RECOVERY_REASON, NEW_RECOVERY_REASON],
  ["guard-cancel failure record", OLD_LAST_VERDICT, NEW_LAST_VERDICT],
  ["status lastGuardFailure", OLD_STATUS, NEW_STATUS],
  ["event fallback to active run", OLD_FALLBACK, NEW_FALLBACK + MARKER],
  ["active run finally", OLD_RUN_FINALLY, NEW_RUN_FINALLY],
  ["task id learned", OLD_TRACK, NEW_TRACK],
  ["orphan helpers", OLD_HELPERS, NEW_HELPERS],
];

function uniqueAt(source, needle, label) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error(`missing or ambiguous guard attribution anchor: ${label}`);
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (!source.includes(MARKER)) {
    for (const [label, before] of PAIRS) uniqueAt(source, before, label);
    for (const [, before, after] of PAIRS) source = source.replace(before, () => after);
  } else {
    for (const [label, , after] of PAIRS) uniqueAt(source, after, "patched " + label);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("guard attribution marker missing");
  for (const [label, , after] of PAIRS) uniqueAt(source, after, "patched " + label);
  for (const [, before, after] of [...PAIRS].reverse()) source = source.replace(after, () => before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, PAIRS, OLD_FALLBACK, NEW_FALLBACK, OLD_RUN_FINALLY,
  NEW_RUN_FINALLY, OLD_TRACK, NEW_TRACK, OLD_HELPERS, NEW_HELPERS, 
  OLD_STOP_REASON, NEW_STOP_REASON, OLD_RECOVERY_REASON, NEW_RECOVERY_REASON, OLD_LAST_VERDICT, NEW_LAST_VERDICT,
  OLD_STATUS, NEW_STATUS };
