#!/usr/bin/env node
"use strict";

// V3-M M5: a Stata error that ran to its r(n) line is reported as executed with
// Stata's return code instead of an unconfirmed failure.
// - Agent /run-command threw `new Error(message)` on a failed mcp-stata result,
//   so rc and log path were lost; the run was released "without verified
//   completion evidence" and the client could only say UNCONFIRMED.
// - Terminal input reported rc -1 because mcp-stata's normalized rc was 0.
// stata_error_outcome_core.classify() decides; anything it does not confirm
// (Stop, watchdog, guard, Break, another run's log, rc mismatch, missing log)
// keeps the previous response. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.85: confirmed Stata errors report their return code";

const HELPER_ANCHOR = "globalThis.__codexTerminalWarmup = __codexTerminalWarmup;\n";
const HELPER = String.raw`
${MARKER}
// Returns the classify() outcome for this run, or null if it could not run.
function __codexStataErrorOutcome(runId, result, error, cancelled) {
  try {
    const nodePath = require("node:path"), nodeFs = require("node:fs");
    const root = (yC && yC.extensionUri && yC.extensionUri.fsPath) || process.cwd();
    const core = require(nodePath.join(root, "scripts", "stata_error_outcome_core.js"));
    const bridge = globalThis.__codexBridgeState || {};
    const life = bridge.lifecycle || {};
    const logPath = (result && typeof result.logPath === "string" && result.logPath) || null;
    let logText = null;
    if (logPath && nodeFs.existsSync(logPath)) {
      const stat = nodeFs.statSync(logPath), length = Math.min(stat.size, 65536), buffer = Buffer.alloc(length);
      const fd = nodeFs.openSync(logPath, "r");
      try { if (length) nodeFs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length)); } finally { nodeFs.closeSync(fd); }
      logText = buffer.toString("utf8");
    }
    const outcome = core.classify({ runId: runId == null ? null : String(runId), result, error, logPath,
      lifecycle: { runId: life.runId, logPath: life.logPath || logPath }, logText, cancelled: Boolean(cancelled),
      completionMarker: runId ? "___CODEX_RUN_DONE_" + String(runId) + "___" : null });
    globalThis.__codexLastStataErrorOutcome = { runId: runId == null ? null : String(runId), at: new Date().toISOString(),
      confirmed: outcome.confirmed, stataRc: outcome.stataRc, reasons: outcome.reasons };
    return { ...outcome, logPath };
  } catch (classifyError) {
    globalThis.__codexLastStataErrorOutcome = { runId: runId == null ? null : String(runId), confirmed: false,
      reasons: ["classify-failed"], error: String(classifyError && classifyError.message || classifyError) };
    return null;
  }
}
globalThis.__codexStataErrorOutcome = __codexStataErrorOutcome;
`;

const THROW_BEFORE = 'if(__r&&(__r.success===!1||__r.error||__r.raw?.error)){let __err=__r.raw?.error||__r.error?.message||__r.stderr||"Stata execution failed";throw new Error(String(__err))}';
const THROW_AFTER = 'if(__r&&(__r.success===!1||__r.error||__r.raw?.error)){let __err=__r.raw?.error||__r.error?.message||__r.stderr||"Stata execution failed";throw Object.assign(new Error(String(__err)),{__codexStataResult:__r})/* codex patch rc.7.85: keep the mcp-stata result */}';

const CATCH_BEFORE = '__run&&Gg.failStreamingEntry(__run,e?.message||String(e));__release();let __codexPrt=e&&e.__codexPreRunTimeout;__send(__res,(__codexPrt&&__codexPrt.status)||500,__codexPrt?';
const CATCH_AFTER = '__run&&Gg.failStreamingEntry(__run,e?.message||String(e));let __codexSe=null;try{__codexSe=e&&e.__codexStataResult&&!(e.__codexPreRunTimeout)&&typeof globalThis.__codexStataErrorOutcome==="function"?globalThis.__codexStataErrorOutcome(__run,e.__codexStataResult,e,!!((typeof __codexBridgePreRunSnapshot!=="undefined"&&__codexBridgePreRunSnapshot&&__codexBridgePreRunSnapshot.stopOwned)||e.__codexStataResult.__codexWatchdogRelease)):null}catch{__codexSe=null}if(__codexSe&&__codexSe.confirmed){__release({rc:__codexSe.stataRc,logPath:__codexSe.logPath,error:e});__send(__res,500,{ok:false,outcome:"STATA_ERROR",executed:true,stataRc:__codexSe.stataRc,payloadMayHaveRun:true,error:e?.message||String(e),runId:__run,requestId:__runId,logPath:__codexSe.logPath,lifecycle:__codexExecution.publicLifecycle(globalThis.__codexBridgeState||{}),state:__current(),patch:__patch});return}/* codex patch rc.7.85: confirmed Stata error */__release();let __codexPrt=e&&e.__codexPreRunTimeout;__send(__res,(__codexPrt&&__codexPrt.status)||500,__codexPrt?';

const TERMINAL_BEFORE = '__codexTerminalFinal={...Q,success:!1,rc:typeof Q.rc=="number"&&Q.rc!==0?Q.rc:-1,stderr:Q.stderr||String(B),error:{message:String(B)}}';
const TERMINAL_AFTER = 'let __codexTse=typeof globalThis.__codexStataErrorOutcome==="function"?globalThis.__codexStataErrorOutcome(A?.runId||null,Q,null,!!Q.__codexWatchdogRelease):null;/* codex patch rc.7.85: Terminal reports a confirmed Stata rc */__codexTerminalFinal={...Q,success:!1,rc:__codexTse&&__codexTse.confirmed?__codexTse.stataRc:(typeof Q.rc=="number"&&Q.rc!==0?Q.rc:-1),stataErrorConfirmed:!!(__codexTse&&__codexTse.confirmed),stderr:Q.stderr||String(B),error:{message:String(B)}}';

const EDITS = [[HELPER_ANCHOR, HELPER_ANCHOR + HELPER], [THROW_BEFORE, THROW_AFTER],
  [CATCH_BEFORE, CATCH_AFTER], [TERMINAL_BEFORE, TERMINAL_AFTER]];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous Stata error outcome anchor: " + needle.slice(0, 80));
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes("__codexStataErrorOutcome") || source.includes("__codexStataResult")) {
      throw new Error("partial Stata error outcome patch");
    }
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
