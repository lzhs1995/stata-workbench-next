#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("./stata_source_compat_core");

const roots = {
  platform: "darwin",
  stataRoot: path.resolve("/Users/test/Documents/cnm/tasks/07_Stata-workbench/开题报告"),
  cnmRoot: path.resolve("/Users/test/Documents/cnm"),
  documentsRoot: path.resolve("/Users/test/Documents"),
};

const source = [
  "\ufeffglobal workfolder \"C:/Users/LZHS/Desktop/开题报告\"",
  "global data \"${workfolder}\\0_data_clo\\Prepare_data\"",
  "local regex \"^foo\\\\d+$\"",
].join("\n");
const result = core.transformSource(source, roots);
assert.strictEqual(result.diagnostics.applied, true);
assert.strictEqual(result.diagnostics.bomStripped, true);
assert.strictEqual(result.diagnostics.rootRewrites, 1);
assert.strictEqual(result.diagnostics.separatorRewrites, 2);
assert.strictEqual(result.diagnostics.dynamicGraphNameProtections, 0);
assert.strictEqual(result.diagnostics.dynamicGraphNameMacro, null);
assert.ok(result.code.includes(`global workfolder "${roots.stataRoot.replace(/\\/g, "/")}"`));
assert.ok(result.code.includes('global data "${workfolder}/0_data_clo/Prepare_data"'));
assert.ok(result.code.includes('local regex "^foo\\\\d+$"'), "non-path strings stay byte-identical");

const win = core.transformSource(source, { ...roots, platform: "win32" });
assert.strictEqual(win.code, source);
assert.strictEqual(win.diagnostics.applied, false);

const dynamicGraph = [
  "local graphtag : display %03.0f 1",
  "histogram price, name(t9gl_hist_`graphtag', replace)",
  "graph export \"x_`graphtag'.png\", name(t9gl_hist_`graphtag') replace",
  "histogram mpg, name(static_graph, replace)",
].join("\n");
const protectedGraph = core.transformSource(dynamicGraph, roots);
assert.strictEqual(protectedGraph.diagnostics.dynamicGraphNameProtections, 2);
assert.strictEqual(protectedGraph.diagnostics.applied, true);
const optionMacro = protectedGraph.diagnostics.dynamicGraphNameMacro;
assert.match(optionMacro, /^__ws_nopt_[0-9a-f]{8}$/);
assert.ok(protectedGraph.code.startsWith(`local ${optionMacro} name\n`));
assert.ok(protectedGraph.code.includes("`" + optionMacro + "'(t9gl_hist_`graphtag', replace)"));
assert.ok(protectedGraph.code.includes("`" + optionMacro + "'(t9gl_hist_`graphtag') replace"));
assert.ok(protectedGraph.code.includes("name(static_graph, replace)"));
assert.ok(protectedGraph.code.endsWith(`capture macro drop ${optionMacro}\n`));
assert.strictEqual(
  core.protectDynamicGraphNames(protectedGraph.code).count,
  0,
  "dynamic graph-name transport protection must be idempotent",
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compat-core-test-"));
const sourceDo = path.join(tempRoot, "fixture.do");
fs.writeFileSync(sourceDo, 'global workfolder "C:/Users/LZHS/Desktop/开题报告"\n', "utf8");
const before = fs.readFileSync(sourceDo);
const prepared = core.prepareExecutionCode(`do "${sourceDo}"`, {
  ...roots,
  cwd: tempRoot,
  tempRoot,
});
assert.strictEqual(prepared.diagnostics.referencedDoCopies.length, 1);
assert.strictEqual(prepared.diagnostics.paginationGuardApplied, true);
assert.ok(prepared.code.startsWith("set more off\n"),
  "all visible execution paths must disable interactive pagination before running code");
assert.notStrictEqual(prepared.code, `do "${sourceDo}"`);
assert.deepStrictEqual(fs.readFileSync(sourceDo), before, "research source must not be modified");
const copiedPath = prepared.diagnostics.referencedDoCopies[0].tempPath;
assert.ok(fs.readFileSync(copiedPath, "utf8").includes(roots.stataRoot.replace(/\\/g, "/")));
assert.strictEqual(prepared.diagnostics.referencedDoCopies[0].sourceIntact, true);

const nestedDo = path.join(tempRoot, "nested-graph.do");
const nestedSource = 'graph export "/tmp/nested.png", replace\n';
fs.writeFileSync(nestedDo, nestedSource, "utf8");
const nestedPrepared = core.prepareExecutionCode(`do "${nestedDo}"`, {
  ...roots,
  cwd: tempRoot,
  tempRoot,
  transformReferencedCode(code, context) {
    assert.strictEqual(context.sourcePath, nestedDo);
    return {
      code: code.replace("graph export", "display as text \"REFERENCED_TRANSFORM\" // graph export"),
      diagnostics: { ok: true, applied: true, replacements: 1 },
    };
  },
});
assert.strictEqual(nestedPrepared.diagnostics.referencedDoCopies.length, 1);
const nestedCopy = nestedPrepared.diagnostics.referencedDoCopies[0];
assert.notStrictEqual(nestedCopy.tempPath, nestedDo);
assert.strictEqual(nestedCopy.secondaryTransform.applied, true);
assert.ok(fs.readFileSync(nestedCopy.tempPath, "utf8").includes("REFERENCED_TRANSFORM"));
assert.strictEqual(fs.readFileSync(nestedDo, "utf8"), nestedSource,
  "secondary transform must never modify the referenced research source");

const alreadyGuarded = core.prepareExecutionCode("set more off\ndisplay 1", {
  ...roots,
  cwd: tempRoot,
});
assert.strictEqual(alreadyGuarded.diagnostics.paginationGuardApplied, false);
assert.strictEqual((alreadyGuarded.code.match(/set more off/gi) || []).length, 1,
  "pagination protection must be idempotent");

const winPrepared = core.prepareExecutionCode("display 2", {
  ...roots,
  platform: "win32",
  cwd: tempRoot,
});
assert.strictEqual(winPrepared.diagnostics.paginationGuardApplied, true);
assert.strictEqual(winPrepared.code, "set more off\ndisplay 2",
  "the noninteractive execution invariant is cross-platform");

const logCloseSource = [
  "capture log close _all",
  "LOG CLOSE _ALL // user cleanup",
  "capture log close named_log",
  "display 3",
].join("\n");
const logClosePrepared = core.prepareExecutionCode(logCloseSource, {
  ...roots,
  cwd: tempRoot,
});
assert.strictEqual(logClosePrepared.diagnostics.transportLogCloseGuards, 2);
assert.strictEqual((logClosePrepared.code.match(/Workbench transport guard/g) || []).length, 2);
assert.ok(logClosePrepared.code.includes("capture log close named_log"),
  "named user logs remain under user control");
assert.strictEqual(
  core.prepareExecutionCode(logClosePrepared.code, { ...roots, cwd: tempRoot }).diagnostics
    .transportLogCloseGuards,
  0,
  "transport-log protection must be idempotent",
);

const logCloseDo = path.join(tempRoot, "log-close.do");
const logCloseDoSource = "capture log close _all\ndisplay 4\n";
fs.writeFileSync(logCloseDo, logCloseDoSource, "utf8");
const referencedLogClose = core.prepareExecutionCode(`do "${logCloseDo}"`, {
  ...roots,
  cwd: tempRoot,
  tempRoot,
});
assert.strictEqual(referencedLogClose.diagnostics.referencedDoCopies.length, 1);
const guardedDoPath = referencedLogClose.diagnostics.referencedDoCopies[0].tempPath;
assert.ok(fs.readFileSync(guardedDoPath, "utf8").includes("Workbench transport guard"));
assert.strictEqual(fs.readFileSync(logCloseDo, "utf8"), logCloseDoSource,
  "transport-log protection must never modify the referenced research source");

const winLogClose = core.prepareExecutionCode("capture log close _all", {
  ...roots,
  platform: "win32",
  cwd: tempRoot,
});
assert.strictEqual(winLogClose.diagnostics.transportLogCloseGuards, 1,
  "the shared visible transport log invariant is cross-platform");
assert.ok(winLogClose.code.includes("Workbench transport guard"));

console.log("STATA_SOURCE_COMPAT_RC7_PASS");
