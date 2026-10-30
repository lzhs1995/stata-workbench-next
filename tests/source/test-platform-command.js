"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const migration = require("../../src/migrations/terminal-preview");
const platformProcess = require("../../src/shared-session/platform-process");

const upstream = fs.readFileSync(path.join(__dirname, "../../upstream/stata-workbench/src/mcp-client.js"), "utf8");
const transformed = migration.transform("mcp-client.js", upstream);
assert.equal((transformed.match(/commandProbeOptions\(finalCommand\)/g) || []).length, 2);
assert.equal(transformed.includes("shell: process.platform === 'win32'"), false);
assert.deepEqual(platformProcess.commandProbeOptions("uvx.exe", "win32"), {
  encoding: "utf8", windowsHide: true, shell: false,
});
assert.deepEqual(platformProcess.commandProbeOptions("C:/Tools/mcp.cmd", "win32"), {
  encoding: "utf8", windowsHide: true, shell: true,
});
assert.deepEqual(platformProcess.commandProbeOptions("uvx", "darwin"), {
  encoding: "utf8", windowsHide: false, shell: false,
});
console.log(JSON.stringify({
  schema: "source-platform-command/1",
  verdict: "PASS_SOURCE_PLATFORM_COMMAND",
  checks: ["mcp-client probes use adapter", "real Windows executables stay shell-free",
    "explicit cmd/bat shims retain shell compatibility", "macOS probes remain shell-free"],
}));
