"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next patch C1: bridge bearer authentication and session registry */";
const SESSION_ANCHOR = '__patch="codex-rc7-shared-execution",__staleAfter=21600000;';
const SERVER_ANCHOR = 'let __srv=__http.createServer((__req,__res)=>{(async()=>{try{';
const SESSION_INSERT = '__patch="codex-rc7-shared-execution",__staleAfter=21600000;'+MARKER+'let __codexSessionRegistry=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","session_registry_core.js")),__codexBridgeAuth=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","bridge_auth_core.js")),__codexSession=__codexSessionRegistry.createSession({sessionName:"stata-workbench-next",port:__port,extensionHostPid:process.pid,bundleSha:globalThis.__codexDiskBundleSha256||globalThis.__codexGuardBuildFingerprint||"0".repeat(64)});';
const SERVER_INSERT = 'let __srv=__http.createServer((__req,__res)=>{(async()=>{try{let __auth=__codexBridgeAuth.authorize(__req.headers,{token:__codexSession.token,port:__port,onReject:__event=>{try{__codexSessionRegistry.recordRejection(__codexSession,{...__event,path:__req.url,method:__req.method});}catch{}}});if(!__auth.ok){__send(__res,__auth.status,{ok:false,error:__auth.reason});return}';

function unique(source, needle) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) throw new Error("missing or ambiguous C auth anchor");
  return first;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    unique(source, MARKER);
    unique(source, SERVER_INSERT.slice(0, 64));
    return options.finalize === false ? source : fingerprint.finalize(source).text;
  }
  unique(source, SESSION_ANCHOR);
  unique(source, SERVER_ANCHOR);
  source = source.replace(SESSION_ANCHOR, () => SESSION_INSERT);
  source = source.replace(SERVER_ANCHOR, () => SERVER_INSERT);
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, MARKER, SESSION_ANCHOR, SERVER_ANCHOR };
