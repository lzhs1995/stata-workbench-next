#!/usr/bin/env node
"use strict";

// Maintained bundle changes only; this script never starts or installs Stata.
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch: explicit runtime and optional integrations stay isolated";
const OLD_FF = 'function FF(g){let A=iA.workspace.getConfiguration("stataMcp"),I=A.get("autoConfigureMcp",!0),Q=A.get("configureClaudeCode",!1),B=A.get("configureCodex",!1);TF(g)&&I&&(zg.getServerConfig&&JF(zg.getServerConfig(),JI,Kg)||fHg(g)),Q&&KHg()?ORA(g):xRA(g);let E=vRA(g);if(E)if(B){let e=mHg(E);JF(e,JI,Kg)||jRA(E)}else VRA(E)}';
const NEW_FF = `function FF(g){/* ${MARKER} */
let A=iA.workspace.getConfiguration("stataMcp"),I=A.get("autoConfigureMcp",!0),Q=A.get("configureClaudeCode",!1),B=A.get("configureCodex",!1);
TF(g)&&I&&(zg.getServerConfig&&JF(zg.getServerConfig(),JI,Kg)||fHg(g));
if(Q===true&&KHg())ORA(g);
if(B===true){let E=vRA(g);if(E){let e=mHg(E);JF(e,JI,Kg)||jRA(E)}}
}`;
const OLD_PATCH = 'let E=zg.getServerConfig({hostOnly:!0});try{let __runtimePatcher=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","mcp_stata_runtime_patch.js")),__runtimePatch=__runtimePatcher.patchRuntime({uvCommand:JI,command:E&&E.command});RI("[mcp-stata runtime] Data Browser listener-loop patch: "+JSON.stringify(__runtimePatch))}catch(__runtimePatchError){RI("[mcp-stata runtime] Data Browser listener-loop patch failed: "+(__runtimePatchError?.message||String(__runtimePatchError)))}';
const NEW_PATCH = `let E=zg.getServerConfig({hostOnly:!0});
let __runtimeIsolation=!!uM().MCP_STATA_CONFIG_PATH;
try{
let __runtimePatcher=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","mcp_stata_runtime_patch.js")),__runtimeOptions={...__runtimePatcher.runtimeOptionsFromConfig(E,uM()),uvCommand:JI};
__runtimeIsolation=__runtimeIsolation||__runtimePatcher.hasExplicitRuntime(__runtimeOptions);
let __runtimePatch=__runtimePatcher.patchRuntime(__runtimeOptions);
RI("[mcp-stata runtime] Data Browser listener-loop patch: "+JSON.stringify(__runtimePatch));
if(__runtimeIsolation&&!__runtimePatch.ok)throw new Error("Explicit mcp-stata runtime unavailable: "+__runtimePatch.status);
}catch(__runtimePatchError){RI("[mcp-stata runtime] Data Browser listener-loop patch failed: "+(__runtimePatchError?.message||String(__runtimePatchError)));if(__runtimeIsolation)throw __runtimePatchError}
if(__runtimeIsolation&&!AP(E))throw new Error("Explicit mcp-stata command failed pre-flight; refusing default runtime fallback");`;
const CONFIG_HEAD = '_loadServerConfig({ignoreCommandArgs:A=!1,hostOnly:I=!1}={}){';
const EXPLICIT_CONFIG = `let __configPath=MM().MCP_STATA_CONFIG_PATH;
if(__configPath!==undefined){
if(typeof __configPath!=="string"||!bA.isAbsolute(__configPath))throw new Error("MCP_STATA_CONFIG_PATH must be an absolute path");
let __config=this._safeParseJson(Lt.readFileSync(__configPath,"utf8")),__server=__config?.servers?.[RF]||__config?.mcpServers?.[RF];
if(!__server||typeof __server.command!=="string"||!__server.command)throw new Error("Explicit MCP config requires a mcp_stata command");
this._log("[mcp-stata] Using explicit config: "+__configPath);
return{command:__server.command,args:Array.isArray(__server.args)?__server.args:null,env:typeof __server.env==="object"&&__server.env!==null?__server.env:{},configPath:__configPath};
}`;
const EXPLICIT_HELPER = 'function __stataHasExplicitRuntime(){let p=require("../scripts/mcp_stata_runtime_patch");return p.hasExplicitRuntime(p.runtimeOptionsFromConfig(zg.getServerConfig({hostOnly:!0}),uM()))}';
const REPLACEMENTS = [
  [OLD_FF, NEW_FF],
  [OLD_PATCH, NEW_PATCH],
  [CONFIG_HEAD, CONFIG_HEAD + EXPLICIT_CONFIG],
  ['Kg=qRA(),FF(g),RI(`mcp-stata version: ${Kg}`)', 'Kg=__runtimeIsolation?"configured":qRA(),FF(g),RI(`mcp-stata version: ${Kg}`)'],
  ['setImmediate(()=>{try{let o=$_();', 'if(!__runtimeIsolation)setImmediate(()=>{try{let o=$_();'],
  ['function qRA(){let g=JI;', EXPLICIT_HELPER + 'function qRA(){if(__stataHasExplicitRuntime())return"configured";let g=JI;'],
  ['function $_(){let g=JI;', 'function $_(){if(__stataHasExplicitRuntime()){RI("Skipping uvx refresh for explicit runtime");return null}let g=JI;'],
  ['B=this._loadServerConfig({ignoreCommandArgs:this._forceLatestServer}),C=Ao,', 'B=this._loadServerConfig({ignoreCommandArgs:this._forceLatestServer}),__runtimePatcher=require("../scripts/mcp_stata_runtime_patch"),__explicitRuntime=__runtimePatcher.hasExplicitRuntime(__runtimePatcher.runtimeOptionsFromConfig(B,I)),C=Ao,'],
  ['&&B.command&&B.command!==Q&&', '&&B.command&&B.command!==Q&&!__explicitRuntime&&'],
  ['catch(L){if(L.message.includes("Command not found")||L.message.includes("failed to execute"))throw L}', 'catch(L){if(__explicitRuntime||L.message.includes("Command not found")||L.message.includes("failed to execute"))throw L}'],
  ['async _ensureLatestServerForMissingTool(A){', 'async _ensureLatestServerForMissingTool(A){let __patcher=require("../scripts/mcp_stata_runtime_patch");if(__patcher.hasExplicitRuntime(__patcher.runtimeOptionsFromConfig(this._loadServerConfig(),MM()))){this._log("Explicit runtime: missing tools require updating that runtime; uvx fallback disabled");return}'],
  ['let A=mB.spawnSync(g.command,["--version"],{encoding:"utf8",shell:process.platform==="win32",timeout:3e3})', 'let A=mB.spawnSync(g.command,["--version"],{env:{...uM(),...(g.env||{})},encoding:"utf8",shell:process.platform==="win32",timeout:3e3})'],
];

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("Missing or ambiguous activation isolation anchor: " + needle.slice(0, 100));
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    uniqueAt(source, MARKER);
    for (const [, after] of REPLACEMENTS) uniqueAt(source, after);
  } else {
    for (const [before, after] of REPLACEMENTS) {
      const at = uniqueAt(source, before);
      source = source.slice(0, at) + after + source.slice(at + before.length);
    }
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: after !== before, target, installed: false }));
}

module.exports = { patchBundle, MARKER, OLD_FF, NEW_FF, OLD_PATCH, NEW_PATCH, REPLACEMENTS };
