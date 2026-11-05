#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const text = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");

function count(value) {
  return text.split(value).length - 1;
}

function windowFrom(start, length = 3500) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `missing wiring anchor: ${start}`);
  return text.slice(at, at + length);
}

function windowBetween(start, end) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `missing wiring anchor: ${start}`);
  const endAt = text.indexOf(end, at + start.length);
  assert.ok(endAt > at, `missing wiring boundary: ${end}`);
  return text.slice(at, endAt);
}

assert.strictEqual(count("codex patch rc.6.4: unified recovery control plane"), 1);
assert.strictEqual(count("codex patch rc.6.4: dedicated verified recovery endpoint"), 1);
assert.strictEqual(count("codex patch rc.6.4: successful no-graph terminal run refreshes readiness runId"), 1);
assert.strictEqual(
  count('__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js"))'),
  1
);
assert.strictEqual(
  count('__codexExecution=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_lifecycle_core.js"))'),
  1
);
assert.ok(text.includes('reasonCode:"recovery-required"'));
assert.ok(text.includes('httpStatus:423'));
assert.ok(text.includes('path query parameter is required'));
assert.strictEqual(count("codex patch rc.7: release infers manual evidence"), 1);

const graphClear = windowBetween(
  'if(__req.method==="POST"&&__req.url==="/graph-clear")',
  'if(__req.method==="POST"&&__req.url==="/recovery-smoke")'
);
assert.ok(!graphClear.includes('readinessState:"ready"'));
assert.ok(!graphClear.includes("__codexSetPostRunBusy"));
assert.ok(!graphClear.includes("postRunBusy"));
assert.ok(!graphClear.includes("__codexGraphMark"));
assert.ok(graphClear.includes("graph clear is UI-only"));
assert.ok(graphClear.includes("publicRecovery"));

const graphClearHelper = windowFrom("function __codexClearGraphPanel", 1800);
assert.ok(graphClearHelper.includes("graph panel clear preserves execution readiness"));
assert.ok(!graphClearHelper.includes("readinessState:"));
assert.ok(!graphClearHelper.includes("readinessReason:"));
assert.ok(!graphClearHelper.includes("readinessRunId:"));
assert.ok(!graphClearHelper.includes("readinessUpdatedAt:"));

const graphHydrateReady = windowFrom("function __codexMaybeMarkGraphHydratedReady", 1200);
assert.ok(graphHydrateReady.includes('state.lastBatchSource === "clear"'));
assert.ok(graphHydrateReady.includes("clear snapshot hydration cannot release readiness"));

const recoveryRoute = windowFrom('if(__req.method==="POST"&&__req.url==="/recovery-smoke")', 7000);
assert.ok(recoveryRoute.includes("x-codex-recovery-token"));
assert.ok(recoveryRoute.includes("verifyRecoveryAttempt"));
assert.ok(recoveryRoute.includes("markerVerified:true"));
assert.ok(!recoveryRoute.includes("searchParams.get(\"code\")"));

const runCommand = windowFrom('if(__req.method!=="POST"||__req.url!=="/run-command")', 1800);
assert.ok(runCommand.includes('x-codex-recovery-token'));
assert.ok(!runCommand.includes("__codexAllowRecoverySmoke"));
assert.ok(!runCommand.includes('/smoke/i.test(__label)'));

const visibleBridgeWatchdog = windowFrom("let __codexBridgeWatchdog=", 900);
assert.ok(visibleBridgeWatchdog.includes("acceptGraphCompletionMarkerAsDone:false"));
assert.ok(visibleBridgeWatchdog.includes("visible bridge waits for executed completion"));
assert.strictEqual(count("codex patch rc.6.4.1: visible bridge waits for executed completion"), 1);

// rc.6.4 的意图：**恢复门禁必须先于图形就绪判定**。
// 原写法用 windowFrom(...,1800) 固定窗口，rc.7.14e 在恢复之后、图形就绪之前插入身份
// fail-closed 早退（+548 字节）后，`const readiness` 被挤出 1800 窗口 → indexOf 返回 -1 →
// `605 < -1` 为假而误报次序回归。真实次序未变（recovery 605 < identity 1542 < readiness 1916）。
// 故改为按大括号配平取**整个函数体**，让断言不再依赖魔数窗口，且顺带把次序断言写全。
const trueReady = (function () {
  const head = "function __codexTrueReadyStatus";
  const at = text.indexOf(head);
  assert.ok(at >= 0, `missing wiring anchor: ${head}`);
  const brace = text.indexOf("{", at + head.length);
  let depth = 0;
  let i = brace;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return text.slice(at, i);
})();
const iRecovery = trueReady.indexOf("__codexRecoveryState");
const iReadiness = trueReady.indexOf("const readiness");
assert.ok(iRecovery >= 0, "trueReady 缺恢复门禁引用");
assert.ok(iReadiness >= 0, "trueReady 缺图形就绪判定");
assert.ok(iRecovery < iReadiness, "恢复门禁必须先于图形就绪判定");

// rc.7.89 在 force reset 开头插入孤儿 worker 记录（约 1.3 KB），darwin 分支被挤出固定 7000 窗口。
// 与上面 trueReady 同法：按大括号配平取整个 force reset 函数体，不依赖魔数窗口。
const forceReset = (function () {
  const head = "globalThis.__codexForceReset=async o=>";
  const at = text.indexOf(head);
  assert.ok(at >= 0, `missing wiring anchor: ${head}`);
  let depth = 0, i = text.indexOf("{", at + head.length);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return text.slice(at, i);
})();
assert.ok(forceReset.includes('process.platform==="win32"'));
assert.ok(forceReset.includes('process.platform==="darwin"'));
assert.ok(forceReset.includes("__codexOwnedBackendPids"));
assert.ok(forceReset.includes("--pid"));

const panicCommand = windowFrom('registerCommand("stata-workbench.panicKill"', 3400);
assert.ok(panicCommand.includes("Windows panic command enters recovery control plane"));
assert.ok(panicCommand.includes("requestRecovery"));

const terminal = windowFrom("var kM=async", 1000);
assert.ok(terminal.includes("controlPlaneRejected:true"));
assert.ok(terminal.includes('reasonCode:"recovery-required"'));
const terminalNoGraph = windowFrom("var kM=async", 15000);
assert.ok(terminalNoGraph.includes("successful no-graph terminal run refreshes readiness runId"));
assert.ok(terminalNoGraph.includes('lastBatchSource:"no-graph-fast-path"'));

const debugSelection = windowFrom('startsWith("/debug-run-selection")', 6200);
assert.ok(debugSelection.includes("__selDecision=__preflight()"));
assert.ok(debugSelection.includes("__selReceipt.accepted===false"));
assert.ok(debugSelection.includes("__selDisk"));
assert.ok(debugSelection.includes('workbench.action.files.revert'));
assert.ok(debugSelection.includes("debug selection refreshes and restores disk buffer"));

const debugFile = windowFrom('startsWith("/debug-run-file")', 3200);
assert.ok(debugFile.includes("__debugDecision=__preflight()"));
assert.ok(debugFile.includes("__debugReceipt.accepted===false"));

assert.ok(text.includes("transformDoSource(__codexHumanFileRunSourceText"));
assert.strictEqual(count("codex patch rc.7: huge human file applies Darwin PNG compatibility"), 1);

console.log("CONTROL_PLANE_WIRING_RC64_PASS");
