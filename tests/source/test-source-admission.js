"use strict";

// 回归：混合入口的执行归属（2026-10-29 Codex 源码审阅 7 项断言）。
// 运行经真实 migration 转换的完整 extension 模块；MCP 是串行替身，UI/遥测是替身。
// 不装 VSIX、不启动 VS Code、不运行 Stata。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const migration = require(path.join(root, "src/migrations/terminal-preview.js"));
const context = require(path.join(root, "upstream/stata-workbench/src/runtime-context.js"));
const original = fs.readFileSync(path.join(root, "upstream/stata-workbench/src/extension.js"), "utf8");

function request(port, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/run-command",
      headers: { "content-type": "application/json" } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("test HTTP timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

function fixture({ editorPath = "/fixture/中文 O'Brien/selection.do", reject = new Set() } = {}) {
  const calls = [], pending = [];
  let serial = Promise.resolve(), executing = 0, maximum = 0, handlers;
  const submit = (kind, code, options = {}) => {
    const entry = { kind, code, runId: options.runId || null, cwd: options.cwd ?? null };
    calls.push(entry);
    const job = serial.then(() => new Promise((resolve, fail) => {
      executing++; maximum = Math.max(maximum, executing);
      if (options.onStarted) options.onStarted();
      pending.push(() => {
        executing--;
        if (reject.has(calls.indexOf(entry))) fail(new Error("synthetic transport lost"));
        else resolve({ success: true, rc: 0 });
      });
    }));
    serial = job.catch(() => {});
    return job;
  };
  const client = { runSelection: (code, o) => submit("selection", code, o), runFile: (file, o) => submit("file", file, o) };
  let rows = 0;
  const TerminalPanel = { currentPanel: null, startStreamingEntry: () => "editor-" + (++rows), show(v) { handlers = v; },
    updateStreamingStatus() {}, finishStreamingEntry() {}, failStreamingEntry() {}, appendStreamingLog() {},
    appendRunArtifact() {}, updateStreamingProgress() {}, addEntry() {} };
  context.setDefaultVscode({
    ExtensionMode: { Test: 3 }, ProgressLocation: { Notification: 1 },
    workspace: { getConfiguration: () => ({ get: (_n, fallback) => fallback }) },
    window: { activeTextEditor: { selection: { isEmpty: false },
      document: { uri: { fsPath: editorPath }, isDirty: false, getText: () => "display 2" } },
      withProgress: (_o, fn) => fn({}, { isCancellationRequested: false }), showErrorMessage: async () => undefined },
  });
  context.setDefaultMcpClient(client);
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, Buffer, URL, setTimeout, clearTimeout, setImmediate,
    process: { platform: process.platform, env: { MCP_STATA_INTEGRATION: "1" } } };
  sandbox.global = sandbox;
  sandbox.require = name => {
    if (name === "./instrument.js") return {};
    if (name === "@sentry/node") return { startSpan: (_o, fn) => fn() };
    if (name === "./runtime-context") return context;
    if (name === "./terminal-panel") return { TerminalPanel };
    if (name === "./data-browser-panel") return { DataBrowserPanel: { currentPanel: null } };
    if (name === "./help-panel") return { HelpPanel: {} };
    if (name === "./artifact-utils") return { openArtifact() {}, resolveArtifactUri: () => null };
    if (name === "./fs-utils") return { getTmpFilePath() { throw new Error("unexpected dirty file"); } };
    if (name === "../package.json") return require(path.join(root, "upstream/stata-workbench/package.json"));
    if (name.startsWith("shared-session/")) return require(path.join(root, "src", name));
    if (name === "path" || name === "os") return require(name);
    throw new Error("unexpected extension dependency: " + name);
  };
  vm.runInNewContext(migration.transform("extension.js", original) +
    // activate() normally creates the output channel used by error reporting.
    "\noutputChannel = { appendLine() {}, show() {} };" +
    "\nmodule.exports.t = { runSelection, runFile, openTerminal, sourceLifecycle, sourceBridge };\n", sandbox,
    { filename: "transformed-extension.js", timeout: 3000 });
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  return { ...module.exports.t, calls, get handlers() { return handlers; }, get maximum() { return maximum; },
    async waitCalls(n) { for (let i = 0; i < 300 && calls.length < n; i++) await tick(); assert.ok(calls.length >= n, "MCP call did not arrive"); },
    async settleNext() { for (let i = 0; i < 300 && !pending.length; i++) await tick(); assert.ok(pending.length); pending.shift()(); await tick(); },
  };
}

(async () => {
  const results = {};
  // Bridge cwd reaches MCP; an editor .do run submitted meanwhile is queued, not the owner.
  {
    const f = fixture({ editorPath: "/fixture/中文 O'Brien/analysis.do" });
    const { port } = await f.sourceBridge.start();
    const response = request(port, { runId: "bridge-1", code: "display 1", cwd: "/fixture/中文 O'Brien" });
    await f.waitCalls(1);
    assert.equal(f.calls[0].cwd, "/fixture/中文 O'Brien");
    const file = f.runFile();
    await f.waitCalls(2);
    assert.equal(f.calls[1].kind, "file");
    assert.equal(f.sourceLifecycle.status().runId, "bridge-1", "file run must not replace the bridge owner");
    await f.settleNext();
    const body = (await response).body;
    assert.equal(body.lifecycle.runId, "bridge-1");
    assert.equal(body.lifecycle.phase, "completed");
    assert.equal(f.sourceLifecycle.status().runId, "editor-1");
    assert.equal(f.sourceLifecycle.status().sourceMode, "file");
    await f.settleNext();
    await file;
    assert.equal(f.sourceLifecycle.status().phase, "completed");
    assert.equal(f.maximum, 1);
    await f.sourceBridge.close();
    results.bridgeThenFile = "PASS";
  }
  // A running Terminal command is visible to bridge admission; its transport loss holds the owner.
  {
    const f = fixture({ reject: new Set([0]) });
    const { port } = await f.sourceBridge.start();
    await f.openTerminal();
    const terminal = f.handlers.runCommand("display 1", { runId: "terminal-1", cwd: "/fixture" });
    await f.waitCalls(1);
    assert.equal(f.sourceLifecycle.status().runId, "terminal-1");
    assert.equal(f.sourceLifecycle.status().phase, "running");
    assert.equal((await request(port, { runId: "bridge-2", code: "display 2" })).status, 409);
    await f.settleNext();
    const shown = await terminal;
    assert.equal(shown.success, false, "the Terminal UI still receives a result object");
    assert.equal(f.sourceLifecycle.status().phase, "unknown");
    assert.equal(f.sourceLifecycle.status().releasedAt, null);
    assert.equal((await request(port, { runId: "bridge-3", code: "display 3" })).status, 409);
    await f.sourceBridge.close();
    results.terminalVisibleAndUnknownHeld = "PASS";
  }
  // A rejected editor selection is an unknown outcome, not a confirmed failure.
  {
    const f = fixture({ reject: new Set([0]) });
    const selection = f.runSelection().catch(error => error);
    await f.waitCalls(1);
    await f.settleNext();
    assert.match(String((await selection)?.message), /synthetic transport lost/);
    assert.equal(f.sourceLifecycle.status().phase, "unknown");
    assert.equal(f.sourceLifecycle.status().releasedAt, null);
    results.selectionRejectionHeld = "PASS";
  }
  console.log(JSON.stringify({ verdict: "PASS_SOURCE_ADMISSION", results, liveStata: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
