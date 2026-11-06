#!/usr/bin/env node
"use strict";

// V3-KW (rc.7.90): on Windows, a confirmed Stata: KILL whose scope succeeded
// (ok, not fail-closed) ended this window's backend tree and then ran the
// verified recovery smoke on the old client, whose server had just been ended.
// Only the fail-closed branch called __codexForceReset, so the smoke always
// failed with transport-failed and the session stayed refused (423
// panic-kill-command-needs-smoke) until the window was closed. The macOS/Linux
// branch resets before its smoke. Now the Windows success branch also resets
// (dispose + reconnect) before the smoke. The reset reason contains
// "panic-kill", so the force reset reuses this scoped result and does not run
// the kill scope a second time. The fail-closed branch and the refusal until
// the smoke passes are unchanged. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.90: a successful Windows KILL resets the backend before the recovery smoke";

// Anchored after the rc.7.82 "panic-kill command" edit (it ends with `let __out=...;`)
// and before the base bundle's bridge-state block, so neither that edit nor the F2
// smoke edit is touched, and the reset runs before requestRecovery marks the smoke as due.
const RESET_BEFORE = "let __out=JSON.stringify(__codexKillScope);try{let s=globalThis.__codexBridgeState||{};";
const RESET_AFTER = "let __out=JSON.stringify(__codexKillScope);"
  + `/* ${MARKER} */if(__codexKillScope&&__codexKillScope.ok===true&&!__codexKillScope.failClosed)try{if(globalThis.__codexForceReset)await globalThis.__codexForceReset("panic-kill-command windows scoped tree ended")}catch{}`
  + "try{let s=globalThis.__codexBridgeState||{};";

const EDITS = [[RESET_BEFORE, RESET_AFTER]];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous Windows KILL reset anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes("panic-kill-command windows scoped tree ended")) throw new Error("partial Windows KILL reset patch");
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

module.exports = { patchBundle, revertBundle, MARKER, EDITS };
