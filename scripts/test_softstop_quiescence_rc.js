#!/usr/bin/env node
"use strict";

// F fix3: the snapshotless soft-stop quiescence probe must own its rc.
//
// The raw results below were recorded against a live StataNow 19.5 MP backend
// driven headlessly through mcp_stata's own session worker (the same path the
// extension's run_command_background uses). After a Break, the shipped probe
// payload reported rc=1 while its unique marker was present in both stdout and
// the SMCL log, so the probe had in fact run to completion on a healthy
// backend. A fresh, never-broken session reported rc=111 the same way, from
// pystata warmup. Cause: mcp_stata restores the entry _rc with
// `capture error <entry_rc>` right before dispatch, and a single-line command
// is run without a `capture` wrapper, so a successful `display` leaves _rc
// untouched and c(rc) reads back the residual value.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_softstop_quiescence_rc_patch");
const fingerprint = require("./finalize_bundle_identity");

const bundlePath = path.join(__dirname, "..", "dist", "extension.js");
const bundle = fs.readFileSync(bundlePath, "utf8");

// Live-recorded probe results. rc/success/markerSeen are measured values.
const LIVE = [
  { name: "break-round1", rc: 1, success: false, markerSeen: true },
  { name: "break-round1-retry", rc: 1, success: false, markerSeen: true },
  { name: "break-round2", rc: 1, success: false, markerSeen: true },
  { name: "break-round2-retry", rc: 1, success: false, markerSeen: true },
  { name: "break-round3", rc: 1, success: false, markerSeen: true },
  { name: "break-round3-retry", rc: 1, success: false, markerSeen: true },
  { name: "fresh-session-warmup-rc", rc: 111, success: false, markerSeen: true },
  { name: "capture-noisily-after-break", rc: 0, success: true, markerSeen: true },
];

// Genuinely not quiescent: the payload never reached Stata, so no marker.
const NOT_QUIESCENT = [
  { name: "backend-busy-cancelled", rc: -1, success: false, markerSeen: false, stderr: "Request cancelled" },
  { name: "backend-killed", rc: -1, success: false, markerSeen: false, stderr: "Session is error; explicit recovery required" },
  { name: "real-stata-error", rc: 111, success: false, markerSeen: false, stderr: "r(111)" },
];

// Lift the shipped and patched classification bodies verbatim out of the bundle
// and run each inside node:vm, so the test exercises real bundle bytes.
function sliceClassification(source) {
  const codeAt = source.indexOf("let __quiescenceCode=");
  assert.ok(codeAt > 0, "probe payload not found");
  const head = source.indexOf("let __quiescenceMarker=", codeAt);
  const shippedHead = source.indexOf("if(__quiescenceResult?.success===false", codeAt);
  const start = head >= 0 && (shippedHead < 0 || head < shippedHead) ? head : shippedHead;
  assert.ok(start > 0, "classification not found");
  const needle = "\"snapshotless soft-stop quiescence probe failed\")";
  const end = source.indexOf(needle, start);
  assert.ok(end > start, "classification tail not found");
  return source.slice(start, end + needle.length);
}

function classify(classifySrc, probeCode, result) {
  const ctx = { __quiescenceCode: probeCode, __quiescenceResult: result, Number, String, __outcome: "ACCEPTED" };
  vm.createContext(ctx);
  vm.runInContext(`try{${classifySrc}}catch(e){__outcome="REJECTED: "+(e&&e.message||String(e))}`, ctx);
  return ctx.__outcome.startsWith("REJECTED") ? "REJECTED" : "ACCEPTED";
}

function resultFor(rec, marker) {
  return {
    success: rec.success,
    rc: rec.rc,
    stdout: rec.markerSeen ? `. display as text "${marker}"\n${marker}\n` : "",
    stderr: rec.stderr || "",
    logPath: null,
  };
}

assert.equal(fingerprint.verify(bundle).ok, true, "bundle identity verifies");

// Layer algebra: replay reproduces the sealed layer, inverse restores the prior one.
const layer = patch.revertBundle(bundle);
assert.equal(patch.patchBundle(layer), bundle, "replay reproduces the sealed layer");
assert.equal(patch.revertBundle(bundle), layer, "inverse restores the prior layer");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "patch is byte-idempotent");

// 6.1: the shipped payload must now carry its own capture.
assert.ok(bundle.includes(patch.NEW_CODE), "patched probe payload present");
assert.ok(!bundle.includes(patch.OLD_CODE), "unwrapped probe payload gone");
assert.ok(layer.includes(patch.OLD_CODE), "prior layer kept the unwrapped payload");
const payloadMatch = bundle.match(/let __quiescenceCode="([^"]*)/);
assert.ok(payloadMatch, "probe payload literal readable");
assert.match(payloadMatch[1], /^capture noisily display as text /, "probe runs under capture noisily");
assert.ok(/noisily/.test(payloadMatch[1]), "capture stays noisily so the marker still reaches the log");

const shippedClassify = sliceClassification(layer);
const fixedClassify = sliceClassification(bundle);
assert.notEqual(shippedClassify, fixedClassify, "classification actually changed");
assert.ok(fixedClassify.includes("__quiescenceMarker"), "fixed classification derives the marker");
// The marker must be read back out of the dispatched payload, never recomputed.
assert.ok(
  fixedClassify.includes("__quiescenceCode.match("),
  "marker is read from the dispatched payload, not recomputed from runId",
);
assert.ok(!/__runId\|\|Date\.now\(\)/.test(fixedClassify), "classification does not re-derive the runId fallback");

let shippedRejections = 0;
for (const rec of LIVE) {
  const marker = `___CODEX_SOFT_STOP_QUIESCENT_${rec.name}___`;
  const probeCode = `capture noisily display as text "${marker}"\n`;
  const result = resultFor(rec, marker);
  if (classify(shippedClassify, probeCode, result) === "REJECTED") shippedRejections += 1;
  assert.equal(
    classify(fixedClassify, probeCode, result),
    "ACCEPTED",
    `probe that ran must be accepted: ${rec.name} (rc=${rec.rc})`,
  );
}
// The shipped classification really did reject healthy backends; without this
// the test would pass vacuously against an already-correct baseline.
assert.equal(shippedRejections, 7, "shipped classification rejected the 7 residual-rc cases");

for (const rec of NOT_QUIESCENT) {
  const marker = `___CODEX_SOFT_STOP_QUIESCENT_${rec.name}___`;
  const probeCode = `capture noisily display as text "${marker}"\n`;
  const result = resultFor(rec, marker);
  assert.equal(
    classify(shippedClassify, probeCode, result),
    "REJECTED",
    `genuinely stuck backend must fail before the fix: ${rec.name}`,
  );
  assert.equal(
    classify(fixedClassify, probeCode, result),
    "REJECTED",
    `genuinely stuck backend must still fail after the fix: ${rec.name}`,
  );
}

// A marker from a different runId must not satisfy the probe.
const foreign = resultFor({ rc: 1, success: false, markerSeen: true }, "___CODEX_SOFT_STOP_QUIESCENT_other_run___");
assert.equal(
  classify(fixedClassify, 'capture noisily display as text "___CODEX_SOFT_STOP_QUIESCENT_mine___"\n', foreign),
  "REJECTED",
  "a stale marker from another run must not be accepted",
);

// The 5 s race and its timeout stay untouched: a probe that never settles is
// still escalated by the surrounding soft-stop code.
assert.ok(
  bundle.includes("snapshotless soft-stop quiescence probe timed out after 5000ms"),
  "probe timeout path preserved",
);
assert.ok(bundle.includes("markerSeen:__quiescenceRan"), "acceptance records marker evidence");

console.log("test_softstop_quiescence_rc: OK");
