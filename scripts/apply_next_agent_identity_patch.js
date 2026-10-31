#!/usr/bin/env node
"use strict";

// Next 阶段 B（0.2.0-next.2）：agent 身份、Terminal 抬头、/status 当前运行来源、事件流。
// 逻辑都在 scripts/next_session_core.js（纯 Node，可单测）；这里只把它接进 bundle：
//   1. 激活时建会话：require next_session_core，createSession；__codexExecution 换成
//      wrapExecution 包过的版本，finishRun 的每条退出路径都记 run-end。
//   2. __acquire 记 agentName/kind，成功记 run-start，被拒记 run-refused。
//   3. /run-command 从请求体 agentName（或旧客户端的 agentId）或 X-Agent-Name 头读 agent 名。
//   4. /status 的 current 加 origin、agentName；顶层加 nextSession。新增只读 GET /events?since=N。
//   5. Terminal：runStarted 带 origin 抬头，webview 在每次运行的卡片上方显示「agent名 · runId」或「You · runId」。
//   6. 人按 Run 被拒时的提示写明是谁在跑、按 Stop。
// 离线改 bundle；不安装，不启动 Stata。所有新加字符串只用 ASCII。
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* next patch 0.2.0-next.2: agent identity, Terminal origin header, session events */";
const REQ = 'require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts",';
const BUSY_TEXT = ':"Stata Workbench is already running a visible command. Wait for it to finish before starting another.")';

// [before, after, 期望 before 出现次数]
const EDITS = [
  // 1. 会话 + 包过的 execution 适配器。不改原 require（test_control_plane_wiring_rc64 等钉了它的原文）；
  //    在 adapter 赋值之后单独一句建会话，失败只关掉 Next 功能，不影响扩展激活。
  //    adapter 本身从不调 finishRun（三处都走局部 __codexExecution），所以只换局部变量。
  ['globalThis.__codexExecutionAdapter=__codexExecution;',
    'globalThis.__codexExecutionAdapter=__codexExecution;try{let __nextCore=' + REQ + '"next_session_core.js"));'
      + 'let __nextSession=__nextCore.createSession({env:process.env});'
      + 'globalThis.__codexNextCoreRef=__nextCore;globalThis.__codexNextSessionRef=__nextSession;'
      + '__codexExecution=__nextCore.wrapExecution(__codexExecution,__nextSession,()=>globalThis.__codexBridgeState||{});'
      + 'globalThis.__codexNextOriginLabel=(__terminalRunId,__forceHuman)=>{try{let __s=globalThis.__codexBridgeState||{};'
      + 'return __nextCore.originLabel(__forceHuman||!__s.busy?null:__s,__terminalRunId)}catch{return null}};'
      + 'globalThis.__codexNextBusyMessage=()=>{try{return __nextCore.busyMessage(globalThis.__codexBridgeState||{})}'
      + 'catch{return "Stata Workbench is already running a visible command. Wait for it to finish before starting another."}}'
      + '}catch(__nextError){globalThis.__codexNextSessionError=String(__nextError&&__nextError.message||__nextError)}'
      + MARKER, 1],
  // 2. acquire：被拒记 run-refused；成功记 agentName/kind 并记 run-start
  ['if(!__codexDecision.ok)return false;',
    'if(!__codexDecision.ok){try{globalThis.__codexNextSessionRef.runRefused({runId:o&&o.runId,source:o&&o.source,kind:o&&o.kind,'
      + 'agentName:o&&o.agentName,busyRunId:s.busy?s.runId:null},__codexDecision)}catch{}return false}', 1],
  ['codePreview:o.codePreview,logPath:null,rc:null});__codexExecution.beginRun(s,{requestId:o.runId,runId:o.runId,sourceMode:o.source,perRunEvidenceRequired:true});return true};',
    'codePreview:o.codePreview,logPath:null,rc:null,agentName:globalThis.__codexNextCoreRef?globalThis.__codexNextCoreRef.sanitizeAgentName(o.agentName):null,kind:o.kind||"normal"});'
      + '__codexExecution.beginRun(s,{requestId:o.runId,runId:o.runId,sourceMode:o.source,perRunEvidenceRequired:true});'
      + 'try{globalThis.__codexNextSessionRef.runStart({runId:o.runId,requestId:o.runId,source:o.source,kind:o.kind,agentName:o.agentName,'
      + 'label:o.label,codePreview:o.codePreview,code:o.code})}catch{}return true};', 1],
  // 3. /run-command 传 agent 名和完整代码（只用于记 SHA）
  ['if(!__acquire({runId:__runId,label:__label,source:__source,codePreview:__code.slice(0,300),kind:__recoveryKind,',
    'if(!__acquire({runId:__runId,label:__label,source:__source,codePreview:__code.slice(0,300),kind:__recoveryKind,'
      + 'agentName:__p.agentName||__p.agentId||__req.headers["x-agent-name"]||null,code:__code,', 1],
  // 4. /status
  ['n=o.busy?{runId:o.runId,label:o.label,source:o.source,',
    'n=o.busy?{runId:o.runId,label:o.label,source:o.source,origin:o.kind==="recovery-smoke"?"internal":'
      + '(o.source==="agent"||o.source==="visible-bridge"?"agent":"human"),agentName:o.agentName||null,', 1],
  ['return{ok:true,bridge:"stata-workbench-visible",patch:__patch,',
    'return{ok:true,bridge:"stata-workbench-visible",patch:__patch,nextSession:globalThis.__codexNextSessionRef'
      + '?globalThis.__codexNextSessionRef.publicSession():{error:globalThis.__codexNextSessionError||"unavailable"},', 1],
  ['if(__req.method==="GET"&&__req.url==="/status"){/* codex patch v4: status endpoint */',
    'if(__req.method==="GET"&&__req.url&&(__req.url==="/events"||__req.url.startsWith("/events?"))){'
      + 'let __q=new URL(__req.url,"http://127.0.0.1").searchParams,__ns=globalThis.__codexNextSessionRef;'
      + 'if(!__ns){__send(__res,503,{ok:false,patch:__patch,error:"session events unavailable",detail:globalThis.__codexNextSessionError||null});return}'
      + '__send(__res,200,{ok:true,patch:__patch,...__ns.since(__q.get("since"),__q.get("limit"))});return}'
      + 'if(__req.method==="GET"&&__req.url==="/status"){/* codex patch v4: status endpoint */', 1],
  // 5. Terminal 抬头
  ['g._postMessage({type:"runStarted",runId:o,code:t})',
    'g._postMessage({type:"runStarted",runId:o,code:t,origin:globalThis.__codexNextOriginLabel?globalThis.__codexNextOriginLabel(o,false):null})', 1],
  ['g._postMessage({type:"runStarted",runId:B,code:Q})',
    'g._postMessage({type:"runStarted",runId:B,code:Q,origin:globalThis.__codexNextOriginLabel?globalThis.__codexNextOriginLabel(B,true):null})', 1],
  ['ensureRunGroup(runId, code);',
    'ensureRunGroup(runId, code, msg.origin);', 1],
  ['function ensureRunGroup(runId, code) {',
    'function ensureRunGroup(runId, code, origin) {', 1],
  ["        div.innerHTML = userHtml + systemHtml;\n        chatStream.appendChild(div);\n        if (autoScrollPinned) scrollToBottom();\n\n        runs[runId] = {",
    "        const originHtml = origin ? ('<div class=\"run-origin text-muted\" style=\"font-size:11px;margin:2px 0 2px 2px;\">'"
      + " + window.stataUI.escapeHtml(String(origin)) + '</div>') : '';\n"
      + "        div.innerHTML = originHtml + userHtml + systemHtml;\n        chatStream.appendChild(div);\n"
      + "        if (autoScrollPinned) scrollToBottom();\n\n        runs[runId] = {", 1],
  // 6. 人按 Run 被拒时的提示（Run Selection、Run File 各一处）
  [BUSY_TEXT,
    ':(globalThis.__codexNextBusyMessage?globalThis.__codexNextBusyMessage():"Stata Workbench is already running a visible command. Wait for it to finish before starting another."))', 2],
];

function count(source, needle) { return source.split(needle).length - 1; }

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after, n] of EDITS) {
      if (count(source, after) !== n) throw new Error("partial Next agent identity patch (anchor)");
    }
  } else {
    if (source.includes("__codexNextSessionRef")) throw new Error("partial Next agent identity patch");
    for (const [before, , n] of EDITS) {
      if (count(source, before) !== n) throw new Error("missing or ambiguous Next agent identity anchor: " + before.slice(0, 60));
    }
    for (const [before, after] of EDITS) source = source.split(before).join(after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  for (const [, after, n] of EDITS) {
    if (count(source, after) !== n) throw new Error("missing or ambiguous Next agent identity anchor");
  }
  for (const [before, after] of [...EDITS].reverse()) source = source.split(after).join(before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, EDITS };
