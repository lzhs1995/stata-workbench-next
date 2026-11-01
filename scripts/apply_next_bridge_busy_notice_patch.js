"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* next patch F1: explicit bridge busy notice names agent connectivity */";
const BEFORE = 'Stata bridge port "+__port+" failed: "+(__e&&__e.message||__e)+" (set stataMcp.visibleBridgePort)\"';
const AFTER = 'Stata bridge port "+__port+" is unavailable; the agent cannot connect: "+(__e&&__e.message||__e)+" (set stataMcp.visibleBridgePort)\"';
const LEGACY_AFTER = AFTER.slice(0, -1);
const LEGACY_BEFORE = BEFORE.slice(0, -1);
function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    // Migrate the first draft, which accidentally placed the marker inside the string literal.
    source = source.replace(LEGACY_AFTER + MARKER, AFTER).replace(LEGACY_BEFORE + MARKER, BEFORE);
    if (source.includes(MARKER)) throw new Error("bridge busy notice marker has an unknown placement");
    return options.finalize === false ? source : fingerprint.finalize(source).text;
  }
  if (source.split(AFTER).length - 1 === 1) return options.finalize === false ? source : fingerprint.finalize(source).text;
  if (source.split(BEFORE).length - 1 !== 1) throw new Error("bridge busy notice anchor missing or ambiguous");
  source = source.replace(BEFORE, AFTER + MARKER);
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}
function revertBundle(source) {
  if (source.includes(MARKER)) {
    source = source.replace(AFTER + MARKER, BEFORE).replace(LEGACY_AFTER + MARKER, BEFORE).replace(LEGACY_BEFORE + MARKER, BEFORE);
    if (source.includes(MARKER)) throw new Error("bridge busy notice marker has an unknown placement");
    return fingerprint.finalize(source).text;
  }
  return source;
}
if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target }));
}
module.exports = { patchBundle, revertBundle, MARKER, BEFORE, AFTER };
