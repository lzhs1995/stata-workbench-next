#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const acorn = require("acorn");
const walk = require("acorn-walk");
const adapter = require("./darwin_compat_adapter");
const { patchBundle, MARKER } = require("./apply_bridge_request_preservation_patch");
const fingerprint = require("./finalize_bundle_identity");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const start = bundle.indexOf("let __codexBridgeDocScanText=");
const end = bundle.indexOf("let __codexBridgeWatchdog=", start);
assert.ok(start >= 0 && end > start);
assert.equal(bundle.indexOf("let __codexBridgeDocScanText=", start + 1), -1);
const bridge = bundle.slice(start, end);
const names = new Set([
  "__codexPrepareHumanFileGraphRun", "__codexPrepareGraphRunCode",
  "__codexResolveSingleDoFilePath", "__codexGraphScanTextForCode",
  "__codexShouldIncludeGraphs", "__codexIsComplexManualSelection",
]);
const functions = [];
walk.simple(acorn.parse(bundle, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), {
  FunctionDeclaration(node) {
    if (names.has(node.id?.name)) functions.push(bundle.slice(node.start, node.end));
  },
});
assert.equal(functions.length, names.size);
const script = new vm.Script(functions.join("\n") + "\n" + bridge + "\n__code");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-request-preservation-"));
const file = path.join(root, "guard with spaces.do");
const leaf = path.join(root, "leaf.do");
const leafText = 'graph export "/tmp/points.png", replace width(800)\n'
  + 'putdocx image "/tmp/points.png"\nputdocx save "/tmp/points.docx", replace\n';
const fileText = `do "${leaf}"\n`;
fs.writeFileSync(file, fileText);
fs.writeFileSync(leaf, leafText);
const marker = "___CODEX_RUN_DONE_fixture___";
const suffix = `\ndisplay as text "${marker}"\n`;
let cases = 0;

function execute(code, options = {}) {
  const calls = { fileRunner: [], instrument: [], errors: [] };
  const context = {
    __code: code, __run: "fixture", __cwd: root, JA: fs, rg: path,
    process: { cwd: () => root }, __codexPreparedGraphRuns: new Map(),
    __codexGraphMark: () => {}, __codexGraphLog: error => calls.errors.push(error),
    __codexTrimTrailingRunFileNonExecutable: text => text,
    __codexActivateNamedGraphExports: text => text,
    __codexBuildCompletionMarker: () => marker,
    __codexAppendCompletionMarker: text => text.trimEnd() + suffix,
    __codexStataString: text => text,
    // Rendering/filesystem outputs are fixture boundaries. Both real graph
    // preparation functions and the real dispatch/assignment execute above.
    __codexInstrumentStataGraphCode: text => {
      calls.instrument.push(text);
      return { code: text, graphCommandCount: 0, manifestPath: null };
    },
    __codexVerifyPreparedRunFileCopy: () => ({ ok: true }),
    __codexBuildRunFileGraphExportCode: p => {
      calls.fileRunner.push(p);
      return { code: `do "${p}"`, snapshotRoot: root, manifestPath: null };
    },
  };
  vm.createContext(context);
  if (options.noHuman) {
    // Keep the actual selection preparation path available if the optional
    // human-file helper was not exported by the host.
    new vm.Script(functions.join("\n") + "\n__codexPrepareHumanFileGraphRun=undefined;\n"
      + bridge + "\n__code").runInContext(context);
  } else script.runInContext(context);
  assert.deepEqual(calls.errors, [], "fixture must not pass via preparation catch fallback");
  return { code: context.__code, calls };
}

try {
  const wrapper = `capture noisily do "${file}"\nlocal diagrc = _rc\n`
    + 'if `diagrc\'==0 display as text "BODY_PASS"\n'
    + 'display as text "CLIENT_DONE"\ndisplay as text "WRAPPER_RC=" `diagrc\'';
  if (process.argv.includes("--expect-legacy")) {
    assert.ok(!bundle.includes(MARKER), "negative control requires the original bundle");
    const result = execute(wrapper);
    assert.deepEqual(result.calls.fileRunner, [file]);
    assert.equal(result.code, `do "${file}"` + suffix);
    assert.ok(!result.code.includes("CLIENT_DONE"));
    console.log(JSON.stringify({ verdict: "LEGACY_WRAPPER_LOSS_REPRODUCED", bundleSha256:
      crypto.createHash("sha256").update(bundle).digest("hex"), input: wrapper, output: result.code,
      executedRealBundleFunctions: [...names], liveStata: false }));
  } else {
    assert.ok(bundle.includes(MARKER));
    const preserved = [
      wrapper, `capture do "${file}"`, `quietly do "${file}"`, `cap noi do "${file}"`,
      `do "${file}"\ndisplay "AFTER"`, `display "BEFORE"\ndo "${file}"`,
      `do "${file}" argument`, `do "${file}", nostop`,
      `* do "${file}"`, `// do "${file}"`, `/*\ndo "${file}"\n*/`,
      'display `"do "' + file + '""\'',
      `do "${file}" // comment`, `do "${file}"; display "AFTER"`,
      `do "${file}"\ndo "${file}"`, `capture do "${file}"\r\ndisplay "AFTER"`,
      `do "${root}/missing.do"`, `run "${file}"`,
    ];
    for (const input of preserved) {
      const result = execute(input);
      assert.deepEqual(result.calls.fileRunner, [], input);
      assert.equal(result.code, input.trimEnd() + suffix, input);
      cases++;
    }
    for (const input of [`do "${file}"`, ` \tDO "${file}"\r\n`, `\n do "${file}"\n\n`]) {
      const result = execute(input);
      assert.deepEqual(result.calls.fileRunner, [file], input);
      assert.equal(result.code, `do "${file}"` + suffix);
      cases++;
    }
    const noHuman = execute(`do "${file}"`, { noHuman: true });
    assert.deepEqual(noHuman.calls.fileRunner, []);
    assert.equal(noHuman.code, `do "${file}"` + suffix);
    cases++;

    // The output of real bridge preparation is then passed through the real
    // recursive Darwin adapter; the capture prefix and trailing markers survive
    // while both referenced files receive their required compatibility copies.
    const routed = execute(wrapper).code;
    const prepared = adapter.prepareVisibleExecution(routed, {
      platform: "darwin", cwd: root, tempRoot: root,
      extensionRoot: path.join(__dirname, ".."),
    });
    assert.equal(prepared.darwinDiagnostics.ok, true, JSON.stringify(prepared.darwinDiagnostics));
    assert.equal(prepared.sourceDiagnostics.referencedDoCopies.length, 2);
    const guardCopy = prepared.sourceDiagnostics.referencedDoCopies.find(x => x.sourcePath === file);
    assert.ok(prepared.code.includes(`capture noisily do "${guardCopy.tempPath}"`));
    assert.ok(prepared.code.includes(wrapper.slice(wrapper.indexOf("\nlocal diagrc"))));
    assert.equal(prepared.code.split(marker).length - 1, 1);
    assert.equal(fs.readFileSync(file, "utf8"), fileText);
    assert.equal(fs.readFileSync(leaf, "utf8"), leafText);
    cases++;

    assert.equal(patchBundle(bundle), bundle, "patch must be byte-idempotent");
    assert.equal(fingerprint.verify(bundle).ok, true);
    assert.throws(() => patchBundle("/* " + MARKER + " */"), /anchor/);
    assert.throws(() => patchBundle(bundle + bridge), /ambiguous/);
    console.log(JSON.stringify({ verdict: "PASS", cases, realBundleFunctions: [...names],
      recursiveDarwinCopies: 2, sourceUnchanged: true, liveStata: false }));
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
