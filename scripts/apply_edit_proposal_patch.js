"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next patch E1: agent .do edits require explicit diff acceptance */";
const REQUIRE_ANCHOR = 'globalThis.__codexEditGate=globalThis.__codexEditGate||require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","edit_proposal_core.js"))';
const OLD_EVENT_INIT = 'createEditGate({eventLogPath:require("node:path").join(require("node:os").homedir(),".stata-workbench-next","events",String(__port)+".jsonl")})';
const SESSION_EVENT_INIT = 'createEditGate({onEvent:__event=>{try{let __session=globalThis.__codexNextSessionRef;if(__session&&__session.record){let __copy={...__event};delete __copy.content;__session.record("edit-proposal",{proposalType:__event.type,...__copy})}}catch{}}})';

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    if (source.includes(OLD_EVENT_INIT)) source = source.replace(OLD_EVENT_INIT, SESSION_EVENT_INIT);
    source = source.replaceAll("iA.Uri.file(__record.path)", "FHg().Uri.file(__record.path)")
      .replaceAll("iA.Uri.file(__tmp)", "FHg().Uri.file(__tmp)")
      .replaceAll("YQ.Uri.file(__record.path)", "FHg().Uri.file(__record.path)")
      .replaceAll("YQ.Uri.file(__tmp)", "FHg().Uri.file(__tmp)");
    if (!source.includes(SESSION_EVENT_INIT)) throw new Error("edit gate event stream wiring missing");
    return options.finalize === false ? source : fingerprint.finalize(source).text;
  }
  const initNeedle = 'let __send=(o,s,n)=>{o.writeHead(s,{"content-type":"application/json"}),o.end(JSON.stringify(n))};';
  if (source.indexOf(initNeedle) < 0 || source.indexOf(initNeedle, source.indexOf(initNeedle) + initNeedle.length) >= 0) throw new Error("edit gate send anchor missing or ambiguous");
  const init = `${MARKER}${REQUIRE_ANCHOR}.createEditGate${SESSION_EVENT_INIT.slice("createEditGate".length)};globalThis.__codexReviewEdit=async(__record,__content)=>{let __tmp=require("node:path").join(require("node:os").tmpdir(),"stata-workbench-edit-"+String(__record.id)+".do");try{require("node:fs").writeFileSync(__tmp,__content,{mode:384});let __current=await iA.workspace.openTextDocument(FHg().Uri.file(__record.path)),__proposed=await iA.workspace.openTextDocument(FHg().Uri.file(__tmp));await iA.commands.executeCommand("vscode.diff",__current.uri,__proposed.uri,"Stata edit proposal: "+__record.agentName);let __choice=await iA.window.showInformationMessage("Agent proposes an edit to "+__record.path,"Accept","Reject");return{status:__choice==="Accept"?"accepted":"rejected",reasonCode:__choice==="Accept"?"USER_ACCEPTED":"USER_REJECTED"}}finally{try{require("node\u003afs").unlinkSync(__tmp)}catch{}}};`;
  source = source.replace(initNeedle, `${initNeedle}${init}`);
  const routeNeedle = 'if(__req.method!=="POST"||__req.url!=="/run-command"){__res.writeHead(404);__res.end("not found");return}';
  if (source.indexOf(routeNeedle) < 0 || source.indexOf(routeNeedle, source.indexOf(routeNeedle) + routeNeedle.length) >= 0) throw new Error("edit gate route anchor missing or ambiguous");
  const route = `if(__req.method==="POST"&&__req.url==="/propose-edit"){let __body="";__req.on("data",__chunk=>{__body+=__chunk;if(__body.length>3145728)__req.destroy()});__req.on("end",async()=>{try{let __proposal=JSON.parse(__body||"{}"),__result=await globalThis.__codexEditGate.propose(__proposal,globalThis.__codexReviewEdit);let __status=__result.status==="accepted"?200:(__result.reasonCode==="DECISION_TIMEOUT"?408:(__result.reasonCode==="SHA_MISMATCH"||__result.reasonCode==="SHA_CHANGED_DURING_REVIEW"?409:200));__send(__res,__status,{ok:__result.status==="accepted",proposal:__result,patch:__patch})}catch(__e){__send(__res,400,{ok:false,error:__e&&__e.message||String(__e),patch:__patch})}});return}`;
  source = source.replace(routeNeedle, `${route}${routeNeedle}`);
  if (!source.includes(MARKER) || !source.includes(REQUIRE_ANCHOR)) throw new Error("edit gate patch did not install");
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("edit gate marker missing");
  const initAt = source.indexOf(MARKER);
  const initEnd = source.indexOf("let __acquire", initAt);
  if (initEnd < 0) throw new Error("edit gate init anchor missing");
  source = source.slice(0, initAt) + source.slice(initEnd);
  const routeNeedle = 'if(__req.method!=="POST"||__req.url!=="/run-command"){__res.writeHead(404);__res.end("not found");return}';
  const routeAt = source.indexOf('if(__req.method==="POST"&&__req.url==="/propose-edit")');
  const runAt = source.indexOf(routeNeedle, routeAt);
  if (routeAt < 0 || runAt < 0) throw new Error("edit gate route anchor missing");
  source = source.slice(0, routeAt) + source.slice(runAt);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER };
