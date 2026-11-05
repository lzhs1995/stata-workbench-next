#!/usr/bin/env node
"use strict";

// V3-W2 D5: the PROGRESS watchdog already keeps its worker CPU counters
// (cpuSamples, cpuSampleErrors, cpuProgressCount, cpuSamplesExpired,
// cpuProbeVersion, and from rc.7.88 cpuErrorKinds) in its state, and the bundle
// stores the last summaries in __codexLastGuard / __codexLastTerminalGuard, but
// /status never read them, so a false IDLE cancel could only be diagnosed from
// the output log. This adds one read-only field, `watchdogCpu`, built by
// execution_guard.cpuStatus(): the guard that is running now (if any) and the
// last agent and Terminal summaries. Numbers and short labels only; no paths,
// no code. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.88: /status shows the watchdog's worker CPU counters";

const STATUS_BEFORE = "lastTerminalGuardFailure:globalThis.__codexLastTerminalFailure||null,";
const STATUS_AFTER = STATUS_BEFORE + `/* ${MARKER} */watchdogCpu:(function(){try{let __eg=globalThis.__codexExecGuardRef;`
  + "return __eg&&typeof __eg.cpuStatus===\"function\"?__eg.cpuStatus(globalThis.__codexLastGuard||null,"
  + "globalThis.__codexLastTerminalGuard||null,typeof globalThis.__codexWorkerCpuProbe===\"function\"):null}"
  + "catch(__wce){return{error:\"watchdogCpu unavailable\"}}})(),";

const EDITS = [[STATUS_BEFORE, STATUS_AFTER]];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous watchdog CPU status anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes("watchdogCpu:")) throw new Error("partial watchdog CPU status patch");
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
