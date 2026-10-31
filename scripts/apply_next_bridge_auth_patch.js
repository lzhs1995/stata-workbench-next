#!/usr/bin/env node
"use strict";

// Next 阶段 C（0.2.0-next.3）：bridge 每个端点都要 Bearer token，Host 必须是 127.0.0.1:<端口>，
// 带 Origin 一律拒。逻辑在 scripts/next_bridge_auth_core.js；这里只接线：
//   1. 激活：单独一句建 auth（与 B 的事件流分开 try，auth 失败时 bridge 对所有请求回 503，
//      事件流照常）。
//   2. bridge 绑定端口后写注册表文件；窗口关闭、进程退出时删自己的那个。
//   3. 请求入口第一件事就是判定；不过就回 401/403/503，不碰任何路由、generation 或 Stata。
//   4. 扩展自己的 recovery-smoke 请求带上 token。
//   5. /status 加 nextAuth（不含 token）。
// 离线改 bundle；不安装，不启动 Stata。新加字符串只用 ASCII。
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* next patch 0.2.0-next.3: bridge bearer authentication */";
const REQ = 'require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts",';
const B_MARKER = "/* next patch 0.2.0-next.2: agent identity, Terminal origin header, session events */";

// [before, after, 期望 before 出现次数]
const EDITS = [
  // 1. 激活：紧接 B 的激活语句之后，独立 try
  [B_MARKER,
    B_MARKER + 'try{let __nextAuthCore=' + REQ + '"next_bridge_auth_core.js")),__nextSessionForAuth=globalThis.__codexNextSessionRef;'
      + 'if(!__nextSessionForAuth)throw new Error("session unavailable: "+(globalThis.__codexNextSessionError||"unknown"));'
      + 'globalThis.__codexNextAuthRef=__nextAuthCore.createAuth({stateRoot:require("path").dirname(require("path").dirname(__nextSessionForAuth.dataDir)),'
      + 'sessionId:__nextSessionForAuth.sessionId});'
      + 'let __nextAuthRemove=()=>{try{globalThis.__codexNextAuthRef&&globalThis.__codexNextAuthRef.remove()}catch{}};'
      + 'process.once("exit",__nextAuthRemove);try{g.subscriptions.push({dispose:__nextAuthRemove})}catch{}'
      + '}catch(__nextAuthError){globalThis.__codexNextAuthError=String(__nextAuthError&&__nextAuthError.message||__nextAuthError)}'
      + MARKER, 1],
  // 2. bridge 绑定成功后写注册表
  ['onBound:__state=>{try{globalThis.__codexBridgePort=__port;}catch{}',
    'onBound:__state=>{try{globalThis.__codexBridgePort=__port;}catch{}'
      + 'try{let __ns=globalThis.__codexNextSessionRef||{};globalThis.__codexNextAuthRef&&globalThis.__codexNextAuthRef.publish({port:__port,'
      + 'extensionHostPid:process.pid,dataDir:__ns.dataDir||null,eventsPath:__ns.eventsPath||null,'
      + 'bundleSha:globalThis.__codexGuardBuildFingerprint||null})}catch{}', 1],
  // 3. 请求入口判定
  ['let __srv=__http.createServer((__req,__res)=>{(async()=>{try{',
    'let __srv=__http.createServer((__req,__res)=>{(async()=>{try{'
      + 'let __nextAuth=globalThis.__codexNextAuthRef?globalThis.__codexNextAuthRef.check(__req.headers)'
      + ':{ok:false,status:503,reason:"AUTH_UNAVAILABLE"};'
      + 'if(!__nextAuth.ok){try{let __ns=globalThis.__codexNextSessionRef;if(__ns&&(!globalThis.__codexNextAuthRef'
      + '||globalThis.__codexNextAuthRef.shouldRecordRefusal(__nextAuth.reason)))__ns.record("auth-refused",'
      + '{reason:__nextAuth.reason,status:__nextAuth.status,method:__req.method,path:String(__req.url||"").split("?")[0].slice(0,64)})}catch{}'
      + '__send(__res,__nextAuth.status,{ok:false,error:__nextAuth.reason,'
      + 'detail:__nextAuth.status===503?(globalThis.__codexNextAuthError||(globalThis.__codexNextAuthRef'
      + '?globalThis.__codexNextAuthRef.publicAuth().publishError:null)):null});return}', 1],
  // 4. 扩展自己的 recovery-smoke 请求带 token
  ['__http.request({host:"127.0.0.1",port:__port,path:"/run-command",method:"POST",headers:{"content-type":"application/json",',
    '__http.request({host:"127.0.0.1",port:__port,path:"/run-command",method:"POST",headers:{'
      + '...(globalThis.__codexNextAuthRef?globalThis.__codexNextAuthRef.headers():{}),"content-type":"application/json",', 1],
  // 5. /status：接在 B 的 nextSession 字段之后，不改 B 写入的文本
  ['{error:globalThis.__codexNextSessionError||"unavailable"},',
    '{error:globalThis.__codexNextSessionError||"unavailable"},'
      + 'nextAuth:globalThis.__codexNextAuthRef?globalThis.__codexNextAuthRef.publicAuth():{required:true,published:false,'
      + 'error:globalThis.__codexNextAuthError||"unavailable"},', 1],
];

function count(source, needle) { return source.split(needle).length - 1; }

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after, n] of EDITS) {
      if (count(source, after) !== n) throw new Error("partial Next bridge auth patch (anchor)");
    }
  } else {
    if (source.includes("__codexNextAuthRef")) throw new Error("partial Next bridge auth patch");
    for (const [before, , n] of EDITS) {
      if (count(source, before) !== n) throw new Error("missing or ambiguous Next bridge auth anchor: " + before.slice(0, 60));
    }
    for (const [before, after] of EDITS) source = source.split(before).join(after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  for (const [, after, n] of EDITS) {
    if (count(source, after) !== n) throw new Error("missing or ambiguous Next bridge auth anchor");
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
