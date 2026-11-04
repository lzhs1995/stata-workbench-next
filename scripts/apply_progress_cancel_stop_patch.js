#!/usr/bin/env node
"use strict";

// V3-T3 D3 (rc.7.87): a person's Run File / Run Selection shows VS Code's
// "Running <name> [Cancel]" progress toast in the bottom-right corner, and it
// sits on top of the Stata Terminal panel's Stop button. A click there lands on
// the toast (hit test DIV.notification-list-item, Stop click counter 0), and the
// toast's own Cancel did nothing: the run body never read its cancellation
// token. The run then went on until the exec guard's 375 s IDLE cancel.
// Now the toast's Cancel goes through the panel's own Stop handler
// (TerminalPanel._handleCancelRun -> soft Stop), only while the same visible run
// is still the active one (bridge busy, same source and startedAt as when the
// toast opened). Otherwise it is logged and ignored. Other IP() users
// (connection test) are unchanged. Offline bundle edit.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.87: the progress toast's Cancel stops this visible run like Terminal Stop";

const HELPER = "/* codex patch rc.7.87: the progress toast's Cancel stops this visible run like Terminal Stop */"
  + "globalThis.__codexProgressCancelStop=(__tok,__src)=>{try{let __b=globalThis.__codexBridgeState||{},__at=__b.startedAt||null;"
  + "if(!__tok||typeof __tok.onCancellationRequested!==\"function\"||__b.busy!==true||__b.source!==__src)return null;"
  + "return __tok.onCancellationRequested(()=>{let __n=globalThis.__codexBridgeState||{},__same=__n.busy===true&&__n.source===__src&&__n.startedAt===__at;"
  + "globalThis.__codexLastProgressCancel={at:new Date().toISOString(),source:__src,runId:__n.runId||null,acted:__same};"
  + "try{RI(\"[Codex progress-cancel] \"+(__same?\"toast Cancel -> Terminal Stop for \":\"toast Cancel ignored, run changed: \")+__src)}catch{}"
  + "if(__same)Promise.resolve(Gg._handleCancelRun()).catch(__e=>{try{RI(\"[Codex progress-cancel] Stop failed: \"+(__e?.message||__e))}catch{}})})}"
  + "catch(__e){try{RI(\"[Codex progress-cancel] hook failed: \"+(__e?.message||__e))}catch{}return null}};";

// D2: when a Stop ended an agent run, /run-command answered a bare 500
// "Request cancelled" and the client could only say EXECUTION_UNCONFIRMED.
// The failure now carries stoppedBy, read from this run's own soft-stop
// supersede record (who: person = Terminal Stop / toast Cancel, api =
// POST /soft-stop, watchdog = exec guard cancel). No record for this run -> null.
const STOPPED_HELPER = "/* codex patch rc.7.87b: an agent failure says which Stop ended the run */"
  + "globalThis.__codexStoppedBy=(__rid)=>{try{if(__rid==null)return null;let __h=globalThis.__codexSupersedeHistory||[];"
  + "for(let __i=__h.length-1;__i>=0;__i--){let __r=__h[__i];if(__r&&__r.kind===\"soft-stop\"&&String(__r.runId)===String(__rid)){let __why=String(__r.reason||\"\");"
  + "return{by:/^terminal Stop button/.test(__why)?\"person\":/^http \\/soft-stop/.test(__why)?\"api\":/^guard cancel/.test(__why)?\"watchdog\":\"other\","
  + "reason:__why.slice(0,120),runId:String(__r.runId),generation:__r.toGeneration,at:__r.at}}}return null}catch(__e){return null}};";

const AGENT_FAILURE = "/* codex patch rc.7.85: confirmed Stata error */__release();let __codexPrt=e&&e.__codexPreRunTimeout;"
  + "__send(__res,(__codexPrt&&__codexPrt.status)||500,__codexPrt?Object.assign({},__codexPrt,{ok:false,runId:__runId,state:__current(),patch:__patch}):"
  + "{ok:false,error:e?.message||String(e),runId:__runId,";

const EDITS = [
  ["helper",
    "Gg.setExtensionUri(g.extensionUri),",
    "Gg.setExtensionUri(g.extensionUri)," + "(()=>{" + HELPER + STOPPED_HELPER + "})(),"],
  ["agent failure stoppedBy",
    AGENT_FAILURE,
    AGENT_FAILURE + "stoppedBy:(globalThis.__codexStoppedBy?globalThis.__codexStoppedBy(__run):null),"],
  ["selection toast",
    "await IP(\"Running selection\",async E=>{",
    "await IP(\"Running selection\",async E=>{globalThis.__codexProgressCancelStop&&globalThis.__codexProgressCancelStop(E,\"human-selection\");"],
  ["run file toast",
    "await IP(`Running ${rg.basename(A)}`,async o=>{",
    "await IP(`Running ${rg.basename(A)}`,async o=>{globalThis.__codexProgressCancelStop&&globalThis.__codexProgressCancelStop(o,\"human-file\");"],
  // D7 (webview script): a person's failing command finished with the plain title
  // "Stata Output"; the agent's failing card already says "(failed)".
  ["failed card title",
    "        if (run.statusTitle) {\n            run.statusTitle.textContent = 'Stata Output';\n        }\n        \n        const cancelBtn = document.getElementById('run-cancel-' + runId);",
    "        if (run.statusTitle) {\n            run.statusTitle.textContent = success ? 'Stata Output' : 'Stata Output (failed)'; /* codex patch rc.7.87c */\n        }\n        \n        const cancelBtn = document.getElementById('run-cancel-' + runId);"],
];

function uniqueAt(source, needle, what) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous progress-cancel anchor: " + what);
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [name, , after] of EDITS) uniqueAt(source, after, name);
  } else {
    if (source.includes("__codexProgressCancelStop") || source.includes("__codexStoppedBy") || source.includes("rc.7.87c")) throw new Error("partial progress-cancel patch");
    for (const [name, before] of EDITS) uniqueAt(source, before, name);
    for (const [, before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  for (const [name, , after] of EDITS) uniqueAt(source, after, name);
  for (const [, before, after] of [...EDITS].reverse()) source = source.replace(after, () => before);
  if (source.includes("__codexProgressCancelStop") || source.includes("__codexStoppedBy") || source.includes("rc.7.87c")) throw new Error("progress-cancel marker survived the revert");
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, EDITS, HELPER, STOPPED_HELPER };
