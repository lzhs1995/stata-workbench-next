"use strict";
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../dist/extension.js"),"utf8");
function extract(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a);return source.slice(a,b);}
const shown=[],artifacts=[];let snapshots=0,created=0;
const panel={viewColumn:2,visible:false,webview:{asWebviewUri:v=>({toString:()=>String(v)})},reveal:(...v)=>shown.push(v)};
const context={iA:{window:{visibleTextEditors:[]}},Gg:{appendRunArtifact:(id,a)=>artifacts.push([id,a])},rg:{basename:p=>p.split('/').at(-1)},__codexGraphPanel:panel,__codexGraphPanelDiag:{revealCount:7,lastRevealAt:'unchanged'},__codexGraphState:{runId:null,graphs:[],version:0},__codexResolveArtifactPath:a=>a.path,__codexUriFile:p=>p,__codexGraphLog(){},__codexQueueGraphSnapshot(){snapshots++;},__codexEnsureGraphPanel(){created++;return panel;},__codexArtifactIsHelp:()=>false};
context.__codexGraphMark=p=>Object.assign(context.__codexGraphPanelDiag,p);vm.createContext(context);
vm.runInContext(extract('function __codexSourceShowOptions(', 'function __codexGraphTargetColumn('),context);
const doc={uri:{fsPath:'/author.do'}};
context.iA.window.visibleTextEditors=[{document:doc,viewColumn:1}];
assert.equal(context.__codexSourceShowOptions(doc).viewColumn,1,'Terminal-focused Group2 must not attract already-visible source');
context.iA.window.visibleTextEditors=[];assert.equal(context.__codexSourceShowOptions(doc).viewColumn,undefined,'no invented column for unopened source');
context.iA.window.visibleTextEditors=[{document:doc,viewColumn:1},{document:doc,viewColumn:2}];assert.equal(context.__codexSourceShowOptions(doc).viewColumn,undefined,'ambiguous targets are not silently claimed unique');
vm.runInContext(extract('function __codexHandleArtifactBatch(', 'function __codexHandleArtifact('),context);
const batch=[{path:'/old1.svg',name:'old1'},{path:'/old2.svg',name:'old2'}];
context.__codexHandleArtifactBatch('run1',batch,'inline-snapshot',0);
assert.equal(shown.length,0);assert.equal(created,0);assert.equal(snapshots,1);assert.equal(context.__codexGraphState.graphs.length,2);assert.equal(context.__codexGraphPanelDiag.revealCount,7);assert.equal(context.__codexGraphPanelDiag.lastRevealAt,'unchanged');assert.equal(context.__codexGraphPanelDiag.panelVisible,false);
panel.visible=true;context.__codexHandleArtifactBatch('run1',batch,'inline-snapshot',0);assert.equal(shown.length,0);assert.equal(context.__codexGraphPanelDiag.panelVisible,true);assert.equal(context.__codexGraphState.graphs.length,2,'same artifacts updated not discarded');
context.__codexGraphPanel=null;context.__codexHandleArtifactBatch('run2',batch,'inline-snapshot',0);assert.equal(created,0);assert.equal(artifacts.length,2);assert.deepEqual(artifacts.map(a=>a[1].path),['/old1.svg','/old2.svg']);
// The individual/explicit existing display path retains its reveal operation.
const single=extract('function __codexHandleArtifact(', 'var kM=');
assert(single.includes('panel.reveal(panel.viewColumn || __codexGraphTargetColumn(), false)'));
vm.runInContext(single,context);context.__codexHandleArtifact('explicit',{path:'/explicit.svg'});assert.equal(shown.length,1);assert.equal(created,1);
for(const name of ['__debugDoc','__codexOverrideDoc','__codexActiveTabDoc']){
 assert(!source.includes('showTextDocument('+name+',{preview:false})'));
 assert(source.includes('showTextDocument('+name+',__codexSourceShowOptions('+name+'))'));
}
console.log('SOURCE_COLUMN_GRAPH_BATCH_PASS: unique source column, no automatic create/reveal, complete background artifacts, actual visibility diagnostics, explicit reveal retained');
