#!/usr/bin/env node
"use strict";

// Offline maintained-bundle patch; never installs or contacts Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch: bridge file shortcut preserves complete requests";
const BEFORE = "let __codexPreparedBridgeRun=__run&&__codexBridgeDoFile&&globalThis.__codexPrepareHumanFileGraphRun?";
const AFTER = '/* ' + MARKER + ' */'
  + 'let __codexBridgeSingleDo=String(__code||"").match(/^[ \\t\\r\\n]*do[ \\t]+"([^"\\r\\n]+\\.do)"[ \\t\\r\\n]*$/i);'
  + 'let __codexPreparedBridgeRun=__run&&__codexBridgeDoFile&&__codexBridgeSingleDo&&__codexBridgeSingleDo[1]===__codexBridgeDoFile&&globalThis.__codexPrepareHumanFileGraphRun?';

function patchBundle(source, options = {}) {
  // Document scanning may inspect an embedded DO. It must never authorize
  // replacing a selection that also contains prefixes, arguments or commands.
  const patched = source.indexOf(AFTER);
  if (patched >= 0) {
    if (source.indexOf(AFTER, patched + AFTER.length) >= 0 || source.includes(BEFORE)) {
      throw new Error("ambiguous bridge request preservation patch");
    }
    return options.finalize === false ? source : fingerprint.finalize(source).text;
  }
  const at = source.indexOf(BEFORE);
  if (source.includes(MARKER) || at < 0 || source.indexOf(BEFORE, at + BEFORE.length) >= 0) {
    throw new Error("missing or ambiguous bridge request preservation anchor");
  }
  const result = source.slice(0, at) + AFTER + source.slice(at + BEFORE.length);
  return options.finalize === false ? result : fingerprint.finalize(result).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { patchBundle, MARKER };
