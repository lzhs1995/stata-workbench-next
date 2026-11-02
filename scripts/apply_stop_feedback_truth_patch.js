#!/usr/bin/env node
"use strict";

// F fix4: what Stop and KILL tell the user must match what they did.
//
// F-1 (PR #14 review r1 §2.3). The quiescence probe was accepted when its marker
// appeared anywhere in an output field. Stata echoes the command line, and that
// echo also contains the marker, so an echo-only response was accepted. The
// marker now has to be a whole output line once SMCL tags are stripped.
//
// P10. The Terminal Stop toast chose its text from recoveryClass and ok only.
// The fence wrapper (PR #13) locks the session without touching either field,
// so a fenced Stop still said "restored the complete pre-run checkpoint when one
// existed" while /status was 423. The toast now checks the fence (and the
// session-wide continuityLost it sets) first.
//
// W-P1b (F-win2 R2). A guard cancel confirmed before Stata wrote any log was
// reported as a known cancel, but the human's code still ran 2 s later. The
// fence now passes whether a log was seen, and guard_cancel_restore_core.js
// reports that case as EXEC_OUTCOME_UNKNOWN / payloadMayHaveRun.
//
// F-5 (PR #13 review r1). The recovery-smoke helper returns
// {ok:true, skipped:"recovery not required"} without running anything, and both
// KILL toasts branched on ok alone, so they said "the verified recovery smoke
// passed" when no smoke ran.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* codex patch rc.7.77: stop feedback tells the truth */";

// F-1: rc.7.76's matcher stays byte-identical (its replay checks those bytes).
// Instead the probe result it reads is narrowed first: every field it searches
// keeps only lines that, with SMCL tags stripped, equal the marker. The command
// echo (". capture noisily display as text \"<marker>\"") is dropped, so the
// matcher's substring test can only succeed on a real output line. rc, success,
// error.message and logPath pass through unchanged.
const OLD_MATCH = "let __quiescenceResult=__quiescenceAttempt.result;";
const NEW_MATCH = OLD_MATCH
  + "{let __probeMarker=(__quiescenceCode.match(/___CODEX_SOFT_STOP_QUIESCENT_[A-Za-z0-9_.-]*___/)||[null])[0];"
  + "let __exactLines=__text=>typeof __text!==\"string\"?__text:"
  + "__text.split(\"\\n\").filter(__line=>!!__probeMarker&&"
  + "__line.replace(/[{][a-z]+(?::[^}]*)?[}]/g,\"\").trim()===__probeMarker).join(\"\\n\");"
  + "if(__quiescenceResult&&typeof __quiescenceResult===\"object\"){"
  + "let __narrow={...__quiescenceResult};"
  + "for(const __field of [\"stdout\",\"smcl_output\",\"smclOutput\",\"contentText\",\"stderr\",\"raw\"])"
  + "if(__field in __narrow)__narrow[__field]=__exactLines(__narrow[__field]);"
  + "if(__narrow.error&&typeof __narrow.error===\"object\")"
  + "__narrow.error={...__narrow.error,context:__exactLines(__narrow.error.context)};"
  + "__quiescenceResult=__narrow}}";

// P10: the fence is checked before the old recoveryClass / ok ladder.
const OLD_TOAST = "iA.window.showWarningMessage(g&&g.recoveryClass===\"RECOVERED_DEGRADED\"?";
const NEW_TOAST = "iA.window.showWarningMessage(g&&(g.fenced===true||!!globalThis.__codexContinuityLost)?"
  + "\"Stata Workbench stopped the request but did not restore the pre-run state; the session is locked. "
  + "Click Stata: KILL to unlock it.\"+(g.recoveryClass===\"RECOVERED_DEGRADED\"?\" (\"+String(g?.restore?.degraded?.skippedEstimates||0)"
  + "+\" estimates and \"+String(g?.restore?.degraded?.skippedGraphs||0)+\" graphs were not restored.)\":\"\")"
  + ":g&&g.recoveryClass===\"RECOVERED_DEGRADED\"?";

// F-5: a skipped smoke is not a passed smoke.
function killToast(name, passed, failedPrefix) {
  const old = `iA.window.showInformationMessage(${name}&&${name}.ok?"${passed}":"${failedPrefix}"`;
  const neu = `iA.window.showInformationMessage(${name}&&${name}.ok&&!${name}.skipped?"${passed}"`
    + `:${name}&&${name}.ok&&${name}.skipped?"${failedPrefix.replace(/, but the verified recovery smoke did not pass$/, "")}`
    + `; no recovery smoke ran ("+String(${name}.skipped)+")."`
    + `:"${failedPrefix}"`;
  return { old, neu };
}
const KILL = killToast("__smoke",
  "Stata Workbench backend reset and the verified recovery smoke passed; the session is READY.",
  "Stata Workbench owned backend reset, but the verified recovery smoke did not pass");
const WIN_KILL = killToast("__winSmoke",
  "Stata panic kill completed and the verified recovery smoke passed; the session is READY.",
  "Stata panic kill completed, but the verified recovery smoke did not pass");

// W-P1b: the guard-cancel fence tells the classifier whether Stata wrote any log
// for the payload before the cancel. The raw guard state carries firstLogAt
// (null until the first log); a state without the key keeps the old rule.
const OLD_FENCE_INPUT = "errorText:(__fenceInput&&__fenceInput.errorText)||__state.error,dispatched:true});";
const NEW_FENCE_INPUT = "errorText:(__fenceInput&&__fenceInput.errorText)||__state.error,dispatched:true,"
  + "firstLogSeen:(\"firstLogAt\" in __state)?__state.firstLogAt!=null:undefined});";

const PAIRS = [
  ["probe marker line match", OLD_MATCH, NEW_MATCH + MARKER],
  ["guard-cancel fence input", OLD_FENCE_INPUT, NEW_FENCE_INPUT],
  ["terminal Stop toast", OLD_TOAST, NEW_TOAST],
  ["KILL toast", KILL.old, KILL.neu],
  ["Windows KILL toast", WIN_KILL.old, WIN_KILL.neu],
];

function uniqueAt(source, needle, label) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error(`missing or ambiguous stop feedback anchor: ${label}`);
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (!source.includes(MARKER)) {
    for (const [label, before] of PAIRS) uniqueAt(source, before, label);
    for (const [, before, after] of PAIRS) source = source.replace(before, () => after);
  } else {
    for (const [label, , after] of PAIRS) uniqueAt(source, after, "patched " + label);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("stop feedback marker missing");
  for (const [label, , after] of PAIRS) uniqueAt(source, after, "patched " + label);
  for (const [, before, after] of PAIRS) source = source.replace(after, () => before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, OLD_MATCH, NEW_MATCH, OLD_TOAST, NEW_TOAST, KILL, WIN_KILL,
  OLD_FENCE_INPUT, NEW_FENCE_INPUT, PAIRS };
