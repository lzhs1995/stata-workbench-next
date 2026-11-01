"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");

const MARKER = "/* next F0b: Terminal Stop falls back to the registered cancel command */";
const BEFORE = 'static async _handleCancelRun(){return bE.startSpan({name:"terminal.cancelRun",op:"extension.operation"},async()=>{if(typeof g._cancelHandler=="function")try{await g._cancelHandler();let A=g._activeRunId;A&&(g._postMessage({type:"runCancelled",runId:A,message:"Run cancelled by user."}),g._postMessage({type:"busy",value:!1}))}catch(A){console.error("[TerminalPanel] cancelRun failed:",A)}})}';
const AFTER = 'static async _handleCancelRun(){return bE.startSpan({name:"terminal.cancelRun",op:"extension.operation"},async()=>{let A=g._activeRunId;try{let I=globalThis.__codexBridgeState;if(I&&I.busy!==!0){g._postMessage({type:"busy",value:!1});return}if(typeof g._cancelHandler=="function")await g._cancelHandler();A&&(g._postMessage({type:"runCancelled",runId:A,message:"Run cancelled by user."}),g._postMessage({type:"busy",value:!1}))}catch(I){console.error("[TerminalPanel] cancelRun failed:",I)}})}';
const UI_BEFORE = `stopBtn.addEventListener('click', () => {
            if (!busy) return;
            stopBtn.disabled = true;`;
const UI_AFTER = `stopBtn.addEventListener('click', () => {
            if (busy) stopBtn.disabled = true;`;

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) return options.finalize === false ? source : fingerprint.finalize(source).text;
  const hostCount = source.split(BEFORE).length - 1;
  const uiCount = source.split(UI_BEFORE).length - 1;
  if (hostCount !== 1) throw new Error(`F0b Stop host anchor count=${hostCount}`);
  if (uiCount !== 1 && !(uiCount === 0 && source.split(UI_AFTER).length - 1 === 1)) throw new Error(`F0b Stop UI anchor count=${uiCount}`);
  const text = source.replace(BEFORE, AFTER).replace(UI_BEFORE, UI_AFTER) + MARKER;
  return options.finalize === false ? text : fingerprint.finalize(text).text;
}

function revertBundle(source) {
  if (!source.includes(MARKER)) throw new Error("F0b Stop marker missing");
  const text = source.replace(MARKER, "");
  if (text.split(AFTER).length - 1 !== 1) throw new Error("F0b Stop patched host anchor missing");
  if (text.split(UI_AFTER).length - 1 !== 1) throw new Error("F0b Stop patched UI anchor missing");
  return fingerprint.finalize(text.replace(AFTER, BEFORE).replace(UI_AFTER, UI_BEFORE)).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, patchBundle(before), "utf8");
  console.log(JSON.stringify({ target, changed: before !== fs.readFileSync(target, "utf8") }));
}

module.exports = { MARKER, BEFORE, AFTER, UI_BEFORE, UI_AFTER, patchBundle, revertBundle };
