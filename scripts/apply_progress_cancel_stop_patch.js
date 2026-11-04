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

const EDITS = [
  ["helper",
    "Gg.setExtensionUri(g.extensionUri),",
    "Gg.setExtensionUri(g.extensionUri)," + "(()=>{" + HELPER + "})(),"],
  ["selection toast",
    "await IP(\"Running selection\",async E=>{",
    "await IP(\"Running selection\",async E=>{globalThis.__codexProgressCancelStop&&globalThis.__codexProgressCancelStop(E,\"human-selection\");"],
  ["run file toast",
    "await IP(`Running ${rg.basename(A)}`,async o=>{",
    "await IP(`Running ${rg.basename(A)}`,async o=>{globalThis.__codexProgressCancelStop&&globalThis.__codexProgressCancelStop(o,\"human-file\");"],
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
    if (source.includes("__codexProgressCancelStop")) throw new Error("partial progress-cancel patch");
    for (const [name, before] of EDITS) uniqueAt(source, before, name);
    for (const [, before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  for (const [name, , after] of EDITS) uniqueAt(source, after, name);
  for (const [, before, after] of [...EDITS].reverse()) source = source.replace(after, () => before);
  if (source.includes("__codexProgressCancelStop")) throw new Error("progress-cancel marker survived the revert");
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, EDITS, HELPER };
