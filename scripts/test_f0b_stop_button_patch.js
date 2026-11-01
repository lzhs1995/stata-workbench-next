"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_f0b_stop_button_fallback_patch");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
assert.equal(bundle.split(patch.MARKER).length - 1, 1, "F0b marker must be installed once");
assert.match(bundle, /I&&I\.busy!==!0/, "host idle guard missing");
assert.doesNotMatch(bundle, /executeCommand\("stata-workbench\.cancelRequest"\)/, "dead fallback must be removed");
assert.match(bundle, /I\.type===\"cancelRun\"/, "webview cancelRun route missing");
assert.doesNotMatch(bundle, /if \(!busy\) return;/, "webview idle guard must not suppress cancelRun");

const reverted = patch.revertBundle(bundle);
assert.equal(reverted.includes(patch.MARKER), false, "revert must remove F0b marker");
const replayed = patch.patchBundle(reverted);
assert.match(replayed, /I&&I\.busy!==!0/);
assert.equal(patch.patchBundle(replayed), replayed, "F0b replay must be idempotent");

function loadHost(source, busy) {
  const a = source.indexOf("static async _handleCancelRun()");
  const b = source.indexOf("static async _handleCancelTask", a);
  assert.ok(a >= 0 && b > a, "host handler segment missing");
  const method = source.slice(a, b).replace(/^static /, "");
  const calls = [];
  const context = {
    globalThis: { __codexBridgeState: { busy }, __codexSoftStop: async () => { calls.push("softStop"); return { ok: true }; } },
    bE: { startSpan: (_meta, fn) => fn() },
    g: { _activeRunId: "run-test", _cancelHandler: async () => { calls.push("cancelHandler"); }, _postMessage: msg => calls.push(msg) },
    console: { error: () => calls.push("error") },
  };
  const fn = vm.runInNewContext(`({${method}})._handleCancelRun`, context);
  return { calls, run: () => fn() };
}
(async () => {
  const idle = loadHost(bundle, false); await idle.run();
  assert.equal(idle.calls.includes("cancelHandler"), false, "idle host must not cancel");
  assert.equal(idle.calls.includes("softStop"), false, "idle host must not soft-stop");
  const idleBusy = idle.calls.find(x => x && x.type === "busy");
  assert.ok(idleBusy && idleBusy.type === "busy" && idleBusy.value === false, "idle host must re-arm busy=false");
  const active = loadHost(bundle, true); await active.run();
  assert.equal(active.calls.includes("cancelHandler"), true, "busy host must cancel");
  assert.equal(active.calls.includes("softStop"), false, "handler owns soft-stop; host must not call it twice");

  const uiMatch = bundle.match(/stopBtn\.addEventListener\('click', \(\) => \{[\s\S]*?\n        \}\);/);
  assert.ok(uiMatch, "Stop click segment missing");
  const messages = [];
  const ui = { stopBtn: { disabled: false, addEventListener: (_type, fn) => fn() }, busy: false,
    vscode: { postMessage: msg => messages.push(msg) }, setTimeout: fn => fn() };
  vm.runInNewContext(uiMatch[0], ui);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "cancelRun", "webview idle click must still post cancelRun");

  const unsafe = bundle.replace(/let I=globalThis\.__codexBridgeState;if\(I&&I\.busy!==!0\)\{g\._postMessage\(\{type:"busy",value:!1\}\);return\}/, "");
  const negative = loadHost(unsafe, false); await negative.run();
  assert.equal(negative.calls.includes("cancelHandler"), true, "negative control must fail without idle guard");
  console.log("F0B_STOP_BUTTON_PATCH_PASS");
})().catch(err => { console.error(err); process.exit(1); });
