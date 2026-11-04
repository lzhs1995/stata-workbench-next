#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");

function windowFrom(marker, length) {
  const at = bundle.indexOf(marker);
  assert.ok(at >= 0, `missing marker: ${marker}`);
  return bundle.slice(at, at + length);
}

// The whole force-reset function, from its unique start to its unique end
// (no character window that could reach past the function or stop inside it).
function between(start, end) {
  const at = bundle.indexOf(start);
  assert.ok(at >= 0 && bundle.indexOf(start, at + 1) < 0, `missing or ambiguous start: ${start}`);
  const stop = bundle.indexOf(end, at);
  assert.ok(stop > at && bundle.indexOf(end, stop + 1) < 0 && bundle.indexOf(end) === stop, `missing or ambiguous end: ${end}`);
  return bundle.slice(at, stop + end.length);
}
const reset = between("globalThis.__codexForceReset=async", "let __state=__current();__state.cleanup=__cleanup;");
assert.ok(reset.includes("__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1"));
assert.ok(reset.includes("codex patch rc.7.9: force-reset generation fences stale handlers"));
assert.ok(reset.includes("__codexExecution.finishRun(s,"));
assert.ok(reset.includes("execution cancelled by force reset:"));
assert.ok(reset.includes("codex patch rc.7.9.1: force-reset finalizes cancelled lifecycle"));
assert.ok(reset.indexOf("__codexExecution.finishRun(s,") < reset.indexOf("s.busy=false,s.postRunBusy=true"),
  "cancelled lifecycle must be finalized before force reset clears busy state");
assert.ok(reset.includes("codex patch rc.7.10.15: force reset reconnects before READY"));
assert.ok(reset.includes("Promise.resolve(zg.connect())"));
// codex patch rc.7.35（缺陷 PF-4）：reconnect 期限不得再是硬编码 10000。
// 旧断言钉的是字面量 "...timed out after 10000ms"，正是把倒挂阶梯钉死的那颗钉子。
// 现在期限从 stop_checkpoint_core.forceResetReconnectTimeoutMs() 取，
// 且必须写进回执（__reconnect.timeoutMs）才能被产物侧复算。
assert.ok(!reset.includes("force-reset backend reconnect timed out after 10000ms"),
  "force-reset reconnect must not carry a hardcoded 10000ms budget (defect PF-4)");
assert.ok(reset.includes("forceResetReconnectTimeoutMs"),
  "force-reset reconnect budget must come from stop_checkpoint_core");
assert.ok(reset.includes('force-reset backend reconnect timed out after "+String(__codexFrReconnectMs)+"ms'),
  "force-reset reconnect timeout message must disclose the effective budget");
assert.ok(reset.includes("__reconnect.timeoutMs=__codexFrReconnectMs"),
  "force-reset reconnect receipt must record the effective budget");
assert.ok(reset.indexOf("Promise.resolve(zg.connect())") < reset.indexOf("s.postRunBusy=false"),
  "force reset must reconnect before clearing postRunBusy");

const clientDispose = windowFrom("async dispose(){let __transport=this._transport", 700);
assert.ok(clientDispose.includes("codex patch rc.7.10.15: atomic MCP client disposal"));
assert.ok(clientDispose.indexOf("this._clientPromise=null") < clientDispose.indexOf("await __transport.close()"),
  "dispose must detach the old client before awaiting transport shutdown");
assert.ok(clientDispose.indexOf("this._transport=null") < clientDispose.indexOf("await __transport.close()"),
  "dispose must detach the old transport before awaiting transport shutdown");

const human = windowFrom("async function xHg", 50000);
assert.ok(human.includes("let __codexHumanFileResetGeneration=Number(globalThis.__codexResetGeneration||0)"));
assert.ok(human.includes("CODEX_FORCE_RESET_CANCELLED"));
assert.ok(human.includes("if(!__codexHumanFileResetStale)try"));
assert.ok(human.includes("if(Number(globalThis.__codexResetGeneration||0)===__codexHumanFileResetGeneration)globalThis.__codexVisibleRelease"));

const guardAt = human.indexOf("CODEX_FORCE_RESET_CANCELLED");
const routeAt = human.indexOf("__codexRouteGraphManifestOrExport", guardAt);
assert.ok(guardAt >= 0 && routeAt > guardAt,
  "generation guard must precede human-file post-run graph routing");

const status = windowFrom("let __current=()=>", 7000);
assert.ok(status.includes("resetGeneration:Number(globalThis.__codexResetGeneration||0)"));
assert.ok(status.includes("lastForceResetReconnect:globalThis.__codexLastForceResetReconnect||null"));
// codex patch rc.7.35b（缺陷 B 可观测性）：/status 必须暴露 human-file 派发诊断。
// 缺了它，物理按键触发的 runFile 被拒时压测器只能看到「什么都没发生」。
assert.ok(status.includes("humanFileDebug:globalThis.__codexHumanFileDebug||null"),
  "/status must expose __codexHumanFileDebug (defect B observability gap)");
assert.ok(status.includes("manualCommandDebug:globalThis.__codexManualCommandDebug||null"),
  "/status must expose __codexManualCommandDebug");

console.log("FORCE_RESET_GENERATION_RC7_PASS");
