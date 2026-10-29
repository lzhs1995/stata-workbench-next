#!/usr/bin/env node
"use strict";

// `_enqueue` checks cancellation only before `await this._ensureClient()`.
// Windows dev.5 step 9: a 60 s pre-run guard timed out during a cold connect,
// cancelRun was confirmed, and the queued snapshot still ran once the backend
// connected. Recheck the same token after the client is ready and before the
// operation body. The r16j89 drain text is left as is: rc7j89 identifies that
// patch by its complete text. Offline bundle edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* codex patch rc.7.68: recheck cancellation after the client is ready */";
const BEFORE = "this._cancellationSourcesByRunId.set(String(n),r);let a,c=new Promise((H,m)=>{a=m})";
const AFTER = "this._cancellationSourcesByRunId.set(String(n),r);" + MARKER
  + "{let __codexEnqueueBody=Q;Q=__client=>{if(r.token.isCancellationRequested)throw new Error(\"Request cancelled\");return __codexEnqueueBody(__client)}}"
  + "let a,c=new Promise((H,m)=>{a=m})";

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous enqueue cancellation anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, AFTER);
  } else {
    if (source.includes("__codexEnqueueBody")) throw new Error("partial enqueue cancellation patch");
    uniqueAt(source, BEFORE);
    source = source.replace(BEFORE, () => AFTER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, AFTER);
  return fingerprint.finalize(source.replace(AFTER, () => BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, BEFORE, AFTER };
