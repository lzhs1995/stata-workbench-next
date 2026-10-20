#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const adapter = require("./darwin_compat_adapter");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-ref-compat-"));
const nested = path.join(root, "activated.do");
const source = [
  'graph export "/tmp/case2.png", name(case2) replace width(1400)',
  'putdocx image "/tmp/case2.png", width(4)',
  'putdocx save "/tmp/case2.docx", replace',
  "",
].join("\n");
fs.writeFileSync(nested, source, "utf8");

const prepared = adapter.prepareVisibleExecution(`do "${nested}"`, {
  platform: "darwin",
  cwd: root,
  tempRoot: root,
  extensionRoot: path.join(__dirname, ".."),
});
assert.strictEqual(prepared.darwinDiagnostics.ok, true, JSON.stringify(prepared.darwinDiagnostics));
assert.strictEqual(prepared.darwinDiagnostics.referencedFiles, 1);
assert.strictEqual(prepared.darwinDiagnostics.replacements, 3);
assert.strictEqual(prepared.sourceDiagnostics.referencedDoCopies.length, 1);
assert.strictEqual(prepared.sourceDiagnostics.paginationGuardApplied, true);
assert.ok(prepared.code.startsWith("set more off\n"));
const copied = prepared.sourceDiagnostics.referencedDoCopies[0].tempPath;
assert.notStrictEqual(copied, nested);
const copiedText = fs.readFileSync(copied, "utf8");
assert.ok(copiedText.includes(".__pngcompat__.svg"));
assert.ok(copiedText.includes("__CODEX_DOCX_IMAGE_V1__"));
assert.ok(copiedText.includes("docx_image_inject.py"));
assert.strictEqual(fs.readFileSync(nested, "utf8"), source,
  "referenced research do-file must stay byte-identical");

const win = adapter.prepareVisibleExecution(`do "${nested}"`, {
  platform: "win32",
  cwd: root,
  tempRoot: root,
  extensionRoot: path.join(__dirname, ".."),
});
assert.strictEqual(win.code, `set more off\ndo "${nested}"`);
assert.strictEqual(win.sourceDiagnostics.paginationGuardApplied, true);
assert.strictEqual(win.sourceDiagnostics.referencedDoCopies.length, 0);
assert.strictEqual(win.darwinDiagnostics.reason, "non-darwin");

// Real execution uses an outer saved wrapper which calls an export DO.
const wrapper = path.join(root, "wrapper.do");
const wrapperSource = `capture noisily do "${nested}"\n`;
fs.writeFileSync(wrapper, wrapperSource);
const recursive = adapter.prepareVisibleExecution(`do "${wrapper}"`, {
  platform: "darwin", cwd: root, tempRoot: root,
  extensionRoot: path.join(__dirname, ".."),
});
assert.strictEqual(recursive.darwinDiagnostics.replacements, 3,
  "PNG/DOCX compatibility must reach the DO inside the saved wrapper");
assert.strictEqual(recursive.sourceDiagnostics.referencedDoCopies.length, 2);
const wrapperCopy = recursive.sourceDiagnostics.referencedDoCopies.find(x => x.sourcePath === wrapper);
const leafCopy = recursive.sourceDiagnostics.referencedDoCopies.find(x => x.sourcePath === nested);
assert.ok(fs.readFileSync(wrapperCopy.tempPath, "utf8").includes(leafCopy.tempPath));
assert.ok(fs.readFileSync(leafCopy.tempPath, "utf8").includes(".__pngcompat__.svg"));
assert.strictEqual(fs.readFileSync(wrapper, "utf8"), wrapperSource);
assert.strictEqual(fs.readFileSync(nested, "utf8"), source);


const opts = { platform: "darwin", cwd: root, tempRoot: root, extensionRoot: path.join(__dirname, "..") };
const commentOnly = [
  `* do "${nested}"`, `// do "${nested}"`,
  `/* block\ndo "${nested}"\n*/`,
  'display `"do "' + nested + '""\'',
  `local example "do ${nested}"`,
  'local multiline `"example\ndo "' + nested + '"\nend"\'',
  'local nestedquote `"example\n`"inner\ndo "' + nested + '"\ninner"\'\nend"\'',
  'local ordinary "example\ndo ' + nested + '\nend"',
].join("\n");
const comments = adapter.prepareVisibleExecution(commentOnly, opts);
assert.strictEqual(comments.code, "set more off\n" + commentOnly);
assert.strictEqual(comments.sourceDiagnostics.referencedDoCopies.length, 0);

const afterString = adapter.prepareVisibleExecution(commentOnly + `\n* 中文🙂\ndo "${nested}"`, opts);
assert.strictEqual(afterString.darwinDiagnostics.replacements, 3);
assert.ok(afterString.code.includes(commentOnly));

const continued = adapter.prepareVisibleExecution(`cap noi do /// comment\n "${nested}"`, opts);
assert.strictEqual(continued.darwinDiagnostics.replacements, 3);
assert.ok(continued.code.includes("/// comment\n"));
const blockBetween = adapter.prepareVisibleExecution(`capture /* note */ do "${nested}"`, opts);
assert.strictEqual(blockBetween.darwinDiagnostics.replacements, 3);
assert.ok(blockBetween.code.includes("/* note */"));

const relative = adapter.prepareVisibleExecution('do "wrapper.do"', opts);
assert.strictEqual(relative.darwinDiagnostics.replacements, 3);
const uncertain = adapter.prepareVisibleExecution('cd "elsewhere"\ndo "wrapper.do"', opts);
assert.strictEqual(uncertain.darwinDiagnostics.ok, false);
assert.ok(uncertain.code.includes("exit 693"));
assert.ok(!uncertain.code.includes('cd "elsewhere"'));
const absoluteAfterCd = adapter.prepareVisibleExecution(`cd "elsewhere"\ndo "${wrapper}"`, opts);
assert.strictEqual(absoluteAfterCd.darwinDiagnostics.replacements, 3);

for (const command of ['do "$root/unknown.do"', 'run "unknown.do"', 'include "unknown.do"']) {
  const result = adapter.prepareVisibleExecution(command, opts);
  assert.strictEqual(result.sourceDiagnostics.referenceCoverage, "partial-static");
  assert.ok(result.code.includes(command));
}
const cycle = path.join(root, "cycle.do");
fs.writeFileSync(cycle, `do "${cycle}"\n`);
const cyclic = adapter.prepareVisibleExecution(`do "${cycle}"`, opts);
assert.strictEqual(cyclic.darwinDiagnostics.ok, false);
assert.match(cyclic.darwinDiagnostics.reason, /cyclic/);
assert.ok(cyclic.code.endsWith("exit 693\n"));
const missing = adapter.prepareVisibleExecution(`do "${root}/absent.do"`, opts);
assert.strictEqual(missing.darwinDiagnostics.ok, false);
assert.ok(!missing.code.includes(`do "${root}/absent.do"`));
const unsupportedLeaf = path.join(root, "unsupported.do");
fs.writeFileSync(unsupportedLeaf, '#delimit ;\ngraph export "unsupported.png", replace;');
const rejectedLeaf = adapter.prepareVisibleExecution(`capture do "${unsupportedLeaf}"\ndisplay "SHOULD_NOT_RUN"`, opts);
assert.strictEqual(rejectedLeaf.sourceDiagnostics.preparationFailed, true);
assert.ok(!rejectedLeaf.code.includes("SHOULD_NOT_RUN"), "capture must not swallow a descendant preparation failure");
const deep = [];
for (let i = 0; i < 17; i++) deep.push(path.join(root, `depth${i}.do`));
for (let i = 0; i < 17; i++) fs.writeFileSync(deep[i], i < 16 ? `do "${deep[i+1]}"` : source);
const depth = adapter.prepareVisibleExecution(`do "${deep[0]}"`, opts);
assert.strictEqual(depth.darwinDiagnostics.ok, false);
assert.match(depth.darwinDiagnostics.reason, /depth exceeds/);
const excessive = adapter.prepareVisibleExecution(Array(257).fill(`do "${nested}"`).join("\n"), opts);
assert.strictEqual(excessive.darwinDiagnostics.ok, false);
assert.match(excessive.darwinDiagnostics.reason, /count exceeds/);
const huge = path.join(root, "huge.do");
fs.writeFileSync(huge, "*".repeat(16 * 1024 * 1024 + 1));
const budget = adapter.prepareVisibleExecution(`do "${huge}"`, opts);
assert.strictEqual(budget.darwinDiagnostics.ok, false);
assert.match(budget.darwinDiagnostics.reason, /budget exceeds/);
fs.rmSync(root, { recursive: true, force: true });
console.log("DARWIN_COMPAT_ADAPTER_PASS");
