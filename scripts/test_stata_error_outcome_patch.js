"use strict";
// rc.7.85 bundle wiring: the helper confirms only a bound, uncancelled r(n)
// error read from the run's own log; the agent catch and Terminal finish keep
// their old responses otherwise. Offline; no Stata, no VS Code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_stata_error_outcome_patch");
const later = require("./later_bundle_patches");

const root = path.join(__dirname, "..");
const dist = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log("ok", name); };
const count = (text, needle) => text.split(needle).length - 1;

ok("every edit is present exactly once in dist", () => {
  for (const [, after] of patch.EDITS) assert.equal(count(dist, after), 1);
  for (const [before] of patch.EDITS.slice(1)) assert.equal(count(dist, before), 0);
});
ok("patch is idempotent and revert is the exact inverse of the layer", () => {
  assert.equal(patch.patchBundle(dist), dist);
  const layer = later.revertAfter(dist, "./apply_stata_error_outcome_patch");
  const before = patch.revertBundle(layer);
  assert.ok(!before.includes(patch.MARKER));
  assert.equal(patch.patchBundle(before), layer);
});
ok("the fallback paths are unchanged after the confirmed branch", () => {
  const [, catchAfter] = patch.EDITS[2];
  const confirmedAt = catchAfter.indexOf("if(__codexSe&&__codexSe.confirmed)");
  const fallbackAt = catchAfter.indexOf("__release();let __codexPrt=e&&e.__codexPreRunTimeout;");
  assert.ok(confirmedAt > 0 && fallbackAt > confirmedAt, "old release and 500 response still follow");
  assert.ok(catchAfter.includes("!(e.__codexPreRunTimeout)"), "pre-run refusals are never classified");
  assert.ok(catchAfter.includes("__codexBridgePreRunSnapshot.stopOwned"), "a Stop-owned run counts as cancelled");
  assert.ok(catchAfter.includes("payloadMayHaveRun:true"), "the confirmed response still says the payload ran");
  const [, terminalAfter] = patch.EDITS[3];
  assert.ok(terminalAfter.includes('(typeof Q.rc=="number"&&Q.rc!==0?Q.rc:-1)'), "unconfirmed Terminal keeps rc -1");
});

// Run the injected helper with a fake bridge state and the real core module.
function helper(state) {
  const context = { require, process, Buffer, yC: { extensionUri: { fsPath: root } }, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(patch.EDITS[0][1].slice(patch.EDITS[0][0].length), context);
  context.__codexBridgeState = state;
  return context;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v3a-m5-"));
const real = path.join(tmp, "mcp_stata_real.log");
fs.copyFileSync(path.join(__dirname, "fixtures", "stata-error-logs", "agent-regress-r111.txt"), real);
const RUN = "run_mw1oskrn_4bzth2dm";
const failed = (logPath) => ({ success: false, rc: 0, logPath, stderr: "no variables defined", raw: { error: { message: "no variables defined" } } });

ok("helper confirms the real agent error log bound to this run", () => {
  const c = helper({ lifecycle: { runId: RUN, logPath: real } });
  const r = c.__codexStataErrorOutcome(RUN, failed(real), new Error("no variables defined"), false);
  assert.equal(JSON.stringify([r.confirmed, r.stataRc, r.logPath]), JSON.stringify([true, 111, real]));
  assert.equal(c.__codexLastStataErrorOutcome.confirmed, true);
});
ok("helper does not confirm another run, a cancelled run, or a missing log", () => {
  const other = helper({ lifecycle: { runId: "run_other", logPath: real } });
  assert.equal(other.__codexStataErrorOutcome(RUN, failed(real), null, false).confirmed, false);
  const stopped = helper({ lifecycle: { runId: RUN, logPath: real } });
  assert.ok(stopped.__codexStataErrorOutcome(RUN, failed(real), null, true).reasons.includes("cancelled"));
  const gone = path.join(tmp, "missing.log");
  const missing = helper({ lifecycle: { runId: RUN, logPath: gone } });
  assert.ok(missing.__codexStataErrorOutcome(RUN, failed(gone), null, false).reasons.includes("log-missing"));
});
ok("a classify failure returns null (old response kept)", () => {
  const c = helper({ lifecycle: { runId: RUN, logPath: real } });
  c.yC = { extensionUri: { fsPath: path.join(tmp, "no-such-extension") } };
  assert.equal(c.__codexStataErrorOutcome(RUN, failed(real), null, false), null);
  assert.equal(JSON.stringify(c.__codexLastStataErrorOutcome.reasons), '["classify-failed"]'); // vm realm array
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log("STATA_ERROR_OUTCOME_PATCH_OK checks=" + n);
