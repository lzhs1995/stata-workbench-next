#!/usr/bin/env node
"use strict";

// Data Browser showed "Frame: default" from the static extension HTML and never
// updated it; Windows dev.5 step 3 browsed the wb_platform frame under that
// label. /v1/dataset already returns dataset.frame. Show it (or "unknown" if the
// service omits it). Edits the source webview and its bundled copy; both are
// shipped. Offline edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const MARKER = "codex patch rc.7.70: Data Browser shows the current frame";
const TARGETS = {
  "src/ui-shared/data-browser.js": {
    before: "            state.totalObs = datasetInfo.n || 0;\n",
    after: "            state.totalObs = datasetInfo.n || 0;\n"
      + "            // " + MARKER + "\n"
      + "            if (dom.frameName) dom.frameName.textContent = datasetInfo.frame ? String(datasetInfo.frame) : 'unknown';\n",
  },
  "dist/ui-shared/data-browser.js": {
    before: "      state.totalObs = datasetInfo.n || 0;\n",
    after: "      state.totalObs = datasetInfo.n || 0;\n"
      + "      // " + MARKER + "\n"
      + "      if (dom.frameName) dom.frameName.textContent = datasetInfo.frame ? String(datasetInfo.frame) : \"unknown\";\n",
  },
};

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous Data Browser frame anchor");
  }
  return at;
}

function patchSource(rel, source) {
  const { before, after } = TARGETS[rel];
  if (source.includes(MARKER)) {
    uniqueAt(source, after);
    return source;
  }
  if (source.includes("dom.frameName.textContent")) throw new Error("partial Data Browser frame patch");
  uniqueAt(source, before);
  return source.replace(before, () => after);
}

// Exact inverse, used by tests to rebuild the unpatched webview.
function revertSource(rel, source) {
  const { before, after } = TARGETS[rel];
  uniqueAt(source, after);
  return source.replace(after, () => before);
}

if (require.main === module) {
  // --check: verify both webview files are already patched and write nothing.
  const check = process.argv.includes("--check");
  const changed = [];
  for (const rel of Object.keys(TARGETS)) {
    const target = path.join(__dirname, "..", rel);
    const before = fs.readFileSync(target, "utf8");
    const after = patchSource(rel, before);
    if (after !== before) { if (!check) fs.writeFileSync(target, after); changed.push(rel); }
  }
  console.log(JSON.stringify({ changed, installed: false, check }));
  if (check && changed.length) process.exitCode = 1;
}

module.exports = { patchSource, revertSource, MARKER, TARGETS };
