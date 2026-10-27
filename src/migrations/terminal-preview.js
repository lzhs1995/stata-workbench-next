"use strict";

// Apply readable source changes before esbuild. No maintained dist input and no
// rewriting of minifier-generated names. The 27 pinned upstream originals stay
// immutable; ambiguous or changed source anchors stop the migration build.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const upstream = path.join(root, "upstream/stata-workbench/src");

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
      build.onLoad({ filter: /[/\\](extension|terminal-panel)\.js$/ }, args => {
        if (path.dirname(args.path) !== upstream) return;
        return { contents: transform(path.basename(args.path), fs.readFileSync(args.path, "utf8")),
          loader: "js", resolveDir: upstream };
      });
    },
  };
}

module.exports = { plugin, transform, replace, CLEAR_BEFORE, CLEAR_AFTER, ROUTE_BEFORE, ROUTE_AFTER };
