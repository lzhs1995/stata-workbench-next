#!/usr/bin/env node
"use strict";

// PLAN-V3 M2. An agent /run-command that arrives while Stata is still starting
// already waits in __codexBeginGraphRun (rc.7.67 start, rc.7.72 warm-up with
// one bound, rc.7.81 worker identity: a failed or slow probe drops the cache).
// What the agent could not tell was whether a refusal is worth retrying. Every
// warm-up refusal now says so: TIMEOUT and FAILED are retryable (nothing was
// dispatched; the next run waits again or starts a fresh worker), CANCELLED is
// not (a person pressed Stop). No retry happens here. Offline bundle edit; no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "// codex patch rc.7.86: warm-up refusals say whether a retry can help (nothing was dispatched)";

const HELPER_ANCHOR = "globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmRestartOnce;\n";
const HELPER = String.raw`
${MARKER}
const __codexWarmupRetryAfterMs = 5000;
async function __codexEnsureBackendWarmLabelled(runId, source) {
  try {
    return await __codexEnsureBackendWarmRestartOnce(runId, source);
  } catch (error) {
    const refusal = error?.__codexPreRunTimeout;
    if (refusal && refusal.preRunStage === "backend-warmup" && refusal.payloadDispatched === false
      && /^PRE_RUN_BACKEND_WARMUP_(TIMEOUT|FAILED|CANCELLED)$/.test(String(refusal.reasonCode || ""))) {
      const retryable = refusal.reasonCode !== "PRE_RUN_BACKEND_WARMUP_CANCELLED";
      error.__codexPreRunTimeout = { ...refusal, retryable, retryAfterMs: retryable ? __codexWarmupRetryAfterMs : null };
    }
    throw error;
  }
}
globalThis.__codexEnsureBackendWarm = __codexEnsureBackendWarmLabelled;
`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous agent warm-up refusal anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, HELPER_ANCHOR + HELPER);
  } else {
    if (source.includes("__codexEnsureBackendWarmLabelled") || source.includes("__codexWarmupRetryAfterMs")) {
      throw new Error("partial agent warm-up refusal patch");
    }
    uniqueAt(source, HELPER_ANCHOR);
    source = source.replace(HELPER_ANCHOR, () => HELPER_ANCHOR + HELPER);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, HELPER_ANCHOR + HELPER);
  return fingerprint.finalize(source.replace(HELPER_ANCHOR + HELPER, () => HELPER_ANCHOR)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, HELPER, HELPER_ANCHOR };
