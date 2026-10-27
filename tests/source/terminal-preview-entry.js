"use strict";
// Test-only entry. Compiled with the same source migration plugin as extension.js.
// Imports real Terminal message handling/HTML and keeps each module's closure.
module.exports = {
  ...require("../../upstream/stata-workbench/src/terminal-panel"),
  context: require("../../upstream/stata-workbench/src/runtime-context"),
  resolveArtifactUri: require("../../upstream/stata-workbench/src/artifact-utils").resolveArtifactUri,
  ...require("../../src/shared-session/manual-graph-preview"),
};
