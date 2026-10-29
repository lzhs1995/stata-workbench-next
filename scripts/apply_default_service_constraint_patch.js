#!/usr/bin/env node
"use strict";

// The default uvx/uv route resolves mcp-stata 1.26.1 together with the newest
// MCP; MCP 2.x removed the FastMCP module mcp-stata imports. Constrain every
// generated `--from` argument array to mcp<2: client default/fallback, version
// probes, refresh and the Claude/Codex/VS Code-Cursor generators (11 arrays).
// Transformer from Codex's independent review (S58 default-service candidate).
// Offline bundle edit; no install, no Stata.
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const fingerprint = require("./finalize_bundle_identity");
const OWNERS = new Set(["_createClient", "ORA", "jRA", "ZRA", "qRA", "$_"]);
const ARRAYS = 11;
const CONSTRAINT = ',"--with","mcp<2"';
// An explicitly configured command without args no longer inherits uvx arguments.
const DEFAULT_BEFORE = 'o=B.args||["--from",e,"--with","mcp<2",Ao]';
const DEFAULT_AFTER = 'o=B.args||(B.command?[]:["--from",e,"--with","mcp<2",Ao])';

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous default service constraint anchor");
  }
  return at;
}

function fromArrays(source) {
  const found = [];
  walk.ancestor(acorn.parse(source, { ecmaVersion: "latest" }), { ArrayExpression(node, ancestors) {
    const from = node.elements.findIndex(e => e?.type === "Literal" && e.value === "--from");
    if (from < 0) return;
    const fn = ancestors.slice().reverse().find(n => n.type === "MethodDefinition" || n.type === "FunctionDeclaration");
    const owner = fn?.key?.name || fn?.id?.name;
    if (!OWNERS.has(owner)) throw new Error("unreviewed --from array in " + owner);
    const [flag, spec] = [node.elements[from + 2], node.elements[from + 3]];
    found.push({ owner, at: node.elements[from + 1].end,
      constrained: flag?.type === "Literal" && flag.value === "--with" && spec?.value === "mcp<2" });
  } });
  if (found.length !== ARRAYS) throw new Error("expected " + ARRAYS + " generated --from arrays, found " + found.length);
  return found;
}

function patchBundle(source, options = {}) {
  const arrays = fromArrays(source);
  const done = arrays.filter(a => a.constrained).length;
  if (done === ARRAYS) {
    uniqueAt(source, DEFAULT_AFTER);
  } else if (done === 0) {
    for (const a of [...arrays].sort((x, y) => y.at - x.at)) source = source.slice(0, a.at) + CONSTRAINT + source.slice(a.at);
    uniqueAt(source, DEFAULT_BEFORE);
    source = source.replace(DEFAULT_BEFORE, () => DEFAULT_AFTER);
  } else {
    throw new Error("partial default service constraint patch: " + done + "/" + ARRAYS);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  uniqueAt(source, DEFAULT_AFTER);
  source = source.replace(DEFAULT_AFTER, () => DEFAULT_BEFORE);
  const arrays = fromArrays(source);
  if (!arrays.every(a => a.constrained)) throw new Error("partial default service constraint patch");
  for (const a of [...arrays].sort((x, y) => y.at - x.at)) {
    if (source.slice(a.at, a.at + CONSTRAINT.length) !== CONSTRAINT) throw new Error("unexpected constraint spelling");
    source = source.slice(0, a.at) + source.slice(a.at + CONSTRAINT.length);
  }
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, fromArrays, CONSTRAINT, DEFAULT_BEFORE, DEFAULT_AFTER, ARRAYS };
