#!/usr/bin/env node
"use strict";

// Next 阶段 D（0.2.0-next.4）：多会话。逻辑在 scripts/next_multi_session_core.js；这里只接线：
//   1. 激活：紧接 C 的激活语句之后，单独一句（独立 try）：解析会话名，建会话自己的 tmp 并把本进程
//      TMPDIR/TEMP/TMP 指过去，定义注册表刷新函数。失败只关掉 D，不影响 B、C 和扩展激活。
//   2. bridge 绑定、C 写完注册表之后立刻补齐 D 的字段。
//   3. 请求通过 C 的判定之后刷新一次注册表（generation、backendPid 变了才写盘），
//      所以客户端读完 /status 再读注册表，两边一致。
//   4. /status 加 nextMulti（不含 token）。
// 不改 B、C 写入的任何字符；锚点全部取自 C 的插入文本。离线改 bundle；新加字符串只用 ASCII。
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const C = require("./apply_next_bridge_auth_patch");
const MARKER = "/* next patch 0.2.0-next.4: multi-session registry and per-session temp */";
const REQ = 'require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts",';

const ACTIVATE = 'try{let __nextMultiCore=' + REQ + '"next_multi_session_core.js")),__nextSessionForMulti=globalThis.__codexNextSessionRef;'
  + 'if(!__nextSessionForMulti)throw new Error("session unavailable: "+(globalThis.__codexNextSessionError||"unknown"));'
  + 'let __nextCfg=iA.workspace.getConfiguration("stataMcp"),__nextFolders=iA.workspace.workspaceFolders||[],'
  + '__nextMulti={sessionName:__nextMultiCore.resolveSessionName(process.env,__nextCfg.get("nextSessionName",null)),'
  + 'profilePath:process.env.STATA_WORKBENCH_NEXT_PROFILE||__nextCfg.get("nextProfilePath",null)||null,'
  + 'workspacePath:__nextFolders[0]&&__nextFolders[0].uri&&__nextFolders[0].uri.scheme==="file"?__nextFolders[0].uri.fsPath:null,'
  + 'dirs:__nextMultiCore.sessionDirs(__nextSessionForMulti.dataDir,process.env),refreshes:0,lastError:null};'
  + '__nextMultiCore.applyTempDir(process.env,__nextMulti.dirs.tempDir);globalThis.__codexNextMultiCoreRef=__nextMultiCore;globalThis.__codexNextMultiRef=__nextMulti;'
  + 'globalThis.__codexNextRegistryRefresh=()=>{let __a=globalThis.__codexNextAuthRef;if(!__a)return;'
  + 'let __bi=globalThis.__codexBundleIdentityStatus?globalThis.__codexBundleIdentityStatus():{};'
  + 'let __u=__a.update(__nextMultiCore.registryFields({...__nextMulti,generation:Number(globalThis.__codexResetGeneration||0),'
  + 'backendPid:__nextMultiCore.latestBackendPid(globalThis.__codexOwnedBackendPids,__p=>{try{process.kill(__p,0);return true}'
  + 'catch(__e){return __e&&__e.code==="ESRCH"?false:true}}),diskBundleSha256:__bi.diskBundleSha256||null}));'
  + 'if(__u.changed)__nextMulti.refreshes++;if(__u.error&&__u.error!=="not published")__nextMulti.lastError=__u.error}'
  + '}catch(__nextMultiError){globalThis.__codexNextMultiError=String(__nextMultiError&&__nextMultiError.message||__nextMultiError)}'
  + MARKER;
const REFRESH = 'try{globalThis.__codexNextRegistryRefresh&&globalThis.__codexNextRegistryRefresh()}catch{}';
const STATUS = 'nextMulti:globalThis.__codexNextMultiRef&&globalThis.__codexNextMultiCoreRef'
  + '?globalThis.__codexNextMultiCoreRef.publicMulti(globalThis.__codexNextMultiRef):{error:globalThis.__codexNextMultiError||"unavailable"},';

// [before, after, 期望 before 出现次数]。before 都是 C 插入的完整文本，D 只在其后追加。
const EDITS = [
  [C.MARKER, C.MARKER + ACTIVATE, 1],
  [C.EDITS[1][1], C.EDITS[1][1] + REFRESH, 1],
  [C.EDITS[2][1], C.EDITS[2][1] + REFRESH, 1],
  [C.EDITS[4][1], C.EDITS[4][1] + STATUS, 1],
];

function count(source, needle) { return source.split(needle).length - 1; }

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after, n] of EDITS) {
      if (count(source, after) !== n) throw new Error("partial Next multi-session patch (anchor)");
    }
  } else {
    if (source.includes("__codexNextMultiRef")) throw new Error("partial Next multi-session patch");
    for (const [before, , n] of EDITS) {
      if (count(source, before) !== n) throw new Error("missing or ambiguous Next multi-session anchor: " + before.slice(0, 60));
    }
    for (const [before, after] of EDITS) source = source.split(before).join(after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  for (const [, after, n] of EDITS) {
    if (count(source, after) !== n) throw new Error("missing or ambiguous Next multi-session anchor");
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

module.exports = { patchBundle, revertBundle, MARKER, EDITS, ACTIVATE, REFRESH, STATUS };
