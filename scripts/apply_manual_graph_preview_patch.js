#!/usr/bin/env node
"use strict";

// Keep saved-image clicks in the existing deterministic maintenance replay.
// This module edits bundle text only; it never opens a window or calls Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const BEFORE = 'I.path&&pag(I.path,I.baseDir)';
const AFTER = 'I.path&&(typeof __codexOpenGraphPreview=="function"&&__codexOpenGraphPreview(I)||pag(I.path,I.baseDir))';
const ANCHOR = 'function __codexHandleArtifact(runId, artifact) {';
const MARKER = '// codex manual graph preview:';
const HELPER = String.raw`// codex manual graph preview: a user click on an existing Terminal graph link opens
// the Stata Graphs panel (creating it if needed). Automatic batch delivery still
// does not create/reveal a panel; help, non-graph and missing paths keep pag().
var __codexManualPreviewSeq = 0;
function __codexOpenGraphPreview(message) {
  try {
    const absolutePath = __codexResolveArtifactPath({ path: message?.path, baseDir: message?.baseDir });
    if (!absolutePath || !/\.(svg|png|jpe?g|gif|webp)$/i.test(absolutePath)) return false;
    if (!JA.existsSync(absolutePath)) return false;
    // Independent preview id: a click is not a Stata execution of the original run.
    const runId = "manual-preview-" + Date.now() + "-" + (++__codexManualPreviewSeq);
    __codexHandleArtifact(runId, { path: absolutePath, label: message?.label || null, source: "manual-terminal-click" });
    return true;
  } catch (error) {
    __codexGraphLog("manual graph preview failed: " + String(error?.message || error));
    return false;
  }
}

`;

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous manual graph preview anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  const anchor = uniqueAt(source, ANCHOR);
  if (source.includes(MARKER)) {
    const start = uniqueAt(source, MARKER);
    if (source.slice(start, anchor) !== HELPER) throw new Error("modified manual graph preview helper");
    uniqueAt(source, AFTER);
    if (source.includes(BEFORE)) throw new Error("mixed manual graph preview routes");
  } else {
    uniqueAt(source, BEFORE);
    if (source.includes("__codexOpenGraphPreview") || source.includes("__codexManualPreviewSeq")) {
      throw new Error("partial manual graph preview patch");
    }
    source = source.replace(BEFORE, AFTER).replace(ANCHOR, HELPER + ANCHOR);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, BEFORE, AFTER, HELPER };
