"use strict";

// Executes the Download handler out of dist/extension.js with a realistic
// createDepProxy stub.  Negative control: the pre-patch segment throws
// "iA.Uri.file is not a function" with the same stubs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_download_uri_binding_patch");

const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");

assert.ok(bundle.includes(patch.MARKER), "F2b marker is in the shipped bundle");
assert.equal(patch.patchBundle(bundle, { finalize: false }), bundle, "F2b patch is idempotent");
const reverted = patch.revertBundle(bundle);
assert.ok(reverted.includes(patch.BEFORE), "revert restores the upstream call");
assert.equal(reverted.includes(patch.MARKER), false);
assert.equal(patch.patchBundle(reverted, { finalize: false }).includes(patch.AFTER), true,
  "revert-then-patch reinstalls the same text");
assert.equal(bundle.includes('"' + patch.MARKER), false, "marker is outside string literals");

// Cut the handler and the helper it now calls out of the bundle.
function segment(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, "segment missing: " + start.slice(0, 32));
  assert.equal(source.indexOf(start, a + 1), -1, "segment not unique");
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, "segment end missing");
  return source.slice(a, b);
}
const HELPERS = segment(bundle, "function __codexVscodeApi() {", "function __codexGraphLog(message) {");
const HANDLER = segment(bundle, "RD(g,__baseDir){return GB.startSpan(", "async function IP(g,A,I){");

// The bundle's own createDepProxy (Rag): a function-valued member is returned
// as `B.bind(Q)`.  vscode.Uri is a class, so the bound copy keeps no static
// members and `iA.Uri.file` is undefined.  Byte-for-byte the shipped handler.
const depProxy = (g) => new Proxy({}, {
  get(_A, I) {
    const Q = g();
    const B = Q?.[I];
    const C = typeof B === "function" && (B._isMockFunction || B.mock);
    return typeof B === "function" && !C ? B.bind(Q) : B;
  },
  set(_A, I, Q) { const B = g(); return B ? ((B[I] = Q), true) : false; },
});
// Guard the premise: the proxy really does lose Uri.file for a class.
{
  class Uri { static file(p) { return { fsPath: p }; } }
  const probe = depProxy(() => ({ Uri }));
  assert.equal(typeof probe.Uri, "function", "the proxy returns the bound class");
  assert.equal(typeof probe.Uri.file, "undefined", "bind() drops the static member");
  assert.equal(typeof Uri.file, "function", "the unwrapped class keeps it");
}

async function runDownload(handlerText, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-download-"));
  const pdf = path.join(tmp, "graph.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4 stub\n");
  const written = [];
  // vscode.Uri is a class with a static file(), which is what breaks the proxy.
  class Uri { static file(value) { return { fsPath: value, scheme: "file" }; } }
  const realVscode = {
    Uri,
    window: {
      showSaveDialog: async (opts) => {
        assert.ok(opts.defaultUri, "the dialog receives a defaultUri");
        assert.equal(opts.defaultUri.scheme, "file", "defaultUri is a real Uri");
        return options.cancel ? undefined : { fsPath: path.join(tmp, "saved.pdf") };
      },
    },
    workspace: { fs: { writeFile: async (uri, bytes) => written.push([uri.fsPath, bytes.length]) } },
  };
  const sandbox = {
    GB: { startSpan: (_meta, fn) => fn() },
    ng: () => {},
    RI: () => {},
    zg: { fetchGraph: async () => ({ path: pdf }) },
    JA: fs,
    rg: path,
    MD: { homedir: () => tmp },
    iA: depProxy(() => realVscode),
    FHg: () => realVscode,
    console,
  };
  const script = HELPERS + "\nasync function " + handlerText + "\nRD;";
  const handler = vm.runInNewContext(script, sandbox);
  const result = await handler("mygraph", tmp);
  return { result, written, tmp };
}

(async () => {
  // Patched: the handler completes and the file is saved through the dialog.
  const ok = await runDownload(HANDLER);
  assert.equal(ok.written.length, 1, "the chosen target is written once");
  assert.equal(path.basename(ok.result.path), "saved.pdf");
  assert.equal(ok.result.label, "mygraph");

  // A cancelled dialog still returns the source path and writes nothing.
  const cancelled = await runDownload(HANDLER, { cancel: true });
  assert.equal(cancelled.written.length, 0);
  assert.equal(path.basename(cancelled.result.path), "graph.pdf");

  // Negative control: the upstream binding on the same stubs.
  const upstream = HANDLER.replace(patch.AFTER, patch.BEFORE);
  assert.notEqual(upstream, HANDLER, "the control really uses the upstream text");
  await assert.rejects(() => runDownload(upstream), /iA\.Uri\.file is not a function/,
    "the upstream wrapped binding throws before the save dialog");

  // Fail-closed: without a usable vscode API the helper raises a named error.
  const noApi = HANDLER;
  await assert.rejects(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-download-noapi-"));
    const pdf = path.join(tmp, "graph.pdf");
    fs.writeFileSync(pdf, "%PDF\n");
    const sandbox = {
      GB: { startSpan: (_m, fn) => fn() }, ng: () => {}, RI: () => {},
      zg: { fetchGraph: async () => ({ path: pdf }) }, JA: fs, rg: path,
      MD: { homedir: () => tmp }, iA: {}, console,
    };
    const handler = vm.runInNewContext(HELPERS + "\nasync function " + noApi + "\nRD;", sandbox);
    await handler("g", tmp);
  }, /VS Code Uri\.file unavailable/, "a missing API is a named failure, not a silent undefined");

  console.log("PASS download uri binding: handler executes, saves, and the upstream binding is the control");
})().catch((error) => { console.error(error); process.exitCode = 1; });
