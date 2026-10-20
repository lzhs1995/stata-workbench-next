#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "dist", "extension.js");
let text = fs.readFileSync(target, "utf8");

function replaceOnce(name, before, after) {
  const first = text.indexOf(before);
  const second = first < 0 ? -1 : text.indexOf(before, first + before.length);
  if (first < 0) throw new Error(`missing rc.7 anchor: ${name}`);
  if (second >= 0) throw new Error(`non-unique rc.7 anchor: ${name}`);
  text = text.slice(0, first) + after + text.slice(first + before.length);
}

function replaceAllRequired(name, before, after, minimum = 1) {
  const count = text.split(before).length - 1;
  if (count < minimum) throw new Error(`missing rc.7 anchor: ${name} (found ${count})`);
  text = text.split(before).join(after);
  return count;
}

function replaceSpanOnce(name, start, end, after) {
  const first = text.indexOf(start);
  const second = first < 0 ? -1 : text.indexOf(start, first + start.length);
  if (first < 0) throw new Error(`missing rc.7 span start: ${name}`);
  if (second >= 0) throw new Error(`non-unique rc.7 span start: ${name}`);
  const endAt = text.indexOf(end, first + start.length);
  if (endAt < 0) throw new Error(`missing rc.7 span end: ${name}`);
  const afterEnd = endAt + end.length;
  text = text.slice(0, first) + after + text.slice(afterEnd);
}

const baseAlreadyApplied = text.includes("codex patch rc.7: shared execution lifecycle");

if (!baseAlreadyApplied) {
replaceOnce(
  "execution lifecycle require",
  '__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js")),__port=',
  '__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js")),__codexExecution=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_lifecycle_core.js")),__port='
);

replaceOnce(
  "patch identity",
  '__patch="codex-rc64-control-plane"',
  '__patch="codex-rc7-shared-execution"'
);

replaceOnce(
  "execution lifecycle initialization",
  'globalThis.__codexControlPlane=__codexControl;globalThis.__codexRecoveryState=',
  'globalThis.__codexControlPlane=__codexControl;globalThis.__codexExecutionAdapter=__codexExecution;__codexExecution.ensureLifecycle(globalThis.__codexBridgeState);globalThis.__codexRecoveryState='
);

replaceOnce(
  "status lifecycle fields",
  'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null}};let __send=',
  'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,...__codexExecution.publicLifecycle(o)}};let __send='
);

replaceOnce(
  "acquire lifecycle",
  'return Object.assign(s,{busy:true,runId:o.runId,label:o.label,source:o.source,startedAt:Date.now(),lastHeartbeatAt:Date.now(),codePreview:o.codePreview,logPath:null,rc:null}),true};let __release=o=>{let s=globalThis.__codexBridgeState;o&&(s.logPath=o.logPath||s.logPath,s.rc=o.rc),s.busy=false,s.lastHeartbeatAt=Date.now()};',
  'Object.assign(s,{busy:true,runId:o.runId,label:o.label,source:o.source,startedAt:Date.now(),lastHeartbeatAt:Date.now(),codePreview:o.codePreview,logPath:null,rc:null});__codexExecution.beginRun(s,{requestId:o.runId,runId:o.runId,sourceMode:o.source});return true};let __release=o=>{let s=globalThis.__codexBridgeState;o&&(s.logPath=o.logPath||s.logPath,s.rc=o.rc);let __life=__codexExecution.ensureLifecycle(s);__codexExecution.finishRun(s,{logPath:(o&&o.logPath)||s.logPath||__life.logPath||null,rc:o&&typeof o.rc==="number"?o.rc:__life.rc,completionMarkerVerified:!!(__life.completionMarkerVerified||(o&&o.completionMarkerVerified)),error:o&&o.error||null});s.busy=false;s.lastHeartbeatAt=Date.now()};'
);

replaceOnce(
  "canonical run id adoption helper",
  'globalThis.__codexVisibleState=__current;globalThis.__codexForceReset=',
  'globalThis.__codexVisibleState=__current;let __codexAdoptExecutionRunId=__runId=>{let __s=globalThis.__codexBridgeState||{},__adopted=__codexExecution.adoptRunId(__s,__runId);__s.runId=__adopted.runId;try{let __recovery=__codexControl.ensureRecoveryState(globalThis.__codexRecoveryState);if(__recovery.activeRunId&&__recovery.activeRunId===__adopted.previousRunId)__recovery.activeRunId=__adopted.runId;globalThis.__codexRecoveryState=__recovery}catch{}return __adopted.runId};globalThis.__codexAdoptExecutionRunId=__codexAdoptExecutionRunId;/* codex patch rc.7: shared execution lifecycle */globalThis.__codexForceReset='
);

replaceOnce(
  "bridge canonical terminal run id",
  '__run=Gg.startStreamingEntry(__code,__label,kM,lM,yM,OF,RD);let __codexBridgeDocScanText=',
  '__run=Gg.startStreamingEntry(__code,__label,kM,lM,yM,OF,RD);__codexAdoptExecutionRunId(__run);let __codexBridgeDocScanText='
);

replaceOnce(
  "manual selection canonical run id",
  'let e=Gg.startStreamingEntry(I,Q,kM,lM,yM,OF,RD);let __codexPreparedGraphRun=',
  'let e=Gg.startStreamingEntry(I,Q,kM,lM,yM,OF,RD);globalThis.__codexAdoptExecutionRunId&&globalThis.__codexAdoptExecutionRunId(e);let __codexPreparedGraphRun='
);

replaceOnce(
  "human file canonical run id",
  'let r=Gg.startStreamingEntry(s,A,kM,lM,yM,OF,RD);let __codexPreparedHumanFileRun=',
  'let r=Gg.startStreamingEntry(s,A,kM,lM,yM,OF,RD);globalThis.__codexAdoptExecutionRunId&&globalThis.__codexAdoptExecutionRunId(r);let __codexPreparedHumanFileRun='
);

replaceOnce(
  "non-destructive pre-acquire policy",
  'function __codexHumanFileNeedsPreflight() {\n  try {',
  'function __codexHumanFileNeedsPreflight() {\n  if (globalThis.__codexExecutionAdapter) return false; /* rc.7: acquire/recovery gate owns stale state; never reset a healthy shared session */\n  try {'
);

replaceOnce(
  "authoritative log directories",
  'const dirs = [rg.join(((iA.workspace.workspaceFolders&&iA.workspace.workspaceFolders[0]?.uri?.fsPath)||(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"7_temp","mcp-stata-temp")];',
  'const dirs = globalThis.__codexExecutionAdapter.resolveLogDirectories({env:process.env,cwd:options?.cwd,workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean),extensionRoot:yC&&yC.extensionUri&&yC.extensionUri.fsPath});'
);

replaceOnce(
  "fifteen second health window",
  'const healthWindowMs = Number.isFinite(options?.healthWindowMs) ? Number(options.healthWindowMs) : 5 * 60 * 1000;\n  const initialHeartbeatMs = Number.isFinite(options?.initialHeartbeatMs) ? Number(options.initialHeartbeatMs) : 30 * 1000;',
  'const healthWindowMs = Math.min(Number.isFinite(options?.healthWindowMs) ? Number(options.healthWindowMs) : 15 * 1000, 15 * 1000);\n  const initialHeartbeatMs = Math.min(Number.isFinite(options?.initialHeartbeatMs) ? Number(options.initialHeartbeatMs) : 12 * 1000, 12 * 1000);\n  const completionIdleMs = Math.min(idleAfterMs, 1000);'
);

replaceOnce(
  "exact completion and rc parsing",
  'if (/end of do-file/i.test(text) || /___END___COMMAND_DONE_MARKER___0/i.test(text) || (options?.acceptGraphCompletionMarkerAsDone !== false && /___CODEX_RUN_DONE_/i.test(text))) { /* codex patch v7.55b: long human runs ignore CODEX marker echoes */\n/* codex patch v7.55c: no-graph human runs ignore graph completion marker */\n      state.sawEndOfDoFile = true;\n    }\n    if (/(?:^|\\n)\\s*r\\([0-9]+\\);/i.test(text)) {\n      state.sawError = true;\n    }',
  'const __inspection=globalThis.__codexExecutionAdapter.inspectLogText(text,runId);if(__inspection.endOfDoFile||__inspection.completionMarkerVerified||/___END___COMMAND_DONE_MARKER___0/i.test(text))state.sawEndOfDoFile=true;if(__inspection.completionMarkerVerified){globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState||{},Date.now())}if(typeof __inspection.rc==="number"&&__inspection.rc!==0)state.sawError=true;'
);

replaceOnce(
  "record discovered log path",
  'if (freshLog) { state.logPath = freshLog; try { if (globalThis.__codexBridgeState && globalThis.__codexBridgeState.busy && !globalThis.__codexBridgeState.logPath) globalThis.__codexBridgeState.logPath = freshLog; } catch {} state.sawLog = true;',
  'if (freshLog) { state.logPath = freshLog; try { if (globalThis.__codexBridgeState && globalThis.__codexBridgeState.busy) globalThis.__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState,freshLog,now); } catch {} state.sawLog = true;'
);

replaceOnce(
  "record callback log path",
  'if (logPath) state.logPath = logPath;\n      ingestLogText(text, true);',
  'if (logPath) { state.logPath = logPath; try { globalThis.__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},logPath,Date.now()); } catch {} }\n      ingestLogText(text, true);'
);

replaceOnce(
  "record callback progress",
  'state.sawProgress = true;\n      state.lastActivityAt = Date.now();',
  'state.sawProgress = true;\n      state.lastActivityAt = Date.now();\n      try { globalThis.__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},state.lastActivityAt); } catch {}'
);

replaceOnce(
  "fast exact completion release",
  'if (state.sawEndOfDoFile && !state.sawError && idleMs >= idleAfterMs) {',
  'if (state.sawEndOfDoFile && !state.sawError && idleMs >= completionIdleMs) {'
);

replaceAllRequired(
  "watchdog result log evidence",
  'durationMs: elapsedMs,\n          __codexWatchdogRelease:',
  'durationMs: elapsedMs,\n          logPath: state.logPath,\n          logSize: state.logSize >= 0 ? state.logSize : null,\n          completionMarkerVerified: !!(globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified),\n          __codexWatchdogRelease:',
  4
);

replaceOnce(
  "bridge do path capture",
  'let __codexBridgeDocScanText=__code;try{let __codexBridgeDoMatch=String(__code||"").match(/\\bdo\\s+"([^"]+\\.do)"/i);if(__codexBridgeDoMatch&&JA.existsSync(__codexBridgeDoMatch[1]))__codexBridgeDocScanText=String(__code||"")+"\\\\n"+JA.readFileSync(__codexBridgeDoMatch[1],"utf8")}catch{}',
  'let __codexBridgeDocScanText=__code,__codexBridgeDoFile=null;try{let __codexBridgeDoMatch=String(__code||"").match(/\\bdo\\s+"([^"]+\\.do)"/i);if(__codexBridgeDoMatch&&JA.existsSync(__codexBridgeDoMatch[1])){__codexBridgeDoFile=__codexBridgeDoMatch[1];__codexBridgeDocScanText=String(__code||"")+"\\\\n"+JA.readFileSync(__codexBridgeDoFile,"utf8")}}catch{}'
);

replaceOnce(
  "bridge do file graph parity",
  'let __codexPreparedBridgeRun=__run&&globalThis.__codexPrepareGraphRunCode?__codexPrepareGraphRunCode(__code,__run,"visible-bridge",__cwd):null;',
  'let __codexPreparedBridgeRun=__run&&__codexBridgeDoFile&&globalThis.__codexPrepareHumanFileGraphRun?__codexPrepareHumanFileGraphRun(__codexBridgeDoFile,__run,__cwd):(__run&&globalThis.__codexPrepareGraphRunCode?__codexPrepareGraphRunCode(__code,__run,"visible-bridge",__cwd):null);'
);

replaceOnce(
  "bridge response canonical run id",
  '__send(__res,200,{ok:true,busy:false,runId:__runId,rc:__r&&__r.rc,logPath:__r&&__r.logPath,logSize:__r&&__r.logSize,patch:__patch})',
  '__send(__res,200,{ok:true,busy:false,runId:__run,requestId:__runId,rc:__r&&__r.rc,logPath:(__r&&__r.logPath)||(globalThis.__codexBridgeState&&globalThis.__codexBridgeState.logPath)||null,logSize:__r&&__r.logSize,completionMarkerVerified:!!(__r&&__r.completionMarkerVerified),lifecycle:__codexExecution.publicLifecycle(globalThis.__codexBridgeState||{}),patch:__patch})'
);
}

if (!text.includes("codex patch rc.7: release infers manual evidence")) {
  replaceOnce(
    "release infers manual log evidence",
    'let __release=o=>{let s=globalThis.__codexBridgeState;o&&(s.logPath=o.logPath||s.logPath,s.rc=o.rc);let __life=__codexExecution.ensureLifecycle(s);__codexExecution.finishRun(s,{logPath:(o&&o.logPath)||s.logPath||__life.logPath||null,rc:o&&typeof o.rc==="number"?o.rc:__life.rc,completionMarkerVerified:!!(__life.completionMarkerVerified||(o&&o.completionMarkerVerified)),error:o&&o.error||null});s.busy=false;s.lastHeartbeatAt=Date.now()};',
    'let __release=o=>{let s=globalThis.__codexBridgeState;o&&(s.logPath=o.logPath||s.logPath,s.rc=o.rc);let __life=__codexExecution.ensureLifecycle(s),__logPath=(o&&o.logPath)||s.logPath||__life.logPath||null,__inspection=null;try{if(__logPath&&JA.existsSync(__logPath)){let __stat=JA.statSync(__logPath),__length=Math.min(__stat.size,65536),__start=Math.max(0,__stat.size-__length),__buffer=Buffer.alloc(__length),__fd=JA.openSync(__logPath,"r");try{if(__length)JA.readSync(__fd,__buffer,0,__length,__start)}finally{JA.closeSync(__fd)}__inspection=__codexExecution.inspectLogText(__buffer.toString("utf8"),__life.runId)}}catch{}let __completion=!!(__life.completionMarkerVerified||(o&&o.completionMarkerVerified)||(__inspection&&__inspection.completionMarkerVerified)),__rc=o&&typeof o.rc==="number"?o.rc:(typeof __life.rc==="number"?__life.rc:(__inspection&&typeof __inspection.rc==="number"?__inspection.rc:null)),__error=o&&o.error||null;if(typeof __rc!=="number"&&__completion)__rc=0;if(!__error&&typeof __rc!=="number"&&!__completion)__error=new Error("execution released without verified completion evidence");/* codex patch rc.7: release infers manual evidence */__codexExecution.finishRun(s,{logPath:__logPath,rc:__rc,completionMarkerVerified:__completion,error:__error});s.logPath=__logPath;s.rc=__rc;s.busy=false;s.lastHeartbeatAt=Date.now()};'
  );
}

if (!text.includes("codex patch rc.7.10.8: structural long-selection watchdog")) {
  replaceOnce(
    "load manual run policy",
    '__codexSourceCompat=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stata_source_compat_core.js")),__port=',
    '__codexSourceCompat=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stata_source_compat_core.js")),__codexManualPolicy=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","manual_run_policy.js")),__port='
  );
  replaceOnce(
    "classify structurally long manual selections",
    'let __codexManualSelectionLongRun=/\\bmi\\s+(impute|estimate|xeq|convert|set|register|passive)\\b/i.test(I)||I.length>200000;',
    'let __codexManualSelectionLongRun=__codexManualPolicy.isLongManualSelection(I);/* codex patch rc.7.10.8: structural long-selection watchdog */'
  );
}

if (!text.includes("codex patch rc.7.10.8.1: manual run policy is command-visible")) {
  replaceOnce(
    "publish manual run policy to command handlers",
    'globalThis.__codexExecutionAdapter=__codexExecution;__codexExecution.ensureLifecycle(globalThis.__codexBridgeState);',
    'globalThis.__codexExecutionAdapter=__codexExecution;globalThis.__codexManualRunPolicy=__codexManualPolicy;/* codex patch rc.7.10.8.1: manual run policy is command-visible */__codexExecution.ensureLifecycle(globalThis.__codexBridgeState);'
  );
  replaceOnce(
    "use command-visible manual run policy",
    'let __codexManualSelectionLongRun=__codexManualPolicy.isLongManualSelection(I);/* codex patch rc.7.10.8: structural long-selection watchdog */',
    'let __codexManualSelectionLongRun=globalThis.__codexManualRunPolicy.isLongManualSelection(I);/* codex patch rc.7.10.8: structural long-selection watchdog */'
  );
}

if (!text.includes("codex patch rc.7.10.9: long manual selections keep exact completion markers")) {
  replaceOnce(
    "long manual selections keep an exact completion marker",
    '__codexSelectionBody=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(__codexSelectionBody,{sourceMode:"manual-selection",runId:e,sourcePath:Q,cwd:B}):__codexSelectionBody;/* shared compatibility: manual selection */let __codexManualSelectionWatchdog=',
    '__codexSelectionBody=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(__codexSelectionBody,{sourceMode:"manual-selection",runId:e,sourcePath:Q,cwd:B}):__codexSelectionBody;/* shared compatibility: manual selection */let __codexManualSelectionExactMarker=e?"___CODEX_RUN_DONE_"+String(e)+"___":null;if(__codexManualSelectionExactMarker&&!String(__codexSelectionBody||"").includes(__codexManualSelectionExactMarker))__codexSelectionBody=String(__codexSelectionBody||"").replace(/\\s*$/,"")+"\\n#delimit cr\\ndisplay as text \\\""+__codexManualSelectionExactMarker+"\\\"\\n";/* codex patch rc.7.10.9: long manual selections keep exact completion markers */let __codexManualSelectionWatchdog='
  );
}

if (!text.includes("codex patch rc.7: lifecycle release proof")) {
  replaceOnce(
    "bridge response lifecycle release proof",
    'completionMarkerVerified:!!(__r&&__r.completionMarkerVerified),lifecycle:__codexExecution.publicLifecycle(globalThis.__codexBridgeState||{})',
    'completionMarkerVerified:!!((__r&&__r.completionMarkerVerified)||__codexExecution.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified),/* codex patch rc.7: lifecycle release proof */lifecycle:__codexExecution.publicLifecycle(globalThis.__codexBridgeState||{})'
  );
}

if (!text.includes("codex patch rc.7: release discovers final run log")) {
  replaceOnce(
    "release discovers exact current run log",
    'let __life=__codexExecution.ensureLifecycle(s),__logPath=(o&&o.logPath)||s.logPath||__life.logPath||null,__inspection=null;try{if(__logPath&&JA.existsSync(__logPath)){',
    'let __life=__codexExecution.ensureLifecycle(s),__logPath=(o&&o.logPath)||s.logPath||__life.logPath||null,__inspection=null;if(!__logPath)try{let __found=__codexExecution.findRunLog({env:process.env,cwd:process.cwd(),workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean),extensionRoot:yC&&yC.extensionUri&&yC.extensionUri.fsPath,runId:__life.runId,startedAt:__life.startedAt});if(__found){__logPath=__found.logPath;__inspection=__found.inspection;__codexExecution.recordLogPath(s,__logPath,Date.now())}}catch{}/* codex patch rc.7: release discovers final run log */try{if(__logPath&&JA.existsSync(__logPath)){'
  );
}

if (!text.includes("codex patch rc.7.5: exact-marker log overrides stale log")) {
  replaceOnce(
    "release searches exact marker even when a stale log path is present",
    "if(!__logPath)try{let __found=__codexExecution.findRunLog",
    "try{let __found=__codexExecution.findRunLog"
  );
  replaceOnce(
    "release binds the exact-marker log to its owning lifecycle",
    "__codexExecution.recordLogPath(s,__logPath,Date.now())}}catch{}/* codex patch rc.7: release discovers final run log */",
    "__codexExecution.recordLogPath(s,__logPath,Date.now(),__life.runId)}}catch{}/* codex patch rc.7: release discovers final run log *//* codex patch rc.7.5: exact-marker log overrides stale log */"
  );
}

if (!text.includes("codex patch rc.7.6: watchdog log ownership is run-scoped")) {
  replaceOnce(
    "fresh log discovery rejects pre-existing logs",
    "if (st.mtimeMs + 5000 < state.startedAt) continue;",
    "const __createdAt=Number.isFinite(st.birthtimeMs)&&st.birthtimeMs>0?st.birthtimeMs:st.ctimeMs;if(__createdAt+1000<state.startedAt)continue;/* codex patch rc.7.6: watchdog log ownership is run-scoped */"
  );
  replaceOnce(
    "watchdog requires the exact current-run completion marker",
    "if (state.sawEndOfDoFile && !state.sawError && idleMs >= completionIdleMs) {",
    "if (globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified===true && !state.sawError && idleMs >= completionIdleMs) {/* codex patch rc.7.6: stale end-of-do-file cannot release current run */"
  );
}

if (!text.includes("codex patch rc.7.7: Agent bridge exact completion marker")) {
  replaceOnce(
    "Agent bridge appends its exact Terminal run marker",
    "if(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.code)__code=__codexPreparedBridgeRun.code;",
    "if(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.code)__code=__codexPreparedBridgeRun.code;let __codexBridgeExactMarker=__run?\"___CODEX_RUN_DONE_\"+String(__run)+\"___\":null;if(__codexBridgeExactMarker&&!String(__code||\"\").includes(__codexBridgeExactMarker))__code=String(__code||\"\").replace(/\\s*$/,\"\")+\"\\ndisplay as text \\\"\"+__codexBridgeExactMarker+\"\\\"\\n\";/* codex patch rc.7.7: Agent bridge exact completion marker */"
  );
}

if (!text.includes("codex patch rc.7.10.21: transport success waits for exact marker")) {
  replaceOnce(
    "watchdog holds successful transport settlement until exact completion",
    `    Promise.resolve(promise).then((result) => {
      settled = true;
      clear();
      resolve(result);
    }, (error) => {
      settled = true;
      clear();
      reject(error);
    });`,
    `    let __codexBaseResult = null;
    let __codexBaseSettled = false;
    const __codexResolveBaseResultIfReady = () => {
      if (settled || !__codexBaseSettled) return false;
      const __life = globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {});
      const __decision = globalThis.__codexExecutionAdapter.transportSettlementDecision(__codexBaseResult || {}, __life);
      if (!__decision.release) return false;
      settled = true;
      clear();
      resolve(__decision.failed
        ? __codexBaseResult
        : globalThis.__codexExecutionAdapter.verifiedTransportResult(__codexBaseResult || {}, {
            logPath: state.logPath || __life.logPath || null,
            logSize: state.logSize >= 0 ? state.logSize : null
          }));
      return true;
    };
    Promise.resolve(promise).then((result) => {
      if (settled) return;
      __codexBaseResult = result || {};
      __codexBaseSettled = true;
      if (__codexBaseResult.logPath) {
        state.logPath = __codexBaseResult.logPath;
        try { globalThis.__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState || {}, state.logPath, Date.now(), runId); } catch {}
      }
      if (__codexBaseResult.completionMarkerVerified === true) {
        try { globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState || {}, Date.now(), runId); } catch {}
      }
      __codexResolveBaseResultIfReady();
    }, (error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    });/* codex patch rc.7.10.21: transport success waits for exact marker */`
  );
  replaceOnce(
    "watchdog rechecks held transport settlement after log ingestion",
    `      } catch {}
      try {
        const diag = globalThis.__codexGraphPanelDiag || {};`,
    `      } catch {}
      if (__codexResolveBaseResultIfReady()) return;
      try {
        const diag = globalThis.__codexGraphPanelDiag || {};`
  );
}

if (!text.includes("codex patch rc.7.10.22: authoritative session log marker fallback")) {
  replaceOnce(
    "watchdog checks the authoritative session log after truncated per-run output",
    `      if (__codexResolveBaseResultIfReady()) return;
      try {
        const diag = globalThis.__codexGraphPanelDiag || {};`,
    `      if (__codexBaseSettled && !globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {}).completionMarkerVerified) try {
        const __codexSessionEvidence = globalThis.__codexExecutionAdapter.findRunLog({
          env: process.env,
          cwd: options?.cwd,
          workspaceRoots: (iA.workspace.workspaceFolders || []).map(__folder => __folder?.uri?.fsPath).filter(Boolean),
          extensionRoot: yC && yC.extensionUri && yC.extensionUri.fsPath,
          runId,
          startedAt: state.startedAt,
          includeSessionLogs: true,
          maxBytes: 262144
        });
        if (__codexSessionEvidence?.inspection?.completionMarkerVerified) {
          globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState || {}, now, runId);
          state.lastEvidenceAt = now;
          state.lastEvidenceType = "authoritative-session-log-marker";
        }
      } catch {}
      /* codex patch rc.7.10.22: authoritative session log marker fallback */
      if (__codexResolveBaseResultIfReady()) return;
      try {
        const diag = globalThis.__codexGraphPanelDiag || {};`
  );
}

if (!text.includes("codex patch rc.7.10.23: authoritative exact marker releases unsettled transport")) {
  replaceOnce(
    "authoritative exact marker releases a transport callback stall",
    `      if (__codexBaseSettled && !globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {}).completionMarkerVerified) try {`,
    `      if (!globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {}).completionMarkerVerified) try {/* codex patch rc.7.10.23: authoritative exact marker releases unsettled transport */`
  );
}

if (!text.includes("codex patch rc.7.10.24: exact marker settles missing task_done")) {
  replaceOnce(
    "MCP client settles a missing task_done notification from exact run evidence",
    'async cancelRun(A){if(!A)return!1;let I=this._cancellationSourcesByRunId.get(String(A));return I?(I.cancel("user cancelled specific run"),this._activeRun&&String(this._activeRun._runId)===String(A)&&(this._activeRun._cancelled=!0),!0):this._activeRun&&String(this._activeRun._runId)===String(A)&&(this._activeRun._cancelled=!0,this._activeCancellation)?(this._activeCancellation.cancel("user cancelled active run"),!0):!1}_createCancellationSource(A){',
    'async cancelRun(A){if(!A)return!1;let I=this._cancellationSourcesByRunId.get(String(A));return I?(I.cancel("user cancelled specific run"),this._activeRun&&String(this._activeRun._runId)===String(A)&&(this._activeRun._cancelled=!0),!0):this._activeRun&&String(this._activeRun._runId)===String(A)&&(this._activeRun._cancelled=!0,this._activeCancellation)?(this._activeCancellation.cancel("user cancelled active run"),!0):!1}settleRunFromExactMarker(A,I={}){if(!A)return!1;let Q=String(A),B=null,C=this._activeRun;if(C&&String(C._runId||"")===Q)B=C;if(!B)for(let E of this._runsByTaskId.values())if(E&&String(E._runId||"")===Q){B=E;break}if(!B||typeof B._taskDoneResolve!=="function")return!1;let E=B.taskId||B._taskDoneTaskId||null,e=I.logPath||B.logPath||null,t={event:"task_done",task_id:E,run_id:Q,status:"completed",rc:0,path:e,result:{success:!0,rc:0,task_id:E,log_path:e}};B._tailCancelled=!0;B._fastDrain=!0;B._taskDonePayload=t;E&&(B._taskDoneTaskId=String(E));B._taskDoneResolve(t);E&&this._scheduleRunCleanup(E);return!0}/* codex patch rc.7.10.24: exact marker settles missing task_done */_createCancellationSource(A){'
  );
  replaceOnce(
    "watchdog tracks exact-marker transport settlement",
    '    let __codexBaseResult = null;\n    let __codexBaseSettled = false;\n    const __codexResolveBaseResultIfReady = () => {',
    '    let __codexBaseResult = null;\n    let __codexBaseSettled = false;\n    let __codexTransportMarkerSettlementRequested = false;\n    const __codexResolveBaseResultIfReady = () => {'
  );
  replaceOnce(
    "exact marker settles the matching background transport before lifecycle release",
    `      /* codex patch rc.7.10.22: authoritative session log marker fallback */
      if (__codexResolveBaseResultIfReady()) return;`,
    `      /* codex patch rc.7.10.22: authoritative session log marker fallback */
      const __codexMarkerLife = globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {});
      if (!__codexBaseSettled && __codexMarkerLife.completionMarkerVerified === true && !__codexTransportMarkerSettlementRequested) {
        __codexTransportMarkerSettlementRequested = true;
        let __codexTransportSettled = false;
        try {
          __codexTransportSettled = !!zg.settleRunFromExactMarker(runId, {
            logPath: state.logPath || __codexMarkerLife.logPath || null
          });
        } catch {}
        globalThis.__codexLastExactMarkerTransportSettlement = {
          at: new Date(now).toISOString(),
          runId,
          requested: true,
          settled: __codexTransportSettled,
          logPath: state.logPath || __codexMarkerLife.logPath || null
        };
        if (!__codexTransportSettled) __codexTransportMarkerSettlementRequested = false;
      }
      /* codex patch rc.7.10.24: exact marker settles missing task_done */
      if (__codexResolveBaseResultIfReady()) return;`
  );
  replaceOnce(
    "completed-log watchdog cannot release before transport settlement",
    '      if (globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified===true && !state.sawError && idleMs >= completionIdleMs) {/* codex patch rc.7.6: stale end-of-do-file cannot release current run */',
    '      if (__codexBaseSettled && globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified===true && !state.sawError && idleMs >= completionIdleMs) {/* codex patch rc.7.6: stale end-of-do-file cannot release current run */'
  );
  replaceOnce(
    "status exposes exact-marker transport settlement",
    'lastForceResetReconnect:globalThis.__codexLastForceResetReconnect||null,ownedBackendPids:',
    'lastForceResetReconnect:globalThis.__codexLastForceResetReconnect||null,lastExactMarkerTransportSettlement:globalThis.__codexLastExactMarkerTransportSettlement||null,ownedBackendPids:'
  );
}

if (!text.includes("codex patch rc.7: human file exact completion marker")) {
  replaceOnce(
    "human file appends exact marker to prepared temp runner",
    'let __codexPreparedHumanFileRun=r&&globalThis.__codexPrepareHumanFileGraphRun?__codexPrepareHumanFileGraphRun(e,r,C):null;try{globalThis.__codexContinuityRunId=r||null;',
    'let __codexPreparedHumanFileRun=r&&globalThis.__codexPrepareHumanFileGraphRun?__codexPrepareHumanFileGraphRun(e,r,C):null;let __codexHumanFileExactCompletionMarker="___CODEX_RUN_DONE_"+String(r||"no-run-id")+"___";if(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)try{let __markerLine="\\ndisplay as text \\\""+__codexStataString(__codexHumanFileExactCompletionMarker)+"\\\"\\n";JA.appendFileSync(__codexPreparedHumanFileRun.tempDoFile,__markerLine,{encoding:"utf8"});let __markerStat=JA.statSync(__codexPreparedHumanFileRun.tempDoFile),__writeCheck=globalThis.__codexGraphPanelDiag&&globalThis.__codexGraphPanelDiag.lastInlineSnapshotWriteCheck;if(__writeCheck&&__writeCheck.runId===r){__writeCheck.completionMarkerAppended=true;__writeCheck.intendedBytes=__markerStat.size;__writeCheck.diskBytes=__markerStat.size}}catch(__markerError){throw new Error("failed to append exact human-file completion marker: "+(__markerError?.message||__markerError))}/* codex patch rc.7: human file exact completion marker */try{globalThis.__codexContinuityRunId=r||null;'
  );

  replaceOnce(
    "human file appends exact marker to non-prepared runner",
    'let __codexHumanFileRunner=__codexHumanFileUseSourceSelection?__codexHumanFileRunSourceText:((__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileTempDoFile)?__codexHumanFileTempDoFile:((__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)?__codexPreparedHumanFileRun.code:(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.code)?__codexPreparedHumanFileRun.code:__codexHumanFileOriginalDo));if(__codexHumanFileIsHugeMiDocumentRun)try{',
    'let __codexHumanFileRunner=__codexHumanFileUseSourceSelection?__codexHumanFileRunSourceText:((__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileTempDoFile)?__codexHumanFileTempDoFile:((__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)?__codexPreparedHumanFileRun.code:(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.code)?__codexPreparedHumanFileRun.code:__codexHumanFileOriginalDo));if(!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)){let __markerLine="\\ndisplay as text \\\""+__codexStataString(__codexHumanFileExactCompletionMarker)+"\\\"\\n";if(__codexHumanFileTempDoFile&&!__codexHumanFileUseSourceSelection)JA.appendFileSync(__codexHumanFileTempDoFile,__markerLine,{encoding:"utf8"});else __codexHumanFileRunner=String(__codexHumanFileRunner||"")+__markerLine}/* exact marker is added only to Workbench transport */if(__codexHumanFileIsHugeMiDocumentRun)try{'
  );
}

if (!text.includes("codex patch rc.7: Terminal input owns shared lifecycle")) {
  replaceOnce(
    "Terminal input acquires the shared lifecycle",
    'error:{message:__codexTerminalRecovery.reason||"recovery smoke required"}};let __codexStoppedSession=',
    'error:{message:__codexTerminalRecovery.reason||"recovery smoke required"}};let __codexTerminalOwnsLifecycle=false;if(A?.runId&&globalThis.__codexVisibleAcquire){let __terminalBridge=globalThis.__codexBridgeState||{},__terminalLife=globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.ensureLifecycle(__terminalBridge);if(!__terminalBridge.busy){let __terminalAccepted=globalThis.__codexVisibleAcquire({runId:A.runId,label:A?.label||"Stata Terminal input",source:A?.sourceMode||"terminal-input",codePreview:String(g||"").slice(0,300),kind:"normal"});if(!__terminalAccepted){let __terminalDecision=globalThis.__codexLastAcquireDecision||{},__terminalReason=__terminalDecision.reason||"Stata Workbench request rejected";return{success:false,rc:-1,controlPlaneRejected:true,httpStatus:Number(__terminalDecision.httpStatus)||409,reasonCode:__terminalDecision.kind||"rejected",stderr:__terminalReason,error:{message:__terminalReason}}}__codexTerminalOwnsLifecycle=true}else if(__terminalLife&&String(__terminalLife.runId||"")!==String(A.runId)){return{success:false,rc:-1,controlPlaneRejected:true,httpStatus:409,reasonCode:"busy",stderr:"Stata Workbench is already running a different visible command.",error:{message:"Stata Workbench is already running a different visible command."}}}}/* codex patch rc.7: Terminal input owns shared lifecycle */let __codexStoppedSession='
  );

  replaceOnce(
    "Terminal input appends its exact completion marker",
    '}catch(__codexTerminalPrepareError){try{RI("[Codex terminal-input] graph prepare failed: "+(__codexTerminalPrepareError?.message||__codexTerminalPrepareError))}catch{}}let __codexTerminalResult;',
    '}catch(__codexTerminalPrepareError){try{RI("[Codex terminal-input] graph prepare failed: "+(__codexTerminalPrepareError?.message||__codexTerminalPrepareError))}catch{}}let __codexTerminalCompletionMarker=A?.runId?"___CODEX_RUN_DONE_"+String(A.runId)+"___":null;if(__codexTerminalCompletionMarker&&!String(__codexTerminalCode||"").includes(__codexTerminalCompletionMarker))__codexTerminalCode=String(__codexTerminalCode||"").replace(/\\s*$/,"")+"\\ndisplay as text \\\""+__codexTerminalCompletionMarker+"\\\"\\n";/* codex patch rc.7: Terminal input exact completion marker */let __codexTerminalResult;'
  );

  replaceOnce(
    "Terminal input records lifecycle start",
    'onStarted:()=>{A?.runId&&Gg.updateStreamingStatus(A.runId,"running")},onRawLog:I,onLog:A?.onLog,',
    'onStarted:()=>{try{globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.recordStarted(globalThis.__codexBridgeState||{},Date.now())}catch{}A?.runId&&Gg.updateStreamingStatus(A.runId,"running")},onRawLog:I,onLog:B=>{try{globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},Date.now())}catch{}A?.onLog&&A.onLog(B)},'
  );

  replaceOnce(
    "Terminal input records task log and progress",
    'onTaskDone:B=>{A?.onTaskDone&&A.onTaskDone(B)},onProgress:A?.onProgress})',
    'onTaskDone:B=>{try{B?.logPath&&globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},B.logPath,Date.now())}catch{}A?.onTaskDone&&A.onTaskDone(B)},onProgress:(B,C,E)=>{try{globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},Date.now())}catch{}A?.onProgress&&A.onProgress(B,C,E)}})'
  );

  replaceOnce(
    "Terminal input releases its owned lifecycle",
    '__codexFinish=Q=>{if(Q&&(Q.success===!1||Q.error||Q.raw?.error)){let B=Q.raw?.error||Q.error?.message||Q.stderr||"Stata execution failed";return/* codex patch v7.50: terminal input skips dataset refresh to preserve shared memory */{...Q,success:!1,rc:typeof Q.rc=="number"&&Q.rc!==0?Q.rc:-1,stderr:Q.stderr||String(B),error:{message:String(B)}}}return/* codex patch v7.50: terminal input skips dataset refresh to preserve shared memory */Q};',
    '__codexFinish=Q=>{let __codexTerminalFinal=Q;if(Q&&(Q.success===!1||Q.error||Q.raw?.error)){let B=Q.raw?.error||Q.error?.message||Q.stderr||"Stata execution failed";__codexTerminalFinal={...Q,success:!1,rc:typeof Q.rc=="number"&&Q.rc!==0?Q.rc:-1,stderr:Q.stderr||String(B),error:{message:String(B)}}}if(__codexTerminalOwnsLifecycle&&globalThis.__codexVisibleRelease)try{globalThis.__codexVisibleRelease(__codexTerminalFinal)}catch(__terminalReleaseError){try{RI("[Codex terminal-input] lifecycle release failed: "+(__terminalReleaseError?.message||__terminalReleaseError))}catch{}}return/* codex patch v7.50: terminal input skips dataset refresh to preserve shared memory *//* codex patch rc.7: Terminal input verified lifecycle release */__codexTerminalFinal};'
  );

  replaceOnce(
    "Terminal stopped-session retry failure releases lifecycle",
    'catch(B){return{success:!1,rc:-1,stderr:B?.message||String(B),error:{message:B?.message||String(B)}}}}return{success:!1,rc:-1,stderr:I?.message||String(I),error:{message:I?.message||String(I)}}}}',
    'catch(B){return __codexFinish({success:!1,rc:-1,stderr:B?.message||String(B),error:{message:B?.message||String(B)}})}}return __codexFinish({success:!1,rc:-1,stderr:I?.message||String(I),error:{message:I?.message||String(I)}})}}'
  );
}

if (!text.includes("codex patch rc.7.10.10: Terminal browse opens Data Browser")) {
  replaceOnce(
    "Terminal input classifies exact Data Browser UI commands",
    "var kM=async(g,A)=>{let __codexTerminalRecovery=",
    'var kM=async(g,A)=>{let __codexTerminalUiCommand=null;try{let __codexUiRoot=(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd(),__codexUiAdapter=require(rg.join(__codexUiRoot,"scripts","terminal_ui_command.js"));__codexTerminalUiCommand=__codexUiAdapter.classifyTerminalUiCommand(g);if(__codexTerminalUiCommand)g=__codexUiAdapter.createTerminalUiSurrogate(__codexTerminalUiCommand)||g}catch(__codexUiClassifyError){try{RI("[Codex terminal-input] UI command classification failed: "+(__codexUiClassifyError?.message||__codexUiClassifyError))}catch{}}/* codex patch rc.7.10.10: Terminal browse opens Data Browser */let __codexTerminalRecovery='
  );
  replaceOnce(
    "Terminal UI command completion waits for Data Browser data",
    "__codexFinish=Q=>{let __codexTerminalFinal=Q;",
    "__codexFinish=async Q=>{let __codexTerminalFinal=Q;"
  );
  replaceOnce(
    "Terminal UI command opens Data Browser after lifecycle release",
    'catch(__terminalReleaseError){try{RI("[Codex terminal-input] lifecycle release failed: "+(__terminalReleaseError?.message||__terminalReleaseError))}catch{}}return/* codex patch v7.50: terminal input skips dataset refresh to preserve shared memory *//* codex patch rc.7: Terminal input verified lifecycle release */__codexTerminalFinal};',
    'catch(__terminalReleaseError){try{RI("[Codex terminal-input] lifecycle release failed: "+(__terminalReleaseError?.message||__terminalReleaseError))}catch{}}if(__codexTerminalUiCommand&&!(__codexTerminalFinal&&(__codexTerminalFinal.success===false||__codexTerminalFinal.error||__codexTerminalFinal.raw?.error)))try{await iA.commands.executeCommand("stata-workbench.viewData");let __dbDeadline=Date.now()+30000,__dbStatus=globalThis.__codexDataBrowserStatus||null;while(Date.now()<__dbDeadline){__dbStatus=globalThis.__codexDataBrowserStatus||null;if(__dbStatus&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number.isFinite(Number(__dbStatus.rowCount))&&Number(__dbStatus.lastArrowBytes)>=0&&!__dbStatus.lastError)break;await new Promise(__resolve=>setTimeout(__resolve,250))}let __dbOk=!!(__dbStatus&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number.isFinite(Number(__dbStatus.rowCount))&&Number(__dbStatus.lastArrowBytes)>=0&&!__dbStatus.lastError);if(!__dbOk)throw new Error("Data Browser did not become ready within 30 seconds");__codexTerminalFinal={...__codexTerminalFinal,uiCommand:__codexTerminalUiCommand.command,dataBrowserReady:true,dataBrowser:__dbStatus}}catch(__dbError){let __dbMessage=__dbError?.message||String(__dbError);__codexTerminalFinal={...__codexTerminalFinal,success:false,rc:-1,stderr:__dbMessage,error:{message:__dbMessage},uiCommand:__codexTerminalUiCommand.command,dataBrowserReady:false,dataBrowser:globalThis.__codexDataBrowserStatus||null}}return/* codex patch v7.50: terminal input skips dataset refresh to preserve shared memory *//* codex patch rc.7: Terminal input verified lifecycle release */__codexTerminalFinal};'
  );
}

if (!text.includes("codex patch rc.7: graph inventory probes are quiet")) {
  replaceOnce(
    "quiet graph inventory describe",
    '    "    capture graph describe `__codex_graph_name\'",',
    '    "    capture quietly graph describe `__codex_graph_name\'", /* codex patch rc.7: graph inventory probes are quiet */'
  );
  replaceOnce(
    "quiet graph delta export display",
    '      exportLines.push(`  capture graph display ${entry.graphName}`);',
    '      exportLines.push(`  capture quietly graph display ${entry.graphName}`);'
  );
}

if (!text.includes("codex patch rc.7: Data Browser observable readiness")) {
  replaceOnce(
    "initialize Data Browser diagnostics",
    'constructor(A,I){this._panel=A,this._extensionUri=I,this._disposables=[],this._credentials=null,this._isWebviewReady=!1,this._panel.webview.onDidReceiveMessage(async Q=>{',
    'constructor(A,I){this._panel=A,this._extensionUri=I,this._disposables=[],this._credentials=null,this._isWebviewReady=!1;globalThis.__codexDataBrowserStatus={panelExists:true,webviewReady:false,credentialsReady:false,datasetId:null,rowCount:null,lastArrowBytes:null,lastApiPath:null,lastApiOk:null,lastError:null,openedAt:new Date().toISOString(),readyAt:null};/* codex patch rc.7: Data Browser observable readiness */this._panel.webview.onDidReceiveMessage(async Q=>{'
  );
  replaceOnce(
    "record Data Browser webview ready",
    'case"ready":g._log("[DataBrowserPanel] Webview reported ready."),this._isWebviewReady=!0,this._credentials&&(',
    'case"ready":g._log("[DataBrowserPanel] Webview reported ready."),this._isWebviewReady=!0,Object.assign(globalThis.__codexDataBrowserStatus||{},{panelExists:true,webviewReady:true,readyAt:new Date().toISOString()}),this._credentials&&('
  );
  replaceOnce(
    "record Data Browser credentials",
    'this._credentials={baseUrl:A.baseUrl,token:A.token};let I=Ut.workspace.getConfiguration("stataMcp");',
    'this._credentials={baseUrl:A.baseUrl,token:A.token};Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:true,lastError:null});let I=Ut.workspace.getConfiguration("stataMcp");'
  );
  replaceOnce(
    "record Data Browser API success",
    'let C=Q.url.endsWith("/arrow"),E=await g._performRequest(Q.url,Q.options,C),e=E instanceof Buffer?new Uint8Array(E):E;g.currentPanel===this&&this._panel.webview.postMessage({type:"apiResponse",reqId:Q.reqId,success:!0,data:e,isBinary:C})',
    'let C=Q.url.endsWith("/arrow"),E=await g._performRequest(Q.url,Q.options,C),e=E instanceof Buffer?new Uint8Array(E):E,__dbStatus=globalThis.__codexDataBrowserStatus||{};Object.assign(__dbStatus,{panelExists:true,lastApiPath:B.pathname,lastApiOk:true,lastError:null});if(B.pathname==="/v1/dataset"){let __dataset=E&&E.dataset||E||{};__dbStatus.datasetId=__dataset.id||null;__dbStatus.rowCount=Number.isFinite(__dataset.n)?__dataset.n:null}if(C)__dbStatus.lastArrowBytes=e&&Number.isFinite(e.byteLength)?e.byteLength:null;globalThis.__codexDataBrowserStatus=__dbStatus;g.currentPanel===this&&this._panel.webview.postMessage({type:"apiResponse",reqId:Q.reqId,success:!0,data:e,isBinary:C})'
  );
  replaceOnce(
    "record Data Browser API error",
    'catch(B){g._log(`[DataBrowser Proxy Error] ${B.message}`),g.currentPanel===this&&this._panel.webview.postMessage({type:"apiResponse",reqId:Q.reqId,success:!1,error:B.message})}',
    'catch(B){Object.assign(globalThis.__codexDataBrowserStatus||{},{lastApiOk:false,lastError:B.message||String(B)}),g._log(`[DataBrowser Proxy Error] ${B.message}`),g.currentPanel===this&&this._panel.webview.postMessage({type:"apiResponse",reqId:Q.reqId,success:!1,error:B.message})}'
  );
  replaceOnce(
    "status exposes Data Browser diagnostics",
    'terminalWebview:(function(){try{return globalThis.__codexTerminalWebviewStatus||{panelExists:!!Gg.currentPanel,scriptReady:!1,styleReady:!1,bundleId:(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||null,readyAt:null}}catch(e){return null}})(),graphPanel:',
    'terminalWebview:(function(){try{return globalThis.__codexTerminalWebviewStatus||{panelExists:!!Gg.currentPanel,scriptReady:!1,styleReady:!1,bundleId:(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||null,readyAt:null}}catch(e){return null}})(),dataBrowser:globalThis.__codexDataBrowserStatus||null,graphPanel:'
  );
  replaceOnce(
    "debug view data endpoint",
    'if(__req.method==="GET"&&__req.url==="/graph-status"){',
    'if(__req.method==="POST"&&__req.url==="/debug-view-data"){await iA.commands.executeCommand("stata-workbench.viewData");let __dbDeadline=Date.now()+30000,__dbStatus=globalThis.__codexDataBrowserStatus||null;while(Date.now()<__dbDeadline){__dbStatus=globalThis.__codexDataBrowserStatus||null;if(__dbStatus&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number(__dbStatus.rowCount)>0&&Number(__dbStatus.lastArrowBytes)>0)break;await new Promise(__resolve=>setTimeout(__resolve,250))}let __dbOk=!!(__dbStatus&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number(__dbStatus.rowCount)>0&&Number(__dbStatus.lastArrowBytes)>0&&!__dbStatus.lastError);__send(__res,__dbOk?200:500,{ok:__dbOk,patch:__patch,dataBrowser:__dbStatus});return}/* codex patch rc.7: debug Data Browser readiness */if(__req.method==="GET"&&__req.url==="/graph-status"){'
  );
}

if (!text.includes("codex patch rc.7: routed and loaded graph paths are distinct")) {
  replaceOnce(
    "graph status exposes loaded image path",
    'lastImageLoadedName: state.lastImageLoadedName || null,\n    lastImageError:',
    'lastImageLoadedName: state.lastImageLoadedName || null,\n    lastImageLoadedPath: state.lastImageLoadedPath || null,\n    lastImageError:'
  );
  replaceAllRequired(
    "image load events do not overwrite routed artifact path",
    'lastArtifactPath: message?.path || (globalThis.__codexGraphPanelDiag?.lastArtifactPath || null),',
    'lastImageLoadedPath: message?.path || null, /* codex patch rc.7: routed and loaded graph paths are distinct */',
    2
  );
}

if (!text.includes("codex patch rc.7: manifest cannot release execution")) {
  replaceOnce(
    "manifest cannot pre-release execution",
    'if (manifestReady && source !== "human-file" && !options?.hasDocumentOutput && !state.sawError && elapsedMs >= idleAfterMs) {',
    'if (false && manifestReady && source !== "human-file" && !options?.hasDocumentOutput && !state.sawError && elapsedMs >= idleAfterMs) { /* codex patch rc.7: manifest cannot release execution */'
  );
}

if (!text.includes("codex patch rc.7: debug selection requires lifecycle completion")) {
  replaceOnce(
    "debug selection requires lifecycle completion",
    'let __selGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,__selOk=!!(__selState&&!__selState.busy&&!__selState.postRunBusy&&__selState.trueReady);',
    'let __selGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,__selOk=!!(__selState&&!__selState.busy&&!__selState.postRunBusy&&__selState.trueReady&&__selState.phase==="completed");/* codex patch rc.7: debug selection requires lifecycle completion */'
  );
}

if (!text.includes("codex patch rc.7: debug selection refreshes and restores disk buffer")) {
  replaceOnce(
    "debug selection parses disk refresh option",
    '__selFile=__selUrl.searchParams.get("path"),__selLine=',
    '__selFile=__selUrl.searchParams.get("path"),__selDisk=/^(1|true|yes)$/i.test(String(__selUrl.searchParams.get("disk")||"")),__selLine='
  );
  replaceOnce(
    "debug selection tracks disk buffer refresh",
    'try{let __selMode="line";if(__selFile){',
    'try{let __selMode="line",__selBufferRefreshed=false;if(__selFile){'
  );
  replaceOnce(
    "debug selection refreshes active buffer from disk",
    'let __selEditor=await iA.window.showTextDocument(__selDoc,{preview:false});try{let __selStartLine=',
    'let __selEditor=await iA.window.showTextDocument(__selDoc,{preview:false});if(__selDisk)try{let __selDiskText=JA.readFileSync(__selFile,"utf8");if(__selEditor.document.getText()!==__selDiskText){let __selFullRange=new iA.Range(__selEditor.document.positionAt(0),__selEditor.document.positionAt(__selEditor.document.getText().length));await __selEditor.edit(__edit=>__edit.replace(__selFullRange,__selDiskText),{undoStopBefore:false,undoStopAfter:false});__selDoc=__selEditor.document;__selBufferRefreshed=true}}catch(__selDiskError){console.log("[Codex debug-run-selection] disk buffer refresh failed:",__selDiskError?.message||__selDiskError)}try{let __selStartLine='
  );
  replaceOnce(
    "debug selection restores clean disk buffer after handler",
    '__selReceipt.accepted===false){__reject(__res,__selReceipt.decision);return}let __selState=',
    '__selReceipt.accepted===false){__reject(__res,__selReceipt.decision);return}if(__selDisk)try{await iA.commands.executeCommand("workbench.action.files.revert")}catch(__selRevertError){console.log("[Codex debug-run-selection] disk buffer restore failed:",__selRevertError?.message||__selRevertError)}/* codex patch rc.7: debug selection refreshes and restores disk buffer */let __selState='
  );
  replaceOnce(
    "debug selection reports disk refresh diagnostics",
    'all:__selAll,selectionMode:__selMode,timeoutSec:',
    'all:__selAll,disk:__selDisk,bufferRefreshed:__selBufferRefreshed,selectionMode:__selMode,timeoutSec:'
  );
}

if (!text.includes("codex patch rc.7: huge human file applies Darwin PNG compatibility")) {
  replaceOnce(
    "huge human file applies Darwin PNG compatibility",
    'let __codexHumanFileUseSourceSelection=!!(__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileRunSourceText);let __codexHumanFileCompletionGuard=',
    'let __codexHumanFileUseSourceSelection=!!(__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileRunSourceText);if(__codexHumanFileUseSourceSelection&&process.platform==="darwin")try{let __pngRoot=(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd(),__pngScript=rg.join(__pngRoot,"scripts","mac","png_compat_transform.js"),__pngHelper=rg.join(__pngRoot,"scripts","mac","png_compat_sips.sh");if(!JA.existsSync(__pngScript)||!JA.existsSync(__pngHelper))throw new Error("PNG_COMPAT_HELPER_MISSING");let __pngResult=require(__pngScript).transformDoSource(__codexHumanFileRunSourceText,{platform:"darwin",helperScript:__pngHelper}),__pngResiduals=__pngResult.residuals||[];globalThis.__codexHumanFilePngCompat={at:new Date().toISOString(),runId:r,sourceMode:"human-file-source-selection",ok:!!__pngResult.ok,transformed:!!__pngResult.transformed,replacements:(__pngResult.replacements||[]).length,residuals:__pngResiduals.length,reason:__pngResult.reason||null,error:__pngResult.error||null};if(!__pngResult.ok||__pngResiduals.length){let __why=String(__pngResult.reason||__pngResult.error||(__pngResiduals[0]&&(__pngResiduals[0].reason||__pngResiduals[0].statement))||"unsupported").replace(/"/g," ").slice(0,180);__codexHumanFileRunSourceText="display as error \\"PNG_COMPAT_UNSUPPORTED: "+__why+"\\"\\nexit 693\\n"}else __codexHumanFileRunSourceText=__pngResult.code}catch(__pngError){let __why=String(__pngError&&__pngError.message||__pngError).replace(/"/g," ").slice(0,180);globalThis.__codexHumanFilePngCompat={at:new Date().toISOString(),runId:r,sourceMode:"human-file-source-selection",ok:false,transformed:false,replacements:0,residuals:null,error:__why};__codexHumanFileRunSourceText="display as error \\"PNG_COMPAT_TRANSFORM_EXCEPTION: "+__why+"\\"\\nexit 693\\n"}/* codex patch rc.7: huge human file applies Darwin PNG compatibility */let __codexHumanFileCompletionGuard='
  );
  replaceOnce(
    "status exposes huge human file PNG diagnostics",
    'sourceCompatibility:globalThis.__codexLastSourceCompat||null,graphPanel:',
    'sourceCompatibility:globalThis.__codexLastSourceCompat||null,pngCompatibility:globalThis.__codexHumanFilePngCompat||null,graphPanel:'
  );
}

if (!text.includes("codex patch rc.7: debug file requires lifecycle completion")) {
  replaceOnce(
    "debug file requires lifecycle completion",
    'let __debugGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null;let __debugStale=__debugGraph&&/human-file-(prelog|pre-log|hard-stall)|prelog-stale|hard-stall-reset/i.test(String(__debugGraph.lastBatchSource||"")+" "+String(__debugGraph.lastGraphExportMode||"")+" "+String(__debugGraph.readinessReason||"")+" "+String(__debugGraph.lastClientError||""));globalThis.__codexLastDebugRunFileError=__debugStale?"human-file watchdog reported stale state":null;__send(__res,__debugStale?500:200,{ok:!__debugStale,patch:__patch,ran:"stata-workbench.runFile",path:__debugFile||null,activeBefore:__debugBefore,handler:!!globalThis.__codexRunFileHandler,humanFileDebug:globalThis.__codexHumanFileDebug||null,graphPanel:__debugGraph})',
    'let __debugGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,__debugLifecycle=__codexExecution.publicLifecycle(globalThis.__codexBridgeState||{});let __debugStale=(__debugGraph&&/human-file-(prelog|pre-log|hard-stall)|prelog-stale|hard-stall-reset/i.test(String(__debugGraph.lastBatchSource||"")+" "+String(__debugGraph.lastGraphExportMode||"")+" "+String(__debugGraph.readinessReason||"")+" "+String(__debugGraph.lastClientError||"")))||__debugLifecycle.phase!=="completed";/* codex patch rc.7: debug file requires lifecycle completion */globalThis.__codexLastDebugRunFileError=__debugStale?"human-file execution did not reach verified lifecycle completion":null;__send(__res,__debugStale?500:200,{ok:!__debugStale,patch:__patch,ran:"stata-workbench.runFile",path:__debugFile||null,activeBefore:__debugBefore,handler:!!globalThis.__codexRunFileHandler,humanFileDebug:globalThis.__codexHumanFileDebug||null,lifecycle:__debugLifecycle,graphPanel:__debugGraph})'
  );
}

if (!text.includes("codex patch rc.7: graph marker is progress only")) {
  replaceOnce(
    "graph completion marker is progress only",
    'if (!state.sawGraphCompletionMarker && marker && marker.indexOf(String(runId)) >= 0) {\n          state.sawGraphCompletionMarker = true;\n          if (options?.acceptGraphCompletionMarkerAsDone !== false) state.sawEndOfDoFile = true;\n          state.sawProgress = true;\n          state.lastActivityAt = now;\n          /* codex patch v7.55: long human runs do not release on graph marker alone *//* codex patch v7.40: manual-selection watchdog accepts graph completion marker */\n        }',
    'if (!state.sawGraphCompletionMarker && marker && marker.indexOf(String(runId)) >= 0) {\n          state.sawGraphCompletionMarker = true;\n          state.sawProgress = true;\n          state.lastActivityAt = now;\n          state.lastEvidenceAt = now;\n          state.lastEvidenceType = "graph-routing-marker";\n          /* codex patch rc.7: graph marker is progress only */\n        }'
  );

  replaceOnce(
    "graph marker cannot pre-log release",
    'if (!state.sawLog && elapsedMs >= preLogStallAfterMs && (preLogStallAfterMs < healthWindowMs || state.noEvidenceWindows >= noEvidenceMaxWindows || state.staleEvidenceWindows >= noEvidenceMaxWindows) && state.sawGraphCompletionMarker && !state.sawError) {',
    'if (false && !state.sawLog && elapsedMs >= preLogStallAfterMs && (preLogStallAfterMs < healthWindowMs || state.noEvidenceWindows >= noEvidenceMaxWindows || state.staleEvidenceWindows >= noEvidenceMaxWindows) && state.sawGraphCompletionMarker && !state.sawError) { /* codex patch rc.7: graph marker cannot pre-log release */'
  );

  replaceOnce(
    "graph marker cannot hard-stall release",
    'if (elapsedMs >= hardStallAfterMs && idleMs >= hardStallIdleMs && state.sawGraphCompletionMarker && !state.sawError) {',
    'if (false && elapsedMs >= hardStallAfterMs && idleMs >= hardStallIdleMs && state.sawGraphCompletionMarker && !state.sawError) { /* codex patch rc.7: graph marker cannot hard-stall release */'
  );

  replaceOnce(
    "manual selection rejects graph-only completion",
    'acceptGraphCompletionMarkerAsDone:!!(__codexPreparedGraphRun&&__codexPreparedGraphRun.graphCommandCount>0&&!__codexManualSelectionLongRun&&!/\\bputdocx\\b|\\bputpdf\\b|\\bputexcel\\b|\\bp_tdocx\\b/i.test(I))',
    'acceptGraphCompletionMarkerAsDone:false/* codex patch rc.7: manual selection rejects graph-only completion */'
  );

  replaceOnce(
    "human file rejects graph-only completion",
    'acceptGraphCompletionMarkerAsDone:!!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.graphCommandCount>0&&!__codexHumanFileIsHugeMiDocumentRun&&!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.hasDocumentOutput))',
    'acceptGraphCompletionMarkerAsDone:false/* codex patch rc.7: human file rejects graph-only completion */'
  );
}

if (!text.includes("codex patch rc.7: graph-only release branches disabled")) {
  replaceOnce(
    "remove obsolete graph-only pre-log release claim",
    '/* codex patch v7.67: manual-selection pre-log watchdog accepts current completion marker */',
    '/* graph routing evidence is not Stata completion */ /* codex patch rc.7: graph-only release branches disabled */'
  );
  replaceOnce(
    "remove obsolete graph-only hard-stall release claim",
    '/* codex patch v7.66: manual-selection hard-stall releases cleanly when current completion marker exists */',
    '/* graph routing evidence cannot turn a hard stall into success */'
  );
}

if (!text.includes("codex patch rc.7: shared source compatibility adapter")) {
  replaceOnce(
    "load shared source compatibility adapter",
    'let __http=require("http"),__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js")),__codexExecution=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_lifecycle_core.js")),',
    'let __http=require("http"),__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js")),__codexExecution=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_lifecycle_core.js")),__codexSourceCompat=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stata_source_compat_core.js")),'
  );

  replaceOnce(
    "initialize shared source compatibility adapter",
    'globalThis.__codexExecutionAdapter=__codexExecution;__codexExecution.ensureLifecycle(globalThis.__codexBridgeState);globalThis.__codexRecoveryState=',
    'globalThis.__codexExecutionAdapter=__codexExecution;__codexExecution.ensureLifecycle(globalThis.__codexBridgeState);globalThis.__codexPrepareCompatExecution=(__source,__meta={})=>{let __original=String(__source==null?"":__source);try{let __result=__codexSourceCompat.prepareExecutionCode(__original,{platform:process.platform,cwd:__meta.cwd,sourcePath:__meta.sourcePath,workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean)});globalThis.__codexLastSourceCompat={...__result.diagnostics,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,at:new Date().toISOString()};return __result.code}catch(__compatError){globalThis.__codexLastSourceCompat={platform:process.platform,applied:false,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,error:__compatError?.message||String(__compatError),at:new Date().toISOString()};return __original}};/* codex patch rc.7: shared source compatibility adapter */globalThis.__codexRecoveryState='
  );

  replaceOnce(
    "status exposes source compatibility diagnostics",
    'dataBrowser:globalThis.__codexDataBrowserStatus||null,graphPanel:',
    'dataBrowser:globalThis.__codexDataBrowserStatus||null,sourceCompatibility:globalThis.__codexLastSourceCompat||null,graphPanel:'
  );

  replaceOnce(
    "agent code uses shared source compatibility adapter",
    'if(!__code.trim()){__send(__res,400,{ok:false,error:"empty code",patch:__patch});return}let __recoveryToken=',
    'if(!__code.trim()){__send(__res,400,{ok:false,error:"empty code",patch:__patch});return}__code=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(__code,{sourceMode:__source,runId:__runId,cwd:__cwd}):__code;/* shared compatibility: agent */let __recoveryToken='
  );

  replaceOnce(
    "manual selection uses shared source compatibility adapter",
    '}catch{}/* codex patch v7.54: huge MI/document manual selection suppresses inline helper boilerplate *//* codex patch v7.59: huge MI/document manual selection guards log close _all *//* codex patch v7.40: MI/document/large manual selections use long-run watchdog */let __codexManualSelectionWatchdog=',
    '}catch{}/* codex patch v7.54: huge MI/document manual selection suppresses inline helper boilerplate *//* codex patch v7.59: huge MI/document manual selection guards log close _all *//* codex patch v7.40: MI/document/large manual selections use long-run watchdog */__codexSelectionBody=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(__codexSelectionBody,{sourceMode:"manual-selection",runId:e,sourcePath:Q,cwd:B}):__codexSelectionBody;/* shared compatibility: manual selection */let __codexManualSelectionWatchdog='
  );

  replaceOnce(
    "manual file uses shared source compatibility adapter",
    'let __codexHumanFileRunner=__codexHumanFileUseSourceSelection?__codexHumanFileRunSourceText:((__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileTempDoFile)?__codexHumanFileTempDoFile:((__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)?__codexPreparedHumanFileRun.code:(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.code)?__codexPreparedHumanFileRun.code:__codexHumanFileOriginalDo));if(!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)){',
    'let __codexHumanFileRunner=__codexHumanFileUseSourceSelection?__codexHumanFileRunSourceText:((__codexHumanFileIsHugeMiDocumentRun&&__codexHumanFileTempDoFile)?__codexHumanFileTempDoFile:((__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)?__codexPreparedHumanFileRun.code:(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.code)?__codexPreparedHumanFileRun.code:__codexHumanFileOriginalDo));__codexHumanFileRunner=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(__codexHumanFileRunner,{sourceMode:"human-file",runId:r,sourcePath:e,cwd:C}):__codexHumanFileRunner;/* shared compatibility: manual file */if(!(__codexPreparedHumanFileRun&&__codexPreparedHumanFileRun.tempDoFile)){'
  );

  replaceOnce(
    "terminal input uses shared source compatibility adapter",
    'let I=fF(),__codexTerminalPrepared=null,__codexTerminalCode=g;',
    'let I=fF(),__codexTerminalPrepared=null,__codexTerminalCode=globalThis.__codexPrepareCompatExecution?globalThis.__codexPrepareCompatExecution(g,{sourceMode:A?.sourceMode||"terminal-input",runId:A?.runId,cwd:A?.cwd}):g;/* shared compatibility: terminal input */'
  );
}

if (!text.includes("codex patch rc.7.1: Terminal graph prep keeps source compatibility")) {
  replaceOnce(
    "Terminal graph preparation keeps compatibility-protected code",
    'if(A?.runId&&globalThis.__codexPrepareGraphRunCode&&globalThis.__codexShouldIncludeGraphs&&__codexShouldIncludeGraphs(g)){/* codex patch v7.27b: terminal input graph routing uses graph lifecycle without clearing Stata memory */__codexTerminalPrepared=__codexPrepareGraphRunCode(g,A.runId,"terminal-input",A?.cwd);__codexTerminalCode=__codexTerminalPrepared?.code||g;',
    'if(A?.runId&&globalThis.__codexPrepareGraphRunCode&&globalThis.__codexShouldIncludeGraphs&&__codexShouldIncludeGraphs(__codexTerminalCode)){/* codex patch v7.27b: terminal input graph routing uses graph lifecycle without clearing Stata memory */__codexTerminalPrepared=__codexPrepareGraphRunCode(__codexTerminalCode,A.runId,"terminal-input",A?.cwd);__codexTerminalCode=__codexTerminalPrepared?.code||__codexTerminalCode;/* codex patch rc.7.1: Terminal graph prep keeps source compatibility */'
  );
}

if (!text.includes("codex patch rc.7.2: shared Darwin graph/document compatibility")) {
  replaceOnce(
    "upgrade shared compatibility adapter with Darwin graph/document transform",
    'globalThis.__codexPrepareCompatExecution=(__source,__meta={})=>{let __original=String(__source==null?"":__source);try{let __result=__codexSourceCompat.prepareExecutionCode(__original,{platform:process.platform,cwd:__meta.cwd,sourcePath:__meta.sourcePath,workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean)});globalThis.__codexLastSourceCompat={...__result.diagnostics,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,at:new Date().toISOString()};return __result.code}catch(__compatError){globalThis.__codexLastSourceCompat={platform:process.platform,applied:false,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,error:__compatError?.message||String(__compatError),at:new Date().toISOString()};return __original}};/* codex patch rc.7: shared source compatibility adapter */',
    `globalThis.__codexPrepareCompatExecution=(__source,__meta={})=>{let __original=String(__source==null?"":__source),__needsDarwin=/\\bgraph\\s+export\\b|\\b(?:putdocx|p_tdocx)\\s+(?:image|save)\\b/i.test(__original);try{let __result=__codexSourceCompat.prepareExecutionCode(__original,{platform:process.platform,cwd:__meta.cwd,sourcePath:__meta.sourcePath,workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean)}),__prepared=__result.code;globalThis.__codexLastSourceCompat={...__result.diagnostics,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,at:new Date().toISOString()};if(process.platform==="darwin"&&__needsDarwin){let __root=(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd(),__script=rg.join(__root,"scripts","mac","png_compat_transform.js"),__pngHelper=rg.join(__root,"scripts","mac","png_compat_sips.sh"),__docxHelper=rg.join(__root,"scripts","mac","docx_image_inject.py");if(!JA.existsSync(__script)||!JA.existsSync(__pngHelper)||!JA.existsSync(__docxHelper))throw new Error("DARWIN_COMPAT_HELPER_MISSING");let __darwin=require(__script).transformDoSource(__prepared,{platform:"darwin",helperScript:__pngHelper,docxHelperScript:__docxHelper});globalThis.__codexLastDarwinCompatibility={ok:!!__darwin.ok,applied:!!__darwin.transformed,replacements:(__darwin.replacements||[]).length,documentImages:(__darwin.replacements||[]).filter(__item=>__item.kind==="document-image").length,documentSaves:(__darwin.replacements||[]).filter(__item=>__item.kind==="document-save").length,reason:__darwin.reason||__darwin.note||null,error:__darwin.error||null,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,at:new Date().toISOString()};if(!__darwin.ok){let __why=String(__darwin.reason||__darwin.error||"unsupported").replace(/"/g,"'").slice(0,180);return "display as error \\\"DARWIN_COMPAT_UNSUPPORTED: "+__why+"\\\"\\nexit 693\\n"}__prepared=__darwin.code}return __prepared}catch(__compatError){let __message=__compatError?.message||String(__compatError);globalThis.__codexLastSourceCompat={platform:process.platform,applied:false,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,error:__message,at:new Date().toISOString()};if(process.platform==="darwin"&&__needsDarwin){globalThis.__codexLastDarwinCompatibility={ok:false,applied:false,error:__message,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,at:new Date().toISOString()};return "display as error \\\"DARWIN_COMPAT_TRANSFORM_EXCEPTION: "+String(__message).replace(/"/g,"'").slice(0,180)+"\\\"\\nexit 693\\n"}return __original}};/* codex patch rc.7: shared source compatibility adapter *//* codex patch rc.7.2: shared Darwin graph/document compatibility */`
  );
  replaceOnce(
    "status exposes shared Darwin compatibility diagnostics",
    'sourceCompatibility:globalThis.__codexLastSourceCompat||null,pngCompatibility:',
    'sourceCompatibility:globalThis.__codexLastSourceCompat||null,darwinCompatibility:globalThis.__codexLastDarwinCompatibility||null,pngCompatibility:'
  );
}

if (!text.includes("codex patch rc.7.3: referenced do-files use Darwin compatibility")) {
  replaceSpanOnce(
    "shared adapter delegates referenced do-file Darwin compatibility",
    "globalThis.__codexPrepareCompatExecution=",
    "/* codex patch rc.7.2: shared Darwin graph/document compatibility */",
    `globalThis.__codexPrepareCompatExecution=(__source,__meta={})=>{let __original=String(__source==null?"":__source);try{let __root=(yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd(),__adapter=require(rg.join(__root,"scripts","darwin_compat_adapter.js")),__result=__adapter.prepareVisibleExecution(__original,{platform:process.platform,extensionRoot:__root,cwd:__meta.cwd,sourcePath:__meta.sourcePath,workspaceRoots:(iA.workspace.workspaceFolders||[]).map(__folder=>__folder?.uri?.fsPath).filter(Boolean)});globalThis.__codexLastSourceCompat={...__result.sourceDiagnostics,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,at:new Date().toISOString()};globalThis.__codexLastDarwinCompatibility={...__result.darwinDiagnostics,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,at:new Date().toISOString()};return __result.code}catch(__compatError){let __message=__compatError?.message||String(__compatError);globalThis.__codexLastSourceCompat={platform:process.platform,applied:false,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,sourcePath:__meta.sourcePath||null,cwd:__meta.cwd||null,error:__message,at:new Date().toISOString()};if(process.platform==="darwin"){globalThis.__codexLastDarwinCompatibility={ok:false,applied:true,error:__message,sourceMode:__meta.sourceMode||null,runId:__meta.runId||null,at:new Date().toISOString()};return "display as error \\"DARWIN_COMPAT_ADAPTER_EXCEPTION: "+String(__message).replace(/"/g,"'").slice(0,180)+"\\"\\nexit 693\\n"}return __original}};/* codex patch rc.7: shared source compatibility adapter *//* codex patch rc.7.2: shared Darwin graph/document compatibility *//* codex patch rc.7.3: referenced do-files use Darwin compatibility */`
  );
}

if (!text.includes("codex patch rc.7.4: lifecycle callbacks are run-scoped")) {
  replaceAllRequired(
    "watchdog completion callback is run-scoped",
    "__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState||{},Date.now())",
    "__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState||{},Date.now(),runId)"
  );
  replaceAllRequired(
    "watchdog log callback is run-scoped",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},logPath,Date.now())",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},logPath,Date.now(),runId)"
  );
  replaceAllRequired(
    "watchdog progress callback is run-scoped",
    "__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},state.lastActivityAt)",
    "__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},state.lastActivityAt,runId)"
  );
  replaceAllRequired(
    "watchdog discovered log is run-scoped",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState,freshLog,now)",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState,freshLog,now,runId)"
  );
  replaceAllRequired(
    "Terminal started callback is run-scoped",
    "__codexExecutionAdapter.recordStarted(globalThis.__codexBridgeState||{},Date.now())",
    "__codexExecutionAdapter.recordStarted(globalThis.__codexBridgeState||{},Date.now(),A?.runId)"
  );
  replaceAllRequired(
    "Terminal progress callbacks are run-scoped",
    "__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},Date.now())",
    "__codexExecutionAdapter.recordProgress(globalThis.__codexBridgeState||{},Date.now(),A?.runId)",
    2
  );
  replaceAllRequired(
    "Terminal task-done callback is run-scoped",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},B.logPath,Date.now())",
    "__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState||{},B.logPath,Date.now(),A?.runId)"
  );
  replaceOnce(
    "run-scoped lifecycle callback marker",
    "globalThis.__codexCreateManualSelectionWatchdog = __codexCreateManualSelectionWatchdog;",
    "globalThis.__codexCreateManualSelectionWatchdog = __codexCreateManualSelectionWatchdog;/* codex patch rc.7.4: lifecycle callbacks are run-scoped */"
  );
}

if (!text.includes("codex patch rc.7: mcp-stata Data Browser listener-loop patch")) {
  replaceOnce(
    "apply mcp-stata Data Browser listener-loop patch before connect",
    'let E=zg.getServerConfig({hostOnly:!0});if(AP(E)?',
    'let E=zg.getServerConfig({hostOnly:!0});try{let __runtimePatcher=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","mcp_stata_runtime_patch.js")),__runtimePatch=__runtimePatcher.patchRuntime({command:E&&E.command});RI("[mcp-stata runtime] Data Browser listener-loop patch: "+JSON.stringify(__runtimePatch))}catch(__runtimePatchError){RI("[mcp-stata runtime] Data Browser listener-loop patch failed: "+(__runtimePatchError?.message||String(__runtimePatchError)))}/* codex patch rc.7: mcp-stata Data Browser listener-loop patch */if(AP(E)?'
  );
}

if (!text.includes("codex patch rc.7.8: manual command diagnostics")) {
  replaceOnce(
    "status exposes manual command diagnostics",
    "dataBrowser:globalThis.__codexDataBrowserStatus||null,sourceCompatibility:",
    "dataBrowser:globalThis.__codexDataBrowserStatus||null,manualCommand:globalThis.__codexManualCommandDebug||null,sourceCompatibility:"
  );
  replaceOnce(
    "manual selection records command entry",
    "async function OHg(){return GB.startSpan",
    'async function OHg(){globalThis.__codexManualCommandDebug={command:"runSelection",stage:"entered",at:new Date().toISOString()};return GB.startSpan'
  );
  replaceOnce(
    "manual selection records editor state",
    "async()=>{let g=iA.window.activeTextEditor;try{",
    'async()=>{let g=iA.window.activeTextEditor;globalThis.__codexManualCommandDebug={command:"runSelection",stage:"editor",at:new Date().toISOString(),path:g?.document?.uri?.fsPath||null,hasEditor:!!g};try{'
  );
  replaceOnce(
    "manual selection records selected text",
    "let A=g.selection,I=A.isEmpty?g.document.lineAt(A.active.line).text:g.document.getText(A);if(!I.trim())",
    'let A=g.selection,I=A.isEmpty?g.document.lineAt(A.active.line).text:g.document.getText(A);globalThis.__codexManualCommandDebug={command:"runSelection",stage:"selection",at:new Date().toISOString(),path:g.document.uri.fsPath||null,isEmpty:A.isEmpty,activeLine:A.active.line+1,chars:I.length,trimmedChars:I.trim().length};if(!I.trim())'
  );
  replaceOnce(
    "manual selection records empty selection",
    'if(!I.trim()){iA.window.showErrorMessage("No text selected or current line is empty");return}',
    'if(!I.trim()){globalThis.__codexManualCommandDebug={...globalThis.__codexManualCommandDebug,stage:"empty-selection",at:new Date().toISOString()};iA.window.showErrorMessage("No text selected or current line is empty");return}'
  );
  replaceOnce(
    "manual selection records acquire attempt",
    'if(globalThis.__codexVisibleAcquire&&!globalThis.__codexVisibleAcquire({runId:__codexHumanRunId,label:"Running selection",source:"human-selection",codePreview:I.slice(0,300),kind:"normal"})){',
    'globalThis.__codexManualCommandDebug={...globalThis.__codexManualCommandDebug,stage:"acquiring",at:new Date().toISOString(),requestId:__codexHumanRunId};if(globalThis.__codexVisibleAcquire&&!globalThis.__codexVisibleAcquire({runId:__codexHumanRunId,label:"Running selection",source:"human-selection",codePreview:I.slice(0,300),kind:"normal"})){'
  );
  replaceOnce(
    "manual selection records acquire rejection",
    'let __decision=globalThis.__codexLastAcquireDecision||{kind:"busy",reason:"bridge busy"};iA.window.showWarningMessage(',
    'let __decision=globalThis.__codexLastAcquireDecision||{kind:"busy",reason:"bridge busy"};globalThis.__codexManualCommandDebug={...globalThis.__codexManualCommandDebug,stage:"rejected",at:new Date().toISOString(),decision:__decision};iA.window.showWarningMessage('
  );
  replaceOnce(
    "manual selection records acquire success",
    'return{accepted:false,runId:__codexHumanRunId,decision:__decision}}try{await IP("Running selection",',
    'return{accepted:false,runId:__codexHumanRunId,decision:__decision}}globalThis.__codexManualCommandDebug={...globalThis.__codexManualCommandDebug,stage:"acquired",at:new Date().toISOString()};/* codex patch rc.7.8: manual command diagnostics */try{await IP("Running selection",'
  );
}

if (!text.includes("codex patch rc.7.9: force-reset generation fences stale handlers")) {
  replaceOnce(
    "force reset increments the handler generation before cancellation",
    "globalThis.__codexForceReset=async o=>{let s=globalThis.__codexBridgeState||{};",
    "globalThis.__codexForceReset=async o=>{globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __codexThisResetGeneration=globalThis.__codexResetGeneration;let s=globalThis.__codexBridgeState||{};/* codex patch rc.7.9: force-reset generation fences stale handlers */"
  );
  replaceOnce(
    "human Run File captures its reset generation",
    "try{globalThis.__codexHumanFileDebug={stage:\"before-IP\",at:new Date().toISOString(),path:A,runId:__codexHumanFileRunId};",
    "let __codexHumanFileResetGeneration=Number(globalThis.__codexResetGeneration||0);try{globalThis.__codexHumanFileDebug={stage:\"before-IP\",at:new Date().toISOString(),path:A,runId:__codexHumanFileRunId,resetGeneration:__codexHumanFileResetGeneration};"
  );
  replaceOnce(
    "cancelled human Run File stops before post-run Stata work",
    "let a=__codexHumanFileWatchdog?await __codexHumanFileWatchdog.guard(__codexHumanFilePromise):await __codexHumanFilePromise;if(__codexHumanFileCompletionGuard)",
    "let a=__codexHumanFileWatchdog?await __codexHumanFileWatchdog.guard(__codexHumanFilePromise):await __codexHumanFilePromise;if(Number(globalThis.__codexResetGeneration||0)!==__codexHumanFileResetGeneration){let __codexResetError=new Error(\"human-file cancelled by force reset generation \"+String(globalThis.__codexResetGeneration||0));__codexResetError.code=\"CODEX_FORCE_RESET_CANCELLED\";throw __codexResetError}if(__codexHumanFileCompletionGuard)"
  );
  replaceOnce(
    "stale human Run File catch cannot mutate graph readiness",
    "catch(a){try{let __codexHumanFileErrorText=String(a?.message||a);",
    "catch(a){let __codexHumanFileResetStale=Number(globalThis.__codexResetGeneration||0)!==__codexHumanFileResetGeneration;if(!__codexHumanFileResetStale)try{let __codexHumanFileErrorText=String(a?.message||a);"
  );
  replaceOnce(
    "stale human Run File finally cannot release a newer lifecycle",
    "finally{globalThis.__codexVisibleRelease&&globalThis.__codexVisibleRelease();if(t&&JA.existsSync(t))",
    "finally{if(Number(globalThis.__codexResetGeneration||0)===__codexHumanFileResetGeneration)globalThis.__codexVisibleRelease&&globalThis.__codexVisibleRelease();if(t&&JA.existsSync(t))"
  );
  replaceOnce(
    "status exposes reset generation",
    "backendOwnerId:globalThis.__codexBackendOwnerId||null,ownedBackendPids:",
    "backendOwnerId:globalThis.__codexBackendOwnerId||null,resetGeneration:Number(globalThis.__codexResetGeneration||0),ownedBackendPids:"
  );
}

if (!text.includes("codex patch rc.7.9.1: force-reset finalizes cancelled lifecycle")) {
  replaceOnce(
    "force reset finalizes the cancelled lifecycle before exposing readiness",
    "let __codexForceResetWasBusy=!!s.busy;if(process.platform===\"win32\"&&__codexForceResetWasBusy",
    "let __codexForceResetWasBusy=!!s.busy;if(__codexForceResetWasBusy)try{let __codexCancelledLife=__codexExecution.ensureLifecycle(s);__codexExecution.finishRun(s,{logPath:__codexCancelledLife.logPath||s.logPath||null,completionMarkerVerified:false,error:new Error(\"execution cancelled by force reset: \"+String(o||\"unknown\"))})}catch(__codexCancelLifecycleError){try{RI(\"[Codex bridge] force reset lifecycle finalization failed: \"+(__codexCancelLifecycleError?.message||__codexCancelLifecycleError))}catch{}}/* codex patch rc.7.9.1: force-reset finalizes cancelled lifecycle */if(process.platform===\"win32\"&&__codexForceResetWasBusy"
  );
}

if (!text.includes("codex patch rc.7.10: soft Stop preserves the pre-run dataset")) {
  replaceOnce(
    "soft Stop owns a pre-run snapshot registry",
    "globalThis.__codexVisibleState=__current;let __codexAdoptExecutionRunId=",
    "globalThis.__codexVisibleState=__current;globalThis.__codexPreRunSnapshots=globalThis.__codexPreRunSnapshots instanceof Map?globalThis.__codexPreRunSnapshots:new Map;let __codexAdoptExecutionRunId="
  );
  replaceOnce(
    "soft Stop preserves the pre-run dataset without disposing the backend",
    "globalThis.__codexAdoptExecutionRunId=__codexAdoptExecutionRunId;/* codex patch rc.7: shared execution lifecycle */globalThis.__codexForceReset=",
    `globalThis.__codexAdoptExecutionRunId=__codexAdoptExecutionRunId;/* codex patch rc.7: shared execution lifecycle */globalThis.__codexSoftStop=async __reason=>{let __s=globalThis.__codexBridgeState||{},__life=__codexExecution.ensureLifecycle(__s),__runId=__life.runId||__s.runId||null,__snapshot=(globalThis.__codexPreRunSnapshots||new Map).get(__runId)||null,__cancelled=false,__drained=false,__restore=null;globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __generation=globalThis.__codexResetGeneration;try{__s.postRunBusy=true;__s.lastPostRunBusyReason="soft-stop-cancelling";if(__s.busy)__codexExecution.finishRun(__s,{logPath:__life.logPath||__s.logPath||null,completionMarkerVerified:false,error:new Error("execution cancelled by soft Stop: "+String(__reason||"user"))});try{__cancelled=!!(await zg.cancelRun(__runId))}catch{}if(!__cancelled)try{__cancelled=!!(await zg.cancelAll())}catch{}let __deadline=Date.now()+15000;while(Date.now()<__deadline&&(zg._active||Number(zg._pending||0)>0))await new Promise(__resolve=>setTimeout(__resolve,50));__drained=!(zg._active||Number(zg._pending||0)>0);if(!__drained){globalThis.__codexLastSoftStop={at:new Date().toISOString(),runId:__runId,generation:__generation,ok:false,cancelled:__cancelled,drained:false,restored:false,reason:"transport did not drain"};return globalThis.__codexForceReset?await globalThis.__codexForceReset("soft-stop escalation: transport did not drain"):globalThis.__codexLastSoftStop}await new Promise(__resolve=>setTimeout(__resolve,250));if(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)){let __restoreCode="use \\\""+__codexStataString(__snapshot.path)+"\\\", clear\\n";try{let __result=await zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:"soft-stop-restore-"+String(__runId||Date.now())});__restore={ok:!(__result?.success===false||__result?.error)&&Number(__result?.rc||0)===0,path:__snapshot.path,bytes:__snapshot.bytes||null,rc:__result?.rc,logPath:__result?.logPath||null}}catch(__restoreError){__restore={ok:false,path:__snapshot.path,error:__restoreError?.message||String(__restoreError)}}}else __restore={ok:true,skipped:"no pre-run dataset snapshot"};try{if(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path))JA.unlinkSync(__snapshot.path)}catch{}try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId)}catch{}__s.busy=false;__s.postRunBusy=false;__s.lastHeartbeatAt=Date.now();__s.lastPostRunBusyReason="soft-stop-complete";try{Gg._postMessage({type:"busy",value:false})}catch{}try{globalThis.__codexGraphMark&&__codexGraphMark({readinessState:__restore&&__restore.ok===false?"stale":"ready",readinessReason:__restore&&__restore.ok===false?"soft-stop dataset restore failed":"soft-stop-complete",readinessRunId:__runId,readinessUpdatedAt:new Date().toISOString(),lastClientError:__restore&&__restore.ok===false?String(__restore.error||"dataset restore failed"):null})}catch{}globalThis.__codexLastSoftStop={at:new Date().toISOString(),runId:__runId,generation:__generation,ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,drained:__drained,restored:!!(__restore&&__restore.path&&__restore.ok),restore:__restore,reason:String(__reason||"user")};return globalThis.__codexLastSoftStop}catch(__softStopError){globalThis.__codexLastSoftStop={at:new Date().toISOString(),runId:__runId,generation:__generation,ok:false,cancelled:__cancelled,drained:__drained,restored:false,error:__softStopError?.message||String(__softStopError),reason:String(__reason||"user")};return globalThis.__codexForceReset?await globalThis.__codexForceReset("soft-stop escalation: "+globalThis.__codexLastSoftStop.error):globalThis.__codexLastSoftStop}};/* codex patch rc.7.10: soft Stop preserves the pre-run dataset */globalThis.__codexForceReset=`
  );
  replaceOnce(
    "status exposes soft Stop rollback diagnostics",
    "resetGeneration:Number(globalThis.__codexResetGeneration||0),ownedBackendPids:",
    "resetGeneration:Number(globalThis.__codexResetGeneration||0),lastSoftStop:globalThis.__codexLastSoftStop||null,ownedBackendPids:"
  );
  replaceOnce(
    "human Run File captures the pre-run dataset snapshot",
    "if(r&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(r,\"human-file\",C,!__codexPreparedHumanFileRun||!!__codexPreparedHumanFileRun.captureBaseline);try{let __codexHumanFileOriginalDo=",
    `if(r&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(r,"human-file",C,!__codexPreparedHumanFileRun||!!__codexPreparedHumanFileRun.captureBaseline);let __codexHumanFilePreRunSnapshot=null;try{let __os=require("node:os"),__path=require("node:path"),__snapshotPath=__path.join(__os.tmpdir(),"codex_prerun_state_"+String(r||Date.now()).replace(/[^A-Za-z0-9_.-]/g,"_")+".dta"),__snapshotCode="capture preserve\\ncapture quietly save \\\""+__codexStataString(__snapshotPath)+"\\\", replace\\ncapture restore\\n";await zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:C,runId:"pre-run-snapshot-"+String(r||Date.now())});if(JA.existsSync(__snapshotPath)){let __stat=JA.statSync(__snapshotPath);if(__stat.size>=512){__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:__stat.size,runId:r,at:new Date().toISOString()};globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot)}else JA.unlinkSync(__snapshotPath)}}catch(__snapshotError){try{RI("[Codex human-file] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}/* codex patch rc.7.10: pre-run dataset snapshot for soft Stop */try{let __codexHumanFileOriginalDo=`
  );
  replaceOnce(
    "normal human Run File removes its rollback snapshot",
    "/* codex patch v7.28c: human-file graph/document completion defers dataset summary refresh to preserve live Stata memory */}catch(a){",
    "/* codex patch v7.28c: human-file graph/document completion defers dataset summary refresh to preserve live Stata memory */try{if(__codexHumanFilePreRunSnapshot&&JA.existsSync(__codexHumanFilePreRunSnapshot.path))JA.unlinkSync(__codexHumanFilePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(r)}catch{}/* codex patch rc.7.10: normal completion removes pre-run snapshot */}catch(a){"
  );
  replaceSpanOnce(
    "Terminal Stop uses soft cancellation instead of hard reset",
    'async function yM(){console.log("[Extension] cancelRequest force-reset called");',
    "async function OF",
    'async function yM(){console.log("[Extension] cancelRequest soft-stop called");try{let g=globalThis.__codexSoftStop?await globalThis.__codexSoftStop("terminal Stop button"):null;g||await zg.cancelAll()||console.log("[Extension] No running Stata requests to cancel."),iA.window.showWarningMessage(g&&g.ok===false?"Stata Workbench Stop required hard recovery; inspect /status before continuing.":"Stata Workbench stopped the current request and restored the pre-run dataset when available.")}catch(g){console.error("[Extension] Soft Stop failed:",g),iA.window.showErrorMessage("Failed to stop Stata Workbench request: "+g.message)}}async function OF'
  );
}

if (!text.includes("codex patch rc.7.10.1: soft Stop always requests bounded break_session")) {
  replaceOnce(
    "soft Stop always requests a bounded Stata break after cancelling the exact run",
    "try{__cancelled=!!(await zg.cancelRun(__runId))}catch{}if(!__cancelled)try{__cancelled=!!(await zg.cancelAll())}catch{}let __deadline=Date.now()+15000;",
    "let __specificCancelled=false,__breakResult=null;try{__specificCancelled=!!(await zg.cancelRun(__runId))}catch{}try{__breakResult=await Promise.race([Promise.resolve(zg.cancelAll()).then(__value=>({settled:true,value:!!__value}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))])}catch(__breakError){__breakResult={settled:true,error:__breakError?.message||String(__breakError)}}__cancelled=!!(__specificCancelled||__breakResult?.value);/* codex patch rc.7.10.1: soft Stop always requests bounded break_session */let __deadline=Date.now()+15000;"
  );
  replaceOnce(
    "soft Stop drain failure exposes break_session diagnostics",
    "ok:false,cancelled:__cancelled,drained:false,restored:false,reason:\"transport did not drain\"",
    "ok:false,cancelled:__cancelled,breakSession:__breakResult,drained:false,restored:false,reason:\"transport did not drain\""
  );
  replaceOnce(
    "successful soft Stop exposes break_session diagnostics",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,drained:__drained,restored:",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,breakSession:__breakResult,drained:__drained,restored:"
  );
  replaceOnce(
    "failed soft Stop exposes break_session diagnostics",
    "ok:false,cancelled:__cancelled,drained:__drained,restored:false,error:",
    "ok:false,cancelled:__cancelled,breakSession:__breakResult,drained:__drained,restored:false,error:"
  );
}

if (!text.includes("codex patch rc.7.10.2: soft Stop cancels the server background task")) {
  replaceOnce(
    "soft Stop cancels the actual mcp-stata background task before client polling",
    "let __specificCancelled=false,__breakResult=null;try{__specificCancelled=!!(await zg.cancelRun(__runId))}catch{}try{__breakResult=await Promise.race([Promise.resolve(zg.cancelAll()).then(__value=>({settled:true,value:!!__value}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))])}catch(__breakError){__breakResult={settled:true,error:__breakError?.message||String(__breakError)}}__cancelled=!!(__specificCancelled||__breakResult?.value);/* codex patch rc.7.10.1: soft Stop always requests bounded break_session */let __deadline=Date.now()+15000;",
    "let __taskId=zg._activeRun?.taskId||null,__taskCancel=null,__specificCancelled=false,__breakResult=null;if(__taskId)try{__taskCancel=await Promise.race([(async()=>{let __client=await zg._ensureClient(),__reply=await zg._callTool(__client,\"cancel_task\",{task_id:String(__taskId)}),__raw=\"\";try{__raw=zg._extractText?zg._extractText(__reply):String(__reply??\"\")}catch{}return{settled:true,requested:true,taskId:String(__taskId),raw:String(__raw||\"\").slice(0,500)}})(),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true,taskId:String(__taskId)}),5000))])}catch(__taskCancelError){__taskCancel={settled:true,requested:false,taskId:String(__taskId),error:__taskCancelError?.message||String(__taskCancelError)}}try{__specificCancelled=!!(await zg.cancelRun(__runId))}catch{}try{__breakResult=await Promise.race([Promise.resolve(zg.cancelAll()).then(__value=>({settled:true,value:!!__value}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))])}catch(__breakError){__breakResult={settled:true,error:__breakError?.message||String(__breakError)}}__cancelled=!!(__taskCancel?.requested||__specificCancelled||__breakResult?.value);/* codex patch rc.7.10.1: soft Stop always requests bounded break_session *//* codex patch rc.7.10.2: soft Stop cancels the server background task */let __deadline=Date.now()+15000;"
  );
  replaceOnce(
    "soft Stop bounds the first dataset restore attempt",
    "let __result=await zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:\"soft-stop-restore-\"+String(__runId||Date.now())});__restore={ok:!(__result?.success===false||__result?.error)&&Number(__result?.rc||0)===0,path:__snapshot.path,bytes:__snapshot.bytes||null,rc:__result?.rc,logPath:__result?.logPath||null}",
    "let __restoreAttempt=await Promise.race([Promise.resolve(zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:\"soft-stop-restore-\"+String(__runId||Date.now())})).then(__result=>({settled:true,result:__result}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),15000))]);if(!__restoreAttempt.settled)throw new Error(\"soft-stop dataset restore timed out after 15000ms\");if(__restoreAttempt.error)throw new Error(__restoreAttempt.error);let __result=__restoreAttempt.result;__restore={ok:!(__result?.success===false||__result?.error)&&Number(__result?.rc||0)===0,path:__snapshot.path,bytes:__snapshot.bytes||null,rc:__result?.rc,logPath:__result?.logPath||null}"
  );
  replaceOnce(
    "soft Stop success exposes server task cancellation diagnostics",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,breakSession:__breakResult,drained:__drained,restored:",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,drained:__drained,restored:"
  );
  replaceOnce(
    "soft Stop failure exposes server task cancellation diagnostics",
    "ok:false,cancelled:__cancelled,breakSession:__breakResult,drained:__drained,restored:false,error:__softStopError",
    "ok:false,cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,drained:__drained,restored:false,error:__softStopError"
  );
}

if (!text.includes("codex patch rc.7.10.3: soft Stop hard fallback restores the dataset")) {
  replaceOnce(
    "soft Stop tracks bounded hard fallback state",
    "let __taskId=zg._activeRun?.taskId||null,__taskCancel=null,__specificCancelled=false,__breakResult=null;",
    "let __taskId=zg._activeRun?.taskId||null,__taskCancel=null,__specificCancelled=false,__breakResult=null,__hardEscalated=false,__hardReset=null;"
  );
  replaceOnce(
    "soft Stop shortens the optimistic restore window before owned-backend fallback",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),15000))]);if(!__restoreAttempt.settled)throw new Error(\"soft-stop dataset restore timed out after 15000ms\");",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))]);if(!__restoreAttempt.settled)throw new Error(\"soft-stop dataset restore timed out after 5000ms\");"
  );
  replaceOnce(
    "soft Stop restores the snapshot after an owned-backend hard fallback",
    "catch(__restoreError){__restore={ok:false,path:__snapshot.path,error:__restoreError?.message||String(__restoreError)}}}else __restore={ok:true,skipped:\"no pre-run dataset snapshot\"};",
    "catch(__restoreError){let __initialRestoreError=__restoreError?.message||String(__restoreError);__restore={ok:false,path:__snapshot.path,error:__initialRestoreError};try{if(!globalThis.__codexForceReset)throw new Error(\"hard reset unavailable\");__hardEscalated=true;let __hardState=await globalThis.__codexForceReset(\"soft-stop escalation: dataset restore unavailable\");__hardReset={ok:!!__hardState?.ok,trueReady:!!__hardState?.trueReady,notReadyReason:__hardState?.notReadyReason||null,cleanup:__hardState?.cleanup||null};let __retryAttempt=await Promise.race([Promise.resolve(zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:\"soft-stop-hard-restore-\"+String(__runId||Date.now())})).then(__result=>({settled:true,result:__result}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),30000))]);if(!__retryAttempt.settled)throw new Error(\"hard-fallback dataset restore timed out after 30000ms\");if(__retryAttempt.error)throw new Error(__retryAttempt.error);let __retryResult=__retryAttempt.result;__restore={ok:!(__retryResult?.success===false||__retryResult?.error)&&Number(__retryResult?.rc||0)===0,path:__snapshot.path,bytes:__snapshot.bytes||null,rc:__retryResult?.rc,logPath:__retryResult?.logPath||null,escalated:true,initialError:__initialRestoreError}}catch(__hardRestoreError){__restore={ok:false,path:__snapshot.path,escalated:true,initialError:__initialRestoreError,error:__hardRestoreError?.message||String(__hardRestoreError)}}}}else __restore={ok:true,skipped:\"no pre-run dataset snapshot\"};/* codex patch rc.7.10.3: soft Stop hard fallback restores the dataset */"
  );
  replaceOnce(
    "successful soft Stop exposes hard fallback diagnostics",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,drained:__drained,restored:",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,hardEscalated:__hardEscalated,hardReset:__hardReset,finalGeneration:Number(globalThis.__codexResetGeneration||0),drained:__drained,restored:"
  );
  replaceOnce(
    "failed soft Stop exposes hard fallback diagnostics",
    "ok:false,cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,drained:__drained,restored:false,error:__softStopError",
    "ok:false,cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,hardEscalated:__hardEscalated,hardReset:__hardReset,finalGeneration:Number(globalThis.__codexResetGeneration||0),drained:__drained,restored:false,error:__softStopError"
  );
}

if (!text.includes("codex patch rc.7.10.4: snapshotless Stop proves backend quiescence")) {
  replaceOnce(
    "snapshotless soft Stop probes the backend before exposing READY",
    "}}else __restore={ok:true,skipped:\"no pre-run dataset snapshot\"};/* codex patch rc.7.10.3: soft Stop hard fallback restores the dataset */",
    "}}else{let __quiescenceCode=\"display as text \\\"___CODEX_SOFT_STOP_QUIESCENT_\"+String(__runId||Date.now()).replace(/[^A-Za-z0-9_.-]/g,\"_\")+\"___\\\"\\n\";try{let __quiescenceAttempt=await Promise.race([Promise.resolve(zg.runSelection(__quiescenceCode,{normalizeResult:!0,includeGraphs:!1,runId:\"soft-stop-quiescence-\"+String(__runId||Date.now())})).then(__result=>({settled:true,result:__result}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))]);if(!__quiescenceAttempt.settled)throw new Error(\"snapshotless soft-stop quiescence probe timed out after 5000ms\");if(__quiescenceAttempt.error)throw new Error(__quiescenceAttempt.error);let __quiescenceResult=__quiescenceAttempt.result;if(__quiescenceResult?.success===false||__quiescenceResult?.error||Number(__quiescenceResult?.rc||0)!==0)throw new Error(__quiescenceResult?.error?.message||__quiescenceResult?.error||\"snapshotless soft-stop quiescence probe failed\");__restore={ok:true,skipped:\"no pre-run dataset snapshot\",quiescenceProbe:{ok:true,rc:__quiescenceResult?.rc,logPath:__quiescenceResult?.logPath||null}}}catch(__quiescenceError){let __initialQuiescenceError=__quiescenceError?.message||String(__quiescenceError);try{if(!globalThis.__codexForceReset)throw new Error(\"hard reset unavailable\");__hardEscalated=true;let __hardState=await globalThis.__codexForceReset(\"soft-stop escalation: snapshotless backend not quiescent\");__hardReset={ok:!!__hardState?.ok,trueReady:!!__hardState?.trueReady,notReadyReason:__hardState?.notReadyReason||null,cleanup:__hardState?.cleanup||null};__restore={ok:!!(__hardState?.ok&&__hardState?.trueReady),skipped:\"no pre-run dataset snapshot\",escalated:true,initialError:__initialQuiescenceError}}catch(__hardQuiescenceError){__restore={ok:false,skipped:\"no pre-run dataset snapshot\",escalated:true,initialError:__initialQuiescenceError,error:__hardQuiescenceError?.message||String(__hardQuiescenceError)}}}}/* codex patch rc.7.10.3: soft Stop hard fallback restores the dataset *//* codex patch rc.7.10.4: snapshotless Stop proves backend quiescence */"
  );
}

if (!text.includes("codex patch rc.7.10.5: hard fallback reconnects before restore")) {
  replaceOnce(
    "soft Stop reconnects the owned transport before hard-fallback dataset restore",
    "__hardReset={ok:!!__hardState?.ok,trueReady:!!__hardState?.trueReady,notReadyReason:__hardState?.notReadyReason||null,cleanup:__hardState?.cleanup||null};let __retryAttempt=await Promise.race([Promise.resolve(zg.runSelection(__restoreCode",
    "__hardReset={ok:!!__hardState?.ok,trueReady:!!__hardState?.trueReady,notReadyReason:__hardState?.notReadyReason||null,cleanup:__hardState?.cleanup||null};let __reconnectAttempt=await Promise.race([Promise.resolve(zg.connect()).then(()=>({settled:true}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),10000))]);if(!__reconnectAttempt.settled)throw new Error(\"hard-fallback reconnect timed out after 10000ms\");if(__reconnectAttempt.error)throw new Error(__reconnectAttempt.error);let __retryAttempt=await Promise.race([Promise.resolve(zg.runSelection(__restoreCode"
  );
  replaceOnce(
    "successful hard-fallback restore exposes reconnect diagnostics",
    "logPath:__retryResult?.logPath||null,escalated:true,initialError:__initialRestoreError}",
    "logPath:__retryResult?.logPath||null,escalated:true,reconnect:__reconnectAttempt,initialError:__initialRestoreError}"
  );
  replaceOnce(
    "hard-fallback reconnect marker",
    "/* codex patch rc.7.10.4: snapshotless Stop proves backend quiescence */",
    "/* codex patch rc.7.10.4: snapshotless Stop proves backend quiescence *//* codex patch rc.7.10.5: hard fallback reconnects before restore */"
  );
}

if (!text.includes("codex patch rc.7.10.6: stale reconnect gets one owned retry")) {
  replaceOnce(
    "soft Stop retries one owned reset when reconnect retained a stale client",
    "if(!__retryAttempt.settled)throw new Error(\"hard-fallback dataset restore timed out after 30000ms\");if(__retryAttempt.error)throw new Error(__retryAttempt.error);let __retryResult=__retryAttempt.result;",
    "if(!__retryAttempt.settled)throw new Error(\"hard-fallback dataset restore timed out after 30000ms\");if(__retryAttempt.error){let __firstRetryError=__retryAttempt.error;let __secondHardState=await globalThis.__codexForceReset(\"soft-stop escalation: stale reconnect retry after \"+String(__firstRetryError));__hardReset.retry={ok:!!__secondHardState?.ok,trueReady:!!__secondHardState?.trueReady,notReadyReason:__secondHardState?.notReadyReason||null,cleanup:__secondHardState?.cleanup||null};__reconnectAttempt=await Promise.race([Promise.resolve(zg.connect()).then(()=>({settled:true}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),10000))]);if(!__reconnectAttempt.settled)throw new Error(\"stale-reconnect retry timed out after 10000ms\");if(__reconnectAttempt.error)throw new Error(__reconnectAttempt.error);__retryAttempt=await Promise.race([Promise.resolve(zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:\"soft-stop-hard-restore-retry-\"+String(__runId||Date.now())})).then(__result=>({settled:true,result:__result}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),30000))]);if(!__retryAttempt.settled)throw new Error(\"stale-reconnect dataset restore retry timed out after 30000ms\");if(__retryAttempt.error)throw new Error(__retryAttempt.error)}let __retryResult=__retryAttempt.result;"
  );
  replaceOnce(
    "stale reconnect owned retry marker",
    "/* codex patch rc.7.10.5: hard fallback reconnects before restore */",
    "/* codex patch rc.7.10.5: hard fallback reconnects before restore *//* codex patch rc.7.10.6: stale reconnect gets one owned retry */"
  );
}

if (!text.includes("codex patch rc.7.10.7: bounded cancellation latency")) {
  replaceOnce(
    "soft Stop limits the exact server-task cancellation opportunity to 2500ms",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true,taskId:String(__taskId)}),5000))])",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true,taskId:String(__taskId)}),2500))])"
  );
  replaceOnce(
    "soft Stop limits the break_session opportunity to 2500ms",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))])}catch(__breakError)",
    "new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),2500))])}catch(__breakError)"
  );
  replaceOnce(
    "bounded cancellation latency marker",
    "/* codex patch rc.7.10.5: hard fallback reconnects before restore *//* codex patch rc.7.10.6: stale reconnect gets one owned retry */",
    "/* codex patch rc.7.10.5: hard fallback reconnects before restore *//* codex patch rc.7.10.6: stale reconnect gets one owned retry *//* codex patch rc.7.10.7: bounded cancellation latency */"
  );
}

if (!text.includes("codex patch rc.7.10.11: Data Browser channel recovery")) {
  replaceOnce(
    "existing Data Browser panels reacquire their UI channel",
    "if(g.currentPanel){let B=g.currentPanel._panel.viewColumn||Ut.ViewColumn.Beside;g.currentPanel._panel.reveal(B);return}",
    "if(g.currentPanel){let B=g.currentPanel._panel.viewColumn||Ut.ViewColumn.Beside;g.currentPanel._panel.reveal(B);await g.currentPanel._fetchCredentials();return}/* codex patch rc.7.10.11: Data Browser channel recovery */"
  );
  replaceOnce(
    "initialize bounded Data Browser recovery state",
    "this._panel=A,this._extensionUri=I,this._disposables=[],this._credentials=null,this._isWebviewReady=!1;globalThis.__codexDataBrowserStatus=",
    "this._panel=A,this._extensionUri=I,this._disposables=[],this._credentials=null,this._isWebviewReady=!1,this._credentialRecoveryAttempts=0,this._credentialRefreshes=0;globalThis.__codexDataBrowserStatus="
  );
  replaceOnce(
    "record Data Browser channel diagnostics",
    "openedAt:new Date().toISOString(),readyAt:null};",
    "openedAt:new Date().toISOString(),readyAt:null,baseUrl:null,credentialRefreshes:0,recoveryAttempts:0,recoveryMaxAttempts:2,refreshStartedAt:null,lastRecoveredAt:null};"
  );
  replaceOnce(
    "reset Data Browser recovery after dataset success",
    "if(B.pathname===\"/v1/dataset\"){let __dataset=E&&E.dataset||E||{};__dbStatus.datasetId=__dataset.id||null;__dbStatus.rowCount=Number.isFinite(__dataset.n)?__dataset.n:null}",
    "if(B.pathname===\"/v1/dataset\"){let __dataset=E&&E.dataset||E||{};__dbStatus.datasetId=__dataset.id||null;__dbStatus.rowCount=Number.isFinite(__dataset.n)?__dataset.n:null;if(__dbStatus.rowCount===0)__dbStatus.lastArrowBytes=0;this._credentialRecoveryAttempts=0;__dbStatus.recoveryAttempts=0;__dbStatus.lastRecoveredAt=new Date().toISOString()}"
  );
  replaceOnce(
    "retry recoverable Data Browser dataset failures",
    "catch(B){Object.assign(globalThis.__codexDataBrowserStatus||{},{lastApiOk:false,lastError:B.message||String(B)}),g._log(`[DataBrowser Proxy Error] ${B.message}`),g.currentPanel===this&&this._panel.webview.postMessage({type:\"apiResponse\",reqId:Q.reqId,success:!1,error:B.message})}break",
    "catch(B){let __dbRequestPath=null;try{__dbRequestPath=new URL(Q.url).pathname}catch{}let __dbRecoverable=__dbRequestPath===\"/v1/dataset\"&&this._credentialRecoveryAttempts<2;if(__dbRecoverable){this._credentialRecoveryAttempts+=1;Object.assign(globalThis.__codexDataBrowserStatus||{},{lastApiPath:__dbRequestPath,lastApiOk:false,lastError:B.message||String(B),recoveryAttempts:this._credentialRecoveryAttempts,recoveryMaxAttempts:2});g._log(`[DataBrowser Proxy] Recovering dataset channel after attempt ${this._credentialRecoveryAttempts}/2: ${B.message}`);await this._fetchCredentials();break}Object.assign(globalThis.__codexDataBrowserStatus||{},{lastApiPath:__dbRequestPath,lastApiOk:false,lastError:B.message||String(B),recoveryAttempts:this._credentialRecoveryAttempts,recoveryMaxAttempts:2}),g._log(`[DataBrowser Proxy Error] ${B.message}`),g.currentPanel===this&&this._panel.webview.postMessage({type:\"apiResponse\",reqId:Q.reqId,success:!1,error:B.message})}break"
  );
  replaceOnce(
    "refresh or reinitialize Data Browser after credential acquisition",
    "if(A&&A.baseUrl&&A.token){this._credentials={baseUrl:A.baseUrl,token:A.token};Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:true,lastError:null});let I=Ut.workspace.getConfiguration(\"stataMcp\");this._config={variableLimit:I.get(\"defaultVariableLimit\",0)},g._log(\"[DataBrowserPanel] Credentials fetched.\"),this._isWebviewReady?(g._log(\"[DataBrowserPanel] Webview already ready, sending init.\"),this._panel.webview.postMessage({type:\"init\",...this._credentials,config:this._config})):g._log(\"[DataBrowserPanel] Waiting for webview ready signal...\")}",
    "if(A&&A.baseUrl&&A.token){let __sameCredentials=!!(this._credentials&&this._credentials.baseUrl===A.baseUrl&&this._credentials.token===A.token);this._credentials={baseUrl:A.baseUrl,token:A.token};this._credentialRefreshes+=1;Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:true,datasetId:null,rowCount:null,lastArrowBytes:null,lastApiPath:null,lastApiOk:null,lastError:null,baseUrl:A.baseUrl,credentialRefreshes:this._credentialRefreshes,recoveryAttempts:this._credentialRecoveryAttempts,recoveryMaxAttempts:2,refreshStartedAt:new Date().toISOString()});let I=Ut.workspace.getConfiguration(\"stataMcp\");this._config={variableLimit:I.get(\"defaultVariableLimit\",0)},g._log(`[DataBrowserPanel] Credentials fetched; sending ${__sameCredentials?\"refresh\":\"init\"}.`),this._isWebviewReady?this._panel.webview.postMessage(__sameCredentials?{type:\"refresh\"}:{type:\"init\",...this._credentials,config:this._config}):g._log(\"[DataBrowserPanel] Waiting for webview ready signal...\");return{ok:true,baseUrl:A.baseUrl,sameCredentials:__sameCredentials}}"
  );
}

if (!text.includes("codex patch rc.7.10.12: exact Data Browser readiness")) {
  replaceAllRequired(
    "Data Browser readiness requires a non-null row count",
    "Number.isFinite(Number(__dbStatus.rowCount))",
    "__dbStatus.rowCount!==null&&__dbStatus.rowCount!==undefined&&Number.isFinite(Number(__dbStatus.rowCount))",
    2
  );
  replaceAllRequired(
    "Data Browser readiness requires a completed Arrow response",
    "Number(__dbStatus.lastArrowBytes)>=0",
    "__dbStatus.lastArrowBytes!==null&&__dbStatus.lastArrowBytes!==undefined&&Number.isFinite(Number(__dbStatus.lastArrowBytes))&&Number(__dbStatus.lastArrowBytes)>=0",
    2
  );
  replaceOnce(
    "exact Data Browser readiness marker",
    "/* codex patch rc.7.10.11: Data Browser channel recovery */",
    "/* codex patch rc.7.10.11: Data Browser channel recovery *//* codex patch rc.7.10.12: exact Data Browser readiness */"
  );
}

if (!text.includes("codex patch rc.7.10.13: fresh Data Browser command completion")) {
  replaceOnce(
    "View Data command awaits Data Browser creation or refresh",
    "async function PHg(){return GB.startSpan({name:\"extension.viewData\",op:\"extension.operation\"},async()=>{GD.createOrShow(Qn)})}",
    "async function PHg(){return GB.startSpan({name:\"extension.viewData\",op:\"extension.operation\"},async()=>{return await GD.createOrShow(Qn)})}/* codex patch rc.7.10.13: fresh Data Browser command completion */"
  );
  replaceOnce(
    "Terminal Data Browser command captures its refresh generation",
    "try{await iA.commands.executeCommand(\"stata-workbench.viewData\");let __dbDeadline=Date.now()+30000,__dbStatus=globalThis.__codexDataBrowserStatus||null;",
    "try{let __dbRefreshBefore=Number(globalThis.__codexDataBrowserStatus?.credentialRefreshes||0);await iA.commands.executeCommand(\"stata-workbench.viewData\");let __dbDeadline=Date.now()+30000,__dbStatus=globalThis.__codexDataBrowserStatus||null;"
  );
  replaceAllRequired(
    "Terminal Data Browser command requires a fresh credential generation",
    "__dbStatus&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&__dbStatus.rowCount!==null",
    "__dbStatus&&Number(__dbStatus.credentialRefreshes||0)>__dbRefreshBefore&&__dbStatus.webviewReady&&__dbStatus.credentialsReady&&__dbStatus.rowCount!==null",
    2
  );
}

if (!text.includes("codex patch rc.7.10.14: Data Browser variable integrity")) {
  replaceOnce(
    "initialize Data Browser variable diagnostics",
    "globalThis.__codexDataBrowserStatus={panelExists:true,webviewReady:false,credentialsReady:false,datasetId:null,rowCount:null,lastArrowBytes:null,lastApiPath:null",
    "globalThis.__codexDataBrowserStatus={panelExists:true,webviewReady:false,credentialsReady:false,datasetId:null,datasetK:null,rowCount:null,variableCount:null,variableNames:null,selectedVariableCount:null,selectedVariables:null,lastArrowBytes:null,lastApiPath:null"
  );
  replaceOnce(
    "record Data Browser dataset width",
    "__dbStatus.datasetId=__dataset.id||null;__dbStatus.rowCount=Number.isFinite(__dataset.n)?__dataset.n:null;if(__dbStatus.rowCount===0)",
    "__dbStatus.datasetId=__dataset.id||null;__dbStatus.datasetK=Number.isFinite(__dataset.k)?__dataset.k:null;__dbStatus.rowCount=Number.isFinite(__dataset.n)?__dataset.n:null;if(__dbStatus.rowCount===0)"
  );
  replaceOnce(
    "record Data Browser variables and Arrow selection",
    "if(C)__dbStatus.lastArrowBytes=e&&Number.isFinite(e.byteLength)?e.byteLength:null;",
    "if(B.pathname===\"/v1/vars\"){let __variables=Array.isArray(E?.variables)?E.variables:Array.isArray(E?.vars)?E.vars:[];__dbStatus.variableCount=__variables.length;__dbStatus.variableNames=__variables.map(__variable=>__variable&&__variable.name).filter(Boolean).slice(0,25)}if(C){let __arrowRequest=null;try{__arrowRequest=JSON.parse(Q.options?.body||\"{}\")}catch{}let __selectedVars=Array.isArray(__arrowRequest?.vars)?__arrowRequest.vars:[];__dbStatus.selectedVariableCount=__selectedVars.length;__dbStatus.selectedVariables=__selectedVars.slice(0,25);__dbStatus.lastArrowBytes=e&&Number.isFinite(e.byteLength)?e.byteLength:null}"
  );
  replaceOnce(
    "reset Data Browser variable diagnostics on credential refresh",
    "Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:true,datasetId:null,rowCount:null,lastArrowBytes:null,lastApiPath:null",
    "Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:true,datasetId:null,datasetK:null,rowCount:null,variableCount:null,variableNames:null,selectedVariableCount:null,selectedVariables:null,lastArrowBytes:null,lastApiPath:null"
  );
  replaceAllRequired(
    "Terminal Data Browser readiness requires real variables for nonempty datasets",
    "__dbStatus.webviewReady&&__dbStatus.credentialsReady&&__dbStatus.rowCount!==null",
    "__dbStatus.webviewReady&&__dbStatus.credentialsReady&&__dbStatus.datasetK!==null&&__dbStatus.datasetK!==undefined&&Number.isFinite(Number(__dbStatus.datasetK))&&(Number(__dbStatus.datasetK)===0||(Number(__dbStatus.variableCount)>0&&Number(__dbStatus.selectedVariableCount)>0))&&__dbStatus.rowCount!==null",
    2
  );
  replaceAllRequired(
    "debug Data Browser readiness requires real variables",
    "__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number(__dbStatus.rowCount)>0",
    "__dbStatus.webviewReady&&__dbStatus.credentialsReady&&Number(__dbStatus.datasetK)>0&&Number(__dbStatus.variableCount)>0&&Number(__dbStatus.selectedVariableCount)>0&&Number(__dbStatus.rowCount)>0",
    2
  );
  replaceOnce(
    "Data Browser variable integrity marker",
    "/* codex patch rc.7.10.13: fresh Data Browser command completion */",
    "/* codex patch rc.7.10.13: fresh Data Browser command completion *//* codex patch rc.7.10.14: Data Browser variable integrity */"
  );
}

if (!text.includes("codex patch rc.7.10.15: force reset reconnects before READY")) {
  replaceOnce(
    "MCP client disposal detaches a closed transport before awaiting shutdown",
    'async dispose(){if(this._transport&&typeof this._transport.close=="function")try{await this._transport.close()}catch{}this._clientPromise=null}',
    'async dispose(){let __transport=this._transport;this._clientPromise=null;this._transport=null;this._availableTools=new Set;/* codex patch rc.7.10.15: atomic MCP client disposal */if(__transport&&typeof __transport.close=="function")try{await __transport.close()}catch{}}'
  );
  replaceOnce(
    "force reset reconnects the MCP backend before exposing READY",
    'if(__cleanup&&__cleanup.ok===true)for(let __pid of __owned)(globalThis.__codexOwnedBackendPids||new Map).delete(__pid)}catch(e){__cleanup={ok:false,mode:"owned-pids",error:e?.message||String(e)}}/* codex patch rc.6.4: cleanup only backend PIDs owned by this extension host */s.postRunBusy=false;try{let __needsSmoke=__codexRecoveryWasRequired||!!(typeof __codexHadContinuityLost!=="undefined"&&__codexHadContinuityLost)||/pre-log|hard-stall|panic-kill|error transport reset|continuity/i.test(String(o||""));let __smokeReason=__needsSmoke?(!!(typeof __codexHadContinuityLost!=="undefined"&&__codexHadContinuityLost)?"force-reset-needs-smoke: continuity-lost":("force-reset-needs-smoke: "+(o||"unknown"))):"force-reset-complete";',
    'if(__cleanup&&__cleanup.ok===true)for(let __pid of __owned)(globalThis.__codexOwnedBackendPids||new Map).delete(__pid)}catch(e){__cleanup={ok:false,mode:"owned-pids",error:e?.message||String(e)}}/* codex patch rc.6.4: cleanup only backend PIDs owned by this extension host */let __reconnectStartedAt=Date.now(),__reconnect=await Promise.race([Promise.resolve(zg.connect()).then(()=>({ok:true,settled:true}),__error=>({ok:false,settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({ok:false,settled:false,timeout:true,error:"force-reset backend reconnect timed out after 10000ms"}),10000))]);__reconnect.durationMs=Date.now()-__reconnectStartedAt;globalThis.__codexLastForceResetReconnect={...__reconnect,at:new Date().toISOString(),generation:__codexThisResetGeneration,reason:String(o||"force-reset")};s.postRunBusy=false;try{let __needsSmoke=__codexRecoveryWasRequired||!__reconnect.ok||!!(typeof __codexHadContinuityLost!=="undefined"&&__codexHadContinuityLost)||/pre-log|hard-stall|panic-kill|error transport reset|continuity/i.test(String(o||""));let __smokeReason=__needsSmoke?(!!(typeof __codexHadContinuityLost!=="undefined"&&__codexHadContinuityLost)?"force-reset-needs-smoke: continuity-lost":(!__reconnect.ok?("force-reset-needs-smoke: backend reconnect failed: "+String(__reconnect.error||"unknown")):("force-reset-needs-smoke: "+(o||"unknown")))):"force-reset-complete";/* codex patch rc.7.10.15: force reset reconnects before READY */'
  );
  replaceOnce(
    "status exposes force-reset backend reconnect proof",
    'resetGeneration:Number(globalThis.__codexResetGeneration||0),lastSoftStop:globalThis.__codexLastSoftStop||null,ownedBackendPids:',
    'resetGeneration:Number(globalThis.__codexResetGeneration||0),lastSoftStop:globalThis.__codexLastSoftStop||null,lastForceResetReconnect:globalThis.__codexLastForceResetReconnect||null,ownedBackendPids:'
  );
}

if (!text.includes("codex patch rc.7.10.16: shared adapter disables Stata pagination")) {
  replaceOnce(
    "shared execution adapter records the noninteractive pagination invariant",
    "/* codex patch rc.7.2: shared Darwin graph/document compatibility */",
    "/* codex patch rc.7.2: shared Darwin graph/document compatibility *//* codex patch rc.7.10.16: shared adapter disables Stata pagination */"
  );
}

if (!text.includes("codex patch rc.7.10.17: bounded MCP log notifications")) {
  replaceOnce(
    "runtime patch records bounded MCP log notification support",
    "/* codex patch rc.7: mcp-stata Data Browser listener-loop patch */",
    "/* codex patch rc.7: mcp-stata Data Browser listener-loop patch *//* codex patch rc.7.10.17: bounded MCP log notifications */"
  );
}

if (!text.includes("codex patch rc.7.10.18: timeout-bounded MCP log notifications")) {
  replaceOnce(
    "runtime patch records timeout-bounded MCP log notification support",
    "/* codex patch rc.7.10.17: bounded MCP log notifications */",
    "/* codex patch rc.7.10.17: bounded MCP log notifications *//* codex patch rc.7.10.18: timeout-bounded MCP log notifications */"
  );
}

if (!text.includes("codex patch rc.7.10.27: patch live uvx runtime")) {
  replaceOnce(
    "runtime patch resolves the live pinned uvx environment",
    "__runtimePatcher.patchRuntime({command:E&&E.command})",
    "__runtimePatcher.patchRuntime({uvCommand:JI,command:E&&E.command})"
  );
  replaceOnce(
    "live uvx runtime patch marker",
    "/* codex patch rc.7.10.18: timeout-bounded MCP log notifications */",
    "/* codex patch rc.7.10.18: timeout-bounded MCP log notifications *//* codex patch rc.7.10.27: patch live uvx runtime */"
  );
}

if (!text.includes("codex patch rc.7.10.29: internal graph probes are quiet")) {
  replaceOnce(
    "quiet current graph snapshot probe",
    '    "  capture graph describe",',
    '    "  capture quietly graph describe", /* codex patch rc.7.10.29: internal graph probes are quiet */'
  );
  replaceAllRequired(
    "quiet double-quoted graph inventory probes",
    '    "  capture graph dir, memory",',
    '    "  capture quietly graph dir, memory",',
    2
  );
  replaceOnce(
    "quiet single-quoted graph inventory probe",
    "    '  capture graph dir, memory',",
    "    '  capture quietly graph dir, memory',"
  );
  replaceAllRequired(
    "quiet retained graph display probes",
    '    "    capture graph display `__codex_graph_name\'",',
    '    "    capture quietly graph display `__codex_graph_name\'",',
    2
  );
  replaceOnce(
    "quiet named graph activation probe",
    '      else out.push(match[1] + "capture graph display " + graphName, line);',
    '      else out.push(match[1] + "capture quietly graph display " + graphName, line);'
  );
  replaceAllRequired(
    "quiet retained graph export probes",
    '    "    capture graph export \\"`__codex_graph_export\'\\", as(svg) replace",',
    '    "    capture quietly graph export \\"`__codex_graph_export\'\\", as(svg) replace",',
    3
  );
  replaceOnce(
    "quiet graph delta export probe",
    '      exportLines.push(`  capture graph export "${exportPath}", as(svg) replace`);',
    '      exportLines.push(`  capture quietly graph export "${exportPath}", as(svg) replace`);'
  );
}

if (!text.includes("codex patch rc.7.10.31: bridge retries transient EADDRINUSE")) {
  replaceOnce(
    "load bridge rebind core",
    '__codexManualPolicy=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","manual_run_policy.js")),__port=',
    '__codexManualPolicy=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","manual_run_policy.js")),__codexBridgeRebind=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","bridge_rebind_core.js")),__port='
  );
  replaceOnce(
    "status exposes bridge bind retries",
    'bridgePort:(function(){try{return globalThis.__codexBridgePort||null}catch(e){return null}})(),terminalWebview:',
    'bridgePort:(function(){try{return globalThis.__codexBridgePort||null}catch(e){return null}})(),bridgeBind:globalThis.__codexBridgeBindState||null,terminalWebview:'
  );
  replaceOnce(
    "retry transient bridge port ownership races",
    'try{globalThis.__codexBridgePort=__port;}catch{}__srv.on("error",function(__e){try{RI("[Codex bridge] listen error on "+__port+": "+(__e&&__e.message||__e));}catch{}try{iA.window.showErrorMessage("Stata bridge port "+__port+" failed: "+(__e&&__e.message||__e)+" (set stataMcp.visibleBridgePort)");}catch{}});__srv.listen(__port,"127.0.0.1",()=>{try{globalThis.__codexBridgePort=__port;}catch{}RI(`Codex visible bridge listening on 127.0.0.1:${__port}`);});',
    'let __codexBridgeBinder=__codexBridgeRebind.createBridgeBinder({server:__srv,port:__port,host:"127.0.0.1",onState:__state=>{globalThis.__codexBridgeBindState=__state},onRetry:({delayMs,state:__state})=>{try{RI("[Codex bridge] port "+__port+" busy; retry "+__state.retriesScheduled+" after "+delayMs+"ms")}catch{}},onBound:__state=>{try{globalThis.__codexBridgePort=__port;}catch{}RI(`Codex visible bridge listening on 127.0.0.1:${__port} after ${__state.attempts} attempt(s)`);},onTerminalError:__e=>{try{RI("[Codex bridge] listen error on "+__port+": "+(__e&&__e.message||__e));}catch{}try{iA.window.showErrorMessage("Stata bridge port "+__port+" failed: "+(__e&&__e.message||__e)+" (set stataMcp.visibleBridgePort)");}catch{}}});globalThis.__codexBridgeBinder=__codexBridgeBinder;__codexBridgeBinder.start();/* codex patch rc.7.10.31: bridge retries transient EADDRINUSE */'
  );
  replaceOnce(
    "dispose bridge bind retry timer",
    'g.subscriptions.push({dispose:()=>{try{__srv.close()}catch{}}})',
    'g.subscriptions.push({dispose:()=>{try{__codexBridgeBinder&&__codexBridgeBinder.dispose()}catch{}try{__srv.close()}catch{}}})'
  );
}

if (!text.includes("codex patch rc.7.10.33: every visible entry point preserves the live transport log")) {
  replaceOnce(
    "mark shared transport-log protection wiring",
    "/* codex patch rc.7.3: referenced do-files use Darwin compatibility */",
    "/* codex patch rc.7.3: referenced do-files use Darwin compatibility *//* codex patch rc.7.10.33: every visible entry point preserves the live transport log */"
  );
}

if (!text.includes("codex patch rc.7.10.34: shared bridge exposes soft Stop")) {
  replaceOnce(
    "shared bridge exposes the existing soft Stop lifecycle",
    'if(__req.method==="POST"&&__req.url==="/force-reset"){/* codex patch v5: force reset endpoint */',
    'if(__req.method==="POST"&&__req.url==="/soft-stop"){let __before=__current();if(!__before.busy){__send(__res,409,{ok:false,softStop:false,error:"no active Stata Workbench request",patch:__patch,state:__before});return}let __soft=globalThis.__codexSoftStop?await globalThis.__codexSoftStop("http /soft-stop"):null,__last=globalThis.__codexLastSoftStop||__soft,__state=__current(),__ok=!!(__last&&__last.ok===true&&!__state.busy&&!__state.postRunBusy&&__state.trueReady);__send(__res,__ok?200:500,{ok:__ok,softStop:true,patch:__patch,result:__soft,lastSoftStop:__last,state:__state});return}/* codex patch rc.7.10.34: shared bridge exposes soft Stop */if(__req.method==="POST"&&__req.url==="/force-reset"){/* codex patch v5: force reset endpoint */'
  );
}

if (!text.includes("codex patch rc.7.10.35: structural long bridge watchdog")) {
  replaceOnce(
    "classify structurally long visible bridge runs",
    'let __codexBridgeHasDocumentOutput=/\\bputdocx\\b|\\bputpdf\\b|\\bputexcel\\b|\\bp_tdocx\\b/i.test(__codexBridgeDocScanText);/* codex patch v7.22a: visible bridge scans embedded do-file content for document-output suppression */',
    'let __codexBridgeHasDocumentOutput=/\\bputdocx\\b|\\bputpdf\\b|\\bputexcel\\b|\\bp_tdocx\\b/i.test(__codexBridgeDocScanText),__codexBridgeLongRun=!!(globalThis.__codexManualRunPolicy&&globalThis.__codexManualRunPolicy.isLongManualSelection(__codexBridgeDocScanText));/* codex patch v7.22a: visible bridge scans embedded do-file content for document-output suppression *//* codex patch rc.7.10.35: structural long bridge watchdog */'
  );
  replaceOnce(
    "extend visible bridge watchdog only for structurally long runs",
    'hardStallAfterMs:600000,hardStallIdleMs:60000,hasDocumentOutput:__codexBridgeHasDocumentOutput',
    'preLogStallAfterMs:(__codexBridgeLongRun?300000:120000),hardStallAfterMs:(__codexBridgeLongRun?14400000:600000),hardStallIdleMs:(__codexBridgeLongRun?1800000:60000),hasDocumentOutput:__codexBridgeHasDocumentOutput'
  );
}

if (!text.includes("codex patch rc.7.10.36: visible bridge snapshots pre-run dataset")) {
  replaceOnce(
    "visible bridge captures the pre-run dataset before Agent execution",
    'if(__run&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(__run,"visible-bridge",__cwd,!!(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.captureBaseline));try{let __codexBridgePromise=',
    'if(__run&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(__run,"visible-bridge",__cwd,!!(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.captureBaseline));let __codexBridgePreRunSnapshot=null;try{let __os=require("node:os"),__path=require("node:path"),__snapshotPath=__path.join(__os.tmpdir(),"codex_prerun_agent_state_"+String(__run||Date.now()).replace(/[^A-Za-z0-9_.-]/g,"_")+".dta"),__snapshotCode="capture preserve\\ncapture quietly save \\\""+__codexStataString(__snapshotPath)+"\\\", replace\\ncapture restore\\n";await zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:__cwd,runId:"pre-run-snapshot-"+String(__run||Date.now())});if(JA.existsSync(__snapshotPath)){let __stat=JA.statSync(__snapshotPath);if(__stat.size>=512){__codexBridgePreRunSnapshot={path:__snapshotPath,bytes:__stat.size,runId:__run,sourceMode:"visible-bridge",at:new Date().toISOString()};globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot)}else JA.unlinkSync(__snapshotPath)}}catch(__snapshotError){try{RI("[Codex bridge] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}/* codex patch rc.7.10.36: visible bridge snapshots pre-run dataset */try{let __codexBridgePromise='
  );
  replaceOnce(
    "normal visible bridge completion removes its rollback snapshot",
    'try{qF()}catch(__codexQfError){try{RI("[Codex bridge] post-run refresh ignored after visible bridge run: "+(__codexQfError?.message||__codexQfError))}catch{}}__release(__r);',
    'try{qF()}catch(__codexQfError){try{RI("[Codex bridge] post-run refresh ignored after visible bridge run: "+(__codexQfError?.message||__codexQfError))}catch{}}try{if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run)}catch{}/* codex patch rc.7.10.36: normal visible bridge completion removes pre-run snapshot */__release(__r);'
  );
  replaceOnce(
    "failed visible bridge completion removes its rollback snapshot",
    '}catch(e){try{globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(__run,"visible-bridge-error-release"):',
    '}catch(e){try{if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run)}catch{}/* codex patch rc.7.10.36: failed visible bridge removes pre-run snapshot */try{globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(__run,"visible-bridge-error-release"):'
  );
}

if (!text.includes("codex patch rc.7.10.37: Stop resolves the active Agent snapshot")) {
  replaceOnce(
    "soft Stop resolves the active snapshot by canonical string run id",
    '__runId=__life.runId||__s.runId||null,__snapshot=(globalThis.__codexPreRunSnapshots||new Map).get(__runId)||null,__cancelled=',
    '__runId=__life.runId||__s.runId||null,__snapshotRegistry=globalThis.__codexPreRunSnapshots||new Map,__activeSnapshot=globalThis.__codexActivePreRunSnapshot||null,__snapshot=__snapshotRegistry.get(__runId)||__snapshotRegistry.get(String(__runId||""))||(__activeSnapshot&&String(__activeSnapshot.runId)===String(__runId)?__activeSnapshot:null),__cancelled='
  );
  replaceOnce(
    "visible Agent bridge registers an observable canonical active snapshot",
    'globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot)}else JA.unlinkSync(__snapshotPath)',
    'globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot);globalThis.__codexPreRunSnapshots.set(String(__run),__codexBridgePreRunSnapshot);globalThis.__codexActivePreRunSnapshot=__codexBridgePreRunSnapshot}else JA.unlinkSync(__snapshotPath)/* codex patch rc.7.10.37: Stop resolves the active Agent snapshot */'
  );
  replaceOnce(
    "status exposes active pre-run snapshot ownership",
    'lastSoftStop:globalThis.__codexLastSoftStop||null,lastForceResetReconnect:',
    'lastSoftStop:globalThis.__codexLastSoftStop||null,preRunSnapshot:(()=>{let __snap=globalThis.__codexActivePreRunSnapshot||null;return __snap?{runId:String(__snap.runId),sourceMode:__snap.sourceMode||null,path:__snap.path||null,bytes:__snap.bytes||null,at:__snap.at||null,exists:!!(__snap.path&&JA.existsSync(__snap.path))}:null})(),lastForceResetReconnect:'
  );
  replaceOnce(
    "soft Stop clears the canonical active snapshot",
    'try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId)}catch{}__s.busy=false;',
    'try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId);(globalThis.__codexPreRunSnapshots||new Map).delete(String(__runId||""));if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(__runId))globalThis.__codexActivePreRunSnapshot=null}catch{}__s.busy=false;'
  );
  replaceOnce(
    "normal Agent completion clears canonical active snapshot ownership",
    'globalThis.__codexPreRunSnapshots.delete(__run)}catch{}/* codex patch rc.7.10.36: normal visible bridge completion removes pre-run snapshot */',
    'globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(__run))globalThis.__codexActivePreRunSnapshot=null}catch{}/* codex patch rc.7.10.36: normal visible bridge completion removes pre-run snapshot */'
  );
  replaceOnce(
    "failed Agent completion clears canonical active snapshot ownership",
    'globalThis.__codexPreRunSnapshots.delete(__run)}catch{}/* codex patch rc.7.10.36: failed visible bridge removes pre-run snapshot */',
    'globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(__run))globalThis.__codexActivePreRunSnapshot=null}catch{}/* codex patch rc.7.10.36: failed visible bridge removes pre-run snapshot */'
  );
}

if (!text.includes("codex patch rc.7.10.38: Stop owns Agent snapshot cleanup")) {
  replaceOnce(
    "soft Stop claims cleanup ownership before cancelling the Agent run",
    'let __generation=globalThis.__codexResetGeneration;try{__s.postRunBusy=true;',
    'let __generation=globalThis.__codexResetGeneration;if(__snapshot)__snapshot.stopOwned=true;/* codex patch rc.7.10.38: Stop owns Agent snapshot cleanup */try{__s.postRunBusy=true;'
  );
  replaceOnce(
    "cancelled Agent handler cannot delete a Stop-owned snapshot",
    'try{if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(__run))globalThis.__codexActivePreRunSnapshot=null}catch{}/* codex patch rc.7.10.36: failed visible bridge removes pre-run snapshot */',
    'try{if(!(__codexBridgePreRunSnapshot&&__codexBridgePreRunSnapshot.stopOwned)){if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(__run))globalThis.__codexActivePreRunSnapshot=null}}catch{}/* codex patch rc.7.10.38: cancelled Agent preserves Stop-owned snapshot *//* codex patch rc.7.10.36: failed visible bridge removes pre-run snapshot */'
  );
  replaceOnce(
    "status exposes snapshot cleanup ownership",
    'bytes:__snap.bytes||null,at:__snap.at||null,exists:',
    'bytes:__snap.bytes||null,at:__snap.at||null,stopOwned:!!__snap.stopOwned,exists:'
  );
}

if (!text.includes("codex patch rc.7.10.39: server task drain before snapshot restore")) {
  replaceOnce(
    "soft Stop keeps server-drain diagnostics in outer scope",
    '__snapshot=__snapshotRegistry.get(__runId)||__snapshotRegistry.get(String(__runId||""))||(__activeSnapshot&&String(__activeSnapshot.runId)===String(__runId)?__activeSnapshot:null),__cancelled=false,__drained=false,__restore=null;',
    '__snapshot=__snapshotRegistry.get(__runId)||__snapshotRegistry.get(String(__runId||""))||(__activeSnapshot&&String(__activeSnapshot.runId)===String(__runId)?__activeSnapshot:null),__cancelled=false,__drained=false,__restore=null,__taskDrain=null;'
  );
  replaceOnce(
    "soft Stop waits for the MCP server task to reach a terminal state",
    '/* codex patch rc.7.10.2: soft Stop cancels the server background task */let __deadline=Date.now()+15000;',
    '/* codex patch rc.7.10.2: soft Stop cancels the server background task */__taskDrain={taskId:__taskId?String(__taskId):null,observed:false,terminal:false,status:null,polls:0,error:null,raw:null};if(__taskId)try{let __drainClient=await zg._ensureClient(),__taskDeadline=Date.now()+15000;while(Date.now()<__taskDeadline){__taskDrain.polls+=1;let __statusAttempt=await Promise.race([Promise.resolve(zg._callTool(__drainClient,"get_task_status",{task_id:String(__taskId)})).then(__value=>({settled:true,value:__value}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),1500))]);if(!__statusAttempt.settled){__taskDrain.error="get_task_status timed out";await new Promise(__resolve=>setTimeout(__resolve,100));continue}if(__statusAttempt.error){__taskDrain.error=__statusAttempt.error;break}let __raw="",__parsed=null;try{__raw=zg._extractText?zg._extractText(__statusAttempt.value):String(__statusAttempt.value??"")}catch{__raw=String(__statusAttempt.value??"")}try{__parsed=zg._tryParseJson?zg._tryParseJson(__raw):JSON.parse(__raw)}catch{}let __status=String(__parsed?.status||__parsed?.state||"").toLowerCase();__taskDrain.observed=true;__taskDrain.status=__status||null;__taskDrain.raw=String(__raw||"").slice(0,500);if(["done","completed","finished","error","failed","cancelled","canceled"].includes(__status)){__taskDrain.terminal=true;__taskDrain.error=null;break}await new Promise(__resolve=>setTimeout(__resolve,100))}}catch(__taskDrainError){__taskDrain.error=__taskDrainError?.message||String(__taskDrainError)}/* codex patch rc.7.10.39: server task drain before snapshot restore */let __deadline=Date.now()+15000;'
  );
  replaceOnce(
    "successful soft Stop exposes server-drain diagnostics",
    'ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,hardEscalated:',
    'ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:__taskCancel,taskDrain:__taskDrain,breakSession:__breakResult,hardEscalated:'
  );
  replaceOnce(
    "failed soft Stop exposes server-drain diagnostics",
    'ok:false,cancelled:__cancelled,taskCancel:__taskCancel,breakSession:__breakResult,hardEscalated:',
    'ok:false,cancelled:__cancelled,taskCancel:__taskCancel,taskDrain:__taskDrain,breakSession:__breakResult,hardEscalated:'
  );
}

if (!text.includes("codex patch rc.7.10.40: cancelled task_done drains before restore")) {
  replaceOnce(
    "cancelled runs still retain their authoritative task_done notification",
    'o&&o._cancelled)return;let s=C?.path||C?.log_path||C?.logPath;',
    'o&&o._cancelled&&e!=="task_done")return;/* codex patch rc.7.10.40: cancelled task_done drains before restore */let s=C?.path||C?.log_path||C?.logPath;'
  );
  replaceSpanOnce(
    "soft Stop waits on the tracked task_done notification",
    '__taskDrain={taskId:__taskId?String(__taskId):null,observed:false,terminal:false,status:null,polls:0,error:null,raw:null};if(__taskId)try{let __drainClient=',
    '/* codex patch rc.7.10.39: server task drain before snapshot restore */',
    '__taskDrain={taskId:__taskId?String(__taskId):null,observed:false,terminal:false,status:null,polls:0,error:null,raw:null};if(__taskId)try{let __taskDeadline=Date.now()+15000;while(Date.now()<__taskDeadline){__taskDrain.polls+=1;let __trackedRun=zg._runsByTaskId instanceof Map?zg._runsByTaskId.get(String(__taskId)):null;if(!__trackedRun&&zg._activeRun&&String(zg._activeRun.taskId||"")===String(__taskId))__trackedRun=zg._activeRun;let __payload=__trackedRun?._taskDonePayload||null;if(__payload){let __event=String(__payload.event||"").toLowerCase(),__status=String(__payload.status||__payload.state||__payload.result?.status||"").toLowerCase();__taskDrain.observed=true;__taskDrain.status=__status||__event||null;try{__taskDrain.raw=JSON.stringify(__payload).slice(0,500)}catch{__taskDrain.raw=String(__payload).slice(0,500)}if(__event==="task_done"||["done","completed","finished","error","failed","cancelled","canceled"].includes(__status)){__taskDrain.terminal=true;break}}await new Promise(__resolve=>setTimeout(__resolve,50))}if(!__taskDrain.terminal)__taskDrain.error="task_done notification not observed before restore deadline"}catch(__taskDrainError){__taskDrain.error=__taskDrainError?.message||String(__taskDrainError)}/* codex patch rc.7.10.39: server task drain before snapshot restore *//* codex patch rc.7.10.40: cancelled task_done drains before restore */'
  );
}

if (!text.includes("codex patch rc.7.10.41: full Stop checkpoint")) {
  replaceOnce(
    "load the full Stop checkpoint core",
    '__codexManualPolicy=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","manual_run_policy.js")),__codexBridgeRebind=',
    '__codexManualPolicy=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","manual_run_policy.js")),__codexStopCheckpoint=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stop_checkpoint_core.js")),/* codex patch rc.7.10.41: full Stop checkpoint */__codexBridgeRebind='
  );
  replaceOnce(
    "enrich Human pre-run snapshots with globals, estimates, and graphs",
    'globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot)}else JA.unlinkSync(__snapshotPath)}}catch(__snapshotError)',
    'globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);await __codexStopCheckpoint.enrich({snapshot:__codexHumanFilePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:C,sourceMode:"human-file"})}else JA.unlinkSync(__snapshotPath)}}catch(__snapshotError)'
  );
  replaceOnce(
    "enrich Agent pre-run snapshots with globals, estimates, and graphs",
    'globalThis.__codexActivePreRunSnapshot=__codexBridgePreRunSnapshot}else JA.unlinkSync(__snapshotPath)/* codex patch rc.7.10.37: Stop resolves the active Agent snapshot */',
    'globalThis.__codexActivePreRunSnapshot=__codexBridgePreRunSnapshot;await __codexStopCheckpoint.enrich({snapshot:__codexBridgePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:__cwd,sourceMode:"visible-bridge"})}else JA.unlinkSync(__snapshotPath)/* codex patch rc.7.10.37: Stop resolves the active Agent snapshot */'
  );
  replaceOnce(
    "soft Stop restores the full checkpoint instead of only the dataset",
    'let __restoreCode="use \\""+__codexStataString(__snapshot.path)+"\\", clear\\n";try{',
    'let __restoreCode=__codexStopCheckpoint.restoreCode(__snapshot,__codexStataString);try{'
  );
  replaceOnce(
    "soft Stop removes the complete checkpoint after restore",
    'try{if(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path))JA.unlinkSync(__snapshot.path)}catch{}try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId);',
    'try{__codexStopCheckpoint.cleanup(__snapshot)}catch{}try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId);'
  );
  replaceOnce(
    "normal Human completion removes the complete checkpoint",
    'try{if(__codexHumanFilePreRunSnapshot&&JA.existsSync(__codexHumanFilePreRunSnapshot.path))JA.unlinkSync(__codexHumanFilePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(r)}catch{}',
    'try{__codexStopCheckpoint.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r)}catch{}'
  );
  replaceOnce(
    "normal Agent completion removes the complete checkpoint",
    'try{if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));',
    'try{__codexStopCheckpoint.cleanup(__codexBridgePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));'
  );
  replaceOnce(
    "failed Agent completion removes the complete checkpoint unless Stop owns it",
    'if(__codexBridgePreRunSnapshot&&JA.existsSync(__codexBridgePreRunSnapshot.path))JA.unlinkSync(__codexBridgePreRunSnapshot.path);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));',
    '__codexStopCheckpoint.cleanup(__codexBridgePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(__run);globalThis.__codexPreRunSnapshots.delete(String(__run));'
  );
  replaceSpanOnce(
    "status summarizes the full active checkpoint",
    'preRunSnapshot:(()=>{let __snap=',
    '})(),lastForceResetReconnect:',
    'preRunSnapshot:__codexStopCheckpoint.publicSummary(globalThis.__codexActivePreRunSnapshot||null),lastForceResetReconnect:'
  );
}

if (!text.includes("codex patch rc.7.10.42: post-run refresh drains before release")) {
  replaceOnce(
    "Agent post-run dataset refresh drains before lifecycle release",
    'try{qF()}catch(__codexQfError){try{RI("[Codex bridge] post-run refresh ignored after visible bridge run: "+(__codexQfError?.message||__codexQfError))}catch{}}',
    'try{await qF()}catch(__codexQfError){try{RI("[Codex bridge] post-run refresh ignored after visible bridge run: "+(__codexQfError?.message||__codexQfError))}catch{}}/* codex patch rc.7.10.42: post-run refresh drains before release */'
  );
  replaceOnce(
    "Manual Selection post-run dataset refresh drains before lifecycle release",
    'else qF()}catch(t)',
    'else await qF()}catch(t)'
  );
  replaceOnce(
    "Human Run File post-run dataset refresh drains before lifecycle release",
    'else qF()}catch(__codexHumanFileQFError)',
    'else await qF()}catch(__codexHumanFileQFError)'
  );
}

if (!text.includes("codex patch rc.7.10.48: large document graph runs extend the pre-log watchdog")) {
  replaceOnce(
    "classify large document graph Run File as a huge human-file run",
    '__codexHumanFileIsHugeMiDocumentRun=(__codexHumanFileLineCount>5000||__codexHumanFileCodeText.length>300000||__codexHumanFileMiCount>100)&&__codexHumanFileMiCount>20&&(__codexHumanFileDoc||__codexHumanFileGraphCount>25)',
    '__codexHumanFileIsHugeMiDocumentRun=((__codexHumanFileLineCount>5000||__codexHumanFileCodeText.length>300000||__codexHumanFileMiCount>100)&&__codexHumanFileMiCount>20&&(__codexHumanFileDoc||__codexHumanFileGraphCount>25))||((__codexHumanFileLineCount>5000||__codexHumanFileCodeText.length>300000)&&__codexHumanFileDoc&&__codexHumanFileGraphCount>25)/* codex patch rc.7.10.48: large document graph runs extend the pre-log watchdog */'
  );
  replaceOnce(
    "extend large human-file pre-log watchdog beyond the five-minute boundary",
    'let __codexHumanFilePreLogStallMs=(__codexHumanFileIsHugeMiDocumentRun?300000:',
    'let __codexHumanFilePreLogStallMs=(__codexHumanFileIsHugeMiDocumentRun?900000:'
  );
  replaceOnce(
    "extend structurally long manual-selection pre-log watchdog",
    'preLogStallAfterMs:(__codexManualSelectionLongRun?300000:45000)',
    'preLogStallAfterMs:(__codexManualSelectionLongRun?900000:45000)'
  );
  replaceOnce(
    "extend structurally long Agent bridge pre-log watchdog",
    'preLogStallAfterMs:(__codexBridgeLongRun?300000:120000)',
    'preLogStallAfterMs:(__codexBridgeLongRun?900000:120000)'
  );
}

// ==================================================================
// codex patch rc.7.40: post-run summaries reuse cached UI credentials
// ------------------------------------------------------------------
// qF runs after every visible execution. Calling get_ui_channel there can
// leave the shared MCP transport wedged after a metadata timeout, causing the
// next real runSelection request to be accepted but never reach a log path.
// Data Browser already owns the current channel credentials; use that cache
// for the optional HTTP summary and skip when no Data Browser channel exists.
if (!text.includes("codex patch rc.7.40: post-run summary uses cached Data Browser credentials")) {
  replaceOnce(
    "post-run dataset summary avoids the shared MCP transport",
    'if(!Gg.currentPanel&&!GD.currentPanel)return;/* upstream 0.22.3: skip dataset summary refresh when UI inactive */let g=await zg.getUiChannel();',
    'let g=GD.currentPanel&&GD.currentPanel._credentials;if(!g||!g.baseUrl||!g.token)return;/* codex patch rc.7.40: post-run summary uses cached Data Browser credentials */'
  );
}

if (text.includes('busy; retry "+(__state.retriesScheduled+1)+" after')) {
  replaceOnce(
    "correct bridge retry ordinal",
    'busy; retry "+(__state.retriesScheduled+1)+" after',
    'busy; retry "+__state.retriesScheduled+" after'
  );
}

if (!text.includes("codex patch rc.7.11.1: bounded pre-run stages")) {
  // ── R1-128 修复：给两个 pre-run await 加独立有界守卫 ──────────────────
  // 缺陷：dataset snapshot 与 checkpoint enrich 都是无界 await。任一不 resolve 时
  //   桥停在 busy=true+postRunBusy=true+trueReady=false+phase=acquired，
  //   logPath 恒 null、CPU 约 0.014 秒/秒，实测 600-1200 秒不自解；此后任何派发
  //   都拿 'bridge busy' 并在约 600s 后返回 500 且 extRunOps 全零。仅 reopen 可恢复。
  //   落盘证据：8 轮 S43 命中 4 轮，步骤号随机，与 payload 体积无关。
  // 为何不能靠主 watchdog：__codexBridgeWatchdog 的 .guard() 在两个 pre-run await
  //   **之后**才调用（全文仅 1 次，包裹 payload promise），pre-run 阶段无 watchdog。
  // 实测停住深度不唯一（有的 .dta 已写完、有的未落地），故两阶段各自设限。
  replaceOnce(
    "load the bounded pre-run stage guard",
    '__codexStopCheckpoint=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stop_checkpoint_core.js")),',
    '__codexStopCheckpoint=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","stop_checkpoint_core.js")),__codexPreRunGuard=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","prerun_stage_guard.js")),/* codex patch rc.7.11.1: bounded pre-run stages */'
  );

  // Agent 侧 dataset snapshot：60s 上限。超时 → 不派 payload、有界 cancel/drain、暴露状态。
  // 【实测补强】首版没接 opts.cancel，实证 504 体里 cancelAttempted=False、
  //   drainSettled=False、recoveryRequired=True（elapsedMs=60002 / drainMs=15002）——
  //   drain 只是干等 15s，卡住的 runSelection 仍占着 transport，
  //   于是 harness 随后看到 LIFECYCLE_INCOMPLETE。
  //   codex 原话是「先执行有界 cancel/drain」，我只做了 drain。
  //   现在把 cancel 接到 __codexSoftStop（桥自带的有界软停），让 drain 真能落定。
  replaceOnce(
    "bound the Agent pre-run dataset snapshot stage",
    'await zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:__cwd,runId:"pre-run-snapshot-"+String(__run||Date.now())});',
    'let __codexSnapStage=__codexPreRunGuard.createStageState("snapshot",{runId:__run,sourceMode:"visible-bridge",snapshotPath:__snapshotPath});globalThis.__codexPreRunStage=__codexSnapStage;let __codexSnapGuard=await __codexPreRunGuard.guardStage("snapshot",()=>zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:__cwd,runId:"pre-run-snapshot-"+String(__run||Date.now())}),{state:__codexSnapStage,cancel:()=>(globalThis.__codexSoftStop?globalThis.__codexSoftStop("pre-run snapshot timeout"):null),log:(m)=>{try{RI(m)}catch{}}});if(!__codexSnapGuard.ok)throw Object.assign(new Error(__codexPreRunGuard.TIMEOUT_CODE.snapshot),{__codexPreRunTimeout:__codexPreRunGuard.timeoutResponse("snapshot",__codexSnapStage)});'
  );

  // Agent 侧 checkpoint enrich：120s 上限。
  replaceOnce(
    "bound the Agent pre-run checkpoint enrich stage",
    'await __codexStopCheckpoint.enrich({snapshot:__codexBridgePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:__cwd,sourceMode:"visible-bridge"})',
    'await (async()=>{let __st=__codexPreRunGuard.createStageState("enrich",{runId:__run,sourceMode:"visible-bridge",snapshotPath:__codexBridgePreRunSnapshot&&__codexBridgePreRunSnapshot.path});globalThis.__codexPreRunStage=__st;let __g=await __codexPreRunGuard.guardStage("enrich",()=>__codexStopCheckpoint.enrich({snapshot:__codexBridgePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:__cwd,sourceMode:"visible-bridge"}),{state:__st,cancel:()=>(globalThis.__codexSoftStop?globalThis.__codexSoftStop("pre-run enrich timeout"):null),log:(m)=>{try{RI(m)}catch{}}});if(!__g.ok)throw Object.assign(new Error(__codexPreRunGuard.TIMEOUT_CODE.enrich),{__codexPreRunTimeout:__codexPreRunGuard.timeoutResponse("enrich",__st)});return __g.value})()'
  );

  // Human-file 侧 checkpoint enrich：同样 120s 上限。
  replaceOnce(
    "bound the Human-file pre-run checkpoint enrich stage",
    'await __codexStopCheckpoint.enrich({snapshot:__codexHumanFilePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:C,sourceMode:"human-file"})',
    'await (async()=>{let __st=__codexPreRunGuard.createStageState("enrich",{runId:r,sourceMode:"human-file",snapshotPath:__codexHumanFilePreRunSnapshot&&__codexHumanFilePreRunSnapshot.path});globalThis.__codexPreRunStage=__st;let __g=await __codexPreRunGuard.guardStage("enrich",()=>__codexStopCheckpoint.enrich({snapshot:__codexHumanFilePreRunSnapshot,runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:C,sourceMode:"human-file"}),{state:__st,cancel:()=>(globalThis.__codexSoftStop?globalThis.__codexSoftStop("pre-run enrich timeout"):null),log:(m)=>{try{RI(m)}catch{}}});if(!__g.ok)throw Object.assign(new Error(__codexPreRunGuard.TIMEOUT_CODE.enrich),{__codexPreRunTimeout:__codexPreRunGuard.timeoutResponse("enrich",__st)});return __g.value})()'
  );

  // /status 暴露 pre-run 阶段：preRunStage/stageStartedAt/snapshotPath/timedOut/
  // cancelAttempted/drainSettled/payloadDispatched 等（codex 要求的 7 个字段）
  replaceOnce(
    "expose pre-run stage state on status",
    'preRunSnapshot:__codexStopCheckpoint.publicSummary(globalThis.__codexActivePreRunSnapshot||null),lastForceResetReconnect:',
    'preRunSnapshot:__codexStopCheckpoint.publicSummary(globalThis.__codexActivePreRunSnapshot||null),preRunStageState:__codexPreRunGuard.publicStageSummary(globalThis.__codexPreRunStage||null),lastForceResetReconnect:'
  );
  // 【实测修正】上面的 guard 会 throw，但它落在**既有**的
  //   catch(__snapshotError){ 只记日志 } 里被吞掉，执行随即继续派发 payload。
  // 实证：S43 新 SHA 第 1 轮 step3 —— /status 显示 enrich 已 timedOut=True
  //   (elapsedMs=120000)，可 step3 仍耗 602.3s 且 extRunOps 全零、logBytes=0，
  //   即 payload 被派进一个仍被占用的 transport，重演旧的 ~600s 挂住。
  // 这正是 codex 警告的「超时后禁止直接派发 payload，原 promise 可能仍占 transport」。
  // 修法：让带 __codexPreRunTimeout 标记的错误穿透既有 catch，交给外层返回 504。
  replaceOnce(
    "let bounded pre-run timeouts escape the legacy snapshot catch",
    'catch(__snapshotError){try{RI("[Codex bridge] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}',
    'catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI("[Codex bridge] pre-run stage timeout; refusing to dispatch payload: "+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}throw __snapshotError}try{RI("[Codex bridge] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}'
  );

  // human-file 侧同理：它的 catch 变量名不同，单独放行。
  replaceOnce(
    "let bounded pre-run timeouts escape the legacy human-file snapshot catch",
    'catch(__snapshotError){try{RI("[Codex human-file] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}',
    'catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI("[Codex human-file] pre-run stage timeout; refusing to dispatch payload: "+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}throw __snapshotError}try{RI("[Codex human-file] pre-run dataset snapshot failed: "+(__snapshotError?.message||__snapshotError))}catch{}}'
  );
}

// ===========================================================================
// rc.7.12 (D0b)：guard transport 适配 + 控制面换代登记 + ABSOLUTE 接线补全
//
// 为什么必须**独立 marker 块**：rc.7.11.1 段被
//   if (!text.includes("codex patch rc.7.11.1: bounded pre-run stages")) { … }
// 包住，dist 已带该 marker → 那段永不再执行。改它的注入串不会进 dist。
// 故本段以新 marker 守卫，对**已注入的代码**做迁移式替换（幂等）。
//
// 本段修三类问题：
//   ① 【回归】C4.1 删掉 prerun 的 opts.cancel 别名，但 #5/#6/#11 三处仍传 cancel:
//      → 实测取消原语从未被调用，直接 DRAIN_FAILED/503（有界但不取消，桥仍被占）。
//      改传 cancelTask/cancelRun/cancelAll 三级 + supersedeLookup。
//   ② 控制面换代登记：softStop/forceReset 增 kind/fromGeneration/toGeneration/token，
//      供 guard 在**检测到换代时**查证（D0a 的 supersedeLookup）。复用既有 generation
//      计数器，不另建台账。
//   ③ ABSOLUTE 首批补齐 #10/#14（manifest v3: ABSOLUTE-60s 未守卫两处）。
if (!text.includes("codex patch rc.7.12: guard transport adapter")) {
  // --- ② 控制面：换代登记器 + guard transport 适配（zg 在此作用域内可见） ---
  replaceOnce(
    "install the guard transport adapter and supersede registry",
    "globalThis.__codexSoftStop=async __reason=>{let __s=globalThis.__codexBridgeState||{}",
    "globalThis.__codexRecordSupersede=(__kind,__runId,__toGen,__reason,__fromGen)=>{try{if(__fromGen==null)return null;let __to=Number(__toGen);let __from=Number(__fromGen);if(!isFinite(__to)||!isFinite(__from))return null;let __rec={kind:String(__kind||\"unknown\"),runId:__runId==null?null:String(__runId),fromGeneration:__from,toGeneration:__to,beforeGeneration:__from,afterGeneration:__to,token:\"sup_\"+String(__to)+\"_\"+Date.now().toString(36)+\"_\"+Math.random().toString(36).slice(2,8),reason:__reason==null?null:String(__reason),at:new Date().toISOString(),consumedAt:null};globalThis.__codexLastSupersede=__rec;let __hist=globalThis.__codexSupersedeHistory=globalThis.__codexSupersedeHistory||[];__hist.push(__rec);if(__hist.length>50)__hist.shift();return __rec}catch(__e){return null}};" +
    "globalThis.__codexGuardTransport={" +
      // getRunExecutionState：19 处不再私读 _activeRun/_runsByTaskId
      "getRunExecutionState:(__runId)=>{try{let __key=__runId==null?null:String(__runId),__run=null;if(__key&&zg._runsByTaskId)for(let __r of zg._runsByTaskId.values()){if(__r&&String(__r._runId||\"\")===__key){__run=__r;break}}if(!__run&&zg._activeRun&&(__key==null||String(zg._activeRun._runId||\"\")===__key))__run=zg._activeRun;if(!__run)return{runId:__key,taskId:null,transportAck:false,logPath:null,logBytes:null,found:false};let __lp=__run.logPath||__run._logPath||null,__lb=null;try{if(__lp&&JA.existsSync(__lp))__lb=JA.statSync(__lp).size}catch{}return{runId:String(__run._runId||__key||\"\"),taskId:__run.taskId==null?null:String(__run.taskId),transportAck:!!(__run.taskId||__run._acked||__lp),logPath:__lp,logBytes:__lb,found:true}}catch(__e){return{runId:__runId==null?null:String(__runId),taskId:null,transportAck:false,logPath:null,logBytes:null,found:false,error:__e?.message||String(__e)}}}," +
      // ① cancelTask：协议 tasks/cancel。返回体是 Task —— 必须按 status 判终态
      //    （TaskSchema.status ∈ working|input_required|completed|failed|cancelled）。
      //    既不能固定当 terminal:true（受理≠终止），也不能固定 false（终态就是终态）。
      "TERMINAL_TASK_STATUS:[\"completed\",\"failed\",\"cancelled\"]," +
      "cancelTask:async(__taskId)=>{try{if(__taskId==null||typeof zg.cancelTask!==\"function\")return false;let __t=await zg.cancelTask(String(__taskId));let __st=__t&&__t.status?String(__t.status):null;let __term=__st!=null&&[\"completed\",\"failed\",\"cancelled\"].indexOf(__st)>=0;return{confirmed:__term,terminal:__term,taskStatus:__st,target:\"cancelTask\",raw:__t}}catch(__e){return false}}," +
      "cancelRun:async(__runId)=>{try{if(__runId==null)return false;return!!(await zg.cancelRun(String(__runId)))}catch(__e){return false}}," +
      "cancelAll:async()=>{try{return!!(await zg.cancelAll())}catch(__e){return false}}," +
      // 换代证据查询：只认 soft-stop / force-reset，且 runId+fromGeneration 必须对得上
      "supersedeLookup:(__q)=>{try{let __rec=globalThis.__codexLastSupersede||null;if(!__rec)return null;if(__q&&__q.runId!=null&&String(__rec.runId)!==String(__q.runId)){let __h=globalThis.__codexSupersedeHistory||[];__rec=null;for(let __i=__h.length-1;__i>=0;__i--){if(String(__h[__i].runId)===String(__q.runId)){__rec=__h[__i];break}}if(!__rec)return null}return __rec}catch(__e){return null}}" +
    "};/* codex patch rc.7.12: guard transport adapter */" +
    "globalThis.__codexSoftStop=async __reason=>{let __s=globalThis.__codexBridgeState||{}"
  );

  // softStop 递增 generation 后立刻登记（换代真正发生的唯一时点）
  replaceOnce(
    "soft stop registers the supersede evidence",
    "globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __generation=globalThis.__codexResetGeneration;",
    "let __codexPrevSoftStopGeneration=Number(globalThis.__codexResetGeneration||0);globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __generation=globalThis.__codexResetGeneration;try{globalThis.__codexRecordSupersede&&globalThis.__codexRecordSupersede(\"soft-stop\",__runId,__generation,__reason,__codexPrevSoftStopGeneration)}catch{}/* codex patch rc.7.12: register soft-stop supersede */"
  );

  // force-reset 同理
  replaceOnce(
    "force reset registers the supersede evidence",
    "globalThis.__codexForceReset=async o=>{globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __codexThisResetGeneration=globalThis.__codexResetGeneration;",
    "globalThis.__codexForceReset=async o=>{let __codexPrevResetGeneration=Number(globalThis.__codexResetGeneration||0);globalThis.__codexResetGeneration=Number(globalThis.__codexResetGeneration||0)+1;let __codexThisResetGeneration=globalThis.__codexResetGeneration;try{let __fs=globalThis.__codexBridgeState||{};globalThis.__codexRecordSupersede&&globalThis.__codexRecordSupersede(\"force-reset\",(__fs.runId||null),__codexThisResetGeneration,o,__codexPrevResetGeneration)}catch{}/* codex patch rc.7.12: register force-reset supersede */"
  );

  // --- ① 回归修复：三处 dead cancel: → 三级原语 + supersedeLookup ---
  // cancelRun 用**transport 级 runId**（pre-run-snapshot-* / pre-run-full-state-*），
  // 不是外层 __run/r —— 否则取消的是别的 run。故闭包忽略入参、锁定 transport id。
  const TRIO = (transportRunIdExpr) =>
    "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
    "cancelRun:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelRun(" + transportRunIdExpr + "):false)," +
    "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
    "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),";

  replaceOnce(
    "agent snapshot stage uses the three-level transport cancel",
    '{state:__codexSnapStage,cancel:()=>(globalThis.__codexSoftStop?globalThis.__codexSoftStop("pre-run snapshot timeout"):null),log:(m)=>{try{RI(m)}catch{}}}',
    '{state:__codexSnapStage,' + TRIO('"pre-run-snapshot-"+String(__run||Date.now())') + 'log:(m)=>{try{RI(m)}catch{}}}'
  );

  // 两处 enrich 的 cancel: 串完全相同，用各自 state 变量名区分（__st 属于 agent/human 两块）
  replaceAllRequired(
    "enrich stages use the three-level transport cancel",
    '{state:__st,cancel:()=>(globalThis.__codexSoftStop?globalThis.__codexSoftStop("pre-run enrich timeout"):null),log:(m)=>{try{RI(m)}catch{}}}',
    '{state:__st,' + TRIO('"pre-run-full-state-"+String(__st.runId||Date.now())') + 'log:(m)=>{try{RI(m)}catch{}}}',
    2
  );

  // --- ③ ABSOLUTE 首批补齐：#10 / #14（manifest v3 标记 ABSOLUTE-60s 未守卫） ---
  // #10 human-file dataset snapshot：原为裸 await（v3 遗漏）。它所在 try 的 catch 已被
  // rc.7.11.1 放行 __codexPreRunTimeout，故超时可正常上抛、拒派 payload。
  replaceOnce(
    "bound the Human-file pre-run dataset snapshot stage",
    'capture restore\\n";await zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:C,runId:"pre-run-snapshot-"+String(r||Date.now())});',
    'capture restore\\n";let __codexHfSnapStage=__codexPreRunGuard.createStageState("snapshot",{runId:r,sourceMode:"human-file",snapshotPath:__snapshotPath});globalThis.__codexPreRunStage=__codexHfSnapStage;let __codexHfSnapGuard=await __codexPreRunGuard.guardStage("snapshot",()=>zg.runSelection(__snapshotCode,{normalizeResult:!0,includeGraphs:!1,cwd:C,runId:"pre-run-snapshot-"+String(r||Date.now())}),{state:__codexHfSnapStage,' + TRIO('"pre-run-snapshot-"+String(r||Date.now())') + 'log:(m)=>{try{RI(m)}catch{}}});if(!__codexHfSnapGuard.ok)throw Object.assign(new Error(__codexPreRunGuard.TIMEOUT_CODE.snapshot),{__codexPreRunTimeout:__codexPreRunGuard.timeoutResponse("snapshot",__codexHfSnapStage)});'
  );

  // #14 human-file 最终 state snapshot：**已退役，不接线**（codex 复核推翻我的接线）。
  // 该调用在 dist 里位于**永久死分支**内：
  //   …stateSnapshotPath:null;if(false&&__codexPreparedHumanFileRun&&(…hasDocumentOutput||…))try{…}
  // `if(false&&…)` 恒假 → 运行时永不可达。之前给它注 guard 属**假接线**，并使我误报
  // 「ABSOLUTE 5/5 全守卫」（真实可达覆盖 = 4 处）。静态「裸调用归零」不能证明可达性。
  // 处置：不启用该功能、不注 guard；manifest 标 RETIRED_UNREACHABLE，从活跃分母移除。
  // 将来若确需最终 state snapshot，须作为独立功能重新设计 + 生产测试，不借本轮顺带恢复。
  // 由 scripts/test_callsite_reachability_gate.js 守门：死分支内出现 guard 注入即红。

  // --- ⑤ D0b-5：HTTP 层按失败体真实 status 发（原固定 500 会吞 503/504） ---
  // guard 的 timeoutResponse 已带 status(500/503/504) + cause/settlement/outcome/
  // cancelLevels/payloadDispatched；这里把它整体透出，不再一律 500。
  // 语义：同步异常/rejection=500、干净阶段超时=504、transport 未收敛=503+recoveryRequired。
  replaceOnce(
    "bridge dispatch sends the real pre-run failure status",
    '__release();__send(__res,500,{ok:false,error:e?.message||String(e),runId:__runId,state:__current(),patch:__patch})',
    '__release();let __codexPrt=e&&e.__codexPreRunTimeout;__send(__res,(__codexPrt&&__codexPrt.status)||500,__codexPrt?Object.assign({},__codexPrt,{ok:false,runId:__runId,state:__current(),patch:__patch}):{ok:false,error:e?.message||String(e),runId:__runId,state:__current(),patch:__patch})/* codex patch rc.7.12: real pre-run status */'
  );

  replaceOnce(
    "human-file debug handler sends the real pre-run failure status",
    'console.log("[Codex debug-run-file] failed:",__debugRunFileError?.message||__debugRunFileError);__send(__res,500,{ok:false,patch:__patch,error:globalThis.__codexLastDebugRunFileError',
    'console.log("[Codex debug-run-file] failed:",__debugRunFileError?.message||__debugRunFileError);let __codexHfPrt=__debugRunFileError&&__debugRunFileError.__codexPreRunTimeout;if(__codexHfPrt)globalThis.__codexLastPreRunFailure=__codexHfPrt;__send(__res,(__codexHfPrt&&__codexHfPrt.status)||500,{ok:false,patch:__patch,preRunFailure:__codexHfPrt||null,error:globalThis.__codexLastDebugRunFileError'
  );

  text += "\n/* codex patch rc.7.12: guard transport adapter */\n";
}

// ===========================================================================
// rc.7.13a (Track A)：#19 terminal-input 接 PROGRESS guard
//
// 为什么单独一批、单独 marker：rc.7.12 块已命中 dist（marker 幂等守卫），
// 改它的注入串不会进 dist。故新开 rc.7.13a。
//
// #19 是 R1-118 / R1-133 的**已复现**现场（`http=-1 TimeoutError`，桥永久 busy）。
// 原代码形态：
//   let __codexTerminalResult;try{__codexTerminalResult=await zg.runSelection(
//     __codexTerminalCode,{...,runId:__codexTerminalRunId,timeoutSec:__codexTerminalTimeoutSec})
//   }catch(__codexTerminalRunError){...throw}
// 注意它**已经**传了 timeoutSec，但 R1-118 照样复现 —— 说明 timeoutSec 只约束
// Stata 侧执行，不约束 promise 落定。故必须在外层加 PROGRESS guard。
//
// policy 取值理由（PROGRESS）：
//   · preLog 120s —— R1-118 的签名正是 logPath 恒 null，pre-log 门限是**主检测器**
//   · idle 取**长**窗口（30min）—— 终端里用户可能跑 mi impute 之类合法长任务，
//     首日志之后若用短 60s 空闲窗会误杀（既往教训：200K/MI 长任务合法无输出）
//   · hardBudget **不设** —— 真实用户 payload 默认关闭，避免误杀
//   · probe 用 rc.7.12 的 getRunExecutionState（该访问器此前无调用方，正为此建）
//   · ownerRef 用 runId + __codexResetGeneration，让 Stop/force-reset 换代被判 SUPERSEDED
//     而非「无进展」，且收尾只精确取消旧 run（禁 cancelAll 误伤新 run）
if (!text.includes("codex patch rc.7.13a: terminal-input progress guard")) {
  // execution_guard 的 guardProgress 不在 prerun 适配层里，需单独 require
  replaceOnce(
    "load the execution guard kernel for PROGRESS policy",
    '__codexPreRunGuard=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","prerun_stage_guard.js")),',
    '__codexPreRunGuard=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","prerun_stage_guard.js")),__codexExecGuard=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_guard.js")),/* codex patch rc.7.13a: PROGRESS policy kernel */'
  );

  // #19 的真实调用形态（从 dist 现读，不靠猜）：
  //   let __codexTerminalResult;try{__codexTerminalResult=await zg.runSelection(
  //     __codexTerminalCode,{normalizeResult:!0,includeGraphs:!1,cwd:A?.cwd,runId:A?.runId,
  //     onStarted:()=>{…recordStarted…updateStreamingStatus…},onRawLog:I,onLog:B=>{…recordProgress…},
  //     onGraphReady:B=>{…}})}catch(…)
  // 参数含 4 个回调、近千字节，**绝不可手抄成字面量**（我第一版就抄错了：把
  // runId:A?.runId 写成 __codexTerminalRunId、还漏了全部回调，导致锚点 count=0）。
  // 故用括号配平扫描器求出真实参数切片，原样复用。
  {
    const SCOPE = require("./js_scope_scan.js");
    const HEAD = "let __codexTerminalResult;try{__codexTerminalResult=await zg.runSelection(";
    const at = text.indexOf(HEAD);
    if (at < 0) throw new Error("missing rc.7 anchor: terminal-input call head");
    if (text.indexOf(HEAD, at + HEAD.length) >= 0) {
      throw new Error("non-unique rc.7 anchor: terminal-input call head");
    }
    const lp = at + HEAD.length - 1;                 // 指向 runSelection 的 '('
    const call = SCOPE.scanBalanced(text, lp, "parens");   // 配平到对应 ')'
    const args = text.slice(lp + 1, call.end - 1);         // 原始参数，逐字保留
    if (!/onStarted:/.test(args) || !/runId:/.test(args)) {
      throw new Error("terminal-input args shape unexpected: " + args.slice(0, 120));
    }
    // try{ 之后必须紧跟 }catch( —— 求出 catch 头以拼回原结构
    const catchAt = text.indexOf("}catch(", call.end);
    if (catchAt < 0) throw new Error("missing rc.7 anchor: terminal-input catch");
    const catchHead = text.slice(catchAt, text.indexOf("{", catchAt + 7) + 1);

    const guarded =
      "let __codexTerminalResult;try{" +
      "let __codexTermRunId=(A&&A.runId)||null," +
      "__codexTermState=__codexExecGuard.createState(__codexExecGuard.POLICY.PROGRESS," +
        "{runId:__codexTermRunId,sourceMode:\"terminal-input\"," +
         "generation:Number(globalThis.__codexResetGeneration||0)})," +
      "__codexTermGuard=await __codexExecGuard.guardProgress(" +
        "()=>zg.runSelection(" + args + ")," +
        "{state:__codexTermState," +
         // C5.2 修正1：structuralLong 不能写死。写死 true 会让**短**终端命令也拿到
         // 30 分钟空闲窗，挂住时要等半小时才判——等于没保护。改按代码本身判定：
         // 只有结构性长任务（mi impute/estimate 等）才用长窗，短任务用 60s 短窗。
         "structuralLong:(function(){try{return !!require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),\"scripts\",\"manual_run_policy.js\")).isLongManualSelection(__codexTerminalCode)}catch(__le){return false}})()," +
         "probe:()=>{try{let __s=globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.getRunExecutionState(__codexTermRunId):null;" +
           "return __s?{runId:__s.runId,taskId:__s.taskId,transportAck:__s.transportAck,logPath:__s.logPath,logBytes:__s.logBytes}:{}}catch(__pe){return{}}}," +
         // C5.2 修正2：ownerRef 必须**实时读桥当前 owner**。原来从闭包回传本次
         // runId，等于恒等于自己 → 同一 generation 下换了 run 永远检测不到 SUPERSEDED。
         "ownerRef:()=>{try{let __bs=globalThis.__codexBridgeState||{}," +
           "__lf=(globalThis.__codexExecutionAdapter&&globalThis.__codexExecutionAdapter.ensureLifecycle)?globalThis.__codexExecutionAdapter.ensureLifecycle(__bs):null;" +
           "return{runId:((__lf&&__lf.runId)||__bs.runId||null),generation:Number(globalThis.__codexResetGeneration||0)}}" +
           "catch(__oe){return{runId:null,generation:Number(globalThis.__codexResetGeneration||0)}}}," +
         "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
         "cancelRun:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelRun(__codexTermRunId):false)," +
         "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
         "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null)," +
         "log:(m)=>{try{RI(m)}catch{}}});" +
      "globalThis.__codexLastTerminalGuard=__codexExecGuard.publicSummary(__codexTermState);" +
      "if(!__codexTermGuard.ok){" +
        "let __codexTermCode=__codexTermGuard.outcome?__codexTermGuard.outcome.code:\"EXEC_PROGRESS_STALL\"," +
        "__codexTermErr=new Error(__codexTermCode);" +
        "__codexTermErr.__codexPreRunTimeout={ok:false," +
          "status:(__codexTermState.recoveryRequired?503:504)," +
          "error:__codexTermCode,reasonCode:__codexTermCode," +
          "preRunStage:\"terminal-input\",sourceMode:\"terminal-input\",runId:__codexTermRunId," +
          "payloadDispatched:true,cause:__codexTermGuard.cause,settlement:__codexTermGuard.settlement," +
          "outcome:__codexTermCode," +
          "outcomeBelongsTo:(__codexTermGuard.outcome?__codexTermGuard.outcome.belongsTo:null)," +
          "exclusionReason:(__codexTermGuard.exclusionReason||null)," +
          "stallReason:__codexTermState.stallReason,cancelHitLevel:__codexTermState.cancelHitLevel," +
          "cancelLevels:__codexTermState.cancelLevels||null," +
          "supersedeEvidence:__codexTermState.supersedeEvidence||null," +
          "recoveryRequired:!!__codexTermState.recoveryRequired,elapsedMs:__codexTermState.elapsedMs};" +
        "throw __codexTermErr}" +
      "__codexTerminalResult=__codexTermGuard.value" +
      "/* codex patch rc.7.13a: terminal-input PROGRESS guard */" +
      catchHead;

    text = text.slice(0, at) + guarded + text.slice(catchAt + catchHead.length);
  }

  // terminal-input handler 的 catch 也按失败体真实 status 发（原固定 500）。
  // 注意变量名是 __terminalError（不是 __codexTerminalError）—— 我第一版抄错过。
  replaceOnce(
    "terminal-input handler sends the real guard failure status",
    'catch(__terminalError){__send(__res,500,{ok:false,patch:__patch,ran:"terminal-input-handler",source:"debug-terminal-input",durationMs:Date.now()-__terminalStarted,error:__terminalError',
    'catch(__terminalError){let __codexTermPrt=__terminalError&&__terminalError.__codexPreRunTimeout;if(__codexTermPrt)globalThis.__codexLastTerminalFailure=__codexTermPrt;__send(__res,(__codexTermPrt&&__codexTermPrt.status)||500,{ok:false,patch:__patch,ran:"terminal-input-handler",source:"debug-terminal-input",guardFailure:__codexTermPrt||null,durationMs:Date.now()-__terminalStarted,error:__terminalError'
  );

  text += "\n/* codex patch rc.7.13a: terminal-input progress guard */\n";
}

// ==================================================================
// codex patch rc.7.13c: bundle identity slot + /status identity contract
// ------------------------------------------------------------------
// 为什么需要：rc.7.0 那次事故的根因是「磁盘装了新包 ≠ host 加载了新包」——
// 装机 152baa79 的 mtime 比 extension host 的启动时间晚 29.2 小时，
// 但 /status 里没有任何字段能把这件事暴露出来，于是「已部署」被误当「已生效」。
//
// 三个可独立计算的身份轴（缺一不可）：
//   1. guardBuildFingerprint —— **内存**侧：从已加载的字面量读出的归一化指纹。
//   2. diskGuardFingerprint  —— **磁盘**侧：activation 时读一次 dist/extension.js 重算。
//   3. diskBundleSha256      —— 磁盘整文件 SHA256，供外部审计逐字节对账。
//
// 归一化（避免自引用悖论）：指纹是「把命名固定宽度槽位的 64 位 hex 清零之后」
// 对整个映像做 SHA256。写入槽位不会改变被摘要的映像，故 finalize 可幂等重跑。
//
// 状态语义（fail closed）：
//   OK                     内存指纹 == 磁盘指纹
//   STALE_HOST             内存指纹 != 磁盘指纹（host 跑的是旧映像）
//   BYTE_IDENTITY_MISMATCH 磁盘槽位值 != 磁盘重算指纹（dist 在 finalize 之后被改过）
//   UNFINALIZED            槽位仍为全零（从未跑 finalize_bundle_identity.js）
//   IDENTITY_UNREADABLE    __filename / 文件读取 / 槽位解析失败
if (!text.includes("codex-bundle-fingerprint-slot-v1")) {
  const ZERO64 = "0".repeat(64);
  // 注意：运行时代码里的槽位前缀必须**拼接**生成，否则它自己就会在 bundle 里
  // 造出第二个匹配，破坏「恰好一个命名槽位」的唯一性前提。
  const identityRuntime =
    "globalThis.__codexComputeBundleIdentity=function(){" +
    "var R={guardBuildFingerprint:null,diskGuardFingerprint:null,diskSlotFingerprint:null," +
    "diskBundleSha256:null,runtimeBundlePath:null,runtimeBundleBytes:null,extensionHostPid:null," +
    'activatedAt:new Date().toISOString(),identityState:"UNKNOWN",identityError:null};' +
    "try{" +
    "R.extensionHostPid=(typeof process!==\"undefined\"&&process&&process.pid)||null;" +
    'R.guardBuildFingerprint=typeof globalThis.__codexGuardBuildFingerprint==="string"?globalThis.__codexGuardBuildFingerprint:null;' +
    'var __fs=require("fs"),__cr=require("crypto");' +
    'R.runtimeBundlePath=typeof __filename==="string"?__filename:null;' +
    'if(!R.runtimeBundlePath){R.identityState="IDENTITY_UNREADABLE";R.identityError="__filename unavailable";return R}' +
    "var __buf=__fs.readFileSync(R.runtimeBundlePath);R.runtimeBundleBytes=__buf.length;" +
    'R.diskBundleSha256=__cr.createHash("sha256").update(__buf).digest("hex");' +
    'var __src=__buf.toString("utf8"),__pfx="codex-bundle-fingerprint-slot-v1 *"+"/globalThis.__codexGuardBuildFingerprint=\\"";' +
    "var __i=__src.indexOf(__pfx),__j=__i<0?-1:__src.indexOf(__pfx,__i+__pfx.length);" +
    'if(__i<0||__j>=0){R.identityState="BYTE_IDENTITY_MISMATCH";R.identityError="fingerprint slot is missing or not unique on disk";return R}' +
    "var __at=__i+__pfx.length;R.diskSlotFingerprint=__src.substr(__at,64);" +
    'if(!/^[0-9a-f]{64}$/.test(R.diskSlotFingerprint)){R.identityState="BYTE_IDENTITY_MISMATCH";R.identityError="disk fingerprint slot is malformed";return R}' +
    'var __norm=__src.slice(0,__at)+"' + ZERO64 + '"+__src.slice(__at+64);' +
    'R.diskGuardFingerprint=__cr.createHash("sha256").update(Buffer.from(__norm,"utf8")).digest("hex");' +
    'if(!/^[0-9a-f]{64}$/.test(String(R.guardBuildFingerprint||""))){R.identityState="IDENTITY_UNREADABLE";R.identityError="in-memory fingerprint slot missing or malformed";return R}' +
    'if(R.guardBuildFingerprint==="' + ZERO64 + '"){R.identityState="UNFINALIZED";R.identityError="bundle was never finalized by finalize_bundle_identity.js";return R}' +
    'if(R.diskSlotFingerprint!==R.diskGuardFingerprint){R.identityState="BYTE_IDENTITY_MISMATCH";R.identityError="dist bundle was mutated after finalization";return R}' +
    'R.identityState=(R.guardBuildFingerprint===R.diskGuardFingerprint)?"OK":"STALE_HOST";' +
    'if(R.identityState==="STALE_HOST")R.identityError="extension host is running an image that differs from dist/extension.js on disk";' +
    '}catch(__e){R.identityState="IDENTITY_UNREADABLE";R.identityError=String((__e&&__e.message)||__e)}' +
    "return R};" +
    "globalThis.__codexBundleIdentityStatus=function(){" +
    "var I=globalThis.__codexBundleIdentity||(globalThis.__codexBundleIdentity=globalThis.__codexComputeBundleIdentity());" +
    "return{guardBuildFingerprint:I.guardBuildFingerprint||null,diskBundleSha256:I.diskBundleSha256||null," +
    "diskGuardFingerprint:I.diskGuardFingerprint||null,diskSlotFingerprint:I.diskSlotFingerprint||null," +
    "runtimeBundlePath:I.runtimeBundlePath||null,runtimeBundleBytes:I.runtimeBundleBytes||null," +
    "extensionHostPid:I.extensionHostPid||null,activatedAt:I.activatedAt||null," +
    'bundleIdentityState:I.identityState||"UNKNOWN",bundleIdentityError:I.identityError||null,bundleIdentity:I}};' +
    "globalThis.__codexBundleIdentity=globalThis.__codexComputeBundleIdentity();";

  // 槽位 + 运行时身份初始化：挂在 rc.7 共享执行生命周期注释之后（该锚点不受
  // guard 包装器注入影响，因此在「裸中间态」与「已接线态」里都唯一）。
  replaceOnce(
    "rc.7.13c bundle fingerprint slot",
    "dexAdoptExecutionRunId=__codexAdoptExecutionRunId;/* codex patch rc.7: shared execution lifecycle */",
    "dexAdoptExecutionRunId=__codexAdoptExecutionRunId;/* codex patch rc.7: shared execution lifecycle */" +
      "/* codex-bundle-fingerprint-slot-v1 */globalThis.__codexGuardBuildFingerprint=\"" + ZERO64 + "\";" +
      identityRuntime
  );

  // /status 契约：单点 spread，字段全部来自 memoized 的身份对象（磁盘只读一次）
  replaceOnce(
    "rc.7.13c status identity fields",
    "graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,...__codexExecution.publicLifecycle(o)",
    "graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null," +
      "...(globalThis.__codexBundleIdentityStatus?globalThis.__codexBundleIdentityStatus():{})," +
      "...__codexExecution.publicLifecycle(o)"
  );

  text += "\n/* codex patch rc.7.13c: bundle identity slot and status contract */\n";
}

// ==================================================================
// codex patch rc.7.14: guard 引用全局化 + manual-selection 错误路径释放
// ------------------------------------------------------------------
// 必须在 rc.7.13 接线**之前**执行（硬顺序约束）：
//   rc.7.13 接线对「已接线」的调用点做**逐字节**重建比对。若先接线后全局化，
//   rc.7.13 迁移路径上就会用全局形态的 POLICY_EXPR 去比对裸形态的既有字节而报错。
//   先全局化 → 两条路径（baseline 重放 / rc.7.13 迁移）都以同一形态进入接线，字节收敛。
//
// 本块只做两件事，且都不依赖硬编码字符偏移：
//   1. guard_global_export_rc714.apply()：注入唯一命名全局导出 + 结构化改写全部裸引用
//   2. manual-selection 错误路径按**已证明的** human-file / visible-bridge 模式释放
//      graph / post-run 就绪态后再原样重抛
{
  const guardGlobals = require("./guard_global_export_rc714.js");
  const g = guardGlobals.apply(text);
  text = g.text;
  console.log(
    "RC714_GUARD_GLOBALS  rewritten=" + g.report.rewritten +
      " (wasResolvable=" + g.report.rewrittenWasResolvable +
      ", wasOutOfScope=" + g.report.rewrittenWasOutOfScope + ")" +
      " kept=" + g.report.kept.length +
      " exports=" + g.report.injected.map((x) => x.globalRef + ":" + x.action).join(",")
  );
}

// ==================================================================
// codex patch rc.7.15: StopCheckpoint 模块引用全局化
// ------------------------------------------------------------------
// 解决的真问题（rc.7.14 真机血证 + acorn 铁证）：
//   `__codexStopCheckpoint` 是 BlockStatement 内的词法 `let`（let@5229112 ∈
//   BlockStatement@5228541-5309154 ∈ FunctionDeclaration@5227763-5317601），
//   零 globalThis 导出。8 个消费点里 2 个越界：
//     · @5369791 human-file pre-run enrich → 「内存里有数据集」的 Run File 必 500
//       （SYNC_THREW / elapsedMs=0），随后桥卡 postRunBusy=true/draining，
//       /soft-stop 返回 409（与 rc.7.13 的 guard 越界完全同一缺陷类）
//     · @5391352 human-file 完成清理 → 抛错被 try{}catch{} 吞掉，快照静默泄漏
//   这也是 Phase 2C C4 取不到证据的原因：唯一能给 soft-stop registry 装快照的
//   授权路径被该 ReferenceError 打死（site @5257441 在作用域内，故一直健康）。
//
// 顺序约束（硬，两条）：
//   a) 必须在 rc.7.11.1 补丁块**之后** —— 该块用裸 require 串
//      '__codexStopCheckpoint=require(...\"stop_checkpoint_core.js\")),' 当锚点，
//      先全局化会把它的锚点改没。
//   b) 必须在 rc.7.13 接线**之前** —— 接线对已接线点做逐字节重建比对，
//      POLICY_TABLE ord6/ord11 的 anchor 已指向全局化形态。
//   放在 rc.7.14 全局化块之后同时满足 a 与 b。
{
  const ckptGlobals = require("./checkpoint_global_export_rc715.js");
  const c = ckptGlobals.apply(text);
  text = c.text;
  console.log(
    "RC715_CHECKPOINT_GLOBALS  export=" + c.report.exportAction +
      " rewritten=" + c.report.rewritten +
      " (wasResolvable=" + c.report.rewrittenWasResolvable +
      ", wasOutOfScope=" + c.report.rewrittenWasOutOfScope + ")"
  );
  // 补丁块账本标记（幂等）：收敛门禁靠它证明本块真的落进了产物
  if (!text.includes("codex patch rc.7.15: stopcheckpoint global export")) {
    text += "\n/* codex patch rc.7.15: stopcheckpoint global export */\n";
  }
}

// manual-selection 的 catch 只有重抛，没有释放——这是 R1-2C-WEDGE 的真因：
//   进 try 之前 `__codexBeginGraphRun(e,"manual-selection",…)` 已经把 postRunBusy 置 true
//   （见 __codexBeginGraphRun → __codexSetPostRunBusy(true, source+"-begin", runId)），
//   一旦 runSelection 结算前抛错（rc.7.13 的 ReferenceError 正是如此），就永久卡在
//   postRunBusy=true / status=draining / trueReady=false。实测 371s 无自愈，
//   期间所有 run 一律 409 "post-run cleanup in progress"，只能靠 /force-reset（9.0s）救。
//
// 修法逐字照抄 baseline 里已存在两处的产品模式（human-file / visible-bridge）：
//   · 先判 reset 代际是否已过期（过期就不许碰更新的生命周期）
//   · __codexFinishGraphRunNoExport 优先，退化到 __codexSetPostRunBusy(false,…)
//   · 全部包在 try{}catch{} 里 —— 释放失败绝不能掩盖原始产品错误
//   · 原样重抛原始错误：不把产品错误变成 PASS，也不隐式 force-reset
if (!text.includes("codex patch rc.7.14: manual-selection error release")) {
  replaceOnce(
    "manual selection captures its reset generation before graph run begins",
    'if(e&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(e,"manual-selection",B,',
    'let __codexManualResetGeneration=Number(globalThis.__codexResetGeneration||0);if(e&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(e,"manual-selection",B,'
  );
  replaceOnce(
    "manual selection errors release graph and post-run readiness before rethrow",
    "}catch(t){throw e&&Gg.failStreamingEntry(e,t?.message||String(t)),t}",
    "}catch(t){let __codexManualResetStale=Number(globalThis.__codexResetGeneration||0)!==__codexManualResetGeneration;" +
      "if(!__codexManualResetStale)try{let __codexManualErrorText=String(t?.message||t);" +
      'RI("[Codex manual] error release: "+__codexManualErrorText);' +
      'globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(e,"manual-selection-error-release"):' +
      'globalThis.__codexSetPostRunBusy&&__codexSetPostRunBusy(false,"manual-selection-error-release",e);' +
      "globalThis.__codexGraphMark&&__codexGraphMark({lastClientError:__codexManualErrorText})}catch{}" +
      "throw e&&Gg.failStreamingEntry(e,t?.message||String(t)),t}" +
      "/* codex patch rc.7.14: manual-selection error release */"
  );
}

// ==================================================================
// codex patch rc.7.14d: guard 模块身份（execution_guard.js / prerun_stage_guard.js）
// ------------------------------------------------------------------
// 为什么 rc.7.13c 的 bundle 身份不够：真正承载 deadline 的是**两个明文 JS 脚本**
// （dist 是动态 require 它们的）。改 scripts/execution_guard.js 里的 30000/60000/120000
// 完全不会动 dist/extension.js 的 SHA，bundleIdentityState 仍然 OK ——
// 也就是说既有身份覆盖面**不含**真正决定超时行为的文件。Phase 2C 已把这点写进结论。
//
// 摘要读的是 require 时**实际传入**的路径（globalThis.__codex*GuardPath，由
// guard_global_export_rc714 在 require 表达式里链式捕获），不二次推导路径，
// 避免「算出来的路径」与「实际加载的文件」不一致这种经典自欺。
//
// fail closed：任一模块缺失/不可读/路径未捕获 → guardModuleIdentityState 非 OK 且带错因，
// 绝不静默给出 null 让调用方以为「没问题」。
if (!text.includes("codex-guard-module-identity-v1")) {
  const moduleIdentityRuntime =
    "globalThis.__codexComputeGuardModuleIdentity=function(){" +
    "var R={guardModuleIdentityState:\"UNKNOWN\",guardModuleIdentityError:null," +
    "guardModuleCombinedSha256:null,guardModules:{}};" +
    "try{var __fs=require(\"fs\"),__cr=require(\"crypto\")," +
    "__specs=[[\"executionGuard\",globalThis.__codexExecGuardPath]," +
    "[\"preRunStageGuard\",globalThis.__codexPreRunGuardPath]]," +
    "__parts=[],__bad=[];" +
    "for(var __i=0;__i<__specs.length;__i++){" +
    "var __nm=__specs[__i][0],__p=__specs[__i][1],__e={path:null,bytes:null,sha256:null,error:null};" +
    "try{" +
    "if(typeof __p!==\"string\"||!__p){__e.error=\"module path was never captured at require time\"}" +
    "else{__e.path=__p;var __b=__fs.readFileSync(__p);__e.bytes=__b.length;" +
    "__e.sha256=__cr.createHash(\"sha256\").update(__b).digest(\"hex\")}" +
    "}catch(__me){__e.error=String((__me&&__me.message)||__me)}" +
    "if(__e.error||!__e.sha256)__bad.push(__nm+\":\"+(__e.error||\"unreadable\"));" +
    "else __parts.push(__nm+\"=\"+__e.sha256);" +
    "R.guardModules[__nm]=__e}" +
    "if(__bad.length){R.guardModuleIdentityState=\"MODULE_UNREADABLE\";R.guardModuleIdentityError=__bad.join(\"; \")}" +
    "else{R.guardModuleCombinedSha256=__cr.createHash(\"sha256\")" +
    ".update(Buffer.from(__parts.join(\"\\n\"),\"utf8\")).digest(\"hex\");" +
    "R.guardModuleIdentityState=\"OK\"}" +
    "}catch(__e2){R.guardModuleIdentityState=\"MODULE_UNREADABLE\";" +
    "R.guardModuleIdentityError=String((__e2&&__e2.message)||__e2)}" +
    "return R};" +
    "globalThis.__codexGuardModuleIdentityStatus=function(){" +
    "var I=globalThis.__codexGuardModuleIdentity||" +
    "(globalThis.__codexGuardModuleIdentity=globalThis.__codexComputeGuardModuleIdentity());" +
    "return{guardModuleIdentityState:I.guardModuleIdentityState||\"UNKNOWN\"," +
    "guardModuleIdentityError:I.guardModuleIdentityError||null," +
    "guardModuleCombinedSha256:I.guardModuleCombinedSha256||null," +
    "guardModules:I.guardModules||{}}};" +
    "/* codex-guard-module-identity-v1 */";

  replaceOnce(
    "rc.7.14d guard module identity runtime",
    "globalThis.__codexBundleIdentity=globalThis.__codexComputeBundleIdentity();",
    "globalThis.__codexBundleIdentity=globalThis.__codexComputeBundleIdentity();" + moduleIdentityRuntime
  );

  // /status 契约：与 bundle 身份同一处单点 spread，只读、memoized
  replaceOnce(
    "rc.7.14d status guard module identity fields",
    "...(globalThis.__codexBundleIdentityStatus?globalThis.__codexBundleIdentityStatus():{}),",
    "...(globalThis.__codexBundleIdentityStatus?globalThis.__codexBundleIdentityStatus():{})," +
      "...(globalThis.__codexGuardModuleIdentityStatus?globalThis.__codexGuardModuleIdentityStatus():" +
      "{guardModuleIdentityState:\"IDENTITY_UNREADABLE\"," +
      "guardModuleIdentityError:\"guard module identity helper is missing from this bundle\"," +
      "guardModuleCombinedSha256:null,guardModules:{}}),"
  );

  text += "\n/* codex patch rc.7.14d: guard module identity */\n";
}

// ==================================================================
// codex patch rc.7.14e: 把 guard 模块身份接进**唯一**就绪门禁（fail closed）
// ------------------------------------------------------------------
// R1 的缺口（supervisor P1）：rc.7.14d 只把身份字段 spread 进 /status，
// 而 spread 发生在 trueReady **已经算完之后**，且 __codexTrueReadyStatus /
// __acquire / HTTP 预检 三处都不引用它 → 下面这种状态完全可表示：
//     { "trueReady": true, "guardModuleIdentityState": "MODULE_UNREADABLE" }
// 也就是「身份坏了但照常放行」。这与 Phase 1B「缺失/不可读模块必须 fail closed」冲突。
//
// 修法（不新增并行策略路径）：__codexTrueReadyStatus 是**单点**就绪门禁，
// 4 个消费点（/status、acquire、HTTP 预检、状态栏轮询）全部经它，
// 因此只在门禁里插一次早退，acquire/预检 天然经 control_plane_core.acquireDecision
// 的 `!ready.ready → 423 not-ready` 拒绝，/status 天然 trueReady:false。
//
// 恢复通道保留（要求 4）：acquireDecision 里 `gate.required` 分支**先于** `!ready.ready`，
// 故带合法 token 的 recovery-smoke 仍可放行；且 POST /force-reset 直接调
// __codexForceReset、GET /status 无条件 200，两者都不经就绪门禁 —— 隔离 profile 仍可修。
//
// 身份策略只写一份：__codexGuardIdentityVerdict。门禁与 4 个回退表达式都调它。
if (!text.includes("codex-guard-identity-admission-v1")) {
  // ---- 单一策略源：身份裁决（null = 放行；否则 = not-ready 结论）----
  const verdictRuntime =
    "globalThis.__codexGuardIdentityVerdict=function(){" +
    "try{" +
    "var __S=globalThis.__codexGuardModuleIdentityStatus;" +
    "if(typeof __S!==\"function\"){" +
    // 身份助手缺失：仅当 rc.7.14 全局导出契约在场（=本 bundle 确实打过 guard 补丁）
    // 才算完整性故障；未打补丁的 bundle 不应被凭空判死。
    "if(globalThis.__codexExecGuardRef||globalThis.__codexPreRunGuardRef)" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard module identity helper is missing from this bundle\"};" +
    "return null}" +
    "var __I=__S()||{},__st=String(__I.guardModuleIdentityState||\"UNKNOWN\");" +
    "if(__st===\"OK\")return null;" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard module identity \"+__st+\": \"+(__I.guardModuleIdentityError||\"unknown\")}" +
    "}catch(__ve){" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard module identity check threw: \"+String((__ve&&__ve.message)||__ve)}}};" +
    // ---- 回退路径的唯一实现：主门禁缺失时也要按同一策略判 ----
    "globalThis.__codexReadinessFallback=function(__b,__base){" +
    "var __s=__b||globalThis.__codexBridgeState||{};" +
    "var __st2=__base||(__s.busy?\"running\":(__s.postRunBusy?\"draining\":\"idle\"));" +
    "try{var __v=globalThis.__codexGuardIdentityVerdict?globalThis.__codexGuardIdentityVerdict():null;" +
    "if(__v)return __v}catch(__fe){" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard module identity check threw: \"+String((__fe&&__fe.message)||__fe)}}" +
    // 补丁在场却没有共享门禁 = 完整性故障（而不是"退回旧语义"）
    "if(typeof globalThis.__codexTrueReadyStatus!==\"function\"&&" +
    "(globalThis.__codexExecGuardRef||globalThis.__codexPreRunGuardRef))" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"shared readiness gate is missing from this bundle\"};" +
    "return{ready:!__s.busy&&!__s.postRunBusy,status:__st2,reason:null}};" +
    "/* codex-guard-identity-admission-v1 */";

  replaceOnce(
    "rc.7.14e identity verdict runtime",
    "/* codex-guard-module-identity-v1 */",
    "/* codex-guard-module-identity-v1 */" + verdictRuntime
  );

  // ---- 门禁内早退：放在 pre-acquire barrier 之后、graph readiness 之前 ----
  // 位置理由：recovery-required / continuity-lost 是**可操作**状态，应先于身份暴露给运维；
  // 而"recovery gate 先于 graph readiness"这条既有次序（rc.6.4 注释）不得被打乱。
  const gateInsert =
    "try{var __idfn=globalThis.__codexGuardIdentityVerdict;" +
    "if(typeof __idfn!==\"function\"){" +
    "if(globalThis.__codexExecGuardRef||globalThis.__codexPreRunGuardRef)" +
    "return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard identity verdict helper is missing from this bundle\"}}" +
    "else{var __idv=__idfn();if(__idv)return __idv}" +
    "}catch(__ie){return{ready:false,status:\"identity-unreadable\"," +
    "reason:\"guard module identity check threw: \"+String((__ie&&__ie.message)||__ie)}}" +
    "/* codex patch rc.7.14e: guard module identity fails closed in the single readiness gate */";

  replaceOnce(
    "rc.7.14e readiness gate identity early-return",
    "/* codex patch v7.25d: /status trueReady honors pre-acquire barrier without blocking acquire */",
    "/* codex patch v7.25d: /status trueReady honors pre-acquire barrier without blocking acquire */" + gateInsert
  );

  // ---- 4 个消费点的内联回退改走共享实现 ----
  // 这 4 处**文本并不一致**（实参顺序、`!(a||b)` vs `!a&&!b`、有无 globalThis 前缀都不同），
  // 所以逐条用各自的完整三元表达式做锚点；replaceOnce 自带唯一性断言。
  // 只patch其中3处会造出"/status fail closed 但 acquire 仍放行"的更坏形态，故末尾硬断言 =4。
  const consumerFallbacks = [
    ["status endpoint",
     "globalThis.__codexTrueReadyStatus?globalThis.__codexTrueReadyStatus(o,s):{ready:!o.busy&&!o.postRunBusy,status:s,reason:null}",
     "globalThis.__codexTrueReadyStatus?globalThis.__codexTrueReadyStatus(o,s):(globalThis.__codexReadinessFallback?globalThis.__codexReadinessFallback(o,s):{ready:!o.busy&&!o.postRunBusy,status:s,reason:null})"],
    ["normal acquire",
     "globalThis.__codexTrueReadyStatus?__codexTrueReadyStatus(s,__codexAcquireStatus):{ready:!s.busy&&!s.postRunBusy,reason:null,status:__codexAcquireStatus}",
     "globalThis.__codexTrueReadyStatus?__codexTrueReadyStatus(s,__codexAcquireStatus):(globalThis.__codexReadinessFallback?globalThis.__codexReadinessFallback(s,__codexAcquireStatus):{ready:!s.busy&&!s.postRunBusy,reason:null,status:__codexAcquireStatus})"],
    ["http preflight",
     "globalThis.__codexTrueReadyStatus?globalThis.__codexTrueReadyStatus(s,__base):{ready:!s.busy&&!s.postRunBusy,status:__base,reason:null}",
     "globalThis.__codexTrueReadyStatus?globalThis.__codexTrueReadyStatus(s,__base):(globalThis.__codexReadinessFallback?globalThis.__codexReadinessFallback(s,__base):{ready:!s.busy&&!s.postRunBusy,status:__base,reason:null})"],
    ["status bar poller",
     "globalThis.__codexTrueReadyStatus?__codexTrueReadyStatus(s):{ready:!(s.busy||s.postRunBusy),status:s.busy?\"running\":s.postRunBusy?\"draining\":\"idle\",reason:null}",
     "globalThis.__codexTrueReadyStatus?__codexTrueReadyStatus(s):(globalThis.__codexReadinessFallback?globalThis.__codexReadinessFallback(s):{ready:!(s.busy||s.postRunBusy),status:s.busy?\"running\":s.postRunBusy?\"draining\":\"idle\",reason:null})"],
  ];
  for (const [nm, before, after] of consumerFallbacks) {
    replaceOnce("rc.7.14e fallback: " + nm, before, after);
  }
  const fbCount = text.split("globalThis.__codexReadinessFallback(").length - 1;
  if (fbCount !== 4) {
    throw new Error(
      "rc.7.14e: 回退改写数必须为 4，实得 " + fbCount +
      "（只改一部分会造出 /status fail closed 而 acquire 仍放行的更坏状态）"
    );
  }

  text += "\n/* codex patch rc.7.14e: guard identity admission */\n";
}

// ==================================================================
// codex patch rc.7.16: runtime admission closure (PF-1 / PF-2 / PF-3)
// ------------------------------------------------------------------
// PF-1: human-file snapshot/enrich errors occur before the existing payload
// try/catch, so its error release cannot run. Release graph/readiness ownership
// and checkpoint state at the pre-dispatch catch before rethrowing the same error.
// PF-3: a matching checkpoint can exist before transport dispatch. Do not let a
// drain-only early return skip restore in that window.
// PF-2: kM intentionally converts exceptions into result objects. Preserve the
// guard envelope on that result, map its HTTP status, and expose it on /status.
if (!text.includes("codex patch rc.7.16: runtime admission closure")) {
  replaceOnce(
    "human-file pre-dispatch timeout releases graph ownership and checkpoint state",
    'catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI("[Codex human-file] pre-run stage timeout; refusing to dispatch payload: "+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}throw __snapshotError}',
    'catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI("[Codex human-file] pre-run stage timeout; refusing to dispatch payload: "+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}try{globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r);if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(r))globalThis.__codexActivePreRunSnapshot=null}catch{}try{globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(r,"human-file-predispatch-error-release"):globalThis.__codexSetPostRunBusy&&__codexSetPostRunBusy(false,"human-file-predispatch-error-release",r);globalThis.__codexGraphMark&&__codexGraphMark({lastClientError:String(__snapshotError?.message||__snapshotError)})}catch{}/* codex patch rc.7.16: human-file pre-dispatch failure cleanup */throw __snapshotError}'
  );

  replaceOnce(
    "soft Stop identifies a matching restore-capable pre-dispatch checkpoint",
    '__snapshot=__snapshotRegistry.get(__runId)||__snapshotRegistry.get(String(__runId||""))||(__activeSnapshot&&String(__activeSnapshot.runId)===String(__runId)?__activeSnapshot:null),__cancelled=false,',
    '__snapshot=__snapshotRegistry.get(__runId)||__snapshotRegistry.get(String(__runId||""))||(__activeSnapshot&&String(__activeSnapshot.runId)===String(__runId)?__activeSnapshot:null),__codexPreDispatchRestore=!!(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)&&!(zg._activeRun&&zg._activeRun.taskId)),__cancelled=false,/* codex patch rc.7.16: pre-dispatch Stop restores matching checkpoint */'
  );
  replaceOnce(
    "soft Stop drain failure does not skip a matching pre-dispatch restore",
    'if(!__drained){globalThis.__codexLastSoftStop=',
    'if(!__drained&&!__codexPreDispatchRestore){globalThis.__codexLastSoftStop='
  );
  replaceOnce(
    "soft Stop success accepts a completed pre-dispatch restore without fake drain",
    'ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,taskCancel:',
    'ok:!!((__drained||__codexPreDispatchRestore)&&__restore&&__restore.ok!==false),cancelled:__cancelled,drainedForRestore:!!(__drained||__codexPreDispatchRestore),taskCancel:'
  );

  replaceOnce(
    "terminal progress guard records its full failure envelope before throwing",
    'recoveryRequired:!!__codexTermState.recoveryRequired,elapsedMs:__codexTermState.elapsedMs};throw __codexTermErr}',
    'recoveryRequired:!!__codexTermState.recoveryRequired,elapsedMs:__codexTermState.elapsedMs};globalThis.__codexLastTerminalFailure=__codexTermErr.__codexPreRunTimeout;throw __codexTermErr}'
  );
  replaceOnce(
    "terminal result conversion preserves the guard failure envelope",
    'return __codexFinish({success:!1,rc:-1,stderr:I?.message||String(I),error:{message:I?.message||String(I)}})}},XRA=',
    'return __codexFinish({success:!1,rc:-1,stderr:I?.message||String(I),error:{message:I?.message||String(I)},guardFailure:I&&I.__codexPreRunTimeout||null})}},XRA='
  );
  replaceOnce(
    "debug terminal endpoint maps preserved guard failures to their HTTP status",
    '__terminalGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,__terminalOk=!(__terminalResult&&( __terminalResult.success===!1||__terminalResult.error||(__terminalResult.rc&&__terminalResult.rc!==0)));__send(__res,__terminalOk?200:500,{ok:__terminalOk,',
    '__terminalGraph=globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null,__terminalGuardFailure=__terminalResult&&__terminalResult.guardFailure||null,__terminalOk=!(__terminalResult&&( __terminalResult.success===!1||__terminalResult.error||(__terminalResult.rc&&__terminalResult.rc!==0)));__send(__res,__terminalOk?200:(__terminalGuardFailure&&__terminalGuardFailure.status)||500,{ok:__terminalOk,guardFailure:__terminalGuardFailure||null,'
  );
  replaceOnce(
    "status exposes the latest terminal guard failure envelope",
    'lastSoftStop:globalThis.__codexLastSoftStop||null,preRunSnapshot:',
    'lastSoftStop:globalThis.__codexLastSoftStop||null,lastTerminalGuardFailure:globalThis.__codexLastTerminalFailure||null,preRunSnapshot:'
  );
  replaceOnce(
    "status exposes C4 restore-capable residency",
    'preRunStageState:globalThis.__codexPreRunGuardRef.publicStageSummary(globalThis.__codexPreRunStage||null),lastForceResetReconnect:',
    'preRunStageState:(()=>{let __p=globalThis.__codexPreRunGuardRef.publicStageSummary(globalThis.__codexPreRunStage||null),__snap=globalThis.__codexActivePreRunSnapshot||null;return __p?Object.assign({},__p,{payloadDispatched:!!__p.payloadDispatched,restoreCapable:!!(__snap&&__snap.path&&JA.existsSync(__snap.path))}):null})(),lastForceResetReconnect:'
  );

  text += "\n/* codex patch rc.7.16: runtime admission closure */\n";
}

// ==================================================================
// codex patch rc.7.17: publish provisional human-file checkpoints
// ------------------------------------------------------------------
// Stata writes the dataset file before runSelection resolves. A Stop in that
// interval must resolve the exact run-owned checkpoint without scanning /tmp.
// Publish a provisional record before dispatch and use one fail-closed
// restore-capability predicate for both soft-stop and /status.
if (!text.includes("codex patch rc.7.17: provisional checkpoint publication")) {
  replaceOnce(
    "publish the human-file provisional checkpoint before snapshot dispatch",
    '__snapshotCode="capture preserve\\ncapture quietly save \\\""+__codexStataString(__snapshotPath)+"\\\", replace\\ncapture restore\\n";let __codexHfSnapStage=',
    '__snapshotCode="capture preserve\\ncapture quietly save \\\""+__codexStataString(__snapshotPath)+"\\\", replace\\ncapture restore\\n";__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:null,runId:r,at:null,provisional:true};globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);globalThis.__codexActivePreRunSnapshot=__codexHumanFilePreRunSnapshot;let __codexHfSnapStage='
  );
  replaceOnce(
    "complete the existing provisional checkpoint after snapshot dispatch",
    '__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:__stat.size,runId:r,at:new Date().toISOString()};globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);await (async()=>',
    'Object.assign(__codexHumanFilePreRunSnapshot,{bytes:__stat.size,at:new Date().toISOString(),provisional:false});globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);globalThis.__codexActivePreRunSnapshot=__codexHumanFilePreRunSnapshot;await (async()=>'
  );
  replaceOnce(
    "soft Stop uses the shared restore-capability predicate",
    '__codexPreDispatchRestore=!!(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)&&!(zg._activeRun&&zg._activeRun.taskId))',
    '__codexPreDispatchRestore=!!(globalThis.__codexStopCheckpointRef.isRestoreCapable(__snapshot)&&!(zg._activeRun&&zg._activeRun.taskId))'
  );
  replaceOnce(
    "status uses the shared restore-capability predicate",
    'restoreCapable:!!(__snap&&__snap.path&&JA.existsSync(__snap.path))',
    'restoreCapable:!!globalThis.__codexStopCheckpointRef.isRestoreCapable(__snap)'
  );
  text += "\n/* codex patch rc.7.17: provisional checkpoint publication */\n";
}

// rc.7.17 still required the snapshot/enrich task to have no active task id,
// which is impossible in the exact early window this path exists to cover.
if (!text.includes("codex patch rc.7.18: active pre-run task remains restore-capable")) {
  replaceOnce(
    "a complete run-owned checkpoint is restore-capable even while its pre-run task is active",
    '__codexPreDispatchRestore=!!(globalThis.__codexStopCheckpointRef.isRestoreCapable(__snapshot)&&!(zg._activeRun&&zg._activeRun.taskId))',
    '__codexPreDispatchRestore=!!globalThis.__codexStopCheckpointRef.isRestoreCapable(__snapshot)/* codex patch rc.7.18: active pre-run task remains restore-capable */'
  );
  text += "\n/* codex patch rc.7.18: active pre-run task remains restore-capable */\n";
}

// ==================================================================
// codex patch rc.7.19: atomic pre-run checkpoint transport
// ------------------------------------------------------------------
// rc.7.18 dispatched snapshot and enrichment as two consecutive runSelection
// calls. S43 proved that task_done/readiness can precede owner-loop transport
// reuse: the DTA existed, but the immediately following enrichment never got a
// log path and timed out. Dispatch one Stata command instead. The snapshot guard
// waits for the post-save milestone; the enrich guard waits for that same command
// to settle. A legacy enrichment dispatch is allowed only if the atomic command
// settles with incomplete sidecar state.
if (!text.includes("codex patch rc.7.19: atomic pre-run checkpoint transport")) {
  const humanStart = "let __codexHumanFilePreRunSnapshot=null;try{";
  const humanEnd = "/* codex patch rc.7.10: pre-run dataset snapshot for soft Stop */";
  const humanAtomic =
    "let __codexHumanFilePreRunSnapshot=null;try{" +
    "let __os=require(\"node:os\"),__path=require(\"node:path\")," +
    "__snapshotPath=__path.join(__os.tmpdir(),\"codex_prerun_state_\"+String(r||Date.now()).replace(/[^A-Za-z0-9_.-]/g,\"_\")+\".dta\")," +
    "__codexCheckpointRunId=String(r||Date.now());" +
    "__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:null,runId:r,sourceMode:\"human-file\",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};" +
    "globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);" +
    "globalThis.__codexActivePreRunSnapshot=__codexHumanFilePreRunSnapshot;" +
    "let __codexHfAtomic=null," +
    "__codexHfSnapStage=globalThis.__codexPreRunGuardRef.createStageState(\"snapshot\",{runId:r,sourceMode:\"human-file\",snapshotPath:__snapshotPath});" +
    "globalThis.__codexPreRunStage=__codexHfSnapStage;" +
    "let __codexHfSnapGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"snapshot\",()=>{" +
    "__codexHfAtomic=globalThis.__codexStopCheckpointRef.beginAtomic({snapshot:__codexHumanFilePreRunSnapshot," +
    "runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:C,sourceMode:\"human-file\"});" +
    "return __codexHfAtomic.snapshotReady},{state:__codexHfSnapStage," +
    "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
    "cancelRun:()=>(globalThis.__codexGuardTransport&&__codexHfAtomic?globalThis.__codexGuardTransport.cancelRun(__codexHfAtomic.runId):false)," +
    "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
    "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null)," +
    "log:(m)=>{try{RI(m)}catch{}}});" +
    "if(!__codexHfSnapGuard.ok)throw Object.assign(new Error(globalThis.__codexPreRunGuardRef.TIMEOUT_CODE.snapshot),{__codexPreRunTimeout:globalThis.__codexPreRunGuardRef.timeoutResponse(\"snapshot\",__codexHfSnapStage)});" +
    "Object.assign(__codexHumanFilePreRunSnapshot,{bytes:JA.statSync(__snapshotPath).size,at:new Date().toISOString(),provisional:false});" +
    "let __codexHfEnrichStage=globalThis.__codexPreRunGuardRef.createStageState(\"enrich\",{runId:r,sourceMode:\"human-file\",snapshotPath:__snapshotPath});" +
    "globalThis.__codexPreRunStage=__codexHfEnrichStage;" +
    "let __codexHfEnrichGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"enrich\",()=>globalThis.__codexStopCheckpointRef.completeAtomic(__codexHfAtomic),{state:__codexHfEnrichStage," +
    "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
    "cancelRun:()=>(globalThis.__codexGuardTransport&&__codexHfAtomic?globalThis.__codexGuardTransport.cancelRun(__codexHfAtomic.runId):false)," +
    "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
    "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null)," +
    "log:(m)=>{try{RI(m)}catch{}}});" +
    "if(!__codexHfEnrichGuard.ok)throw Object.assign(new Error(globalThis.__codexPreRunGuardRef.TIMEOUT_CODE.enrich),{__codexPreRunTimeout:globalThis.__codexPreRunGuardRef.timeoutResponse(\"enrich\",__codexHfEnrichStage)});" +
    "Object.assign(__codexHumanFilePreRunSnapshot,{atomicDispatchCount:Number(__codexHumanFilePreRunSnapshot.atomicDispatchCount||0),fallbackDispatchCount:Number(__codexHfAtomic.fallbackDispatchCount||0)});" +
    "}catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI(\"[Codex human-file] pre-run stage timeout; refusing to dispatch payload: \"+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}try{globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r);if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(r))globalThis.__codexActivePreRunSnapshot=null}catch{}try{globalThis.__codexFinishGraphRunNoExport?__codexFinishGraphRunNoExport(r,\"human-file-predispatch-error-release\"):globalThis.__codexSetPostRunBusy&&__codexSetPostRunBusy(false,\"human-file-predispatch-error-release\",r);globalThis.__codexGraphMark&&__codexGraphMark({lastClientError:String(__snapshotError?.message||__snapshotError)})}catch{}/* codex patch rc.7.16: human-file pre-dispatch failure cleanup */throw __snapshotError}try{RI(\"[Codex human-file] pre-run dataset snapshot failed: \"+(__snapshotError?.message||__snapshotError))}catch{}}" +
    humanEnd;
  replaceSpanOnce("rc.7.19 human-file atomic checkpoint", humanStart, humanEnd, humanAtomic);

  const bridgeStart = "let __codexBridgePreRunSnapshot=null;try{";
  const bridgeEnd = "/* codex patch rc.7.10.36: visible bridge snapshots pre-run dataset */";
  const bridgeAtomic =
    "let __codexBridgePreRunSnapshot=null;try{" +
    "let __os=require(\"node:os\"),__path=require(\"node:path\")," +
    "__snapshotPath=__path.join(__os.tmpdir(),\"codex_prerun_agent_state_\"+String(__run||Date.now()).replace(/[^A-Za-z0-9_.-]/g,\"_\")+\".dta\")," +
    "__codexCheckpointRunId=String(__run||Date.now());" +
    "__codexBridgePreRunSnapshot={path:__snapshotPath,bytes:null,runId:__run,sourceMode:\"visible-bridge\",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};" +
    "globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot);" +
    "globalThis.__codexPreRunSnapshots.set(String(__run),__codexBridgePreRunSnapshot);" +
    "globalThis.__codexActivePreRunSnapshot=__codexBridgePreRunSnapshot;" +
    "let __codexBridgeAtomic=null," +
    "__codexSnapStage=globalThis.__codexPreRunGuardRef.createStageState(\"snapshot\",{runId:__run,sourceMode:\"visible-bridge\",snapshotPath:__snapshotPath});" +
    "globalThis.__codexPreRunStage=__codexSnapStage;" +
    "let __codexSnapGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"snapshot\",()=>{" +
    "__codexBridgeAtomic=globalThis.__codexStopCheckpointRef.beginAtomic({snapshot:__codexBridgePreRunSnapshot," +
    "runSelection:(__code,__options)=>zg.runSelection(__code,__options),stataString:__codexStataString,cwd:__cwd,sourceMode:\"visible-bridge\"});" +
    "return __codexBridgeAtomic.snapshotReady},{state:__codexSnapStage," +
    "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
    "cancelRun:()=>(globalThis.__codexGuardTransport&&__codexBridgeAtomic?globalThis.__codexGuardTransport.cancelRun(__codexBridgeAtomic.runId):false)," +
    "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
    "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null)," +
    "log:(m)=>{try{RI(m)}catch{}}});" +
    "if(!__codexSnapGuard.ok)throw Object.assign(new Error(globalThis.__codexPreRunGuardRef.TIMEOUT_CODE.snapshot),{__codexPreRunTimeout:globalThis.__codexPreRunGuardRef.timeoutResponse(\"snapshot\",__codexSnapStage)});" +
    "Object.assign(__codexBridgePreRunSnapshot,{bytes:JA.statSync(__snapshotPath).size,at:new Date().toISOString(),provisional:false});" +
    "let __codexEnrichStage=globalThis.__codexPreRunGuardRef.createStageState(\"enrich\",{runId:__run,sourceMode:\"visible-bridge\",snapshotPath:__snapshotPath});" +
    "globalThis.__codexPreRunStage=__codexEnrichStage;" +
    "let __codexEnrichGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"enrich\",()=>globalThis.__codexStopCheckpointRef.completeAtomic(__codexBridgeAtomic),{state:__codexEnrichStage," +
    "cancelTask:(__tid)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelTask(__tid):false)," +
    "cancelRun:()=>(globalThis.__codexGuardTransport&&__codexBridgeAtomic?globalThis.__codexGuardTransport.cancelRun(__codexBridgeAtomic.runId):false)," +
    "cancelAll:()=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.cancelAll():false)," +
    "supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null)," +
    "log:(m)=>{try{RI(m)}catch{}}});" +
    "if(!__codexEnrichGuard.ok)throw Object.assign(new Error(globalThis.__codexPreRunGuardRef.TIMEOUT_CODE.enrich),{__codexPreRunTimeout:globalThis.__codexPreRunGuardRef.timeoutResponse(\"enrich\",__codexEnrichStage)});" +
    "Object.assign(__codexBridgePreRunSnapshot,{atomicDispatchCount:Number(__codexBridgePreRunSnapshot.atomicDispatchCount||0),fallbackDispatchCount:Number(__codexBridgeAtomic.fallbackDispatchCount||0)});" +
    "/* codex patch rc.7.10.37: Stop resolves the active Agent snapshot */" +
    "}catch(__snapshotError){if(__snapshotError&&__snapshotError.__codexPreRunTimeout){try{RI(\"[Codex bridge] pre-run stage timeout; refusing to dispatch payload: \"+JSON.stringify(__snapshotError.__codexPreRunTimeout))}catch{}throw __snapshotError}try{RI(\"[Codex bridge] pre-run dataset snapshot failed: \"+(__snapshotError?.message||__snapshotError))}catch{}}" +
    bridgeEnd;
  replaceSpanOnce("rc.7.19 Agent atomic checkpoint", bridgeStart, bridgeEnd, bridgeAtomic);
  text += "\n/* codex patch rc.7.19: atomic pre-run checkpoint transport */\n";
}

if (!text.includes("codex patch rc.7.19: atomic snapshot milestone admission")) {
  replaceOnce(
    "soft Stop requires the completed atomic snapshot milestone",
    '__codexPreDispatchRestore=!!globalThis.__codexStopCheckpointRef.isRestoreCapable(__snapshot)/* codex patch rc.7.18: active pre-run task remains restore-capable */',
    '__codexPreDispatchRestore=!!globalThis.__codexStopCheckpointRef.isSnapshotReady(__snapshot)/* codex patch rc.7.18: active pre-run task remains restore-capable *//* codex patch rc.7.19: atomic snapshot milestone admission */'
  );
  replaceOnce(
    "status requires the completed atomic snapshot milestone",
    'restoreCapable:!!globalThis.__codexStopCheckpointRef.isRestoreCapable(__snap)',
    'restoreCapable:!!globalThis.__codexStopCheckpointRef.isSnapshotReady(__snap)'
  );
  text += "\n/* codex patch rc.7.19: atomic snapshot milestone admission */\n";
}

if (!text.includes("codex patch rc.7.19b: clean before provisional publication")) {
  replaceOnce(
    "human-file removes stale checkpoint bytes before provisional publication",
    '__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:null,runId:r,sourceMode:"human-file",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);',
    '__codexHumanFilePreRunSnapshot={path:__snapshotPath,bytes:null,runId:r,sourceMode:"human-file",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.set(r,__codexHumanFilePreRunSnapshot);'
  );
  replaceOnce(
    "Agent removes stale checkpoint bytes before provisional publication",
    '__codexBridgePreRunSnapshot={path:__snapshotPath,bytes:null,runId:__run,sourceMode:"visible-bridge",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot);',
    '__codexBridgePreRunSnapshot={path:__snapshotPath,bytes:null,runId:__run,sourceMode:"visible-bridge",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0};globalThis.__codexStopCheckpointRef.cleanup(__codexBridgePreRunSnapshot);globalThis.__codexPreRunSnapshots.set(__run,__codexBridgePreRunSnapshot);'
  );
  text += "\n/* codex patch rc.7.19b: clean before provisional publication */\n";
}

if (!text.includes("codex patch rc.7.20: Stop-owned human snapshot survives cancellation race")) {
  replaceOnce(
    "human-file pre-dispatch failure preserves a Stop-owned ready snapshot",
    'try{globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r);if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(r))globalThis.__codexActivePreRunSnapshot=null}catch{}try{globalThis.__codexFinishGraphRunNoExport?',
    'try{if(globalThis.__codexStopCheckpointRef.shouldCleanupAfterFailure(__codexHumanFilePreRunSnapshot)){globalThis.__codexStopCheckpointRef.cleanup(__codexHumanFilePreRunSnapshot);globalThis.__codexPreRunSnapshots.delete(r);if(globalThis.__codexActivePreRunSnapshot&&String(globalThis.__codexActivePreRunSnapshot.runId)===String(r))globalThis.__codexActivePreRunSnapshot=null}}catch{}/* codex patch rc.7.20: Stop-owned human snapshot survives cancellation race */try{globalThis.__codexFinishGraphRunNoExport?'
  );
  text += "\n/* codex patch rc.7.20: Stop-owned human snapshot survives cancellation race */\n";
}

if (!text.includes("codex patch rc.7.21: successful hard reset owns final readiness")) {
  replaceOnce(
    "soft Stop keeps successful hard-reset readiness after a failed restore",
    'try{globalThis.__codexGraphMark&&__codexGraphMark({readinessState:__restore&&__restore.ok===false?"stale":"ready",readinessReason:__restore&&__restore.ok===false?"soft-stop dataset restore failed":"soft-stop-complete",readinessRunId:__runId,readinessUpdatedAt:new Date().toISOString(),lastClientError:__restore&&__restore.ok===false?String(__restore.error||"dataset restore failed"):null})}catch{}',
    'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);globalThis.__codexGraphMark&&__codexGraphMark({readinessState:__codexStopReady.readinessState,readinessReason:__codexStopReady.readinessReason,readinessRunId:__runId,readinessUpdatedAt:new Date().toISOString(),lastClientError:__codexStopReady.lastClientError})}catch{}/* codex patch rc.7.21: successful hard reset owns final readiness */'
  );
  text += "\n/* codex patch rc.7.21: successful hard reset owns final readiness */\n";
}

if (!text.includes("codex patch rc.7.22: configured runtime patch is fail-closed")) {
  text += "\n/* codex patch rc.7.22: configured runtime patch is fail-closed */\n";
}

if (!text.includes("codex patch rc.7.23: empty-session checkpoint is restore-capable")) {
  text += "\n/* codex patch rc.7.23: empty-session checkpoint is restore-capable */\n";
}

if (!text.includes("codex patch rc.7.24: checkpoint marker uses byte-stable Stata tabs")) {
  text += "\n/* codex patch rc.7.24: checkpoint marker uses byte-stable Stata tabs */\n";
}

if (!text.includes("codex patch rc.7.25: per-run log completion is fail-closed")) {
  replaceOnce(
    "rc.7.25 visible runs require their own completion evidence",
    '__codexExecution.beginRun(s,{requestId:o.runId,runId:o.runId,sourceMode:o.source});return true',
    '__codexExecution.beginRun(s,{requestId:o.runId,runId:o.runId,sourceMode:o.source,perRunEvidenceRequired:true});return true'
  );
  replaceOnce(
    "rc.7.25 release trusts only the actual per-run log",
    '}catch{}let __completion=!!(__life.completionMarkerVerified||(o&&o.completionMarkerVerified)||(__inspection&&__inspection.completionMarkerVerified)),__rc=',
    '}catch{}if(__inspection&&__inspection.completionMarkerVerified)try{__codexExecution.recordPerRunCompletionMarker(s,Date.now(),__life.runId)}catch{}let __completion=!!(__life.perRunCompletionMarkerVerified||(__inspection&&__inspection.completionMarkerVerified)),__rc='
  );
  replaceOnce(
    "rc.7.25 bridge response reports lifecycle verification only",
    'completionMarkerVerified:!!((__r&&__r.completionMarkerVerified)||__codexExecution.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified),/* codex patch rc.7: lifecycle release proof */',
    'completionMarkerVerified:!!__codexExecution.ensureLifecycle(globalThis.__codexBridgeState||{}).perRunCompletionMarkerVerified,/* codex patch rc.7: lifecycle release proof */'
  );
  replaceOnce(
    "rc.7.25 log ingestion separates callbacks from per-run disk evidence",
    'const ingestLogText = (text, updateActivity) => {',
    'const ingestLogText = (text, updateActivity, perRunDiskEvidence = false) => {'
  );
  replaceOnce(
    "rc.7.25 exact marker records only per-run disk verification",
    'if(__inspection.completionMarkerVerified){globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState||{},Date.now(),runId)}',
    'if(__inspection.completionMarkerVerified&&perRunDiskEvidence){globalThis.__codexExecutionAdapter.recordPerRunCompletionMarker(globalThis.__codexBridgeState||{},Date.now(),runId)}'
  );
  replaceOnce(
    "rc.7.25 callback output is not disk verification",
    'ingestLogText(text, true);',
    'ingestLogText(text, true, false);'
  );
  replaceOnce(
    "rc.7.25 polled per-run log is disk verification",
    'ingestLogText(snap.text, grew);',
    'ingestLogText(snap.text, grew, true);'
  );
  replaceOnce(
    "rc.7.25 upstream completion boolean cannot verify the per-run log",
    `      if (__codexBaseResult.completionMarkerVerified === true) {
        try { globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState || {}, Date.now(), runId); } catch {}
      }
      __codexResolveBaseResultIfReady();`,
    `      /* Upstream completion may come from a later session SMCL write. Only
         the polled per-run file can verify HTTP success. */
      __codexResolveBaseResultIfReady();`
  );
  replaceOnce(
    "rc.7.25 session search runs until either evidence class is found",
    'if (!globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {}).completionMarkerVerified) try {/* codex patch rc.7.10.23: authoritative exact marker releases unsettled transport */',
    'if (!globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState || {}).sessionCompletionMarkerAt) try {/* codex patch rc.7.10.23: authoritative exact marker releases unsettled transport */'
  );
  replaceOnce(
    "rc.7.25 classify authoritative log evidence",
    `        if (__codexSessionEvidence?.inspection?.completionMarkerVerified) {
          globalThis.__codexExecutionAdapter.recordCompletionMarker(globalThis.__codexBridgeState || {}, now, runId);
          state.lastEvidenceAt = now;
          state.lastEvidenceType = "authoritative-session-log-marker";
        }`,
    `        if (__codexSessionEvidence?.inspection?.completionMarkerVerified) {
          if (__codexSessionEvidence.logKind === "per-run") {
            state.logPath = __codexSessionEvidence.logPath;
            state.logSize = __codexSessionEvidence.size;
            globalThis.__codexExecutionAdapter.recordLogPath(globalThis.__codexBridgeState || {}, state.logPath, now, runId);
            globalThis.__codexExecutionAdapter.recordPerRunCompletionMarker(globalThis.__codexBridgeState || {}, now, runId);
            state.lastEvidenceType = "per-run-log-marker";
          } else {
            globalThis.__codexExecutionAdapter.recordSessionCompletionMarker(globalThis.__codexBridgeState || {}, now, runId);
            state.lastEvidenceType = "authoritative-session-log-marker";
          }
          state.lastEvidenceAt = now;
        }`
  );
  replaceOnce(
    "rc.7.25 either marker can settle a missing task_done",
    'if (!__codexBaseSettled && __codexMarkerLife.completionMarkerVerified === true && !__codexTransportMarkerSettlementRequested) {',
    'if (!__codexBaseSettled && (__codexMarkerLife.sessionCompletionMarkerAt||__codexMarkerLife.perRunCompletionMarkerVerified===true) && !__codexTransportMarkerSettlementRequested) {'
  );
  replaceOnce(
    "rc.7.25 bounded per-run convergence failure",
    `      /* codex patch rc.7.10.24: exact marker settles missing task_done */
      if (__codexResolveBaseResultIfReady()) return;`,
    `      /* codex patch rc.7.10.24: exact marker settles missing task_done */
      const __codexPerRunDecision = globalThis.__codexExecutionAdapter.perRunLogCompletionDecision({
        sessionCompletionMarkerAt: __codexMarkerLife.sessionCompletionMarkerAt,
        perRunCompletionMarkerVerified: __codexMarkerLife.perRunCompletionMarkerVerified,
        now,
        graceMs: 10000
      });
      if (__codexPerRunDecision.failed) {
        const __codexPerRunMessage = "PER_RUN_LOG_INCOMPLETE: Stata completed, but the per-run log did not converge within 10 seconds.";
        globalThis.__codexExecutionAdapter.recordPerRunEvidenceFailure(
          globalThis.__codexBridgeState || {},
          "PER_RUN_LOG_INCOMPLETE",
          now,
          runId
        );
        settled = true;
        clear();
        state.watchdogReleased = true;
        state.sawError = true;
        resolve({
          ok: false,
          rc: 11003,
          code: "PER_RUN_LOG_INCOMPLETE",
          success: false,
          hasError: true,
          stdout: state.tail,
          contentText: state.tail,
          stderr: __codexPerRunMessage,
          error: { message: __codexPerRunMessage, code: "PER_RUN_LOG_INCOMPLETE" },
          durationMs: elapsedMs,
          logPath: state.logPath,
          logSize: state.logSize >= 0 ? state.logSize : null,
          completionMarkerVerified: false,
          __codexWatchdogRelease: true,
          __codexPerRunLogIncomplete: true
        });
        return;
      }
      if (__codexResolveBaseResultIfReady()) return;`
  );
  replaceOnce(
    "rc.7.25 completed-log watchdog requires per-run evidence",
    'if (__codexBaseSettled && globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).completionMarkerVerified===true && !state.sawError && idleMs >= completionIdleMs)',
    'if (__codexBaseSettled && globalThis.__codexExecutionAdapter.ensureLifecycle(globalThis.__codexBridgeState||{}).perRunCompletionMarkerVerified===true && !state.sawError && idleMs >= completionIdleMs)'
  );
  text += "\n/* codex patch rc.7.25: per-run log completion is fail-closed */\n";
}

// ==================================================================
// codex patch rc.7.13: guard 接线（唯一权威实现）
// ------------------------------------------------------------------
// 全部 17 个活跃 zg.runSelection 调用点由纯函数模块 guard_wiring_rc713.js 接线。
// 该模块自带锚点唯一性闸门、AST 序号交叉校验、退役点断言与逐字节幂等校验；
// 任何漂移都会抛错而不是静默回落（旧 wire_rc713b_remaining.js 的 SHORT_INTERNAL
// 静默回落正是它被废弃的原因）。
{
  const guardWiring = require("./guard_wiring_rc713.js");
  const wired = guardWiring.apply(text);
  text = wired.text;
  const r = wired.report;
  console.log(
    "RC713_GUARD_WIRING  wrapped=" + r.wrapped.length +
    " verifiedWrapped=" + r.verifiedWrapped.length +
    " migratedWrapped=" + r.migratedWrapped.length +
    " verifiedCore=" + r.verifiedCore.length +
      " retired=" + r.retired.length +
      " total=" + r.totalCallsites
  );
}

if (!text.includes("codex patch rc.7.26: progress wrappers use dynamic long-run policy")) {
  text += "\n/* codex patch rc.7.26: progress wrappers use dynamic long-run policy */\n";
}

if (!text.includes("codex patch rc.7.27: atomic stages drain the owning transport")) {
  const transportProbe = (runExpr) =>
    `transportProbe:()=>{try{return globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.getRunExecutionState(${runExpr}):null}catch{return null}},`;
  replaceOnce(
    "bridge snapshot drains its owning runSelection transport",
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),log:(m)=>{try{RI(m)}catch{}}});if(!__codexSnapGuard.ok)',
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),' +
      'drainPromise:()=>__codexBridgeAtomic&&__codexBridgeAtomic.complete,' +
      transportProbe('(__codexBridgeAtomic&&__codexBridgeAtomic.runId)||null') +
      'log:(m)=>{try{RI(m)}catch{}}});if(!__codexSnapGuard.ok)'
  );
  replaceOnce(
    "bridge enrich drains its owning runSelection transport",
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),log:(m)=>{try{RI(m)}catch{}}});if(!__codexEnrichGuard.ok)',
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),' +
      'drainPromise:()=>__codexBridgeAtomic&&__codexBridgeAtomic.complete,' +
      transportProbe('(__codexBridgeAtomic&&__codexBridgeAtomic.runId)||null') +
      'log:(m)=>{try{RI(m)}catch{}}});if(!__codexEnrichGuard.ok)'
  );
  replaceOnce(
    "human snapshot drains its owning runSelection transport",
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),log:(m)=>{try{RI(m)}catch{}}});if(!__codexHfSnapGuard.ok)',
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),' +
      'drainPromise:()=>__codexHfAtomic&&__codexHfAtomic.complete,' +
      transportProbe('(__codexHfAtomic&&__codexHfAtomic.runId)||null') +
      'log:(m)=>{try{RI(m)}catch{}}});if(!__codexHfSnapGuard.ok)'
  );
  replaceOnce(
    "human enrich drains its owning runSelection transport",
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),log:(m)=>{try{RI(m)}catch{}}});if(!__codexHfEnrichGuard.ok)',
    'supersedeLookup:(__q)=>(globalThis.__codexGuardTransport?globalThis.__codexGuardTransport.supersedeLookup(__q):null),' +
      'drainPromise:()=>__codexHfAtomic&&__codexHfAtomic.complete,' +
      transportProbe('(__codexHfAtomic&&__codexHfAtomic.runId)||null') +
      'log:(m)=>{try{RI(m)}catch{}}});if(!__codexHfEnrichGuard.ok)'
  );
  text += "\n/* codex patch rc.7.27: atomic stages drain the owning transport */\n";
}

if (!text.includes("codex patch rc.7.28: checkpoint-aware soft Stop restore window")) {
  replaceOnce(
    "soft Stop derives its initial restore window from checkpoint complexity",
    "try{let __restoreAttempt=await Promise.race",
    "try{let __restoreTimeoutMs=globalThis.__codexStopCheckpointRef.restoreTimeoutMs(__snapshot),__restoreAttempt=await Promise.race"
  );
  replaceOnce(
    "soft Stop uses the checkpoint-aware restore deadline",
    'new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),5000))]);if(!__restoreAttempt.settled)throw new Error("soft-stop dataset restore timed out after 5000ms");',
    'new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),__restoreTimeoutMs))]);if(!__restoreAttempt.settled)throw new Error("soft-stop dataset restore timed out after "+String(__restoreTimeoutMs)+"ms");/* codex patch rc.7.28: checkpoint-aware soft Stop restore window */'
  );
  replaceOnce(
    "successful initial restore exposes the chosen timeout",
    "bytes:__snapshot.bytes||null,rc:__result?.rc,logPath:__result?.logPath||null}",
    "bytes:__snapshot.bytes||null,rc:__result?.rc,logPath:__result?.logPath||null,timeoutMs:__restoreTimeoutMs}"
  );
}

if (!text.includes("codex patch rc.7.30: Stop requires true transport settlement")) {
  replaceOnce(
    "soft Stop keeps exact transport settlement diagnostics in outer scope",
    ",__restore=null,__taskDrain=null;",
    ",__restore=null,__taskDrain=null,__transportDrain=null;"
  );
  replaceOnce(
    "human-file payload tracks its exact transport promise",
    "let a=__codexHumanFileWatchdog?await __codexHumanFileWatchdog.guard(__codexHumanFilePromise):await __codexHumanFilePromise;",
    'globalThis.__codexStopCheckpointRef.trackTransport(__codexHumanFilePreRunSnapshot,__codexHumanFilePromise,{runId:r,sourceMode:"human-file"});let a=__codexHumanFileWatchdog?await __codexHumanFileWatchdog.guard(__codexHumanFilePromise):await __codexHumanFilePromise;'
  );
  replaceOnce(
    "visible-bridge payload tracks its exact transport promise",
    "let __r=__codexBridgeWatchdog?await __codexBridgeWatchdog.guard(__codexBridgePromise):await __codexBridgePromise;",
    'globalThis.__codexStopCheckpointRef.trackTransport(__codexBridgePreRunSnapshot,__codexBridgePromise,{runId:__run,sourceMode:"visible-bridge"});let __r=__codexBridgeWatchdog?await __codexBridgeWatchdog.guard(__codexBridgePromise):await __codexBridgePromise;'
  );
  replaceOnce(
    "soft Stop drains the tracked promise and local ownership before restore",
    "let __deadline=Date.now()+15000;while(Date.now()<__deadline&&(zg._active||Number(zg._pending||0)>0))await new Promise(__resolve=>setTimeout(__resolve,50));__drained=!(zg._active||Number(zg._pending||0)>0);",
    'let __deadline=Date.now()+15000;if(__snapshot){while(Date.now()<__deadline){__transportDrain=globalThis.__codexStopCheckpointRef.transportSummary(__snapshot,zg,__taskId);if(__transportDrain.safeForRestore)break;await new Promise(__resolve=>setTimeout(__resolve,50))}__transportDrain=globalThis.__codexStopCheckpointRef.transportSummary(__snapshot,zg,__taskId);__drained=!!__transportDrain.safeForRestore}else{while(Date.now()<__deadline&&(zg._active||Number(zg._pending||0)>0))await new Promise(__resolve=>setTimeout(__resolve,50));__drained=!(zg._active||Number(zg._pending||0)>0)}'
  );
  replaceOnce(
    "unsettled tracked transport escalates before any checkpoint restore",
    "if(!__drained&&!__codexPreDispatchRestore){globalThis.__codexLastSoftStop=",
    'if(!__drained&&__snapshot){if(!globalThis.__codexForceReset)throw new Error("soft-stop transport did not settle and hard reset is unavailable");__hardEscalated=true;let __transportHardState=await globalThis.__codexForceReset("soft-stop escalation: transport promise did not settle");__hardReset={ok:!!__transportHardState?.ok,trueReady:!!__transportHardState?.trueReady,notReadyReason:__transportHardState?.notReadyReason||null,cleanup:__transportHardState?.cleanup||null};let __transportReconnect=await Promise.race([Promise.resolve(zg.connect()).then(()=>({settled:true}),__error=>({settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({settled:false,timeout:true}),10000))]);if(!__transportReconnect.settled)throw new Error("transport-settlement hard-reset reconnect timed out after 10000ms");if(__transportReconnect.error)throw new Error(__transportReconnect.error);if(__transportDrain)__transportDrain=Object.assign({},__transportDrain,{hardResetOverride:true,hardResetReconnect:__transportReconnect});__drained=true}if(!__drained){globalThis.__codexLastSoftStop='
  );
  replaceOnce(
    "transport drain failure exposes settlement diagnostics",
    'ok:false,cancelled:__cancelled,breakSession:__breakResult,drained:false,restored:false,reason:"transport did not drain"',
    'ok:false,cancelled:__cancelled,transportDrain:__transportDrain,breakSession:__breakResult,drained:false,restored:false,reason:"transport did not drain"'
  );
  replaceOnce(
    "successful soft Stop no longer accepts a checkpoint-only drain bypass",
    "ok:!!((__drained||__codexPreDispatchRestore)&&__restore&&__restore.ok!==false),cancelled:__cancelled,drainedForRestore:!!(__drained||__codexPreDispatchRestore),",
    "ok:!!(__drained&&__restore&&__restore.ok!==false),cancelled:__cancelled,drainedForRestore:!!__drained,"
  );
  replaceAllRequired(
    "soft Stop outcomes expose exact transport settlement diagnostics",
    "taskDrain:__taskDrain,breakSession:__breakResult",
    "taskDrain:__taskDrain,transportDrain:__transportDrain,breakSession:__breakResult",
    2
  );
  text += "\n/* codex patch rc.7.30: Stop requires true transport settlement */\n";
}

if (!text.includes("codex patch rc.7.32: read-only editor identity")) {
  replaceOnce(
    "read-only editor identity route",
    'if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/debug-active-editor")){',
    String.raw`if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state")){/* codex patch rc.7.32: read-only editor identity */
let __editorStateQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorStatePath=__editorStateQuery.get("path"),__editorState={ok:true,canonical:false,queriedPath:__editorStatePath||null,reasons:[],windowFocused:false,active:null,visibleTargetCount:0,visibleTargets:[]};
try{if(!__editorStatePath||!rg.isAbsolute(__editorStatePath)){__editorState.ok=false;__editorState.reasons.push("absolute-path-required")}else{let __editorStateReal=JA.realpathSync(__editorStatePath),__editorStateHash=__text=>require("crypto").createHash("sha256").update(String(__text||""),"utf8").digest("hex"),__editorStateTarget=__editorStateReal;let __editorStateVisible=Array.isArray(iA.window.visibleTextEditors)?iA.window.visibleTextEditors:[];__editorState.visibleTargets=__editorStateVisible.map(__ed=>{let __path=null;try{__path=__ed?.document?.uri?.fsPath?JA.realpathSync(__ed.document.uri.fsPath):null}catch{}return{fsPath:__path,viewColumn:__ed?.viewColumn||null,languageId:__ed?.document?.languageId||null,isDirty:!!__ed?.document?.isDirty}}).filter(__ed=>__ed.fsPath===__editorStateTarget);__editorState.visibleTargetCount=__editorState.visibleTargets.length;__editorState.windowFocused=!!iA.window.state?.focused;let __active=iA.window.activeTextEditor,__activePath=null;if(__active?.document?.uri?.fsPath){try{__activePath=JA.realpathSync(__active.document.uri.fsPath)}catch{__activePath=__active.document.uri.fsPath}}if(__active){let __docText=__active.document.getText(),__sel=__active.selection,__selText=__sel&&!__sel.isEmpty?__active.document.getText(__sel):"";__editorState.active={fsPath:__activePath,uri:__active.document.uri.toString(),viewColumn:__active.viewColumn||null,isDirty:!!__active.document.isDirty,version:__active.document.version,documentSha256:__editorStateHash(__docText),selection:{startLine:__sel.start.line+1,startCharacter:__sel.start.character,endLine:__sel.end.line+1,endCharacter:__sel.end.character,isEmpty:!!__sel.isEmpty,sha256:__editorStateHash(__selText)}}}if(__activePath!==__editorStateTarget)__editorState.reasons.push("active-path-mismatch");if(__editorState.visibleTargetCount!==1)__editorState.reasons.push("visible-target-count:"+String(__editorState.visibleTargetCount));if(!__editorState.active||__editorState.active.isDirty)__editorState.reasons.push(__editorState.active?"active-editor-dirty":"active-editor-missing");if(__editorState.windowFocused!==true)__editorState.reasons.push("window-not-focused");__editorState.canonical=__editorState.reasons.length===0}}
catch(__editorStateError){__editorState.ok=false;__editorState.reasons.push("editor-state-error:"+String(__editorStateError?.message||__editorStateError).slice(0,240))}__send(__res,200,__editorState);return}if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/debug-active-editor")){/* codex patch v7.25h: debug active editor/tab state for stale Run File diagnosis */`
  );
  text += "\n/* codex patch rc.7.32: read-only editor identity */\n";
}

if (!text.includes("codex patch rc.7.32: focus unique visible editor")) {
  replaceOnce(
    "focus one already-visible clean editor without opening another renderer",
    'if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state")){/* codex patch rc.7.32: read-only editor identity */',
    String.raw`if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus */
let __editorFocusQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorFocusPath=__editorFocusQuery.get("path"),__editorFocusAllowDirty=__editorFocusQuery.get("allowDirty")==="1",__editorFocus={ok:false,queriedPath:__editorFocusPath||null,allowDirty:__editorFocusAllowDirty,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null,error:null};
try{if(!__editorFocusPath||!rg.isAbsolute(__editorFocusPath)){__editorFocus.error="absolute-path-required"}else{let __editorFocusReal=JA.realpathSync(__editorFocusPath),__editorFocusVisible=(Array.isArray(iA.window.visibleTextEditors)?iA.window.visibleTextEditors:[]).filter(__ed=>{try{return !!__ed?.document?.uri?.fsPath&&JA.realpathSync(__ed.document.uri.fsPath)===__editorFocusReal}catch{return false}});__editorFocus.visibleTargetCount=__editorFocusVisible.length;if(__editorFocusVisible.length!==1){__editorFocus.error="visible-target-count:"+String(__editorFocusVisible.length)}else if(__editorFocusVisible[0].document.isDirty&&!__editorFocusAllowDirty){__editorFocus.error="visible-target-dirty"}else{let __editorFocusEditor=__editorFocusVisible[0];await iA.window.showTextDocument(__editorFocusEditor.document,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});let __editorFocusActive=iA.window.activeTextEditor,__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}__editorFocus.focusedPath=__editorFocusActivePath;__editorFocus.viewColumn=__editorFocusActive?.viewColumn||null;__editorFocus.isDirty=typeof __editorFocusActive?.document?.isDirty==="boolean"?__editorFocusActive.document.isDirty:null;__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&(__editorFocusAllowDirty?__editorFocus.isDirty===true:__editorFocus.isDirty===false);if(!__editorFocus.ok)__editorFocus.error="focus-did-not-converge"}}}
catch(__editorFocusError){__editorFocus.error="editor-focus-error:"+String(__editorFocusError?.message||__editorFocusError).slice(0,240)}__send(__res,__editorFocus.ok?200:409,__editorFocus);return}if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state")){/* codex patch rc.7.32: read-only editor identity */`
  );
  text += "\n/* codex patch rc.7.32: focus unique visible editor */\n";
}

if (!text.includes("codex patch rc.7.50: explicit dirty editor recovery focus")) {
  const dirtyFocusQuery = 'let __editorFocusQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorFocusPath=__editorFocusQuery.get("path"),__editorFocusAllowDirty=__editorFocusQuery.get("allowDirty")==="1",';
  if (!text.includes(dirtyFocusQuery)) {
    replaceOnce(
      "editor focus records an explicit dirty-recovery request",
      'let __editorFocusQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorFocusPath=__editorFocusQuery.get("path"),__editorFocus={ok:false,queriedPath:__editorFocusPath||null,visibleTargetCount:0,focusedPath:null,viewColumn:null,error:null};',
      'let __editorFocusQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorFocusPath=__editorFocusQuery.get("path"),__editorFocusAllowDirty=__editorFocusQuery.get("allowDirty")==="1",__editorFocus={ok:false,queriedPath:__editorFocusPath||null,allowDirty:__editorFocusAllowDirty,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null,error:null};'
    );
    replaceOnce(
      "editor focus keeps dirty targets closed by default",
      'else if(__editorFocusVisible[0].document.isDirty){__editorFocus.error="visible-target-dirty"}',
      'else if(__editorFocusVisible[0].document.isDirty&&!__editorFocusAllowDirty){__editorFocus.error="visible-target-dirty"}'
    );
    replaceOnce(
      "editor focus binds convergence to the requested clean or dirty state",
      '__editorFocus.focusedPath=__editorFocusActivePath;__editorFocus.viewColumn=__editorFocusActive?.viewColumn||null;__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&!__editorFocusActive.document.isDirty;',
      '__editorFocus.focusedPath=__editorFocusActivePath;__editorFocus.viewColumn=__editorFocusActive?.viewColumn||null;__editorFocus.isDirty=typeof __editorFocusActive?.document?.isDirty==="boolean"?__editorFocusActive.document.isDirty:null;__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&(__editorFocusAllowDirty?__editorFocus.isDirty===true:__editorFocus.isDirty===false);'
    );
  }
  replaceOnce(
    "inline the dirty editor recovery marker for replay convergence",
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor */',
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus */'
  );
  const legacyDirtyFocusMarker = "\n/* codex patch rc.7.50: explicit dirty editor recovery focus */\n";
  if (text.includes(legacyDirtyFocusMarker)) {
    replaceOnce("remove the pre-convergence dirty focus ledger marker", legacyDirtyFocusMarker, "");
  }
}

if (!text.includes("codex patch rc.7.56: exact visible editor group fallback")) {
  replaceOnce(
    "editor focus exposes the bounded group fallback receipt",
    "__editorFocus={ok:false,queriedPath:__editorFocusPath||null,allowDirty:__editorFocusAllowDirty,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null,error:null}",
    "__editorFocus={ok:false,queriedPath:__editorFocusPath||null,allowDirty:__editorFocusAllowDirty,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null,groupFallbackAttempted:false,groupFallbackCommand:null,error:null}"
  );
  replaceOnce(
    "editor focus activates the exact existing group before one final proof",
    'let __editorFocusEditor=__editorFocusVisible[0];await iA.window.showTextDocument(__editorFocusEditor.document,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});let __editorFocusActive=iA.window.activeTextEditor,__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}',
    'let __editorFocusEditor=__editorFocusVisible[0];await iA.window.showTextDocument(__editorFocusEditor.document,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});let __editorFocusActive=iA.window.activeTextEditor,__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}if(__editorFocusActivePath!==__editorFocusReal){let __editorFocusGroupCommands=[null,"workbench.action.focusFirstEditorGroup","workbench.action.focusSecondEditorGroup","workbench.action.focusThirdEditorGroup","workbench.action.focusFourthEditorGroup","workbench.action.focusFifthEditorGroup","workbench.action.focusSixthEditorGroup","workbench.action.focusSeventhEditorGroup","workbench.action.focusEighthEditorGroup"],__editorFocusGroupCommand=__editorFocusGroupCommands[Number(__editorFocusEditor.viewColumn)]||null;__editorFocus.groupFallbackCommand=__editorFocusGroupCommand;if(__editorFocusGroupCommand){__editorFocus.groupFallbackAttempted=true;await iA.commands.executeCommand(__editorFocusGroupCommand);await iA.window.showTextDocument(__editorFocusEditor.document,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}}}'
  );
  replaceOnce(
    "editor focus binds success to the unique target's existing group",
    "__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&(",
    "__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn&& ("
  );
  replaceOnce(
    "inline the exact editor-group fallback marker for replay convergence",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback */"
  );
}

if (!text.includes("codex patch rc.7.57: await editor group activation")) {
  replaceOnce(
    "editor focus records the bounded group activation observation",
    "groupFallbackAttempted:false,groupFallbackCommand:null,error:null",
    "groupFallbackAttempted:false,groupFallbackCommand:null,groupFallbackWaited:false,groupFallbackObserved:false,error:null"
  );
  replaceOnce(
    "editor focus waits for the group-focus event before final proof",
    'await iA.commands.executeCommand(__editorFocusGroupCommand);await iA.window.showTextDocument(__editorFocusEditor.document,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}}}',
    'await iA.commands.executeCommand(__editorFocusGroupCommand);await new Promise(__editorFocusResolve=>{let __editorFocusDone=false,__editorFocusSubscription=null,__editorFocusTimer=null;let __editorFocusFinish=()=>{if(__editorFocusDone)return;__editorFocusDone=true;try{__editorFocusSubscription?.dispose()}catch{}if(__editorFocusTimer)clearTimeout(__editorFocusTimer);__editorFocusResolve()};__editorFocusSubscription=iA.window.onDidChangeActiveTextEditor(__editorFocusFinish);__editorFocusTimer=setTimeout(__editorFocusFinish,500);Promise.resolve().then(()=>{let __editorFocusNow=iA.window.activeTextEditor,__editorFocusNowPath=null;try{__editorFocusNowPath=__editorFocusNow?.document?.uri?.fsPath?JA.realpathSync(__editorFocusNow.document.uri.fsPath):null}catch{}if(__editorFocusNowPath===__editorFocusReal&&__editorFocusNow?.viewColumn===__editorFocusEditor.viewColumn)__editorFocusFinish()})});__editorFocus.groupFallbackWaited=true;__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}__editorFocus.groupFallbackObserved=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn}}'
  );
  replaceOnce(
    "inline the bounded editor-group activation marker",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation */"
  );
}

if (!text.includes("codex patch rc.7.58: bounded previous-group focus fallback")) {
  replaceOnce(
    "editor focus records the bounded group-cycle receipt",
    "groupFallbackObserved:false,error:null",
    "groupFallbackObserved:false,cycleFallbackAttempted:false,cycleFallbackCommand:null,cycleFallbackSteps:0,cycleFallbackVisitedColumns:[],cycleFallbackObserved:false,error:null"
  );
  replaceOnce(
    "editor focus cycles existing groups until global active identity converges",
    '__editorFocus.groupFallbackObserved=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn}}',
    '__editorFocus.groupFallbackObserved=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn}if(!__editorFocus.groupFallbackObserved){let __editorFocusVisibleColumns=[...new Set((Array.isArray(iA.window.visibleTextEditors)?iA.window.visibleTextEditors:[]).map(__ed=>__ed?.viewColumn).filter(__column=>Number.isInteger(__column)&&__column>0))],__editorFocusCycleLimit=Math.min(32,Math.max(1,__editorFocusVisibleColumns.length));__editorFocus.cycleFallbackAttempted=true;__editorFocus.cycleFallbackCommand="workbench.action.focusPreviousGroup";for(let __editorFocusCycleStep=0;__editorFocusCycleStep<__editorFocusCycleLimit;__editorFocusCycleStep++){let __editorFocusCycleFinish=null,__editorFocusCyclePromise=new Promise(__editorFocusCycleResolve=>{let __editorFocusCycleDone=false,__editorFocusCycleSubscription=null,__editorFocusCycleTimer=null;__editorFocusCycleFinish=()=>{if(__editorFocusCycleDone)return;__editorFocusCycleDone=true;try{__editorFocusCycleSubscription?.dispose()}catch{}if(__editorFocusCycleTimer)clearTimeout(__editorFocusCycleTimer);__editorFocusCycleResolve()};__editorFocusCycleSubscription=iA.window.onDidChangeActiveTextEditor(__editorFocusCycleFinish);__editorFocusCycleTimer=setTimeout(__editorFocusCycleFinish,200)});await iA.commands.executeCommand(__editorFocus.cycleFallbackCommand);await __editorFocusCyclePromise;__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}__editorFocus.cycleFallbackSteps=__editorFocusCycleStep+1;__editorFocus.cycleFallbackVisitedColumns.push(__editorFocusActive?.viewColumn||null);if(__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn){__editorFocus.cycleFallbackObserved=true;break}}}}'
  );
  replaceOnce(
    "inline the bounded previous-group focus marker",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback */"
  );
}

if (!text.includes("codex patch rc.7.59: command-open active editor fallback")) {
  replaceOnce(
    "editor focus records the command-open receipt",
    "cycleFallbackVisitedColumns:[],cycleFallbackObserved:false,error:null",
    "cycleFallbackVisitedColumns:[],cycleFallbackObserved:false,commandOpenFallbackAttempted:false,commandOpenFallbackWaited:false,commandOpenFallbackObserved:false,error:null"
  );
  replaceOnce(
    "editor focus asks the workbench to activate the exact existing resource",
    '__editorFocus.cycleFallbackObserved=true;break}}}}',
    '__editorFocus.cycleFallbackObserved=true;break}}}if(!__editorFocus.cycleFallbackObserved){__editorFocus.commandOpenFallbackAttempted=true;let __editorFocusOpenFinish=null,__editorFocusOpenPromise=new Promise(__editorFocusOpenResolve=>{let __editorFocusOpenDone=false,__editorFocusOpenSubscription=null,__editorFocusOpenTimer=null;__editorFocusOpenFinish=()=>{if(__editorFocusOpenDone)return;__editorFocusOpenDone=true;try{__editorFocusOpenSubscription?.dispose()}catch{}if(__editorFocusOpenTimer)clearTimeout(__editorFocusOpenTimer);__editorFocusOpenResolve()};__editorFocusOpenSubscription=iA.window.onDidChangeActiveTextEditor(__editorFocusOpenFinish);__editorFocusOpenTimer=setTimeout(__editorFocusOpenFinish,500)});await iA.commands.executeCommand("vscode.open",__editorFocusEditor.document.uri,{viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false});await __editorFocusOpenPromise;__editorFocus.commandOpenFallbackWaited=true;__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}__editorFocus.commandOpenFallbackObserved=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn}}'
  );
  replaceOnce(
    "inline the command-open active editor marker",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback *//* codex patch rc.7.59: command-open active editor fallback */"
  );
}

if (!text.includes("codex patch rc.7.60: focus editor area before group command")) {
  replaceOnce(
    "editor focus records the editor-area focus command",
    "groupFallbackAttempted:false,groupFallbackCommand:null,groupFallbackWaited:false",
    "editorAreaFocusAttempted:false,groupFallbackAttempted:false,groupFallbackCommand:null,groupFallbackWaited:false"
  );
  replaceOnce(
    "editor focus enters the active editor area before changing groups",
    "__editorFocus.groupFallbackAttempted=true;await iA.commands.executeCommand(__editorFocusGroupCommand)",
    '__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup");__editorFocus.groupFallbackAttempted=true;await iA.commands.executeCommand(__editorFocusGroupCommand)'
  );
  replaceOnce(
    "inline the editor-area focus marker",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback *//* codex patch rc.7.59: command-open active editor fallback */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback *//* codex patch rc.7.59: command-open active editor fallback *//* codex patch rc.7.60: focus editor area before group command */"
  );
}

if (!text.includes("codex patch rc.7.61: focus workbench window before editor area")) {
  replaceOnce(
    "editor focus records the workbench-window focus command",
    "editorAreaFocusAttempted:false,groupFallbackAttempted:false",
    "windowFocusAttempted:false,editorAreaFocusAttempted:false,groupFallbackAttempted:false"
  );
  replaceOnce(
    "editor focus enters the workbench window before the active editor area",
    '__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup")',
    '__editorFocus.windowFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusWindow");__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup")'
  );
  replaceOnce(
    "inline the workbench-window focus marker",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback *//* codex patch rc.7.59: command-open active editor fallback *//* codex patch rc.7.60: focus editor area before group command */",
    "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.56: exact visible editor group fallback *//* codex patch rc.7.57: await editor group activation *//* codex patch rc.7.58: bounded previous-group focus fallback *//* codex patch rc.7.59: command-open active editor fallback *//* codex patch rc.7.60: focus editor area before group command *//* codex patch rc.7.61: focus workbench window before editor area */"
  );
}

if (!text.includes("codex patch rc.7.62: active-tab-bound effective editor state")) {
  replaceOnce(
    "editor state separates the raw active editor from the handler target",
    "active:null,visibleTargetCount:0,visibleTargets:[]",
    "active:null,rawActive:null,activeTabPath:null,effectiveEditorSource:null,visibleTargetCount:0,visibleTargets:[]"
  );
  replaceOnce(
    "editor state derives the effective handler target from the exact active tab",
    'let __active=iA.window.activeTextEditor,__activePath=null;if(__active?.document?.uri?.fsPath){try{__activePath=JA.realpathSync(__active.document.uri.fsPath)}catch{__activePath=__active.document.uri.fsPath}}if(__active){let __docText=__active.document.getText(),__sel=__active.selection,__selText=__sel&&!__sel.isEmpty?__active.document.getText(__sel):"";__editorState.active={fsPath:__activePath,uri:__active.document.uri.toString(),viewColumn:__active.viewColumn||null,isDirty:!!__active.document.isDirty,version:__active.document.version,documentSha256:__editorStateHash(__docText),selection:{startLine:__sel.start.line+1,startCharacter:__sel.start.character,endLine:__sel.end.line+1,endCharacter:__sel.end.character,isEmpty:!!__sel.isEmpty,sha256:__editorStateHash(__selText)}}}if(__activePath!==__editorStateTarget)',
    'let __rawActive=iA.window.activeTextEditor,__rawActivePath=null;if(__rawActive?.document?.uri?.fsPath){try{__rawActivePath=JA.realpathSync(__rawActive.document.uri.fsPath)}catch{__rawActivePath=__rawActive.document.uri.fsPath}}let __activeTab=iA.window.tabGroups?.activeTabGroup?.activeTab,__activeTabInput=__activeTab?.input,__activeTabCandidate=__activeTabInput?.uri?.fsPath||__activeTabInput?.modified?.fsPath||__activeTabInput?.original?.fsPath||null,__activeTabPath=null;try{__activeTabPath=__activeTabCandidate?JA.realpathSync(__activeTabCandidate):null}catch{}__editorState.activeTabPath=__activeTabPath;let __effectiveEditor=__rawActive,__effectivePath=__rawActivePath;__editorState.effectiveEditorSource="active-text-editor";if(__rawActivePath!==__editorStateTarget&&__activeTabPath===__editorStateTarget&&__editorState.visibleTargetCount===1){__effectiveEditor=__editorStateVisible.find(__ed=>{try{return !!__ed?.document?.uri?.fsPath&&JA.realpathSync(__ed.document.uri.fsPath)===__editorStateTarget}catch{return false}})||null;__effectivePath=__effectiveEditor?__editorStateTarget:null;__editorState.effectiveEditorSource="active-tab-visible-target"}let __editorStateSnapshot=(__ed,__path)=>{if(!__ed)return null;let __docText=__ed.document.getText(),__sel=__ed.selection,__selText=__sel&&!__sel.isEmpty?__ed.document.getText(__sel):"";return{fsPath:__path,uri:__ed.document.uri.toString(),viewColumn:__ed.viewColumn||null,isDirty:!!__ed.document.isDirty,version:__ed.document.version,documentSha256:__editorStateHash(__docText),selection:__sel?{startLine:__sel.start.line+1,startCharacter:__sel.start.character,endLine:__sel.end.line+1,endCharacter:__sel.end.character,isEmpty:!!__sel.isEmpty,sha256:__editorStateHash(__selText)}:null}};__editorState.rawActive=__editorStateSnapshot(__rawActive,__rawActivePath);__editorState.active=__editorStateSnapshot(__effectiveEditor,__effectivePath);if(__effectivePath!==__editorStateTarget)'
  );
  replaceOnce(
    "inline the active-tab-bound editor-state marker",
    'if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state")){/* codex patch rc.7.32: read-only editor identity */',
    'if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state")){/* codex patch rc.7.32: read-only editor identity *//* codex patch rc.7.62: active-tab-bound effective editor state */'
  );
}

if (!text.includes("codex patch rc.7.62: handler-target-bound editor focus")) {
  replaceOnce(
    "editor focus records raw and handler-bound identity",
    "windowFocusAttempted:false,editorAreaFocusAttempted:false,groupFallbackAttempted:false",
    "activeTextEditorPath:null,activeTabPath:null,handlerTargetBound:false,windowFocusAttempted:false,editorAreaFocusAttempted:false,groupFallbackAttempted:false"
  );
  replaceOnce(
    "editor focus skips group churn when the real handler target is already bound",
    'try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}if(__editorFocusActivePath!==__editorFocusReal){',
    'try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}let __editorFocusReadActiveTabPath=()=>{let __tab=iA.window.tabGroups?.activeTabGroup?.activeTab,__input=__tab?.input,__candidate=__input?.uri?.fsPath||__input?.modified?.fsPath||__input?.original?.fsPath||null;try{return __candidate?JA.realpathSync(__candidate):null}catch{return null}};__editorFocus.activeTextEditorPath=__editorFocusActivePath;__editorFocus.activeTabPath=__editorFocusReadActiveTabPath();__editorFocus.handlerTargetBound=__editorFocus.activeTabPath===__editorFocusReal;if(!__editorFocus.handlerTargetBound&&__editorFocusActivePath!==__editorFocusReal){'
  );
  replaceOnce(
    "editor focus admits only the exact active-tab-bound handler target",
    '__editorFocus.focusedPath=__editorFocusActivePath;__editorFocus.viewColumn=__editorFocusActive?.viewColumn||null;__editorFocus.isDirty=typeof __editorFocusActive?.document?.isDirty==="boolean"?__editorFocusActive.document.isDirty:null;__editorFocus.ok=__editorFocusActivePath===__editorFocusReal&&__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn&& (__editorFocusAllowDirty?__editorFocus.isDirty===true:__editorFocus.isDirty===false);',
    '__editorFocus.activeTextEditorPath=__editorFocusActivePath;__editorFocus.activeTabPath=__editorFocusReadActiveTabPath();__editorFocus.handlerTargetBound=__editorFocus.activeTabPath===__editorFocusReal;__editorFocus.focusedPath=__editorFocus.handlerTargetBound?__editorFocusReal:__editorFocusActivePath;__editorFocus.viewColumn=__editorFocus.handlerTargetBound?(__editorFocusEditor.viewColumn||null):(__editorFocusActive?.viewColumn||null);__editorFocus.isDirty=typeof __editorFocusEditor?.document?.isDirty==="boolean"?__editorFocusEditor.document.isDirty:null;__editorFocus.ok=__editorFocus.handlerTargetBound&&(__editorFocusAllowDirty?__editorFocus.isDirty===true:__editorFocus.isDirty===false);'
  );
  replaceOnce(
    "inline the handler-target-bound editor-focus marker",
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor */',
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus */'
  );
}

const duplicateDirtyFocusMarker =
  "focus unique visible editor *//* codex patch rc.7.50: explicit dirty editor recovery focus *//* codex patch rc.7.62: handler-target-bound editor focus *//* codex patch rc.7.50: explicit dirty editor recovery focus */";
if (text.includes(duplicateDirtyFocusMarker)) {
  replaceOnce(
    "remove the duplicate dirty-focus marker exposed by the rc.7.62 insertion",
    duplicateDirtyFocusMarker,
    "focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus *//* codex patch rc.7.50: explicit dirty editor recovery focus */"
  );
}

if (!text.includes("codex patch rc.7.33: exact non-mutating editor selection")) {
  replaceOnce(
    "select an exact clean visible editor range without document mutation",
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus */',
    String.raw`if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-select")){/* codex patch rc.7.33: exact non-mutating editor selection */
let __editorSelectQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorSelectPath=__editorSelectQuery.get("path"),__editorSelectStart=Number(__editorSelectQuery.get("startLine")),__editorSelectEnd=Number(__editorSelectQuery.get("endLine")),__editorSelect={ok:false,queriedPath:__editorSelectPath||null,startLine:__editorSelectStart,endLine:__editorSelectEnd,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null,documentSha256:null,selectionSha256:null,selection:null,error:null};
try{if(!__editorSelectPath||!rg.isAbsolute(__editorSelectPath)){__editorSelect.error="absolute-path-required"}else if(!Number.isInteger(__editorSelectStart)||!Number.isInteger(__editorSelectEnd)){__editorSelect.error="integer-lines-required"}else{let __editorSelectReal=JA.realpathSync(__editorSelectPath),__editorSelectVisible=(Array.isArray(iA.window.visibleTextEditors)?iA.window.visibleTextEditors:[]).filter(__ed=>{try{return !!__ed?.document?.uri?.fsPath&&JA.realpathSync(__ed.document.uri.fsPath)===__editorSelectReal}catch{return false}});__editorSelect.visibleTargetCount=__editorSelectVisible.length;if(__editorSelectVisible.length!==1){__editorSelect.error="visible-target-count:"+String(__editorSelectVisible.length)}else if(__editorSelectVisible[0].document.isDirty){__editorSelect.error="visible-target-dirty"}else{let __editorSelectEditor=await iA.window.showTextDocument(__editorSelectVisible[0].document,{viewColumn:__editorSelectVisible[0].viewColumn,preserveFocus:false,preview:false}),__editorSelectDocument=__editorSelectEditor.document;if(__editorSelectStart<1||__editorSelectEnd<__editorSelectStart||__editorSelectEnd>__editorSelectDocument.lineCount){__editorSelect.error="selection-lines-out-of-range"}else{let __editorSelectStartPos=__editorSelectDocument.lineAt(__editorSelectStart-1).range.start,__editorSelectEndPos=__editorSelectDocument.lineAt(__editorSelectEnd-1).range.end,__editorSelectRange=new iA.Selection(__editorSelectStartPos,__editorSelectEndPos),__editorSelectHash=__value=>require("crypto").createHash("sha256").update(String(__value||""),"utf8").digest("hex");__editorSelectEditor.selection=__editorSelectRange;__editorSelectEditor.revealRange(new iA.Range(__editorSelectStartPos,__editorSelectEndPos),iA.TextEditorRevealType.InCenterIfOutsideViewport);let __editorSelectActive=iA.window.activeTextEditor,__editorSelectActivePath=null;try{__editorSelectActivePath=__editorSelectActive?.document?.uri?.fsPath?JA.realpathSync(__editorSelectActive.document.uri.fsPath):null}catch{}let __editorSelectActual=__editorSelectActive?.selection;__editorSelect.focusedPath=__editorSelectActivePath;__editorSelect.viewColumn=__editorSelectActive?.viewColumn||null;__editorSelect.isDirty=!!__editorSelectActive?.document?.isDirty;__editorSelect.documentSha256=__editorSelectActive?.document?__editorSelectHash(__editorSelectActive.document.getText()):null;__editorSelect.selectionSha256=__editorSelectActive?.document&&__editorSelectActual?__editorSelectHash(__editorSelectActive.document.getText(__editorSelectActual)):null;__editorSelect.selection=__editorSelectActual?{startLine:__editorSelectActual.start.line+1,startCharacter:__editorSelectActual.start.character,endLine:__editorSelectActual.end.line+1,endCharacter:__editorSelectActual.end.character,isEmpty:!!__editorSelectActual.isEmpty}:null;__editorSelect.ok=__editorSelectActivePath===__editorSelectReal&&__editorSelect.isDirty===false&&!!__editorSelectActual&&__editorSelectActual.start.isEqual(__editorSelectStartPos)&&__editorSelectActual.end.isEqual(__editorSelectEndPos)&&!__editorSelectActual.isEmpty;if(!__editorSelect.ok)__editorSelect.error="selection-did-not-converge"}}}}
catch(__editorSelectError){__editorSelect.error="editor-select-error:"+String(__editorSelectError?.message||__editorSelectError).slice(0,240)}__send(__res,__editorSelect.ok?200:409,__editorSelect);return}if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){/* codex patch rc.7.32: focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus */`
  );
  text += "\n/* codex patch rc.7.33: exact non-mutating editor selection */\n";
}

if (!text.includes("codex patch rc.7.62: handler-target-bound editor selection")) {
  replaceOnce(
    "editor selection records raw and handler-bound identity",
    "__editorSelect={ok:false,queriedPath:__editorSelectPath||null,startLine:__editorSelectStart,endLine:__editorSelectEnd,visibleTargetCount:0,focusedPath:null,viewColumn:null,isDirty:null",
    "__editorSelect={ok:false,queriedPath:__editorSelectPath||null,startLine:__editorSelectStart,endLine:__editorSelectEnd,visibleTargetCount:0,focusedPath:null,activeTextEditorPath:null,activeTabPath:null,handlerTargetBound:false,viewColumn:null,isDirty:null"
  );
  replaceOnce(
    "editor selection proves the target editor selected for the real handler",
    'let __editorSelectActive=iA.window.activeTextEditor,__editorSelectActivePath=null;try{__editorSelectActivePath=__editorSelectActive?.document?.uri?.fsPath?JA.realpathSync(__editorSelectActive.document.uri.fsPath):null}catch{}let __editorSelectActual=__editorSelectActive?.selection;__editorSelect.focusedPath=__editorSelectActivePath;__editorSelect.viewColumn=__editorSelectActive?.viewColumn||null;__editorSelect.isDirty=!!__editorSelectActive?.document?.isDirty;__editorSelect.documentSha256=__editorSelectActive?.document?__editorSelectHash(__editorSelectActive.document.getText()):null;__editorSelect.selectionSha256=__editorSelectActive?.document&&__editorSelectActual?__editorSelectHash(__editorSelectActive.document.getText(__editorSelectActual)):null;__editorSelect.selection=__editorSelectActual?{startLine:__editorSelectActual.start.line+1,startCharacter:__editorSelectActual.start.character,endLine:__editorSelectActual.end.line+1,endCharacter:__editorSelectActual.end.character,isEmpty:!!__editorSelectActual.isEmpty}:null;__editorSelect.ok=__editorSelectActivePath===__editorSelectReal&&__editorSelect.isDirty===false&&!!__editorSelectActual&&__editorSelectActual.start.isEqual(__editorSelectStartPos)&&__editorSelectActual.end.isEqual(__editorSelectEndPos)&&!__editorSelectActual.isEmpty;',
    'let __editorSelectActive=iA.window.activeTextEditor,__editorSelectActivePath=null;try{__editorSelectActivePath=__editorSelectActive?.document?.uri?.fsPath?JA.realpathSync(__editorSelectActive.document.uri.fsPath):null}catch{}let __editorSelectTab=iA.window.tabGroups?.activeTabGroup?.activeTab,__editorSelectTabInput=__editorSelectTab?.input,__editorSelectTabCandidate=__editorSelectTabInput?.uri?.fsPath||__editorSelectTabInput?.modified?.fsPath||__editorSelectTabInput?.original?.fsPath||null,__editorSelectTabPath=null;try{__editorSelectTabPath=__editorSelectTabCandidate?JA.realpathSync(__editorSelectTabCandidate):null}catch{}let __editorSelectActual=__editorSelectEditor.selection;__editorSelect.activeTextEditorPath=__editorSelectActivePath;__editorSelect.activeTabPath=__editorSelectTabPath;__editorSelect.handlerTargetBound=__editorSelectTabPath===__editorSelectReal;__editorSelect.focusedPath=__editorSelect.handlerTargetBound?__editorSelectReal:__editorSelectActivePath;__editorSelect.viewColumn=__editorSelectEditor.viewColumn||null;__editorSelect.isDirty=!!__editorSelectDocument.isDirty;__editorSelect.documentSha256=__editorSelectHash(__editorSelectDocument.getText());__editorSelect.selectionSha256=__editorSelectActual?__editorSelectHash(__editorSelectDocument.getText(__editorSelectActual)):null;__editorSelect.selection=__editorSelectActual?{startLine:__editorSelectActual.start.line+1,startCharacter:__editorSelectActual.start.character,endLine:__editorSelectActual.end.line+1,endCharacter:__editorSelectActual.end.character,isEmpty:!!__editorSelectActual.isEmpty}:null;__editorSelect.ok=__editorSelect.handlerTargetBound&&__editorSelect.isDirty===false&&!!__editorSelectActual&&__editorSelectActual.start.isEqual(__editorSelectStartPos)&&__editorSelectActual.end.isEqual(__editorSelectEndPos)&&!__editorSelectActual.isEmpty;'
  );
  replaceOnce(
    "inline the handler-target-bound editor-selection marker",
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-select")){/* codex patch rc.7.33: exact non-mutating editor selection */',
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-select")){/* codex patch rc.7.33: exact non-mutating editor selection *//* codex patch rc.7.62: handler-target-bound editor selection */'
  );
}

if (!text.includes("codex patch r16j106: select blank-line terminator")) {
  replaceOnce(
    "represent a requested blank line by its existing line terminator",
    "let __editorSelectStartPos=__editorSelectDocument.lineAt(__editorSelectStart-1).range.start,__editorSelectEndPos=__editorSelectDocument.lineAt(__editorSelectEnd-1).range.end,__editorSelectRange=new iA.Selection(__editorSelectStartPos,__editorSelectEndPos)",
    "let __editorSelectStartPos=__editorSelectDocument.lineAt(__editorSelectStart-1).range.start,__editorSelectEndBase=__editorSelectDocument.lineAt(__editorSelectEnd-1).range.end,__editorSelectUsesLineTerminator=__editorSelectStartPos.isEqual(__editorSelectEndBase)&&__editorSelectEnd<__editorSelectDocument.lineCount,__editorSelectEndPos=__editorSelectUsesLineTerminator?__editorSelectDocument.lineAt(__editorSelectEnd).range.start:__editorSelectEndBase,__editorSelectRange=new iA.Selection(__editorSelectStartPos,__editorSelectEndPos)"
  );
  replaceOnce(
    "inline the blank-line terminator selection marker",
    "handler-target-bound editor selection */",
    "handler-target-bound editor selection *//* codex patch r16j106: select blank-line terminator */"
  );
}

if (!text.includes("codex patch rc.7.63: focus handler-bound editor area")) {
  replaceOnce(
    "handler-bound editor focus enters the editor area before final proof",
    '__editorFocus.handlerTargetBound=__editorFocus.activeTabPath===__editorFocusReal;if(!__editorFocus.handlerTargetBound&&__editorFocusActivePath!==__editorFocusReal){',
    '__editorFocus.handlerTargetBound=__editorFocus.activeTabPath===__editorFocusReal;if(__editorFocus.handlerTargetBound){__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup");__editorFocusActive=iA.window.activeTextEditor;__editorFocusActivePath=null;try{__editorFocusActivePath=__editorFocusActive?.document?.uri?.fsPath?JA.realpathSync(__editorFocusActive.document.uri.fsPath):null}catch{}}if(!__editorFocus.handlerTargetBound&&__editorFocusActivePath!==__editorFocusReal){'
  );
  replaceOnce(
    "inline the handler-bound editor-area focus marker",
    "focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus */",
    "focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus *//* codex patch rc.7.63: focus handler-bound editor area */"
  );
}

if (!text.includes("codex patch rc.7.64: bind focused workbench window context")) {
  replaceOnce(
    "handler-bound focus restores the workbench command context only when its window is already foreground",
    'if(__editorFocus.handlerTargetBound){__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup")',
    'if(__editorFocus.handlerTargetBound){if(iA.window.state?.focused===true){__editorFocus.windowFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusWindow")}__editorFocus.editorAreaFocusAttempted=true;await iA.commands.executeCommand("workbench.action.focusActiveEditorGroup")'
  );
  replaceOnce(
    "inline the focused workbench-window context marker",
    "focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus *//* codex patch rc.7.63: focus handler-bound editor area */",
    "focus unique visible editor *//* codex patch rc.7.62: handler-target-bound editor focus *//* codex patch rc.7.63: focus handler-bound editor area *//* codex patch rc.7.64: bind focused workbench window context */"
  );
}

if (!text.includes("codex patch rc.7.65: exact keyless editor close")) {
  replaceOnce(
    "add an exact keyless close route before editor focus",
    'if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){',
    String.raw`if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-close")){/* codex patch rc.7.65: exact keyless editor close */
let __editorCloseQuery=new URL(__req.url,"http://127.0.0.1").searchParams,__editorClosePath=__editorCloseQuery.get("path"),__editorClose={ok:false,applied:false,queriedPath:__editorClosePath||null,visibleTargetCountBefore:null,visibleTargetCountAfter:null,activeTextEditorPath:null,activeTabPath:null,windowFocused:null,isDirty:null,error:null};
try{if(!__editorClosePath||!rg.isAbsolute(__editorClosePath)){__editorClose.error="absolute-path-required"}else{let __editorCloseReal=JA.realpathSync(__editorClosePath),__editorClosePathOf=__ed=>{try{return __ed?.document?.uri?.fsPath?JA.realpathSync(__ed.document.uri.fsPath):null}catch{return null}},__editorCloseVisible=()=>((Array.isArray(iA.window.visibleTextEditors)?iA.window.visibleTextEditors:[]).filter(__ed=>__editorClosePathOf(__ed)===__editorCloseReal)),__editorCloseActive=iA.window.activeTextEditor,__editorCloseTab=iA.window.tabGroups?.activeTabGroup?.activeTab,__editorCloseInput=__editorCloseTab?.input,__editorCloseCandidate=__editorCloseInput?.uri?.fsPath||__editorCloseInput?.modified?.fsPath||__editorCloseInput?.original?.fsPath||null;__editorClose.visibleTargetCountBefore=__editorCloseVisible().length;__editorClose.activeTextEditorPath=__editorClosePathOf(__editorCloseActive);try{__editorClose.activeTabPath=__editorCloseCandidate?JA.realpathSync(__editorCloseCandidate):null}catch{}__editorClose.windowFocused=typeof iA.window.state?.focused==="boolean"?iA.window.state.focused:null;__editorClose.isDirty=typeof __editorCloseActive?.document?.isDirty==="boolean"?__editorCloseActive.document.isDirty:null;if(__editorClose.visibleTargetCountBefore!==1){__editorClose.error="visible-target-count:"+String(__editorClose.visibleTargetCountBefore)}else if(__editorClose.activeTextEditorPath!==__editorCloseReal){__editorClose.error="active-text-editor-mismatch"}else if(__editorClose.activeTabPath!==__editorCloseReal){__editorClose.error="active-tab-mismatch"}else if(__editorClose.windowFocused!==true){__editorClose.error="window-not-focused"}else if(__editorClose.isDirty!==false){__editorClose.error="active-editor-not-clean"}else{let __editorCloseFinish=null,__editorClosePromise=new Promise(__editorCloseResolve=>{let __editorCloseDone=false,__editorCloseSubscription=null,__editorCloseTimer=null;__editorCloseFinish=()=>{if(__editorCloseDone)return;__editorCloseDone=true;try{__editorCloseSubscription?.dispose()}catch{}if(__editorCloseTimer)clearTimeout(__editorCloseTimer);__editorCloseResolve()};__editorCloseSubscription=iA.window.onDidChangeVisibleTextEditors(__editorCloseFinish);__editorCloseTimer=setTimeout(__editorCloseFinish,1000)});await iA.commands.executeCommand("workbench.action.closeActiveEditor");__editorClose.applied=true;await __editorClosePromise;__editorClose.visibleTargetCountAfter=__editorCloseVisible().length;__editorClose.ok=__editorClose.visibleTargetCountAfter===0;if(!__editorClose.ok)__editorClose.error="target-editor-still-visible"}}}
catch(__editorCloseError){__editorClose.error="editor-close-error:"+String(__editorCloseError?.message||__editorCloseError).slice(0,240)}__send(__res,__editorClose.ok?200:409,__editorClose);return}if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus")){`
  );
}

if (!text.includes("codex patch rc.7.66: active-tab-owned editor close")) {
  replaceOnce(
    "record the active-tab-owned close revision",
    "codex patch rc.7.65: exact keyless editor close */",
    "codex patch rc.7.65: exact keyless editor close *//* codex patch rc.7.66: active-tab-owned editor close */"
  );
  replaceOnce(
    "record exact-tab close acceptance",
    "windowFocused:null,isDirty:null,error:null};",
    "windowFocused:null,isDirty:null,tabCloseAccepted:null,error:null};"
  );
  replaceOnce(
    "bind close authorization to the exact active tab and its target document",
    '__editorClose.windowFocused=typeof iA.window.state?.focused==="boolean"?iA.window.state.focused:null;__editorClose.isDirty=typeof __editorCloseActive?.document?.isDirty==="boolean"?__editorCloseActive.document.isDirty:null;if(__editorClose.visibleTargetCountBefore!==1){__editorClose.error="visible-target-count:"+String(__editorClose.visibleTargetCountBefore)}else if(__editorClose.activeTextEditorPath!==__editorCloseReal){__editorClose.error="active-text-editor-mismatch"}else if(__editorClose.activeTabPath!==__editorCloseReal){__editorClose.error="active-tab-mismatch"}else if(__editorClose.windowFocused!==true){__editorClose.error="window-not-focused"}else if(__editorClose.isDirty!==false){__editorClose.error="active-editor-not-clean"}else{',
    '__editorClose.windowFocused=typeof iA.window.state?.focused==="boolean"?iA.window.state.focused:null;let __editorCloseTarget=__editorCloseVisible()[0]||null;__editorClose.isDirty=typeof __editorCloseTarget?.document?.isDirty==="boolean"?__editorCloseTarget.document.isDirty:null;if(__editorClose.visibleTargetCountBefore!==1){__editorClose.error="visible-target-count:"+String(__editorClose.visibleTargetCountBefore)}else if(__editorClose.activeTabPath!==__editorCloseReal){__editorClose.error="active-tab-mismatch"}else if(__editorCloseTab?.isActive!==true){__editorClose.error="active-tab-not-active"}else if(__editorClose.windowFocused!==true){__editorClose.error="window-not-focused"}else if(__editorClose.isDirty!==false){__editorClose.error="target-editor-not-clean"}else{'
  );
  replaceOnce(
    "close the exact active tab object instead of command-context activeTextEditor",
    'await iA.commands.executeCommand("workbench.action.closeActiveEditor");__editorClose.applied=true;await __editorClosePromise;__editorClose.visibleTargetCountAfter=__editorCloseVisible().length;__editorClose.ok=__editorClose.visibleTargetCountAfter===0;',
    'let __editorCloseAccepted=await iA.window.tabGroups.close(__editorCloseTab,true);__editorClose.tabCloseAccepted=__editorCloseAccepted===true;__editorClose.applied=__editorClose.tabCloseAccepted;await __editorClosePromise;__editorClose.visibleTargetCountAfter=__editorCloseVisible().length;__editorClose.ok=__editorClose.applied&&__editorClose.visibleTargetCountAfter===0;'
  );
}

if (!text.includes("codex patch rc.7.34: outer pre-run failure contract")) {
  // Snapshot/enrich execute before the payload-level try/catch. Preserve their
  // structured failure evidence when they reach the outer request catch.
  replaceOnce(
    "preserve the complete pre-run contract in the outer bridge catch",
    'catch(e){__release();__send(__res,500,{ok:false,error:e?.message||String(e),patch:__patch})',
    'catch(e){__release();let __codexOuterPrt=e&&e.__codexPreRunTimeout;__send(__res,(__codexOuterPrt&&__codexOuterPrt.status)||500,__codexOuterPrt?Object.assign({},__codexOuterPrt,{ok:false,preRunFailure:__codexOuterPrt,patch:__patch}):{ok:false,error:e?.message||String(e),patch:__patch})/* codex patch rc.7.34: outer pre-run failure contract */'
  );
  text += "\n/* codex patch rc.7.34: outer pre-run failure contract */\n";
}

// ==================================================================
// codex patch rc.7.35: monotonic escalation ladder（缺陷 PF-4）
// ------------------------------------------------------------------
// 原阶梯 45000 → 30000 → 10000 **单调递减**，于是「restore 在 L1 内做不完」
// 按构造保证后两级也做不完。实测 BROAD-RC734-20260823_055413_530294 S12 step5：
//   lastSoftStop.restore.initialError = "... timed out after 45000ms"   (L1)
//   lastSoftStop.restore.error        = "... timed out after 30000ms"   (L2)
//   lastForceResetReconnect.durationMs = 10002 / timeout=true           (L3)
// 终态 status=recovery-required、trueReady=false、自愈 reason=transport-failed。
//
// 修法两条同时生效：
//   1. 五处硬编码期限全部改为从 stop_checkpoint_core.escalationLadder() 取值，
//      reconnect 与 restore 分别计时；
//   2. L2 改用 datasetOnly 降级恢复 —— 更多时间做更少的事。慢的不是 160 KB
//      数据量，是 artifacts>=60 条 estimates/graphs 的逐条重建。
if (!text.includes("codex patch rc.7.35: monotonic escalation ladder")) {
  replaceOnce(
    "hard fallback computes a monotonic escalation ladder before escalating",
    'catch(__restoreError){let __initialRestoreError=__restoreError?.message||String(__restoreError);__restore={ok:false,path:__snapshot.path,error:__initialRestoreError};',
    'catch(__restoreError){let __initialRestoreError=__restoreError?.message||String(__restoreError);__restore={ok:false,path:__snapshot.path,error:__initialRestoreError};'
      + 'let __codexCkpt=globalThis.__codexStopCheckpointRef||null,'
      + '__codexLadder=(__codexCkpt&&__codexCkpt.escalationLadder)?__codexCkpt.escalationLadder(__snapshot):{l1RestoreMs:45000,l2ReconnectMs:15000,l2RestoreMs:67500,l3ReconnectMs:30000,monotonic:true},'
      + '__codexL2ReconnectMs=__codexLadder.l2ReconnectMs,__codexL2RestoreMs=__codexLadder.l2RestoreMs,'
      + '__codexL2Downgrade=(__codexCkpt&&__codexCkpt.restoreDowngradeSummary)?__codexCkpt.restoreDowngradeSummary(__snapshot):null,'
      + '__codexL2RestoreCode=(__codexCkpt&&__codexCkpt.restoreCode)?__codexCkpt.restoreCode(__snapshot,__codexStataString,{datasetOnly:true}):__restoreCode;'
      + '/* codex patch rc.7.35: monotonic escalation ladder */'
  );
  // L2 的 reconnect：原硬编码 10000。实测健康态 force-reset 重连 7.49 s，
  // 只有 25% 余量；压测下必然不够。
  replaceOnce(
    "hard-fallback reconnect uses the ladder reconnect budget",
    ',10000))]);if(!__reconnectAttempt.settled)throw new Error("hard-fallback reconnect timed out after 10000ms")',
    ',__codexL2ReconnectMs))]);if(!__reconnectAttempt.settled)throw new Error("hard-fallback reconnect timed out after "+String(__codexL2ReconnectMs)+"ms")'
  );
  // L2 的 restore：原硬编码 30000（< L1 的 45000，方向反了）。
  replaceOnce(
    "hard-fallback restore uses the ladder restore budget",
    ',30000))]);if(!__retryAttempt.settled)throw new Error("hard-fallback dataset restore timed out after 30000ms")',
    ',__codexL2RestoreMs))]);if(!__retryAttempt.settled)throw new Error("hard-fallback dataset restore timed out after "+String(__codexL2RestoreMs)+"ms")'
  );
  replaceOnce(
    "stale-reconnect retry uses the ladder reconnect budget",
    ',10000))]);if(!__reconnectAttempt.settled)throw new Error("stale-reconnect retry timed out after 10000ms")',
    ',__codexL2ReconnectMs))]);if(!__reconnectAttempt.settled)throw new Error("stale-reconnect retry timed out after "+String(__codexL2ReconnectMs)+"ms")'
  );
  replaceOnce(
    "stale-reconnect restore retry uses the ladder restore budget",
    ',30000))]);if(!__retryAttempt.settled)throw new Error("stale-reconnect dataset restore retry timed out after 30000ms")',
    ',__codexL2RestoreMs))]);if(!__retryAttempt.settled)throw new Error("stale-reconnect dataset restore retry timed out after "+String(__codexL2RestoreMs)+"ms")'
  );
  // L2 的两次 restore 都改跑 datasetOnly 降级码：跳过 estimates/graphs 逐条重建。
  replaceOnce(
    "hard-fallback restore runs the dataset-only downgrade payload",
    'zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:"soft-stop-hard-restore-"+String(__runId||Date.now())})',
    'zg.runSelection(__codexL2RestoreCode,{normalizeResult:!0,includeGraphs:!1,runId:"soft-stop-hard-restore-"+String(__runId||Date.now())})'
  );
  replaceOnce(
    "stale-reconnect restore retry runs the dataset-only downgrade payload",
    'zg.runSelection(__restoreCode,{normalizeResult:!0,includeGraphs:!1,runId:"soft-stop-hard-restore-retry-"+String(__runId||Date.now())})',
    'zg.runSelection(__codexL2RestoreCode,{normalizeResult:!0,includeGraphs:!1,runId:"soft-stop-hard-restore-retry-"+String(__runId||Date.now())})'
  );
  // 降级必须如实标注：ok=true 不能让人以为 estimates/graphs 也回来了。
  // ladder 一并落进回执，使「后级期限不得小于前级」可从产物直接复算。
  replaceOnce(
    "escalated restore discloses the downgrade and the ladder",
    'logPath:__retryResult?.logPath||null,escalated:true,reconnect:__reconnectAttempt,initialError:__initialRestoreError}',
    'logPath:__retryResult?.logPath||null,escalated:true,reconnect:__reconnectAttempt,degraded:__codexL2Downgrade,ladder:__codexLadder,initialError:__initialRestoreError}'
  );
  // L3 force-reset reconnect：原硬编码 10000（实测 durationMs=10002 卡死）。
  // 通用路径拿不到 snapshot，取模块静态值 30000；并把 timeoutMs 写进回执。
  replaceOnce(
    "force-reset reconnect uses the module reconnect budget",
    'let __reconnectStartedAt=Date.now(),__reconnect=await Promise.race([Promise.resolve(zg.connect()).then(()=>({ok:true,settled:true}),__error=>({ok:false,settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({ok:false,settled:false,timeout:true,error:"force-reset backend reconnect timed out after 10000ms"}),10000))]);',
    'let __codexFrReconnectMs=(globalThis.__codexStopCheckpointRef&&globalThis.__codexStopCheckpointRef.forceResetReconnectTimeoutMs)?globalThis.__codexStopCheckpointRef.forceResetReconnectTimeoutMs():30000,__reconnectStartedAt=Date.now(),__reconnect=await Promise.race([Promise.resolve(zg.connect()).then(()=>({ok:true,settled:true}),__error=>({ok:false,settled:true,error:__error?.message||String(__error)})),new Promise(__resolve=>setTimeout(()=>__resolve({ok:false,settled:false,timeout:true,error:"force-reset backend reconnect timed out after "+String(__codexFrReconnectMs)+"ms"}),__codexFrReconnectMs))]);__reconnect.timeoutMs=__codexFrReconnectMs;'
  );
  text += "\n/* codex patch rc.7.35: monotonic escalation ladder */\n";
}

// ==================================================================
// codex patch rc.7.35b: /status 暴露 human-file 派发诊断（缺陷 B 的可观测性缺口）
// ------------------------------------------------------------------
// 实测 broad_stress_rc734_20260820_163407_224614 S12 step9：物理 cmd+shift+d
// 已投递（CGEventPostToPid ok、frontmost=true、focusRole=AXTextArea、目标窗口正确、
// 桥 busy=false/trueReady=true），却没有产生任何 human_file_* 请求 ——
// flat.lastRunId 停在上一条 debug_terminal_*，phase 仍是 completed。
//
// 产品其实**记了**原因：globalThis.__codexHumanFileDebug.stage 会写
// entered / no-active-editor / not-do-file / acquire-failed(+decision) 等。
// 但它只在 /editor-state 与 /debug-run-file 的响应里暴露，/status 的 67 个字段
// 里一个都没有。压测器走物理按键 + 读 /status，于是对「命令到底有没有被调用、
// 被谁拒了」完全瞎，故障被推迟两步才以 409 的形式浮现，归因极难。
//
// 加性改动：只往 /status 多挂一个已有的全局，不改任何判定分支。
if (!text.includes("codex patch rc.7.35b: status exposes human-file dispatch debug")) {
  replaceOnce(
    "status exposes the human-file dispatch debug record",
    'lastTerminalGuardFailure:globalThis.__codexLastTerminalFailure||null',
    'lastTerminalGuardFailure:globalThis.__codexLastTerminalFailure||null,humanFileDebug:globalThis.__codexHumanFileDebug||null,manualCommandDebug:globalThis.__codexManualCommandDebug||null/* codex patch rc.7.35b: status exposes human-file dispatch debug */'
  );
  text += "\n/* codex patch rc.7.35b: status exposes human-file dispatch debug */\n";
}

// ==================================================================
// codex patch rc.7.35c: 成功的 soft-stop 不再被判 graph readiness stale（缺陷 PF-5）
// ------------------------------------------------------------------
// 实测（rc.7.35 真机，20_softstop_snapshotless_PF5.json）：对 terminal-input
// 运行做 soft-stop，停得干干净净 ——
//   lastSoftStop: ok=true cancelled=true drained=true
//                 taskCancel.settled=true taskDrain.terminal=true status=done
//                 breakSession.settled=true
//                 restore={ok:true, skipped:"no pre-run dataset snapshot",
//                          quiescenceProbe:{ok:true, rc:0}}
//                 hardEscalated=false
// 但 /soft-stop 端点返回 500，桥被留在 status=stale / trueReady=false：
//   graph.readinessState = "ready"
//   graph.readinessReason = "soft-stop-complete"
//   graph.readinessRunId  = <被取消的那个 run>
//   graph.lastRunId       = <上一个真正路由过图的 run>      ← 永远追不上
//
// 机理：graph.lastRunId 记的是「最后一次真正路由过图批次的 run」。被取消的运行
// 压根不会产生图批次，所以它永不前进，而 readinessRunId 已经前进 —— runMismatch
// 永久成立。已有的 benignNoGraphMismatch 逃生口只认 no-graph-fast-path /
// native-artifact-only 两种 lastBatchSource，实测那次是 manual-post-export /
// delta-export，逃不掉。
//
// 修法：再开一个**证据绑定**的逃生口，三个合取项一个都不能少：
//   1. readiness 自身已经是 ready；
//   2. 不符可归因于 soft-stop（readinessReason === "soft-stop-complete"）；
//   3. 同一个 run，且那次 soft-stop **真的成功**
//      （__codexLastSoftStop.ok === true 且 runId === readinessRunId）。
// 第 3 条是 fail-closed 的关键：soft-stop **失败**时仍然判 stale —— 那正是
// PF-4 升级失败的形态，桥确实没准备好，不许被这个逃生口放过去。
if (!text.includes("codex patch rc.7.35c: successful soft-stop is not graph-readiness stale")) {
  replaceOnce(
    "successful soft-stop clears the graph readiness run mismatch",
    "    if (readiness === \"draining\" || readiness === \"recovering\" || readiness === \"broken\" || readiness === \"stale\" || (runMismatch && !benignNoGraphMismatch)) {",
    "    /* codex patch rc.7.35c: successful soft-stop is not graph-readiness stale */\n"
    + "    const __codexStopReceipt = globalThis.__codexLastSoftStop || null;\n"
    + "    const benignSoftStopMismatch = runMismatch && readiness === \"ready\"\n"
    + "      && graph.readinessReason === \"soft-stop-complete\"\n"
    + "      && !!__codexStopReceipt && __codexStopReceipt.ok === true\n"
    + "      && String(__codexStopReceipt.runId || \"\") === String(readinessRunId);\n"
    + "    const benignMismatch = benignNoGraphMismatch || benignSoftStopMismatch;\n"
    + "    if (readiness === \"draining\" || readiness === \"recovering\" || readiness === \"broken\" || readiness === \"stale\" || (runMismatch && !benignMismatch)) {"
  );
  replaceOnce(
    "graph readiness mismatch status honors the benign soft-stop case",
    "      const status = readiness === \"stale\" || runMismatch ? \"stale\" : (readiness || \"not-ready\");",
    "      const status = readiness === \"stale\" || (runMismatch && !benignMismatch) ? \"stale\" : (readiness || \"not-ready\");"
  );
  text += "\n/* codex patch rc.7.35c: successful soft-stop is not graph-readiness stale */\n";
}

// ==================================================================
// codex patch rc.7.37: degraded Stop recovery blocks shared continuity
// ------------------------------------------------------------------
// Backend connectivity is not the shared-session contract.  An L2 dataset-only
// restore may leave estimates/graphs behind, and a successful hard reset may
// leave the checkpoint unrestored.  Both cases must remain fail-closed until an
// explicit reset + recovery smoke establishes a new session boundary.
if (!text.includes("codex patch rc.7.37: degraded Stop recovery blocks shared continuity")) {
  replaceOnce(
    "soft Stop keeps its recovery classification local to the request",
    "__taskDrain=null,__transportDrain=null;",
    "__taskDrain=null,__transportDrain=null,__softStopRecoveryClass=null;"
  );
  replaceOnce(
    "soft Stop publishes continuity loss from the checkpoint arbiter",
    'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);globalThis.__codexGraphMark&&__codexGraphMark({readinessState:__codexStopReady.readinessState,readinessReason:__codexStopReady.readinessReason,readinessRunId:__runId,readinessUpdatedAt:new Date().toISOString(),lastClientError:__codexStopReady.lastClientError})}catch{}/* codex patch rc.7.21: successful hard reset owns final readiness */',
    'try{let __codexStopReady=globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset);__softStopRecoveryClass=__codexStopReady.recoveryClass||null;if(__codexStopReady.continuityLost){globalThis.__codexContinuityLost={at:new Date().toISOString(),runId:__runId,...__codexStopReady.continuityLost};globalThis.__codexContinuityNote=null}globalThis.__codexGraphMark&&__codexGraphMark({readinessState:__codexStopReady.readinessState,readinessReason:__codexStopReady.readinessReason,readinessRunId:__runId,readinessUpdatedAt:new Date().toISOString(),lastClientError:__codexStopReady.lastClientError})}catch(__codexStopArbitrationError){__softStopRecoveryClass="RECOVERY_FAILED";globalThis.__codexContinuityLost={at:new Date().toISOString(),runId:__runId,reason:"soft-stop-readiness-arbitration-threw",detail:String(__codexStopArbitrationError?.message||__codexStopArbitrationError)}}/* codex patch rc.7.21: successful hard reset owns final readiness *//* codex patch rc.7.37: degraded Stop recovery blocks shared continuity */'
  );
  replaceOnce(
    "successful soft Stop receipt exposes the recovery class",
    'restore:__restore,reason:String(__reason||"user")',
    'restore:__restore,recoveryClass:__softStopRecoveryClass||(__restore&&__restore.ok===true?"RECOVERED_FULL":"RECOVERY_FAILED"),reason:String(__reason||"user")'
  );
  replaceOnce(
    "failed soft Stop receipt exposes the recovery class",
    'restored:false,error:__softStopError?.message||String(__softStopError),reason:String(__reason||"user")',
    'restored:false,error:__softStopError?.message||String(__softStopError),recoveryClass:"RECOVERY_FAILED",reason:String(__reason||"user")'
  );
  replaceOnce(
    "Terminal Stop reports partial state loss instead of claiming restoration",
    'iA.window.showWarningMessage(g&&g.ok===false?"Stata Workbench Stop required hard recovery; inspect /status before continuing.":"Stata Workbench stopped the current request and restored the pre-run dataset when available.")',
    'iA.window.showWarningMessage(g&&g.recoveryClass==="RECOVERED_DEGRADED"?"Stata Workbench restored the dataset/globals but did not restore "+String(g?.restore?.degraded?.skippedEstimates||0)+" estimates and "+String(g?.restore?.degraded?.skippedGraphs||0)+" graphs; shared-session continuity is blocked. Run recovery/reset and inspect /status.":g&&g.ok===false?"Stata Workbench Stop required hard recovery; inspect /status before continuing.":"Stata Workbench stopped the current request and restored the complete pre-run checkpoint when one existed.")'
  );
  text += "\n/* codex patch rc.7.37: degraded Stop recovery blocks shared continuity */\n";
}

// ==================================================================
// codex patch rc.7.39: 空 inline manifest 分支不得提前释放 postRunBusy
// ------------------------------------------------------------------
// 实测（fresh S44 step 18 判 GRAPH_ROUTE_NOT_ATTEMPTED）：
// __codexRouteGraphSnapshotManifest 在 artifacts 为空的分支里先
// __codexSetPostRunBusy(false, "inline-snapshot-empty", runId) 再 return false；
// 而它唯一的调用方 __codexRouteGraphManifestOrExport 看到 false 之后还要
// await __codexExportCurrentGraphsForPanel（数秒），真正的释放在那个 finally 里。
// 于是 ready:!busy&&!postRunBusy 在路由仍在进行时就转绿，门禁按固定 3s settle
// 采样，恰好错过 1.668s 之后才落地的那 52 张图。
//
// 修法是一处纯减法：删掉这个提前释放，释放权由外层 finally 独占。
//
// 本 transform 刻意**不**追加 dist 标记：已验收的 bundle
// sha256 7d38d9a4df880704b8b0505d8dcc30ec9d7af21450814f6698c842fd2762a286
// 里并没有标记，追加就会改变它。收敛标记就是下面那四行中文注释本身。
// 双计数 + fail-closed：1/0 → 替换一次；0/1 → 已修好，不动一个字节；
// 其余任何组合都抛（绝不猜、绝不部分替换）。
{
  const rc739Old = '    __codexSetPostRunBusy(false, "inline-snapshot-empty", runId);\n';
  const rc739Fixed =
    "    // 空 inline manifest 只意味着「改走 fallback」，不是「本次投递结束」。\n" +
    "    // 这里绝不能释放 postRunBusy：调用方 __codexRouteGraphManifestOrExport 看到\n" +
    "    // false 后还要 await __codexExportCurrentGraphsForPanel，释放由其 finally 独占。\n" +
    "    // 提前释放会让 trueReady(=!busy&&!postRunBusy) 在路由仍在进行时就转绿。\n";
  const rc739OldCount = text.split(rc739Old).length - 1;
  const rc739FixedCount = text.split(rc739Fixed).length - 1;
  if (rc739OldCount === 1 && rc739FixedCount === 0) {
    const rc739At = text.indexOf(rc739Old);
    text = text.slice(0, rc739At) + rc739Fixed + text.slice(rc739At + rc739Old.length);
  } else if (rc739OldCount !== 0 || rc739FixedCount !== 1) {
    throw new Error(
      "unexpected rc.7.39 inline-snapshot-empty shape: old=" + rc739OldCount +
        " fixed=" + rc739FixedCount + " (expected 1/0 to patch, or 0/1 already patched)"
    );
  }
}

/* ===================================================================
 * R16J89 Data Browser / execution isolation gate wiring.
 * Execution-priority admission barrier + explicit HTTP uncertainty.
 * This does NOT claim to repair the mcp-stata server wedge; it forbids new
 * Data Browser admission once execution reserved, drains only already-admitted
 * requests under a 5,000 ms budget, and makes unresolved generations visible.
 * Budget order: drain 5,000 < socket-idle 30,000 < wall 32,000 < sentinel 46,000.
 * =================================================================== */
function rc7j89(name, before, after) {
  // R120 deliberately replaces the complete admission prefix. Its generated
  // method is executed by the wiring tests; do not try to reapply R91 over it.
  if (name === "r16j91-admission-and-response" &&
      text.includes("codex patch r16j120: epoch-bound credentials") &&
      text.includes('__dbStale.gateCode="stale-ui-channel"')) return "superseded-r16j120";
  // `after` is strictly more specific than `before` and in most of these sites
  // literally CONTAINS it, so the post-patch form must be tested first or a
  // re-run sees both and cannot decide.
  const afterCount = text.split(after).length - 1;
  if (afterCount === 1) return "already";
  if (afterCount > 1) {
    throw new Error("non-unique r16j89 patched form: " + name + " after=" + afterCount);
  }
  const beforeCount = text.split(before).length - 1;
  if (beforeCount === 1) {
    const at = text.indexOf(before);
    text = text.slice(0, at) + after + text.slice(at + before.length);
    return "applied";
  }
  throw new Error(
    "unexpected r16j89 anchor shape: " + name +
      " before=" + beforeCount + " after=" + afterCount
  );
}

const r16j89 = {};

// (1) Require the gate once at activation and publish the shared singleton.
r16j89.require = rc7j89(
  "r16j89-require",
  'let __http=require("http"),__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js"))',
  'let __http=require("http"),__codexDbGateMod=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","data_browser_execution_gate.js")),__codexDbGate=(globalThis.__codexDbGateMod=__codexDbGateMod,globalThis.__codexDbGate=globalThis.__codexDbGate||__codexDbGateMod.getSharedGate({/* codex patch r16j91: non-mutating liveness probe, signal 0 only */pidAlive:function(__pid){try{process.kill(__pid,0);return true}catch(__pe){return __pe&&__pe.code==="EPERM"}}})),__codexControl=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","control_plane_core.js"))'
);

// (2) Synchronous reservation in the common _enqueue, before any await or queue
//     wait, so admission closes even while the execution is still queued.
r16j89.reserve = rc7j89(
  "r16j89-enqueue-reserve",
  "let s=!!(I.bypassQueue||o),n=I.runId||`internal-${Math.random().toString(36).slice(2,9)}`;this._pending+=1",
  "let s=!!(I.bypassQueue||o),n=I.runId||`internal-${Math.random().toString(36).slice(2,9)}`;/* codex patch r16j89: synchronous execution reservation before any await */let __execGate=globalThis.__codexDbGate||null,__execRes=null;if(__execGate&&__execGate.isExecutionOperation(A)){let __execTaken=__execGate.reserveExecution({op:A,runId:String(n)});if(!__execTaken.ok){let __execErr=new Error(\"execution blocked by Data Browser gate: \"+__execTaken.code);__execErr.gateCode=__execTaken.code;throw __execErr}__execRes=__execTaken.reservation}this._pending+=1"
);

// (3) Await the drain inside the real operation promise, before _ensureClient
//     and before Q(m). A failed drain invokes both exactly zero times.
r16j89.drain = rc7j89(
  "r16j89-enqueue-drain",
  "try{let m=await this._ensureClient(),L=await this._withTimeout(Q(m),t,A,r.token)",
  "try{/* codex patch r16j89: 5000ms HTTP drain reports before the ~46000ms sentinel */if(__execRes&&__execGate){let __execDrain=await __execGate.waitForHttpDrain(__execRes,5e3);if(!__execDrain.ok){let __drainErr=new Error(\"execution gate drain failed: \"+__execDrain.code);__drainErr.gateCode=__execDrain.code;__drainErr.gateDrain=__execDrain;throw __drainErr}}let m=await this._ensureClient(),L=await this._withTimeout(Q(m),t,A,r.token)"
);

// (4) Release from the REAL promise d in finally, never from Promise.race([d,c]):
//     an outer cancellation must not reopen HTTP while backend work may be alive.
r16j89.release = rc7j89(
  "r16j89-enqueue-release",
  ",d=(async()=>{try{return s||await this._queue.catch(()=>{}),await u()}finally{G&&G.dispose()}})();",
  ",d=(async()=>{try{return s||await this._queue.catch(()=>{}),await u()}finally{G&&G.dispose(),/* codex patch r16j89: release only from the real promise */__execRes&&__execGate&&__execGate.releaseExecution(__execRes)}})();"
);

// (5) Data Browser lifecycle: admission, settle-once adapter, response-emitter
//     ownership, private started flag, and a catch that can actually see them.
//     ONE pair: layered anchors invalidated each other's post-patch forms.
r16j89.j91Locals = rc7j89("r16j91-lifecycle-locals", "()=>new Promise((B,C)=>{try{let E=new URL(A),e=I.body,t={...I.headers};", "()=>new Promise((B,C)=>{/* codex patch r16j91: lifecycle locals OUTSIDE try so catch can see them; one settle-once adapter */let __dbGate=globalThis.__codexDbGate||null,__dbTok=null,__dbStarted=false,__dbSettled=false,__dbSettle=function(__oc){if(__dbSettled)return false;if(!__dbTok||!__dbGate)return false;__dbSettled=true;__dbGate.finishHttp(__dbTok,__oc);return true};try{let E=new URL(A),e=I.body,t={...I.headers};");
r16j89.j91Admit  = rc7j89("r16j91-admission-and-response", "t.Connection=\"close\";let o={method:I.method,headers:t,timeout:3e4},s=yHg.request(E,o,n=>{let r=[];n.on(\"data\",a=>r.push(a)),n.on(\"end\",()=>{let a=Buffer.concat(r);", "t.Connection=\"close\";/* codex patch r16j91: admission before the socket exists */if(__dbGate){let __dbAdm=__dbGate.beginHttp({path:E.pathname,method:I.method,baseUrl:E.origin});if(!__dbAdm.ok){let __dbErr=new Error(\"Data Browser request refused by execution gate: \"+__dbAdm.code);__dbErr.gateCode=__dbAdm.code;return C(__dbErr)}__dbTok=__dbAdm.token}let o={method:I.method,headers:t,timeout:3e4},s=yHg.request(E,o,n=>{let r=[];/* codex patch r16j91: response emitter ownership, settle-once */n.on(\"aborted\",()=>{__dbSettle(\"abort\")&&C(new Error(\"Proxy response aborted from Stata server\"))}),n.on(\"error\",__re=>{__dbSettle(\"error\")&&C(__re)}),n.on(\"close\",()=>{__dbSettle(\"abort\")&&C(new Error(\"Proxy response closed before end from Stata server\"))}),n.on(\"data\",a=>r.push(a)),n.on(\"end\",()=>{__dbSettle(\"response-end\");let a=Buffer.concat(r);");
r16j89.j91Tail   = rc7j89("r16j91-request-tail-and-catch", "s.on(\"timeout\",()=>{s.destroy(),C(new Error(\"Proxy request timed out from Stata server\"))}),s.on(\"error\",n=>{GM.captureException(n),C(n)}),e&&s.write(e),s.end()}catch(E){C(E)}}))}", "s.on(\"timeout\",()=>{let __w=__dbSettle(\"timeout\");s.destroy();__w&&C(new Error(\"Proxy request timed out from Stata server\"))}),s.on(\"error\",n=>{let __w=__dbSettle(\"error\");GM.captureException(n);__w&&C(n)}),s.on(\"abort\",()=>{__dbSettle(\"abort\")&&C(new Error(\"Proxy request aborted before response end\"))}),s.on(\"close\",()=>{__dbSettle(\"abort\")&&C(new Error(\"Proxy request closed before response end\"))}),__dbTok&&__dbGate&&(__dbGate.markHttpStarted(__dbTok),__dbStarted=true,__dbGate.armWallWatchdog(__dbTok)),e&&s.write(e),s.end()}catch(E){/* codex patch r16j91: private started flag; cleanup errors are not swallowed */__dbSettle(__dbStarted?\"error\":\"construction-failed\");C(E)}}))}");

// (8) Gate refusals are not credential failures: they must not consume or
//     trigger the dataset credential-recovery tries.
r16j89.credRecovery = rc7j89(
  "r16j89-credential-recovery-exclusion",
  'let __dbRecoverable=__dbRequestPath==="/v1/dataset"&&this._credentialRecoveryAttempts<2;',
  'let __dbGateCode=(B&&B.gateCode)||null,__dbRecoverable=!__dbGateCode&&__dbRequestPath==="/v1/dataset"&&this._credentialRecoveryAttempts<2;'
);

// (10) A verified changed credential origin rotates the channel generation
//      (audit P1-7).
r16j89.rotate = text.includes("codex patch r16j120: epoch-bound credentials") ? "superseded-r16j120" : rc7j89(
  "r16j90-credentials-rotate",
  "this._credentials={baseUrl:A.baseUrl,token:A.token};this._credentialRefreshes+=1;",
  'let __dbRotPrior=this._credentials&&this._credentials.baseUrl||null;this._credentials={baseUrl:A.baseUrl,token:A.token};this._credentialRefreshes+=1;/* codex patch r16j90: verified fresh origin rotates the gate generation */try{let __dbRotGate=globalThis.__codexDbGate||null;if(__dbRotGate&&__dbRotPrior&&A.baseUrl){let __dbRot=__dbRotGate.rotateChannel({verifiedFresh:true,expectedGeneration:__dbRotGate.generation,expectedPriorBaseUrl:__dbRotPrior,baseUrl:A.baseUrl});if(__dbRot&&__dbRot.ok)Object.assign(globalThis.__codexDataBrowserStatus||{},{gateGeneration:__dbRot.generation})}}catch(__dbRotErr){}'
);

// (11) Pre-force-reset census BEFORE the first finishRun / panic-kill /
//      clear / cancel / dispose / PID-map mutation (r16j92 P1-2).
//      Capture failure is diagnostic-only and never blocks fail-closed reset.
r16j89.resetDiag = rc7j89("r16j92-census-before-finishrun", "/* codex patch rc.6.3: capture hadContinuityLost before clear */let __codexForceResetWasBusy=!!s.busy;", "/* codex patch rc.6.3: capture hadContinuityLost before clear *//* codex patch r16j92: census BEFORE the first finishRun / panic-kill / clear */let __dbResetGate=null,__dbResetGen=null,__dbResetUnc=null;try{__dbResetGate=globalThis.__codexDbGate||null;if(__dbResetGate){__dbResetGen=__dbResetGate.generation;let __dbUncId=__dbResetGate.uncertaintyIdentity();__dbResetUnc=__dbUncId?__dbUncId.uncertaintyId:null;__dbResetGate.captureDiagnostic({reason:\"force-reset:\"+(o||\"unknown\"),runId:(s&&s.runId)||null,ownedPids:Array.from((globalThis.__codexOwnedBackendPids||new Map).keys())})}}catch(__dbDiagErr){}let __codexForceResetWasBusy=!!s.busy;");

// (12) Strict generation- and identity-bound clearance, only after the existing
//      product-owned reconnect reports ok===true (audit P0-3, P1-7).
r16j89.reconnectClear = rc7j89(
  "r16j90-reconnect-clear",
  "__reconnect.timeoutMs=__codexFrReconnectMs;__reconnect.durationMs=Date.now()-__reconnectStartedAt;",
  '__reconnect.timeoutMs=__codexFrReconnectMs;__reconnect.durationMs=Date.now()-__reconnectStartedAt;/* codex patch r16j90: clearance bound to pre-reset generation and uncertainty id */try{if(__dbResetGate&&__reconnect&&__reconnect.ok===true&&__dbResetGen!==null){let __dbClear=__dbResetGate.resetAfterReconnect({reconnectOk:true,expectedGeneration:__dbResetGen,expectedUncertaintyId:__dbResetUnc});__reconnect.gateCleared=!!(__dbClear&&__dbClear.ok);__reconnect.gateGeneration=(__dbClear&&__dbClear.generation)||null}else if(__dbResetGate)__reconnect.gateCleared=false}catch(__dbClearErr){}'
);

// (13) /status exposes the live gate snapshot and the last pre-reset wedge
//      diagnostic without changing the existing lifecycle schema (audit P1-8).
r16j89.status = rc7j89(
  "r16j90-status-exposure",
  "dataBrowser:globalThis.__codexDataBrowserStatus||null,manualCommand:globalThis.__codexManualCommandDebug||null,",
  "dataBrowser:globalThis.__codexDataBrowserStatus||null,executionGate:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.snapshot():null}catch(__dbSnapErr){return null}})(),executionGateDiagnostic:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.lastDiagnostic:null}catch(__dbDiagErr2){return null}})(),manualCommand:globalThis.__codexManualCommandDebug||null,"
);

console.log(
  "R16J90_DB_EXECUTION_GATE " +
    Object.keys(r16j89).map((k) => k + "=" + r16j89[k]).join(" ")
);

// Failed or degraded Stop must retain the only recovery copy. Normal run
// cleanup is deliberately unchanged; this anchor is unique to soft Stop.
if (!text.includes("codex patch r16j114: retain checkpoint after failed Stop")) {
  replaceOnce(
    "retain failed Stop checkpoint evidence",
    'try{globalThis.__codexStopCheckpointRef.cleanup(__snapshot)}catch{}try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId);',
    'try{/* codex patch r16j114: retain checkpoint after failed Stop */if(globalThis.__codexStopCheckpointRef.softStopReadiness(__restore,__hardReset).ready===true)globalThis.__codexStopCheckpointRef.cleanup(__snapshot)}catch{}try{(globalThis.__codexPreRunSnapshots||new Map).delete(__runId);'
  );
}

// A successful reconnect fences HTTP tokens, but it also retires the backend's
// UI port/token. Never let cached post-run summaries open a socket on that old
// channel. Fresh credentials are obtained only by the existing explicit UI
// fetch path, not by adding an MCP metadata call to every execution.
if (!text.includes("codex patch r16j120: epoch-bound credentials")) {
  replaceOnce(
    "capture credential generation before the async channel query",
    'let A=await uHg.getUiChannel();if(A&&A.baseUrl&&A.token){',
    'let __dbCredentialGate=globalThis.__codexDbGate||null,__dbCredentialGen=__dbCredentialGate?__dbCredentialGate.generation:null;let A=await uHg.getUiChannel();if(__dbCredentialGate&&__dbCredentialGate.generation!==__dbCredentialGen)return{ok:false,reason:"stale-credential-response"};if(A&&A.baseUrl&&A.token){'
  );
  replaceOnce(
    "publish credentials only after generation-bound origin rotation",
    'let __dbRotPrior=this._credentials&&this._credentials.baseUrl||null;this._credentials={baseUrl:A.baseUrl,token:A.token};this._credentialRefreshes+=1;/* codex patch r16j90: verified fresh origin rotates the gate generation */try{let __dbRotGate=globalThis.__codexDbGate||null;if(__dbRotGate&&__dbRotPrior&&A.baseUrl){let __dbRot=__dbRotGate.rotateChannel({verifiedFresh:true,expectedGeneration:__dbRotGate.generation,expectedPriorBaseUrl:__dbRotPrior,baseUrl:A.baseUrl});if(__dbRot&&__dbRot.ok)Object.assign(globalThis.__codexDataBrowserStatus||{},{gateGeneration:__dbRot.generation})}}catch(__dbRotErr){}',
    '/* codex patch r16j120: epoch-bound credentials */let __dbRotGate=__dbCredentialGate;if(__dbRotGate){let __dbRotPrior=__dbRotGate.snapshot().origin,__dbNextOrigin=new URL(A.baseUrl).origin;if(__dbRotPrior!==__dbNextOrigin){let __dbRot=__dbRotGate.rotateChannel({verifiedFresh:true,expectedGeneration:__dbCredentialGen,expectedPriorBaseUrl:__dbRotPrior,baseUrl:A.baseUrl});if(!__dbRot||__dbRot.ok!==true)return{ok:false,reason:"credential-rotation-rejected"}}else if(__dbRotGate.isChannelUncertain())return{ok:false,reason:"credential-channel-uncertain"}}this._credentialGeneration=__dbRotGate?__dbRotGate.generation:null;this._credentials={baseUrl:A.baseUrl,token:A.token};this._credentialRefreshes+=1;Object.assign(globalThis.__codexDataBrowserStatus||{},{gateGeneration:this._credentialGeneration,requiresRefresh:false});'
  );
  replaceOnce(
    "refuse stale UI generation origin or bearer before HTTP admission",
    'if(__dbGate){let __dbAdm=__dbGate.beginHttp({path:E.pathname,method:I.method,baseUrl:E.origin});',
    'if(__dbGate){let __dbCached=g.currentPanel&&g.currentPanel._credentials,__dbCachedGen=g.currentPanel&&g.currentPanel._credentialGeneration;if(!__dbCached||__dbCachedGen!==__dbGate.generation||new URL(__dbCached.baseUrl).origin!==E.origin||t.Authorization!=="Bearer "+__dbCached.token){let __dbStale=new Error("Data Browser channel belongs to a retired backend; reopen Data Browser to refresh");__dbStale.gateCode="stale-ui-channel";Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:false,requiresRefresh:true,lastError:__dbStale.message});return C(__dbStale)}let __dbAdm=__dbGate.beginHttp({path:E.pathname,method:I.method,baseUrl:E.origin});'
  );
  replaceOnce(
    "skip optional summary with retired cache without disabling active summary",
    'if(!g||!g.baseUrl||!g.token)return;/* codex patch rc.7.40: post-run summary uses cached Data Browser credentials */',
    'if(!g||!g.baseUrl||!g.token)return;/* codex patch rc.7.40: post-run summary uses cached Data Browser credentials */let __dbSummaryGate=globalThis.__codexDbGate||null;if(__dbSummaryGate&&GD.currentPanel._credentialGeneration!==__dbSummaryGate.generation){Object.assign(globalThis.__codexDataBrowserStatus||{},{credentialsReady:false,requiresRefresh:true,lastError:"cached UI credentials retired by backend reconnect"});return}'
  );
}

// A reconnect creates a new stdio pipe. An instance-wide "attached" boolean
// leaves every later backend's stderr unread, eventually blocking that backend
// on a full pipe. Track concrete transports instead; proc/wrapper/post-connect
// aliases of one transport still have exactly one consumer.
if (!text.includes("codex patch r16j126: stderr consumer per transport")) {
  replaceOnce(
    "stderr listener lifetime belongs to the transport, not the client",
    '_attachStderrListener(A,I){return!A||typeof A.on!="function"||this._stderrStreamAttached||A._stataListenerAttached?!1:(A._stataListenerAttached=!0,this._stderrStreamAttached=!0,A.setEncoding?.("utf8"),A.on("data",Q=>this._handleStderrData(Q,I)),!0)}',
    '_attachStderrListener(A,I,B){/* codex patch r16j126: stderr consumer per transport */if(!A||typeof A.on!=="function")return false;let C=B&&typeof B==="object"?B:A;this._stderrAttachedTransports||(this._stderrAttachedTransports=new WeakSet);if(this._stderrAttachedTransports.has(C)||A._stataListenerAttached)return false;A.setEncoding?.("utf8");A.on("data",Q=>this._handleStderrData(Q,I));A._stataListenerAttached=true;this._stderrAttachedTransports.add(C);return true}'
  );
  replaceOnce("bind early process stderr to its transport",
    'this._attachStderrListener(F.stderr,"proc")',
    'this._attachStderrListener(F.stderr,"proc",d)');
  replaceOnce("bind transport stderr to its transport",
    'this._attachStderrListener(H,"transport")',
    'this._attachStderrListener(H,"transport",d)');
  replaceOnce("bind post-connect fallback to its transport",
    'this._attachStderrListener(C.stderr,"post_connect")',
    'this._attachStderrListener(C.stderr,"post_connect",Q)');
}

// Keep the new finalizer in the deterministic maintenance replay. As with the
// other patches, replay leaves fingerprint finalization to the final build step.
text = require("./apply_inline_error_finalizer_patch").patchBundle(text, { finalize: false });
text = require("./apply_terminal_memory_patch").patchBundle(text, { finalize: false });
text = require("./apply_source_column_graph_batch_patch").patchBundle(text, { finalize: false });
text = require("./apply_log_tail_fairness_patch").patchBundle(text, { finalize: false });
text = require("./apply_bridge_request_preservation_patch").patchBundle(text, { finalize: false });
text = require("./apply_bridge_prerun_failure_patch").patchBundle(text, { finalize: false });
text = require("./apply_graph_inventory_guard_patch").patchBundle(text, { finalize: false });
text = require("./apply_activation_isolation_patch").patchBundle(text, { finalize: false });
text = require("./apply_manual_graph_preview_patch").patchBundle(text, { finalize: false });
fs.writeFileSync(target, text, "utf8");
console.log(baseAlreadyApplied ? "RC7_SHARED_EXECUTION_UPDATED" : "RC7_SHARED_EXECUTION_APPLIED", target);
