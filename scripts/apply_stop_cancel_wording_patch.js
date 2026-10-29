#!/usr/bin/env node
"use strict";

// Soft Stop and force reset both advance __codexResetGeneration to fence stale
// handlers. A human Run File cancelled by soft Stop then reported "cancelled
// by force reset generation N" although no reset happened (Windows dev.5 step 7,
// hardReset null). Name the cause from the supersede record that advanced the
// run's generation. Message text and /status.resetGenerationKind only: the
// fence, the error code and control flow are unchanged. Offline bundle edit.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* codex patch rc.7.69: cancellation names soft Stop or force reset */";
const BEFORE = 'let __codexResetError=new Error("human-file cancelled by force reset generation "+String(globalThis.__codexResetGeneration||0));';
// Kinds of every fence advance since this run captured its generation, in order.
// A soft Stop that escalated to force reset reports both.
const AFTER = MARKER + "let __codexResetKinds=[];try{for(let __rec of globalThis.__codexSupersedeHistory||[])"
  + "if(__rec&&Number(__rec.fromGeneration)>=__codexHumanFileResetGeneration)__codexResetKinds.push(String(__rec.kind))}catch{}"
  + "let __codexResetCause=__codexResetKinds.length?__codexResetKinds.map(__k=>__k===\"soft-stop\"?\"soft Stop\":__k===\"force-reset\"?\"force reset\":__k).join(\" then \"):\"reset\";"
  + 'let __codexResetError=new Error("human-file cancelled by "+__codexResetCause+" (generation "+String(globalThis.__codexResetGeneration||0)+")");'
  + "__codexResetError.resetKinds=__codexResetKinds;";
const STATUS_BEFORE = "resetGeneration:Number(globalThis.__codexResetGeneration||0)";
const STATUS_AFTER = STATUS_BEFORE + ",resetGenerationKind:(globalThis.__codexLastSupersede&&globalThis.__codexLastSupersede.kind)||null";

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous stop cancellation wording anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, AFTER);
    uniqueAt(source, STATUS_AFTER);
  } else {
    if (source.includes("resetGenerationKind") || source.includes("__codexResetKinds")) {
      throw new Error("partial stop cancellation wording patch");
    }
    uniqueAt(source, BEFORE);
    uniqueAt(source, STATUS_BEFORE);
    source = source.replace(BEFORE, () => AFTER).replace(STATUS_BEFORE, () => STATUS_AFTER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, AFTER);
  uniqueAt(source, STATUS_AFTER);
  return fingerprint.finalize(source.replace(AFTER, () => BEFORE).replace(STATUS_AFTER, () => STATUS_BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, BEFORE, AFTER, STATUS_BEFORE, STATUS_AFTER };
