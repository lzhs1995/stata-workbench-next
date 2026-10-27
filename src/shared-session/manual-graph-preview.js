"use strict";

// Source migration of the maintained manual preview policy. Dependencies are
// explicit so Terminal and Graphs never depend on sibling bundle closure scope.
function createManualGraphPreview({ resolvePath, exists, deliver, log = () => {}, now = Date.now }) {
  let sequence = 0;
  return function openGraphPreview(message) {
    try {
      const absolutePath = resolvePath(message);
      if (!absolutePath || !/\.(svg|png|jpe?g|gif|webp)$/i.test(absolutePath)) return false;
      if (!exists(absolutePath)) return false;
      const previewId = "manual-preview-" + now() + "-" + (++sequence);
      deliver(previewId, {
        path: absolutePath, label: message?.label || null, source: "manual-terminal-click",
      });
      return true;
    } catch (error) {
      log("manual graph preview failed: " + String(error?.message || error));
      return false;
    }
  };
}

function routeTerminalArtifact(message, { openHelp, openPreview, openFile }) {
  if ((message.artifactType === "help" || message.type_hint === "help") && message.path && typeof openHelp === "function") {
    return openHelp(message.path, message.label);
  }
  if (message.path && !(typeof openPreview === "function" && openPreview(message))) {
    return openFile(message.path, message.baseDir);
  }
}

module.exports = { createManualGraphPreview, routeTerminalArtifact };
