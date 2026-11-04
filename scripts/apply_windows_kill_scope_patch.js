#!/usr/bin/env node
"use strict";

// F v3 (W-P5 KILL scope): on Windows, Stata: KILL, POST /panic-kill and a busy
// force reset ran panic_kill_stata_chain.ps1 -Force -IncludeStataGui, which picks
// targets by image name: every mcp-stata backend and every Stata GUI on the
// machine, so one window's KILL also ended other windows' sessions and the
// user's own Stata. All three now go through scripts/windows_kill_scope_core.js,
// which ends only this extension host's backend tree (owned pid, parent = this
// host, creation time checked) and fails closed when it cannot tell. The confirm
// dialog says so. macOS already reset only the owned backend. Offline bundle edit.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch rc.7.82: Windows KILL ends only this session's backend process tree";

const EDITS = [
  ["owner id helper",
    "globalThis.__codexBackendOwnerId=globalThis.__codexBackendOwnerId||(String(process.pid)+\"-\"+String(__port)+\"-\"+Math.random().toString(36).slice(2));",
    "globalThis.__codexBackendOwnerId=globalThis.__codexBackendOwnerId||(String(process.pid)+\"-\"+String(__port)+\"-\"+Math.random().toString(36).slice(2));/* codex patch rc.7.82: Windows KILL ends only this session's backend process tree */try{globalThis.__codexWindowsKillScopeRef=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"windows_kill_scope_core.js\"));globalThis.__codexWindowsKillScope=globalThis.__codexWindowsKillScopeRef.createWindowsKillScope({execFileSync:require(\"child_process\").execFileSync,scriptPath:rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"panic_kill_stata_chain.ps1\"),platform:process.platform,hostPid:process.pid,ownedPids:()=>globalThis.__codexOwnedBackendPids,log:__m=>{try{RI(\"[Codex kill scope] \"+__m)}catch{}}});globalThis.__codexWindowsKillScopeError=null}catch(__ksErr){globalThis.__codexWindowsKillScope=null;globalThis.__codexWindowsKillScopeError=String(__ksErr?.message||__ksErr)}globalThis.__codexWindowsKillScopeRun=(__dry,__src)=>{let __r;try{__r=globalThis.__codexWindowsKillScope?globalThis.__codexWindowsKillScope.run({dryRun:!!__dry,source:__src}):{ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope helper unavailable: \"+String(globalThis.__codexWindowsKillScopeError||\"not installed\")],targets:[],census:[]}}catch(__ksRunErr){__r={ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope failed: \"+String(__ksRunErr?.message||__ksRunErr)],targets:[],census:[]}}globalThis.__codexLastKillScope=__r;try{if(!__dry&&__r&&__r.ok!==true&&!__r.skipped&&globalThis.__codexWindowsKillScopeRef)globalThis.__codexUnresolvedCleanup=globalThis.__codexWindowsKillScopeRef.openGate(globalThis.__codexUnresolvedCleanup,__r,globalThis.__codexOwnedBackendPids,{source:__src})}catch{}return __r};globalThis.__codexUnresolvedCleanupRecheck=()=>{try{if(globalThis.__codexUnresolvedCleanup&&globalThis.__codexUnresolvedCleanup.open&&globalThis.__codexWindowsKillScope)globalThis.__codexUnresolvedCleanup=globalThis.__codexWindowsKillScope.recheck(globalThis.__codexUnresolvedCleanup)}catch(__gErr){}return globalThis.__codexUnresolvedCleanup||null};"],
  ["force-reset before dispose",
    "try{RI(\"[Codex bridge] force reset requested: \"+(o||\"unknown\"))}catch{}",
    "try{RI(\"[Codex bridge] force reset requested: \"+(o||\"unknown\"))}catch{}/* codex patch rc.7.82: a Windows force reset ends this window's verified backend tree before dispose */if(process.platform===\"win32\"&&globalThis.__codexKillScopeGeneration!==__codexThisResetGeneration&&!/panic-kill/i.test(String(o||\"\"))){s.lastForceResetPanic=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(false,\"force-reset before dispose\"):{ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope helper unavailable: \"+String(globalThis.__codexWindowsKillScopeError||\"not installed\")],targets:[],census:[]});globalThis.__codexKillScopeGeneration=__codexThisResetGeneration}"],
  ["force-reset cleanup",
    "if(process.platform===\"win32\"){let __script=rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"cleanup_mcp_stata_processes.ps1\"),__args=[\"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",__script,\"-Force\",\"-OwnedPidCsv\",__owned.join(\",\")],__out=cp.execFileSync(\"powershell.exe\",__args,{encoding:\"utf8\",timeout:15000,windowsHide:true});try{__cleanup=JSON.parse(__out)}catch{__cleanup={ok:true,mode:\"owned-pids\",pids:__owned,raw:__out}}}",
    "if(process.platform===\"win32\"){/* codex patch rc.7.82: no bare-pid cleanup; reuse the verified scoped result */let __ks=globalThis.__codexKillScopeGeneration===__codexThisResetGeneration?s.lastForceResetPanic:/panic-kill/i.test(String(o||\"\"))&&globalThis.__codexLastKillScope&&!globalThis.__codexLastKillScope.dryRun?globalThis.__codexLastKillScope:null;__cleanup=__ks?{ok:__ks.ok===true,mode:\"scoped-tree\",pids:__owned,failClosed:!!__ks.failClosed,scope:__ks}:{ok:null,mode:\"scoped-tree\",pids:__owned,skipped:\"no verified scoped result for this reset\"};if(__cleanup.ok!==true)try{globalThis.__codexUnresolvedCleanup=globalThis.__codexWindowsKillScopeRef.openGate(globalThis.__codexUnresolvedCleanup,__ks||{ok:null},new Map(__owned.map(__p=>[__p,(globalThis.__codexOwnedBackendPids||new Map).get(__p)||{pid:__p}])),{source:\"force-reset cleanup\"})}catch{}}"],
  ["force-reset dispose evidence",
    "try{await Promise.race([zg.dispose(),new Promise(r=>setTimeout(r,2500))])}catch(e){try{RI(\"[Codex bridge] force reset dispose failed: \"+(e?.message||e))}catch{}}",
    "/* codex patch rc.7.82: force reset records what dispose actually did */let __codexDispose={attempted:true,settled:false,ok:false,error:null};try{let __dr=await Promise.race([Promise.resolve().then(()=>zg.dispose()).then(()=>\"ok\",__e=>{__codexDispose.error=String(__e?.message||__e);return\"rejected\"}),new Promise(r=>setTimeout(()=>r(\"timeout\"),2500))]);__codexDispose.settled=__dr!==\"timeout\";__codexDispose.ok=__dr===\"ok\";if(__dr===\"timeout\")__codexDispose.error=\"dispose did not finish within 2.5 s\";if(__dr!==\"ok\")try{RI(\"[Codex bridge] force reset dispose failed: \"+__codexDispose.error)}catch{}}catch(e){__codexDispose.error=String(e?.message||e)}"],
  ["force-reset readiness gate",
    "let __needsSmoke=__codexRecoveryWasRequired||!__reconnect.ok||",
    "/* codex patch rc.7.82: an unresolved cleanup keeps READY closed */let __codexCleanupOpen=!!(process.platform===\"win32\"&&globalThis.__codexUnresolvedCleanup&&globalThis.__codexUnresolvedCleanup.open);let __needsSmoke=__codexCleanupOpen||__codexRecoveryWasRequired||!__reconnect.ok||"],
  ["force-reset state",
    "let __state=__current();__state.cleanup=__cleanup;return __state};",
    "let __state=__current();__state.cleanup=__cleanup;__state.dispose=__codexDispose;__state.unresolvedCleanup=globalThis.__codexUnresolvedCleanup||null;return __state};"],
  ["recovery-smoke gate",
    "__req.url===\"/recovery-smoke\"){/* codex patch rc.6.4: dedicated verified recovery endpoint */let __recovery=__codexControl.ensureRecoveryState(globalThis.__codexRecoveryState);",
    "__req.url===\"/recovery-smoke\"){/* codex patch rc.6.4: dedicated verified recovery endpoint *//* codex patch rc.7.82: re-check unresolved cleanup before any smoke */if(process.platform===\"win32\"&&globalThis.__codexUnresolvedCleanup&&globalThis.__codexUnresolvedCleanup.open){let __g=globalThis.__codexUnresolvedCleanupRecheck?globalThis.__codexUnresolvedCleanupRecheck():globalThis.__codexUnresolvedCleanup;if(__g&&__g.open){__send(__res,423,{ok:false,error:(globalThis.__codexWindowsKillScopeRef&&globalThis.__codexWindowsKillScopeRef.gateMessage(__g))||\"unresolved cleanup\",reasonCode:\"unresolved-cleanup\",unresolvedCleanup:__g,patch:__patch});return}}let __recovery=__codexControl.ensureRecoveryState(globalThis.__codexRecoveryState);"],
  ["force-reset escalation",
    "let cp=require(\"child_process\"),__args=[\"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"panic_kill_stata_chain.ps1\"),\"-Force\",\"-IncludeStataGui\"],__out=cp.execFileSync(\"powershell.exe\",__args,{encoding:\"utf8\",timeout:30000,windowsHide:true});try{s.lastForceResetPanic=JSON.parse(__out)}catch{s.lastForceResetPanic={ok:true,raw:__out}}",
    "/* codex patch rc.7.82: busy force reset ends only this window's backend tree */s.lastForceResetPanic=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(false,\"force-reset escalation\"):{ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope helper unavailable: \"+String(globalThis.__codexWindowsKillScopeError||\"not installed\")],targets:[],census:[]});globalThis.__codexKillScopeGeneration=__codexThisResetGeneration;"],
  ["panic-kill endpoint",
    "let cp=require(\"child_process\"),__include=!/[?&]includeStataGui=(0|false|no)/i.test(__req.url),__dry=/[?&]dryRun=(1|true|yes)/i.test(__req.url),__args=[\"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"panic_kill_stata_chain.ps1\")];if(!__dry)__args.push(\"-Force\");else __args.push(\"-DryRun\");if(__include)__args.push(\"-IncludeStataGui\");let __out=cp.execFileSync(\"powershell.exe\",__args,{encoding:\"utf8\",timeout:30000,windowsHide:true});try{__panic=JSON.parse(__out)}catch{__panic={ok:true,raw:__out}}",
    "/* codex patch rc.7.82: /panic-kill ends only this window's backend tree */let __dry=/[?&]dryRun=(1|true|yes)/i.test(__req.url);__panic=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(__dry,__dry?\"panic-kill endpoint dry run\":\"panic-kill endpoint\"):{ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope helper unavailable: \"+String(globalThis.__codexWindowsKillScopeError||\"not installed\")],targets:[],census:[]});"],
  ["panic-kill command",
    "let cp=require(\"child_process\"),__args=[\"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"panic_kill_stata_chain.ps1\"),\"-Force\",\"-IncludeStataGui\"];let __out=cp.execFileSync(\"powershell.exe\",__args,{encoding:\"utf8\",timeout:30000,windowsHide:true});",
    "/* codex patch rc.7.82: KILL ends only this window's backend tree */let __codexKillScope=(globalThis.__codexWindowsKillScopeRun?globalThis.__codexWindowsKillScopeRun(false,\"panic-kill command\"):{ok:false,failClosed:true,scope:\"this-session\",reasons:[\"kill scope helper unavailable: \"+String(globalThis.__codexWindowsKillScopeError||\"not installed\")],targets:[],census:[]});let __codexKillReset=null;if(__codexKillScope&&__codexKillScope.failClosed)try{if(globalThis.__codexForceReset)__codexKillReset=await globalThis.__codexForceReset(\"panic-kill-command scope unverified\")}catch{}let __codexKillDispose=(__codexKillReset&&__codexKillReset.dispose)||null;if(__codexKillScope&&__codexKillScope.ok===false){try{iA.window.showWarningMessage(globalThis.__codexWindowsKillScopeRef&&globalThis.__codexWindowsKillScopeRef.failClosedMessage?globalThis.__codexWindowsKillScopeRef.failClosedMessage(__codexKillScope,{disposed:!!(__codexKillDispose&&__codexKillDispose.ok),disposeAttempted:!!(__codexKillDispose&&__codexKillDispose.attempted),disposeError:__codexKillDispose&&__codexKillDispose.error}):\"Stata Workbench could not confirm which processes belong to this window's Stata backend, so it did not end them.\")}catch{}}let __out=JSON.stringify(__codexKillScope);"],
  ["confirm dialog",
    "\"Panic kill ALL Stata Workbench execution processes? Unsaved Stata work may be lost.\",{modal:true},\"Kill all Stata processes\",\"Cancel\");if(__choice!==\"Kill all Stata processes\")return;",
    "\"End this window's Stata Workbench backend? Other VS Code windows and Stata sessions are not affected. Unsaved Stata work in this session may be lost.\",{modal:true},\"Kill this window's Stata\",\"Cancel\");if(__choice!==\"Kill this window's Stata\")return;"],
];

function uniqueAt(source, needle, what) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous Windows KILL scope anchor: " + what);
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [name, , after] of EDITS) uniqueAt(source, after, name);
  } else {
    if (source.includes("__codexWindowsKillScope")) throw new Error("partial Windows KILL scope patch");
    for (const [name, before] of EDITS) uniqueAt(source, before, name);
    for (const [, before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// Exact inverse, used by tests to rebuild earlier sealed bundles.
function revertBundle(source) {
  for (const [name, , after] of EDITS) uniqueAt(source, after, name);
  for (const [, before, after] of [...EDITS].reverse()) source = source.replace(after, () => before);
  if (source.includes("__codexWindowsKillScope")) throw new Error("Windows KILL scope marker survived the revert");
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
