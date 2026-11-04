#!/usr/bin/env node
/**
 * Windows static safety gate for shared-session dist (rc.5+).
 *
 * OLD (obsolete): sips string count == 0 in extension.js
 * NEW:
 *   1) win32 token count must equal expected baseline (default 39; rc.7.82 adds the pre-dispose scoped kill, cleanup-gate and recovery-smoke gate guards)
 *   2) extension.js must not embed /usr/bin/sips executable path
 *   3) PNG_COMPAT production path must be under process.platform === "darwin"
 *   4) scripts/mac helpers must exist for packaging (not executed on Windows)
 *   5) recovery cleanup is platform-guarded and graph-clear is UI-only
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ext = path.join(root, "dist", "extension.js");
const expectedWin32 = parseInt(process.env.WIN32_BASELINE || "39", 10);

function fail(msg) {
  console.error("GATE_FAIL", msg);
  process.exit(1);
}

if (!fs.existsSync(ext)) fail("missing dist/extension.js");
const text = fs.readFileSync(ext, "utf8");

const win32 = (text.match(/win32/g) || []).length;
if (win32 !== expectedWin32) {
  fail(`win32 count ${win32} != baseline ${expectedWin32}`);
}

if (text.includes("/usr/bin/sips")) {
  fail("extension.js embeds /usr/bin/sips (must stay in scripts/mac only)");
}

// PNG_COMPAT inject must be darwin-guarded nearby
const a3 = text.search(/A3\/rc\.[56](?:\.\d+)* PNG_COMPAT/);
if (a3 < 0) fail("missing A3/rc.5+ PNG_COMPAT inject marker");
const window = text.slice(a3, a3 + 2500);
if (!window.includes('process.platform === "darwin"')) {
  fail("PNG_COMPAT inject window missing darwin platform guard");
}

// helper scripts present
const helper = path.join(root, "scripts", "mac", "png_compat_sips.sh");
const transform = path.join(root, "scripts", "mac", "png_compat_transform.js");
const docxHelper = path.join(root, "scripts", "mac", "docx_image_inject.py");
const darwinAdapter = path.join(root, "scripts", "darwin_compat_adapter.js");
if (!fs.existsSync(helper)) fail("missing scripts/mac/png_compat_sips.sh");
if (!fs.existsSync(transform)) fail("missing scripts/mac/png_compat_transform.js");
if (!fs.existsSync(docxHelper)) fail("missing scripts/mac/docx_image_inject.py");
if (!fs.existsSync(darwinAdapter)) fail("missing scripts/darwin_compat_adapter.js");

// informational (not fail): sips string may appear in comments
const sipsCount = (text.match(/sips/g) || []).length;
console.log(
  JSON.stringify(
    {
      ok: true,
      win32,
      expectedWin32,
      sipsStringCount: sipsCount,
      note: "sips string count is informational only; gate is win32 + no /usr/bin/sips + darwin guard",
      hasDarwinGuard: true,
      helpers: { helper: true, transform: true, docxHelper: true },
    },
    null,
    2
  )
);
if (!text.includes("visibleBridgePort")) fail("missing visibleBridgePort wiring");
if (!text.includes("__cfgRest===true") && !text.includes("__cfgRest === true")) fail("missing strict restoreEnabled===true");
if (!text.includes("force-reset-needs-smoke: continuity-lost")) fail("missing continuity-lost smoke reason");
if (!text.includes("__codexHadContinuityLost")) fail("missing hadContinuityLost capture");
if (!text.includes("force-reset cleared continuityLost") && !text.includes("force-reset clears continuity")) {
  // allow either marker
  if (!text.includes("force-reset-cleared-continuity-lost")) fail("missing force-reset continuity clear");
}

const forceResetAt = text.indexOf("globalThis.__codexForceReset=async");
if (forceResetAt < 0) fail("missing force-reset implementation");
const forceResetWindow = text.slice(forceResetAt, forceResetAt + 9000);
if (!forceResetWindow.includes('if(process.platform==="win32"&&__codexForceResetWasBusy')) {
  fail("panic PowerShell escalation is not guarded by win32");
}
// rc.7.82: Windows cleanup reuses the verified scoped-tree result; the bare-pid
// cleanup_mcp_stata_processes.ps1 call is gone from force reset.
if (!forceResetWindow.includes('if(process.platform==="win32"){/* codex patch rc.7.82: no bare-pid cleanup')) {
  fail("Windows force-reset cleanup is not the win32-guarded scoped result");
}
if (!forceResetWindow.includes('if(process.platform==="win32"&&globalThis.__codexKillScopeGeneration!==__codexThisResetGeneration')) {
  fail("Windows pre-dispose scoped kill is not guarded by win32");
}
if (!forceResetWindow.includes('else if(process.platform==="darwin")')) {
  fail("missing Darwin owned-PID cleanup branch");
}
if (forceResetWindow.includes("-OwnedPidCsv") || forceResetWindow.includes("cleanup_mcp_stata_processes")) {
  fail("Windows force reset still calls the bare-pid cleanup");
}
if (!forceResetWindow.includes('__args.push("--pid",String(__pid))')) {
  fail("Darwin cleanup does not receive extension-owned PIDs");
}
if (!text.includes("codex patch rc.6.4: Windows panic command enters recovery control plane")) {
  fail("Windows panic command does not enter recovery control plane");
}

const graphClearAt = text.indexOf('if(__req.method==="POST"&&__req.url==="/graph-clear")');
if (graphClearAt < 0) fail("missing graph-clear endpoint");
const graphClearEnd = text.indexOf('if(__req.method==="POST"&&__req.url==="/recovery-smoke")', graphClearAt);
if (graphClearEnd < 0) fail("missing recovery-smoke route after graph-clear");
const graphClearWindow = text.slice(graphClearAt, graphClearEnd);
if (!graphClearWindow.includes("graph clear is UI-only")) fail("missing graph-clear UI-only marker");
for (const forbidden of ["postRunBusy", "__codexSetPostRunBusy", "__codexGraphMark", "readinessState"]) {
  if (graphClearWindow.includes(forbidden)) fail(`graph-clear mutates execution readiness via ${forbidden}`);
}
const graphClearHelperAt = text.indexOf("function __codexClearGraphPanel");
if (graphClearHelperAt < 0) fail("missing graph panel clear helper");
const graphClearHelperWindow = text.slice(graphClearHelperAt, graphClearHelperAt + 1800);
if (!graphClearHelperWindow.includes("graph panel clear preserves execution readiness")) {
  fail("graph panel clear helper lacks readiness-preservation marker");
}
for (const forbidden of ["readinessState:", "readinessReason:", "readinessRunId:", "readinessUpdatedAt:"]) {
  if (graphClearHelperWindow.includes(forbidden)) fail(`graph panel clear helper mutates ${forbidden}`);
}
if (!text.includes("codex patch rc.6.4: clear snapshot hydration cannot release readiness")) {
  fail("clear snapshot hydration can still release execution readiness");
}
if (!text.includes("codex patch rc.6.4: successful no-graph terminal run refreshes readiness runId")) {
  fail("successful no-graph terminal runs do not refresh readiness runId");
}
console.log("WINDOWS_STATIC_GATE_PASS");
