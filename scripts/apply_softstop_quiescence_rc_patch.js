#!/usr/bin/env node
"use strict";

// F fix3: the snapshotless soft-stop quiescence probe must not inherit Stata's
// residual _rc.
//
// mcp_stata runs a single-line command without a `capture` wrapper and reads
// c(rc) afterwards, but it restores the entry _rc with `capture error <entry_rc>`
// immediately before dispatching. A bare `display` succeeds without clearing
// _rc, so after a Break (_rc=1) the probe reported rc=1 even though it ran, and
// the snapshotless branch hard-reset a healthy backend, losing the user's data.
// Measured 3/3 on StataNow 19.5 MP; a fresh never-broken session reported
// rc=111 from warmup for the same reason.
//
// 6.1 wraps the probe payload in `capture noisily`, so _rc becomes this
// command's own return code while the marker still reaches the log.
// 6.2 accepts the probe whenever its unique per-runId marker appears in the
// output, which proves the payload reached Stata and ran to completion. A
// genuinely busy or dead backend emits no marker and still fails.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* codex patch rc.7.76: soft-stop quiescence probe owns its rc */";

// 6.1 probe payload: capture noisily so _rc is this command's own rc.
const OLD_CODE = "let __quiescenceCode=\"display as text \\\"___CODEX_SOFT_STOP_QUIESCENT_\"";
const NEW_CODE = "let __quiescenceCode=\"capture noisily display as text \\\"___CODEX_SOFT_STOP_QUIESCENT_\"";

// 6.2 acceptance: the probe's unique marker in any output channel proves it ran.
const OLD_CLASSIFY = "if(__quiescenceResult?.success===false||__quiescenceResult?.error"
  + "||Number(__quiescenceResult?.rc||0)!==0)"
  + "throw new Error(__quiescenceResult?.error?.message||__quiescenceResult?.error"
  + "||\"snapshotless soft-stop quiescence probe failed\")";
// The marker is read back out of the dispatched payload, never recomputed, so
// it cannot drift from the runId fallback used to build __quiescenceCode.
const NEW_CLASSIFY = "let __quiescenceMarker=(__quiescenceCode.match("
  + "/___CODEX_SOFT_STOP_QUIESCENT_[A-Za-z0-9_.-]*___/)||[null])[0],"
  + "__quiescenceRan=(__codexQuiescenceMarkerSeen=>__codexQuiescenceMarkerSeen("
  + "__quiescenceResult,__quiescenceMarker))((__result,__marker)=>{"
  + "if(!__result||!__marker)return false;"
  + "for(const __field of [\"stdout\",\"smcl_output\",\"smclOutput\",\"contentText\",\"stderr\"]){"
  + "const __value=__result[__field];"
  + "if(typeof __value===\"string\"&&__value.includes(__marker))return true}"
  + "const __context=__result.error&&__result.error.context;"
  + "if(typeof __context===\"string\"&&__context.includes(__marker))return true;"
  + "const __raw=__result.raw;"
  + "if(typeof __raw===\"string\"&&__raw.includes(__marker))return true;"
  + "return false});"
  + "if(!__quiescenceRan&&(__quiescenceResult?.success===false||__quiescenceResult?.error"
  + "||Number(__quiescenceResult?.rc||0)!==0))"
  + "throw new Error(__quiescenceResult?.error?.message||__quiescenceResult?.error"
  + "||\"snapshotless soft-stop quiescence probe failed\")";

// The accepted-probe record keeps the evidence that acceptance came from the marker.
const OLD_OK = "__restore={ok:true,skipped:\"no pre-run dataset snapshot\","
  + "quiescenceProbe:{ok:true,rc:__quiescenceResult?.rc,"
  + "logPath:__quiescenceResult?.logPath||null}}";
const NEW_OK = "__restore={ok:true,skipped:\"no pre-run dataset snapshot\","
  + "quiescenceProbe:{ok:true,rc:__quiescenceResult?.rc,markerSeen:__quiescenceRan,"
  + "logPath:__quiescenceResult?.logPath||null}}";

function uniqueAt(source, needle, label) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error(`missing or ambiguous soft-stop quiescence anchor: ${label}`);
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (!source.includes(MARKER)) {
    uniqueAt(source, OLD_CODE, "probe payload");
    uniqueAt(source, OLD_CLASSIFY, "probe classification");
    uniqueAt(source, OLD_OK, "probe acceptance record");
    source = source
      .replace(OLD_CODE, () => NEW_CODE)
      .replace(OLD_CLASSIFY, () => NEW_CLASSIFY + MARKER)
      .replace(OLD_OK, () => NEW_OK);
  } else {
    uniqueAt(source, NEW_CODE, "patched probe payload");
    uniqueAt(source, NEW_CLASSIFY + MARKER, "patched probe classification");
    uniqueAt(source, NEW_OK, "patched probe acceptance record");
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("soft-stop quiescence marker missing");
  uniqueAt(source, NEW_CODE, "patched probe payload");
  uniqueAt(source, NEW_CLASSIFY + MARKER, "patched probe classification");
  uniqueAt(source, NEW_OK, "patched probe acceptance record");
  source = source
    .replace(NEW_CODE, () => OLD_CODE)
    .replace(NEW_CLASSIFY + MARKER, () => OLD_CLASSIFY)
    .replace(NEW_OK, () => OLD_OK);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = {
  patchBundle,
  revertBundle,
  MARKER,
  OLD_CODE,
  NEW_CODE,
  OLD_CLASSIFY,
  NEW_CLASSIFY,
  OLD_OK,
  NEW_OK,
};
