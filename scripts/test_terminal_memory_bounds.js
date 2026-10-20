#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bundle = fs.readFileSync(path.join(__dirname, '../dist/extension.js'), 'utf8');
const generator = bundle.slice(bundle.indexOf('function FDA'), bundle.indexOf('function JO', bundle.indexOf('function FDA')));
const tag = '<script nonce="${I}">';
const begin = generator.indexOf(tag, generator.indexOf(tag) + tag.length) + tag.length;
const source = vm.runInNewContext('`' + generator.slice(begin, generator.indexOf('</script>', begin)) + '`');
new vm.Script(source);
class Element {
  constructor() { this.children = []; this.dataset = {}; this.classList = {add(){}}; this.listeners = new Map(); this.scrollTop = 0; }
  appendChild(el) { el.parent = this; this.children.push(el); }
  prepend(el) { el.parent = this; this.children.unshift(el); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this),1); }
  addEventListener(k,v) { this.listeners.set(k,v); }
  removeEventListener(k,v) { if(this.listeners.get(k) === v) this.listeners.delete(k); }
  querySelector() { return null; }
  get scrollHeight() { return this.children.length * 100; }
  get lastElementChild() { return this.children.at(-1); }
  get firstElementChild() { return this.children[0]; }
  set innerHTML(value) { this.children=[]; this.html=value; }
  get innerHTML() { throw Error('Unbounded stream serialization forbidden'); }
  get outerHTML() { return this.html || '<card/>'; }
}
const messages=[], conversions=[], persisted=[];
const stream = new Element();
const ctx = {
  document: {createElement(){return new Element();}},
  window: {stataUI:{smclToHtml(s){conversions.push(s.length);return s;}}},
  vscode:{postMessage(v){messages.push(v);},setState(v){persisted.push(v);}},
  scheduleHighlight(){}, console:{log(){},error(){}},
  safeSliceTail:(s,n)=>s.slice(-n), chatStream:stream,
  runs:{}, searchControllers:new Map(), taskDoneRuns:new Set(), logUpdateQueued:new Set(),
  history:[],sessionArtifacts:[]
};
vm.createContext(ctx);
const helpers = source.slice(source.indexOf('    function boundedTerminalText('),source.indexOf('    // Debounce mutation observer'));
vm.runInContext(helpers,ctx);
const logClass = source.slice(source.indexOf('    class LogViewer {'),source.indexOf('    // Register global handler for log chunks'));
vm.runInContext(logClass+'\nthis.LogViewer=LogViewer;',ctx);
// Former code requested the full 200 MB and loaded forward automatically.
const box=new Element();
const viewer=new ctx.LogViewer(box,'/evidence/full.log',200_000_000,'r',{autoLoadAll:true});
assert.equal(messages[0].maxBytes,50_000);
assert.equal(messages[0].offset,199_950_000);
viewer.appendData('x'.repeat(1_000_000),199_999_999);
assert.equal(messages.length,1,'no implicit full-log hydration');
assert.ok(conversions.at(-1)<51_000,'oversized response is bounded before HTML conversion');
for(let i=0;i<100;i++) {viewer.pendingPrepend=true;viewer.appendData('old chunk',0);}
assert.equal(box.children.length,4,'manual historical paging must not accumulate unlimited chunks');
viewer.dispose();viewer.fetchChunk(0);viewer.appendData('late response',0);
assert.equal(messages.length,1);assert.equal(box.listeners.size,0);
// Hundreds of settled cards plus one active request: keep active and recent settled.
for(let i=0;i<500;i++) {const el=new Element();el.dataset.runId='r'+i;stream.appendChild(el);ctx.runs['r'+i]={settled:true};ctx.searchControllers.set('r'+i,{});ctx.taskDoneRuns.add('r'+i);}
const active=new Element();active.dataset.runId='active';stream.prepend(active);ctx.runs.active={settled:false};
ctx.saveState();
assert.equal(stream.children.length,21);assert.ok(ctx.runs.active);assert.equal(Object.keys(ctx.runs).length,21);assert.equal(ctx.searchControllers.size,20);
assert.equal(persisted.length,1);assert.ok(persisted[0].chatHtml.length<=2_000_000);
assert.ok(source.includes("savedState.chatHtml.length <= 2_000_000"),'legacy giant restore state must be rejected before DOM parsing');
assert.ok(source.includes('initialEntries.slice(-20).forEach(appendEntry)'));
assert.ok(!source.includes("smclToHtml(String(msg.stdout || ''))"),'completion messages must not bypass the preview cap');
assert.ok(source.includes('run.settled = true;'));
console.log('TERMINAL_MEMORY_BOUNDS_PASS: huge-log request/response, bounded paging, disposed callbacks, 500 settled + active, bounded restore, completion bypass');
