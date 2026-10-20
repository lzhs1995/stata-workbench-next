"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),http=require("node:http"),crypto=require("node:crypto");
const bundle=fs.readFileSync(path.join(__dirname,"../dist/extension.js"),"utf8");
const start=bundle.indexOf('async _tailLogLoop('),end=bundle.indexOf('async readLog(',start);
assert(start>=0&&end>start);
const method=bundle.slice(start,end);
const yieldCode='/* codex patch rc.7.43: populated log chunks yield to host I/O */await this._delay(0);';
assert.equal(method.split(yieldCode).length,2);
function makeMethod(text){return vm.runInNewContext('({'+text+'})',{CI:{captureException(e){throw e;}},Date,String})._tailLogLoop;}
const data=('record 0123456789 abcdefghijklmnopqrstuvwxyz\n').repeat(64);
async function fairness(text) {
 let reads=0,servedAt=null,timerAt=null;const raw=[],filtered=[],appended=[],total=128;
 const state={_runId:'offline-fairness',logPath:'/virtual/log',logOffset:0,_lineBuffer:'',_cancelled:false,_tailCancelled:false,_fastDrain:false,onRawLog:s=>raw.push(s),onLog:s=>filtered.push(s),_appendLog:s=>appended.push(s)};
 const server=http.createServer((req,res)=>{servedAt=reads;res.end('responsive');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const response=new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port,path:'/editor-state'},res=>{res.resume();res.on('end',resolve);}).on('error',reject);});
 const timer=new Promise(resolve=>setTimeout(()=>{timerAt=reads;resolve();},0));
 const object={_readLogSlice:async()=>{if(reads===total){state._tailCancelled=true;return {data:'',next_offset:state.logOffset};}reads++;return {data,next_offset:reads*Buffer.byteLength(data)};},_filterLogChunk:s=>s,_delay:ms=>new Promise(r=>setTimeout(r,ms)),_log:s=>{throw Error(s);}};
 try {
  await makeMethod(text).call(object,null,state);
  await Promise.all([response,timer]);
  assert.equal(reads,total);assert.equal(state.logOffset,total*Buffer.byteLength(data));
  const expected=data.repeat(total);assert.equal(raw.join(''),expected);assert.equal(filtered.join(''),expected);assert.equal(appended.join(''),expected);
  return {chunks:reads,timerAt,servedAt,sha256:crypto.createHash('sha256').update(raw.join('')).digest('hex')};
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
(async()=>{
 const old=await fairness(method.replace(yieldCode,''));
 const now=await fairness(method);
 assert.equal(old.timerAt,old.chunks,'negative control demonstrates timer starvation until EOF');
 assert.equal(old.servedAt,old.chunks,'negative control demonstrates HTTP starvation until EOF');
 assert(now.timerAt<now.chunks,'timer must run before log drains');
 assert(now.servedAt<now.chunks,'HTTP must respond before log drains');
 assert.equal(now.sha256,old.sha256,'yield cannot truncate/reorder log bytes');
 let reads=0;const st={_runId:'cancel',logPath:'/virtual/log',logOffset:0,_lineBuffer:'',onLog(){st._cancelled=true;}};
 await makeMethod(method).call({_readLogSlice:async()=>{reads++;return {data:'a\n',next_offset:2};},_filterLogChunk:s=>s,_delay:ms=>new Promise(r=>setTimeout(r,ms)),_log:s=>{throw Error(s);}},null,st);
 assert.equal(reads,1,'existing cancellation still stops the next read');
 console.log(JSON.stringify({verdict:'LOG_TAIL_FAIRNESS_PASS',negativeControl:old,candidate:now,cancellationReads:reads,scope:'extracted actual tail loop with synchronous fixture reads; local HTTP server only; no Stata/UI/production calls'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
