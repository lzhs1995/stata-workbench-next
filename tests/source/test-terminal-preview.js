"use strict";
// Exercise actual source-built Terminal handlers and emitted HTML, not copied
// handler branches. The unmodified upstream module is the failing control.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "out/migrated-source");
const migration = require("../../src/migrations/terminal-preview");
const manifest = JSON.parse(fs.readFileSync(path.join(output, "BUILD-MANIFEST.json")));
for (const [name, expected] of Object.entries(manifest.outputs)) {
  const data = fs.readFileSync(path.join(output, name));
  assert.equal(data.length, expected.bytes, name);
  assert.equal(crypto.createHash("sha256").update(data).digest("hex"), expected.sha256, name);
}

class Element {
  constructor(root = false) { this.root = root; this.parentNode = null; this.children = []; this.html = ""; }
  get isConnected() { return this.root || !!this.parentNode?.isConnected; }
  set innerHTML(value) { this.html = value; for (const item of this.children) item.parentNode = null; this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(item) { item.parentNode = this; this.children.push(item); return item; }
  querySelectorAll() { return []; }
}

function segment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "Missing emitted HTML function: " + start);
  return source.slice(a, b);
}

function checkDom(html, fixed) {
  const clear = segment(html, "    function clearAllOutput() {", "\n    function ");
  const render = segment(html, "    function renderSessionArtifacts() {", "    function removeSessionArtifact(");
  const stream = new Element(true), artifacts = new Element();
  stream.appendChild(artifacts);
  const context = { chatStream: stream, sessionArtifactsEl: artifacts, runs: { old: {} },
    sessionArtifacts: [], sessionArtifactKeys: new Set(), history: ["old"], historyIndex: 0,
    updateLastCommand() {}, updateStatusIndicator() {}, scrollToBottom() {},
    renderArtifacts: items => items.map(item => item.path).join(","), bindArtifactImageEvents() {}, console: { log() {} } };
  vm.createContext(context);
  vm.runInContext(clear + render, context);
  for (let i = 0; i < 2; i++) {
    context.clearAllOutput();
    assert.equal(context.history.length, 0);
    assert.equal(Object.keys(context.runs).length, 0);
    assert.equal(context.addSessionArtifact({ path: "image-" + i + ".png" }), true);
    context.renderSessionArtifacts();
    assert.equal(artifacts.innerHTML, "image-" + i + ".png");
    assert.equal(artifacts.isConnected, fixed);
    assert.equal(stream.children.length, fixed ? 1 : 0);
  }
}

async function checkBuiltTerminal(filename, fixed) {
  const contract = require(path.join(output, filename));
  const { TerminalPanel, context, createManualGraphPreview, resolveArtifactUri } = contract;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source 图形 O'Brien "));
  try {
    for (const name of ["a.svg", "b.PNG", "output.log"]) fs.writeFileSync(path.join(dir, name), "synthetic " + name);
    const calls = { previews: [], opened: [], help: [], errors: [], stata: 0 };
    function uri(file) { return { scheme: "file", fsPath: file, toString: () => "file:" + file }; }
    function panel() {
      return { viewColumn: 2, reveal() {}, onDidDispose() {}, webview: {
        cspSource: "webview:", asWebviewUri: item => ({ toString: () => "webview:" + item.fsPath }),
        onDidReceiveMessage(fn) { this.receive = fn; }, postMessage() {},
      } };
    }
    context.setDefaultVscode({ Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
      parse: text => ({ scheme: text.split(":")[0], toString: () => text }) },
      ViewColumn: { Beside: 2, Active: 1 },
      workspace: { workspaceFolders: [{ uri: uri(dir) }] },
      commands: { executeCommand: (...args) => calls.opened.push(args) },
      window: { createWebviewPanel: panel, showErrorMessage: message => calls.errors.push(message) },
    });
    context.setDefaultMcpClient(new Proxy({}, { get() { calls.stata++; throw new Error("Preview must not call Stata"); } }));
    const preview = createManualGraphPreview({
      resolvePath: message => { const value = resolveArtifactUri(message.path, message.baseDir); return value?.scheme === "file" ? value.fsPath : null; },
      exists: fs.existsSync, deliver: (id, item) => calls.previews.push({ id, item }), now: () => 42,
    });
    const handlers = { openGraphPreview: preview, openHelpPanel: (...args) => calls.help.push(args) };
    TerminalPanel.setExtensionUri(uri(dir));
    TerminalPanel.setHandlersFactory(() => handlers);
    TerminalPanel._bindHandlers(handlers);
    TerminalPanel.show({ ...handlers, filePath: path.join(dir, "synthetic.do") });
    const send = message => TerminalPanel.currentPanel.webview.receive({ type: "openArtifact", ...message });
    await send({ path: path.join(dir, "a.svg"), label: "saved graph" });
    if (!fixed) {
      assert.equal(calls.previews.length, 0, "Unmodified source has no preview callback route");
      assert.equal(calls.opened[0][0], "vscode.open", "Control reproduces ordinary editor fallback");
      checkDom(TerminalPanel.currentPanel.webview.html, false);
      return;
    }
    assert.equal(calls.previews.length, 1);
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.previews[0].id, "manual-preview-42-1");
    assert.equal(calls.previews[0].item.path, path.join(dir, "a.svg"));
    await send({ path: "b.PNG", baseDir: dir });
    assert.equal(calls.previews[1].item.path, path.join(dir, "b.PNG"));
    assert.equal(calls.previews[1].id, "manual-preview-42-2");
    await send({ path: "output.log", baseDir: dir });
    assert.equal(calls.opened.at(-1)[0], "vscode.open");
    await send({ path: "help regress", artifactType: "help", label: "Help" });
    assert.deepEqual(calls.help, [["help regress", "Help"]]);
    await send({ path: "missing.svg", baseDir: dir });
    assert.equal(calls.previews.length, 2);
    assert(calls.errors.at(-1).includes("Artifact not found"));
    // A serializer must rebind the callback across the actual Terminal module.
    TerminalPanel._openGraphPreview = null;
    TerminalPanel.restorePanel(panel(), {});
    await send({ path: path.join(dir, "a.svg") });
    assert.equal(calls.previews.length, 3);
    assert.equal(calls.stata, 0);
    checkDom(TerminalPanel.currentPanel.webview.html, true);
    assert.equal(fs.readFileSync(path.join(dir, "a.svg"), "utf8"), "synthetic a.svg");
  } finally {
    TerminalPanel.currentPanel = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await checkBuiltTerminal("upstream-terminal-contract.cjs", false);
  await checkBuiltTerminal("terminal-contract.cjs", true);
  const upstream = fs.readFileSync(path.join(root, "upstream/stata-workbench/src/terminal-panel.js"), "utf8");
  assert.throws(() => migration.transform("terminal-panel.js", upstream.replace(migration.ROUTE_BEFORE, "changed upstream route")), /anchor changed/);
  assert.throws(() => migration.transform("terminal-panel.js", upstream + migration.ROUTE_BEFORE), /anchor changed/);
  const result = { schema: "source-migration-behavior/1", verdict: "PASS_SOURCE_TERMINAL_PREVIEW",
    checks: ["real compiled Terminal callback route", "absolute SVG and relative Unicode/apostrophe PNG path",
      "independent preview IDs", "non-image fallback", "help routing", "missing-file refusal",
      "serializer callback rebinding", "connected artifact container across two clears",
      "unmodified upstream failing controls", "changed/ambiguous source refusal", "no Stata calls or saved-file mutation"],
    buildManifestSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(output, "BUILD-MANIFEST.json"))).digest("hex"),
    scope: "Compiled Terminal/preview behavior with fake VS Code host and DOM; actual Graphs rendering and complete runtime parity remain pending" };
  fs.writeFileSync(path.join(output, "BEHAVIOR-RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
