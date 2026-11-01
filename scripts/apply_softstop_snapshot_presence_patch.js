#!/usr/bin/env node
"use strict";

// F0 P3: a registered, ready checkpoint whose .dta disappeared is recovery
// failure.  It must never be treated as the harmless "no snapshot" case.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* codex patch rc.7.75: missing ready snapshot fails closed */";
const OLD_PLAN = "let __codexRestorePlan=__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)"
  + "&&globalThis.__codexStopCheckpointRef.restorePlan"
  + "?globalThis.__codexStopCheckpointRef.restorePlan(globalThis.__codexStopCheckpointRef.restoreCode(__snapshot,__codexStataString),__codexPayloadAdmittedAtStop)"
  + ":{dispatch:true};";
const NEW_PLAN = "let __codexRestoreSnapshot=globalThis.__codexStopCheckpointRef"
  + "&&typeof globalThis.__codexStopCheckpointRef.classifyRestoreSnapshot===\"function\""
  + "?globalThis.__codexStopCheckpointRef.classifyRestoreSnapshot(__snapshot):"
  + "(__snapshot&&__snapshot.path?{kind:\"present\"}:{kind:\"none\"}),"
  + "__codexRestorePlan=__codexRestoreSnapshot.kind===\"present\""
  + "&&globalThis.__codexStopCheckpointRef.restorePlan"
  + "?globalThis.__codexStopCheckpointRef.restorePlan(globalThis.__codexStopCheckpointRef.restoreCode(__snapshot,__codexStataString),__codexPayloadAdmittedAtStop)"
  + ":__codexRestoreSnapshot.kind===\"missing\""
  + "?{dispatch:false,restore:{ok:false,path:__snapshot&&__snapshot.path||null,"
  + "error:__codexRestoreSnapshot.error||\"pre-run dataset snapshot missing or unreadable\","
  + "continuityLost:true}}"
  + ":{dispatch:true};";
const LEGACY_PLAN = "let __codexRestoreSnapshot=globalThis.__codexStopCheckpointRef"
  + "&&typeof globalThis.__codexStopCheckpointRef.classifyRestoreSnapshot===\"function\""
  + "?globalThis.__codexStopCheckpointRef.classifyRestoreSnapshot(__snapshot):"
  + "(__snapshot&&__snapshot.path?{kind:\"present\"}:{kind:\"none\"}),"
  + "__codexRestorePlan=__codexRestoreSnapshot.kind===\"present\""
  + "&&globalThis.__codexStopCheckpointRef.restorePlan"
  + "?globalThis.__codexStopCheckpointRef.restorePlan(globalThis.__codexStopCheckpointRef.restoreCode(__snapshot,__codexStataString),__codexPayloadAdmittedAtStop)"
  + ":__codexRestoreSnapshot.kind===\"missing\""
  + "?{dispatch:false,restore:{ok:false,path:__snapshot&&__snapshot.path||null,"
  + "error:__codexRestoreSnapshot.error||\"pre-run dataset snapshot missing or unreadable\","
  + "continuityLost:true}}"
  + ":{dispatch:false,restore:{ok:true,skipped:__codexRestoreSnapshot.skipped||\"no pre-run dataset snapshot\"}};";

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous snapshot-presence anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    if (source.includes(NEW_PLAN)) uniqueAt(source, NEW_PLAN);
    else {
      uniqueAt(source, LEGACY_PLAN + MARKER);
      source = source.replace(LEGACY_PLAN + MARKER, () => NEW_PLAN + MARKER);
    }
  } else {
    uniqueAt(source, OLD_PLAN);
    source = source.replace(OLD_PLAN, () => NEW_PLAN + MARKER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  uniqueAt(source, NEW_PLAN + MARKER);
  source = source.replace(NEW_PLAN + MARKER, () => OLD_PLAN);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, OLD_PLAN, NEW_PLAN };
