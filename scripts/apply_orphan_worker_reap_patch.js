#!/usr/bin/env node
"use strict";

// V3-W2 (coordinator 02:33 finding, reproduced 02:55): on macOS a KILL / force
// reset during a running command left the old Stata worker alive with ppid 1,
// holding this session's files, while /status said READY. Force reset ends only
// the mcp-stata server; its multiprocessing worker is reaped only on a normal
// server exit. This patch (not on Windows, where rc.7.82 ends the whole tree):
// 1) when force reset starts, records the identity (pid, start time, cwd) of the
//    owned server's descendants, in parallel with the cancel;
// 2) after dispose, ends only a recorded process whose pid, start time and cwd
//    still match and whose cwd is inside this session's workspace / mcp-temp
//    (SIGTERM, then SIGKILL after a grace period). Unknown identity: report only;
// 3) /status shows `orphanWorkers` (the close tool reports its own).
// Logic in scripts/orphan_worker_core.js. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.89: force reset ends this session's orphaned Stata worker";

const REQ = 'require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","orphan_worker_core.js"))';

const CAPTURE_BEFORE = 'try{RI("[Codex bridge] force reset requested: "+(o||"unknown"))}catch{}';
// Placed before the rc.7.82 line so rc.7.82's own inserted text stays contiguous (exact revert).
const CAPTURE_AFTER = `/* ${MARKER} */globalThis.__codexOrphanCaptureP=null;if(process.platform!=="win32")try{`
  + 'globalThis.__codexOrphanCaptureP=' + REQ + '.startCapture(globalThis.__codexOwnedBackendPids)'
  + '}catch(__oce){globalThis.__codexOrphanCaptureP=Promise.resolve(null)}' + CAPTURE_BEFORE;

const REAP_BEFORE = '__codexDispose.error=String(e?.message||e)}try{HF("connected")}catch{}';
const REAP_AFTER = REAP_BEFORE + '/* codex patch rc.7.89: end recorded orphan workers after dispose */'
  + 'if(globalThis.__codexOrphanCaptureP)try{let __cp=globalThis.__codexOrphanCaptureP,__d=[];globalThis.__codexOrphanCaptureP=null;'
  + 'try{for(let __f of (iA.workspace.workspaceFolders||[]))__d.push(__f&&__f.uri&&__f.uri.fsPath)}catch{}'
  + 'try{__d.push(globalThis.__codexNextMultiRef.dirs.tempDir)}catch{}'
  + 'globalThis.__codexOrphanReap=await ' + REQ + '.finishReap(__cp,__d,{generation:__codexThisResetGeneration,reason:o});'
  + 'let __ow=globalThis.__codexOrphanReap.orphanWorkers;if(__ow.length)try{RI("[Codex bridge] force reset orphan workers: "+__ow.map(w=>String(w.pid)+":"+w.reason+(w.ended?":ended":"")).join(","))}catch{}'
  + '}catch(__ore){globalThis.__codexOrphanReap={at:new Date().toISOString(),orphanWorkers:[{pid:null,startedAt:null,ended:false,reason:"reap-failed"}]}}';

// After rc.7.88's whole inserted field, so rc.7.88 stays contiguous.
const STATUS_BEFORE = 'catch(__wce){return{error:"watchdogCpu unavailable"}}})(),';
const STATUS_AFTER = STATUS_BEFORE + "orphanWorkers:globalThis.__codexOrphanReap||null,";

const EDITS = [[CAPTURE_BEFORE, CAPTURE_AFTER], [REAP_BEFORE, REAP_AFTER], [STATUS_BEFORE, STATUS_AFTER]];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous orphan worker reap anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes("__codexOrphanCaptureP") || source.includes("orphan_worker_core")) {
      throw new Error("partial orphan worker reap patch");
    }
    for (const [before] of EDITS) uniqueAt(source, before);
    for (const [before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

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
