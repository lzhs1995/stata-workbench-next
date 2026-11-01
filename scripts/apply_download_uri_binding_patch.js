#!/usr/bin/env node
"use strict";

// The Download (PDF export) handler builds the save-dialog default URI with
// `iA.Uri.file`. `iA` is the createDepProxy wrapper around getVscode (bundle:
// `iA=KF(FHg)`); the proxy binds functions and loses static members, so
// `iA.Uri.file` is undefined and Download throws before the dialog opens.
//
// The same module already owns `__codexUriFile`, which resolves the real API
// through `FHg()` and raises a named error when it is unavailable.  `FHg` is in
// scope here (both live in the QP module), so this routes the one remaining
// call site through that helper instead of re-deriving `FHg()` inline.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next patch F2b: Download uses the unwrapped vscode Uri binding */";
const target = path.join(__dirname, "..", "dist", "extension.js");

const BEFORE = 'let B=iA.Uri.file(rg.join(MD.homedir(),"Downloads",`${g}.pdf`)),C=await iA.window.showSaveDialog(';
const AFTER = 'let B=__codexUriFile(rg.join(MD.homedir(),"Downloads",`${g}.pdf`))' + MARKER + ',C=await iA.window.showSaveDialog(';

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) return options.finalize === false ? source : fingerprint.finalize(source).text;
  const count = source.split(BEFORE).length - 1;
  if (count !== 1) throw new Error(`F2b download Uri anchor count=${count}`);
  const text = source.replace(BEFORE, AFTER);
  return options.finalize === false ? text : fingerprint.finalize(text).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) return source;
  const text = source.replace(AFTER, BEFORE);
  if (text.includes(MARKER)) throw new Error("F2b marker survived the revert");
  return fingerprint.finalize(text).text;
}

if (require.main === module) {
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after, "utf8");
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { MARKER, BEFORE, AFTER, patchBundle, revertBundle };
