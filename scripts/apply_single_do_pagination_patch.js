#!/usr/bin/env node
"use strict";

// The darwin compatibility layer (stata_source_compat_core ensurePaginationOff)
// prefixes "set more off" before an Agent request `do "<file>"` reaches the
// visible bridge. Both single-do matchers there were anchored to the whole
// string, so the prefixed request no longer counted as one do-file: the bridge
// skipped __codexPrepareHumanFileGraphRun and __codexResolveSingleDoFilePath
// returned null, named graph exports were never activated, and Stata 18 failed
// `graph export …, name(g)` with r(693) "could not find Graph window"
// (rc.7.44 FULL45 S8/S25/S28, taught_task5/7/8 over the Agent path). Skip
// leading pagination lines before matching, and keep them in front of the
// prepared code. Other code still does not count as a single do-file.
// Offline bundle edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* codex patch rc.7.73: single-do matchers skip the pagination prefix */";

const RESOLVER_HEAD = "function __codexResolveSingleDoFilePath(code, cwd) {\n  try {\n";
const HELPER = MARKER + `
// Leading "set more off" lines (as ensurePaginationOff writes them) are split
// off; body is the rest. Nothing else is stripped.
function __codexSplitPaginationPrefix(code) {
  const text = String(code == null ? "" : code);
  const line = /[ \\t]*(?:capture[ \\t]+)?set[ \\t]+more[ \\t]+off[ \\t]*(?:\\/\\/[^\\r\\n]*)?(?:\\r?\\n|$)/iy;
  let at = 0;
  for (;;) {
    const blank = /[ \\t]*\\r?\\n/y;
    blank.lastIndex = at;
    if (blank.test(text)) { at = blank.lastIndex; continue; }
    line.lastIndex = at;
    if (at < text.length && line.test(text)) { at = line.lastIndex; continue; }
    break;
  }
  if (!/\\bmore\\b/i.test(text.slice(0, at))) return { prefix: "", body: text };
  return { prefix: text.slice(0, at), body: text.slice(at) };
}
globalThis.__codexSplitPaginationPrefix = __codexSplitPaginationPrefix;

`;
const SPLIT = "(globalThis.__codexSplitPaginationPrefix?globalThis.__codexSplitPaginationPrefix(__code):{prefix:\"\",body:String(__code||\"\")})";

// [before, after] pairs. The bridge edits sit at the seams between existing
// patch spans (rc.7.10.35 | bridge request preservation | v7.23), so replaying
// those earlier patches on this bundle still finds their text unchanged.
const BRIDGE_SEAM = "/* codex patch rc.7.10.35: structural long bridge watchdog *//* codex patch: bridge file shortcut preserves complete requests */";
const BRIDGE_END = '__codexPrepareGraphRunCode(__code,__run,"visible-bridge",__cwd):null);/* codex patch v7.23:';
const ANCHORS = {
  resolver: [RESOLVER_HEAD + "    const text = String(code || \"\").trim();\n",
    HELPER + RESOLVER_HEAD + "    const text = __codexSplitPaginationPrefix(code).body.trim();\n"],
  // The single-do shortcut sees the request without its pagination prefix …
  bridgeStrip: [BRIDGE_SEAM, BRIDGE_SEAM.replace("*//*", "*/" + MARKER
    + "let __codexBridgeFullCode=__code,__codexBridgePagination=" + SPLIT + ";__code=__codexBridgePagination.body;/*")],
  // … and the prefix goes back in front of whatever the shortcut prepared.
  bridgeRestore: [BRIDGE_END, BRIDGE_END.replace(":null);/*", ":null);__code=__codexBridgeFullCode;"
    + "if(__codexBridgePagination.prefix&&__codexPreparedBridgeRun&&__codexPreparedBridgeRun.code&&!/^\\s*(?:capture\\s+)?set\\s+more\\s+off\\b/i.test(String(__codexPreparedBridgeRun.code)))"
    + "__codexPreparedBridgeRun=Object.assign({},__codexPreparedBridgeRun,{code:__codexBridgePagination.prefix+__codexPreparedBridgeRun.code});/*")],
  graphRunPrefix: ['      if (activatedDoFile) preparedCode = "do \\"" + __codexStataString(activatedDoFile) + "\\"";\n    }\n',
    '      if (activatedDoFile) preparedCode = "do \\"" + __codexStataString(activatedDoFile) + "\\"";\n    }\n'
      + "    " + MARKER + "\n"
      + "    if (graphScan.doFilePath && /^\\s*do\\s+\"/i.test(preparedCode)) preparedCode = __codexSplitPaginationPrefix(text).prefix + preparedCode;\n"],
};
const KEYS = Object.keys(ANCHORS);

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous single-do pagination anchor");
  }
  return at;
}

const MARKER_COUNT = 3;

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const key of KEYS) uniqueAt(source, ANCHORS[key][1]);
    if (source.split(MARKER).length - 1 !== MARKER_COUNT) throw new Error("partial single-do pagination patch");
  } else {
    if (source.includes("__codexSplitPaginationPrefix") || source.includes("__codexBridgePagination")) {
      throw new Error("partial single-do pagination patch");
    }
    for (const key of KEYS) uniqueAt(source, ANCHORS[key][0]);
    for (const key of KEYS) {
      source = source.replace(ANCHORS[key][0], () => ANCHORS[key][1]);
    }
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  const keys = KEYS;
  for (const key of keys) uniqueAt(source, ANCHORS[key][1]);
  for (const key of [...keys].reverse()) source = source.replace(ANCHORS[key][1], () => ANCHORS[key][0]);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, ANCHORS, HELPER };
