#!/usr/bin/env node
"use strict";

// V3-W (V3-M M4 / F-mac P5): the PROGRESS watchdog counted only mcp log growth,
// so `bootstrap ..., nodots` and other commands that print nothing for 60 s
// were cancelled as IDLE and the session locked. Stata runs in the mcp-stata
// worker, so this patch installs a probe for the CPU time of this window's own
// backend tree (scripts/worker_cpu_progress_core.js, root = newest live pid in
// __codexOwnedBackendPids, which must be a direct child of this extension host)
// and hands it to both PROGRESS call sites (agent /
// shared execution and Terminal input). The guard uses it for IDLE only;
// PRE_LOG, HARD_BUDGET and every failure path keep the log-only schedule.
// Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.84: worker CPU time counts as watchdog progress";

const INSTALL_BEFORE = '"scripts","execution_guard.js"))),/* codex patch rc.7.13a: PROGRESS policy kernel */';
const INSTALL_AFTER = INSTALL_BEFORE + `/* ${MARKER} */__codexWorkerCpuProbeInstalled=(function(){try{`
  + 'let __wc=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","worker_cpu_progress_core.js"));'
  + 'globalThis.__codexWorkerCpuProbe=__wc.createOwnedTreeCpuProbe({getRoot:()=>__wc.latestOwnedRoot(globalThis.__codexOwnedBackendPids,(__p)=>{try{process.kill(__p,0);return true}catch(__e){return !!(__e&&__e.code==="EPERM")}},process.pid)});'
  + 'return true}catch(__wce){globalThis.__codexWorkerCpuProbe=null;return false}})(),';

const AGENT_BEFORE = "structuralLong:!!__so.structuralLong,probe:()=>{";
const AGENT_AFTER = "structuralLong:!!__so.structuralLong,cpuProbe:(typeof globalThis.__codexWorkerCpuProbe===\"function\"?globalThis.__codexWorkerCpuProbe:null),probe:()=>{";

const TERM_BEFORE = "})(),probe:()=>{try{let __s=globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.getRunExecutionState(__codexTermRunId)";
const TERM_AFTER = "})(),cpuProbe:(typeof globalThis.__codexWorkerCpuProbe===\"function\"?globalThis.__codexWorkerCpuProbe:null),probe:()=>{try{let __s=globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.getRunExecutionState(__codexTermRunId)";

const EDITS = [[INSTALL_BEFORE, INSTALL_AFTER], [AGENT_BEFORE, AGENT_AFTER], [TERM_BEFORE, TERM_AFTER]];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous worker CPU progress anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes("__codexWorkerCpuProbe") || source.includes("worker_cpu_progress_core")) {
      throw new Error("partial worker CPU progress patch");
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
