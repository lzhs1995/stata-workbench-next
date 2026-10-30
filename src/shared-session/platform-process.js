"use strict";

/**
 * Small process boundary shared by the source-built client.
 *
 * Windows only needs a shell for an explicitly configured batch shim. Real
 * executables such as uv/uvx use the native process API, which preserves argv
 * boundaries for Unicode, spaces and metacharacters.
 */
function isWindowsShim(command) {
  return /\.(?:cmd|bat)$/i.test(String(command || ""));
}

function commandProbeOptions(command, platform = process.platform) {
  const windows = platform === "win32";
  return {
    encoding: "utf8",
    windowsHide: windows,
    shell: windows && isWindowsShim(command),
  };
}

module.exports = { commandProbeOptions, isWindowsShim };
