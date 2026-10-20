#!/usr/bin/env node
"use strict";

// Offline maintained-bundle patch. No installation, bridge or Stata access.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.40: inline body returns to product finalizer";

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) return source;
  let text = source;
  function once(before, after) {
    const at = text.indexOf(before);
    if (at < 0 || text.indexOf(before, at + before.length) >= 0) {
      throw new Error("missing or ambiguous patch anchor: " + before.slice(0, 100));
    }
    text = text.slice(0, at) + after + text.slice(at + before.length);
  }
  const start = text.indexOf('    const intended = "set more off\\n" + __codexBodyCode +');
  const end = text.indexOf("    rec.tempDoFile = tempDoFile;", start);
  if (start < 0 || end < start || end - start > 300) {
    throw new Error("inline writer shape changed");
  }
  text = text.slice(0, start) + [
    '    const intended = "set more off\\n" + __codexBodyCode + "\\n";',
    "    /* " + MARKER + " */",
    "    rec.executionCode = require(rg.join(",
    '      (yC && yC.extensionUri && yC.extensionUri.fsPath) || process.cwd(),',
    '      "scripts", "runfile_finalizer_core.js")).buildFinalizerCode({',
    "        bodyPath: tempDoFile, snapshotPath: stateSnapshotPath, runId,",
    "        stataString: __codexStataString",
    "      });",
    "    rec.completionMarkerInRunner = true;",
    '    rec.executionCodeSha256 = require("node:crypto").createHash("sha256").update(rec.executionCode).digest("hex");',
    '    rec.bodySha256 = require("node:crypto").createHash("sha256").update(intended).digest("hex");',
    ""
  ].join("\n") + text.slice(end);

  for (const [suffix, indent] of [["A", "          "], ["B", "        "]]) {
    const before = indent + 'code: \'do "\' + __codexStataString(tempDoFile) + \'"\',\n'
      + indent + "tempDoFile,";
    once(before, indent + "code: __codexWriteCheck" + suffix + ".executionCode,\n"
      + indent + "completionMarkerInRunner: true,\n" + indent + "tempDoFile,");
  }
  // The finalizer owns exactly one terminal marker outside the author body.
  once(
    "if(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)try{let __markerLine=",
    "if(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile&&!__codexPreparedHumanFileRun.completionMarkerInRunner)try{let __markerLine="
  );
  // The separate huge-document/source-selection route may not use this driver.
  once(
    "if(!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)){let __markerLine=",
    "if(!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)||(__codexHumanFileIsHugeMiDocumentRun&&__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.completionMarkerInRunner)){let __markerLine="
  );
  once(
    '__rc=o&&typeof o.rc==="number"?o.rc:(typeof __life.rc==="number"?__life.rc:(__inspection&&typeof __inspection.rc==="number"?__inspection.rc:null)),',
    '__rc=__inspection&&__inspection.finalizerReturnCodeVerified?__inspection.rc:(o&&typeof o.rc==="number"?o.rc:(typeof __life.rc==="number"?__life.rc:(__inspection&&typeof __inspection.rc==="number"?__inspection.rc:null))),'
  );
  once(
    "let __completion=!!(__life.perRunCompletionMarkerVerified||(__inspection&&__inspection.completionMarkerVerified)),",
    "let __completion=!(__inspection&&__inspection.finalizerEvidenceInvalid)&&!!(__life.perRunCompletionMarkerVerified||(__inspection&&__inspection.completionMarkerVerified)),"
  );
  once(
    '__error=o&&o.error||null;if(typeof __rc!=="number"&&__completion)',
    '__error=(__inspection&&__inspection.finalizerEvidenceInvalid)?new Error("invalid run-file finalizer evidence"):(o&&o.error||null);if(typeof __rc!=="number"&&__completion)'
  );
  once(
    'if(typeof __inspection.rc==="number"&&__inspection.rc!==0)state.sawError=true;',
    'if(__inspection.finalizerReturnCodeVerified&&perRunDiskEvidence)state.finalizerRc=__inspection.rc;if(typeof __inspection.rc==="number"&&__inspection.rc!==0)state.sawError=true;'
  );
  once(
    'logPath: state.logPath || __codexMarkerLife.logPath || null\n          });',
    'logPath: state.logPath || __codexMarkerLife.logPath || null,\n            rc: state.finalizerRc\n          });'
  );
  once(
    'e=I.logPath||B.logPath||null,t={event:"task_done",task_id:E,run_id:Q,status:"completed",rc:0,path:e,result:{success:!0,rc:0,task_id:E,log_path:e}};',
    'e=I.logPath||B.logPath||null,__finalRc=Number.isSafeInteger(I.rc)&&I.rc>=0?I.rc:0,t={event:"task_done",task_id:E,run_id:Q,status:__finalRc===0?"completed":"failed",rc:__finalRc,path:e,result:{success:__finalRc===0,rc:__finalRc,task_id:E,log_path:e}};'
  );
  // Retain the real pre-run checkpoint if the post-run snapshot could not be
  // restored. It is evidence and a possible future recovery input, not READY.
  once(
    'try{globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r)}catch{}/* codex patch rc.7.10: normal completion removes pre-run snapshot */',
    'try{if(!(globalThis.__codexContinuityLost&&String(globalThis.__codexContinuityLost.runId)===String(r))){globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r)}}catch{}/* codex patch rc.7.10: normal completion removes pre-run snapshot *//* codex patch rc.7.40: failed continuity retains pre-run checkpoint */'
  );
  return options.finalize === false ? text : fingerprint.finalize(text).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (before !== after) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}
module.exports = { patchBundle, MARKER };
