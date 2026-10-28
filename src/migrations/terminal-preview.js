"use strict";

// Apply readable source changes before esbuild. No maintained dist input and no
// rewriting of minifier-generated names. The 27 pinned upstream originals stay
// immutable; ambiguous or changed source anchors stop the migration build.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const upstream = path.join(root, "upstream/stata-workbench/src");

const MCP_PROBE_BEFORE = "spawnSync(finalCommand, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });";
const MCP_PROBE_AFTER = "spawnSync(finalCommand, ['--version'], commandProbeOptions(finalCommand));";

const LIFECYCLE_REQUIRE = "const { createExecutionLifecycle } = require('shared-session/execution-lifecycle');\n";
const BRIDGE_REQUIRE = "const { createBridgeHttp } = require('shared-session/bridge-http');\n";
const LIFECYCLE_INIT = "let globalContext = null;";
const LIFECYCLE_INIT_AFTER = `let globalContext = null;
const sourceLifecycle = createExecutionLifecycle({
  publish: snapshot => { try { globalThis.__codexSourceLifecycle = snapshot; } catch (_) {} },
});`;
const BRIDGE_INIT_AFTER = `let globalContext = null;
const sourceLifecycle = createExecutionLifecycle({
  publish: snapshot => { try { globalThis.__codexSourceLifecycle = snapshot; } catch (_) {} },
});
const sourceBridge = createBridgeHttp({
  lifecycle: sourceLifecycle,
  runCommand: payload => terminalRunCommand(payload.code, { runId: payload.runId }),
});
try { globalThis.__codexSourceBridge = sourceBridge; } catch (_) {}`;
const RUN_START = "const runId = TerminalPanel.startStreamingEntry(text, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);";
const RUN_START_AFTER = RUN_START + "\n            if (runId) sourceLifecycle.begin({ runId, requestId: runId, sourceMode: 'selection' });";
const FILE_RUN_START = "const runId = TerminalPanel.startStreamingEntry(commandText, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);";
const FILE_RUN_START_AFTER = FILE_RUN_START + "\n                if (runId) sourceLifecycle.begin({ runId, requestId: runId, sourceMode: 'file' });";
const STARTED = "TerminalPanel.updateStreamingStatus(runId, 'running');";
const STARTED_AFTER = "sourceLifecycle.started(runId);\n                        " + STARTED;
const FINISH = "TerminalPanel.finishStreamingEntry(runId, result);";
const FINISH_AFTER = "sourceLifecycle.finish(runId, result);\n                    " + FINISH;
const FAIL = "TerminalPanel.failStreamingEntry(runId, error?.message || String(error));";
const FAIL_AFTER = "sourceLifecycle.fail(runId, error);\n                    " + FAIL;
const BRIDGE_START = "    outputChannel = vscode.window.createOutputChannel('Stata Workbench');";
const BRIDGE_START_AFTER = BRIDGE_START + `
    sourceBridge.start(Number(settings.get('visibleBridgePort', 17485))).then(snapshot => {
        try { globalThis.__codexSourceBridgeStatus = snapshot; } catch (_) {}
    }).catch(error => appendLine('[Source bridge] ' + String(error?.message || error)));`;
const BRIDGE_CLOSE = "async function deactivate() {";
const BRIDGE_CLOSE_AFTER = BRIDGE_CLOSE + "\n    await sourceBridge.close();";

const CLEAR_BEFORE = "            chatStream.innerHTML = '';";
const CLEAR_AFTER = CLEAR_BEFORE + "\n            // Preserve the element retained by artifact rendering after restore.\n            if (sessionArtifactsEl) chatStream.appendChild(sessionArtifactsEl);";
const ROUTE_BEFORE = `        if ((message.artifactType === 'help' || message.type_hint === 'help') && message.path && typeof TerminalPanel._openHelpPanel === 'function') {
          TerminalPanel._openHelpPanel(message.path, message.label);
        } else if (message.path) {
          openArtifact(message.path, message.baseDir);
        }`;
const ROUTE_AFTER = `        routeTerminalArtifact(message, {
          openHelp: TerminalPanel._openHelpPanel,
          openPreview: TerminalPanel._openGraphPreview,
          openFile: openArtifact,
        });`;

function replace(source, before, after, expected = 1) {
  assert.equal(source.split(before).length - 1, expected, "Source migration anchor changed: " + before.slice(0, 100));
  return source.split(before).join(after);
}

function transform(name, source) {
  if (name === "mcp-client.js") {
    source = "const { commandProbeOptions } = require('shared-session/platform-process');\n" + source;
    assert.equal(source.split(MCP_PROBE_BEFORE).length - 1, 2,
      "Source migration anchor changed: Windows MCP probe options");
    return source.split(MCP_PROBE_BEFORE).join(MCP_PROBE_AFTER);
  }
  if (name === "terminal-panel.js") {
    source = "const { routeTerminalArtifact } = require('shared-session/manual-graph-preview');\n" + source;
    source = replace(source, "  static _openHelpPanel = null;", "  static _openHelpPanel = null;\n  static _openGraphPreview = null;");
    source = replace(source, "downloadGraphPdf, openHelpPanel, cancelRun", "downloadGraphPdf, openHelpPanel, openGraphPreview, cancelRun", 3);
    source = replace(source, "    if (typeof openHelpPanel === 'function') {", "    if (typeof openGraphPreview === 'function') TerminalPanel._openGraphPreview = openGraphPreview;\n    if (typeof openHelpPanel === 'function') {");
    source = replace(source, ROUTE_BEFORE, ROUTE_AFTER);
    source = replace(source, CLEAR_BEFORE, CLEAR_AFTER);
    return source;
  }
  if (name === "extension.js") {
    source = "const { createManualGraphPreview } = require('shared-session/manual-graph-preview');\n" + source;
    source = replace(source, "const { openArtifact } = require('./artifact-utils');", "const { openArtifact, resolveArtifactUri } = require('./artifact-utils');");
    source = replace(source, "let globalContext = null;", `let globalContext = null;
const openGraphPreview = createManualGraphPreview({
    resolvePath: message => {
        const uri = resolveArtifactUri(message?.path, message?.baseDir);
        return uri?.scheme === 'file' ? uri.fsPath : null;
    },
    exists: absolutePath => fs.existsSync(absolutePath),
    deliver: (_previewId, artifact) => {
        openGraphPanel([artifact]);
        graphPanel.reveal(vscode.ViewColumn.Beside, true);
    },
    log: message => debugLog(message),
});`);
    source = replace(source, "    TerminalPanel.setHandlersFactory(() => ({", "    TerminalPanel._bindHandlers({ openGraphPreview });\n    TerminalPanel.setHandlersFactory(() => ({\n        openGraphPreview,");
    // The original upstream graph renderer only allowed bundled resources and
    // file:// SVGs. Scope local roots to this explicit preview and use webview URIs.
    source = replace(source, "    const html = renderGraphHtml(graphDetails, graphPanel.webview, globalExtensionUri, nonce);", `    graphPanel.webview.options = {
        ...graphPanel.webview.options,
        localResourceRoots: [
            vscode.Uri.joinPath(globalExtensionUri, 'src', 'ui-shared'),
            vscode.Uri.joinPath(globalExtensionUri, 'dist', 'ui-shared'),
            ...graphDetails.map(item => vscode.Uri.file(path.dirname(item.path))),
        ],
    };
    const html = renderGraphHtml(graphDetails, graphPanel.webview, globalExtensionUri, nonce);`);
    source = replace(source, "const canPreview = preview && preview.toLowerCase().endsWith('.svg');", "const canPreview = preview && /\\.(svg|png|jpe?g|gif|webp)$/i.test(preview);");
    source = replace(source, 'src="file://${preview}"', 'src="${escapeHtml(webview.asWebviewUri(vscode.Uri.file(preview)).toString())}"');
    source = BRIDGE_REQUIRE + LIFECYCLE_REQUIRE + source;
    source = replace(source, LIFECYCLE_INIT, BRIDGE_INIT_AFTER);
    source = replace(source, RUN_START, RUN_START_AFTER);
    source = replace(source, FILE_RUN_START, FILE_RUN_START_AFTER);
    source = replace(source, STARTED, STARTED_AFTER, 2);
    source = replace(source, FINISH, FINISH_AFTER, 2);
    source = replace(source, FAIL, FAIL_AFTER, 2);
    source = replace(source, BRIDGE_START, BRIDGE_START_AFTER);
    source = replace(source, BRIDGE_CLOSE, BRIDGE_CLOSE_AFTER);
    return source;
  }
  return source;
}

function plugin() {
  return {
    name: "terminal-preview-source-migration",
    setup(build) {
      build.onResolve({ filter: /^shared-session\/manual-graph-preview$/ }, () => ({
        path: path.join(root, "src/shared-session/manual-graph-preview.js"),
      }));
      build.onResolve({ filter: /^shared-session\/platform-process$/ }, () => ({
        path: path.join(root, "src/shared-session/platform-process.js"),
      }));
      build.onResolve({ filter: /^shared-session\/execution-lifecycle$/ }, () => ({
        path: path.join(root, "src/shared-session/execution-lifecycle.js"),
      }));
      build.onResolve({ filter: /^shared-session\/bridge-http$/ }, () => ({
        path: path.join(root, "src/shared-session/bridge-http.js"),
      }));
      build.onLoad({ filter: /[/\\](extension|terminal-panel|mcp-client)\.js$/ }, args => {
        if (path.dirname(args.path) !== upstream) return;
        return { contents: transform(path.basename(args.path), fs.readFileSync(args.path, "utf8")),
          loader: "js", resolveDir: upstream };
      });
    },
  };
}

module.exports = {
  plugin, transform, replace, CLEAR_BEFORE, CLEAR_AFTER, ROUTE_BEFORE, ROUTE_AFTER,
  MCP_PROBE_BEFORE, MCP_PROBE_AFTER, LIFECYCLE_REQUIRE, BRIDGE_REQUIRE, LIFECYCLE_INIT,
  LIFECYCLE_INIT_AFTER, BRIDGE_INIT_AFTER, RUN_START, RUN_START_AFTER, FILE_RUN_START,
  FILE_RUN_START_AFTER, STARTED, FINISH, FAIL, BRIDGE_START, BRIDGE_CLOSE,
};
