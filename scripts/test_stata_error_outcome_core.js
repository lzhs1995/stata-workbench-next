"use strict";
// rc.7.85 core: a Stata error is confirmed only when every check holds.
// The r(n); line formats below are not yet checked against a real mcp-stata log
// (V3-A step 5 was not run); see V3-A-REPORT.md before wiring this into the bundle.
const assert = require("node:assert/strict");
const core = require("./stata_error_outcome_core");

const RUN = "run_m5_1";
const LOG = "/tmp/mcp_stata_m5.log";
const base = () => ({
  runId: RUN,
  result: { success: false, rc: 111, logPath: LOG, stderr: "variable nosuchvar_v3a not found", raw: { error: { rc: 111 } } },
  error: new Error("variable nosuchvar_v3a not found"),
  logPath: LOG,
  lifecycle: { runId: RUN, logPath: LOG },
  logText: ". regress nosuchvar_v3a\nvariable nosuchvar_v3a not found\nr(111);\n",
  cancelled: false,
  completionMarker: "___CODEX_RUN_DONE_" + RUN + "___",
});
const check = (mutate) => { const input = base(); mutate(input); return core.classify(input); };
let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log("ok", name); };

ok("plain r(111); after the error text is confirmed", () => {
  const r = core.classify(base());
  assert.equal(r.confirmed, true);
  assert.equal(r.stataRc, 111);
});
ok("SMCL-prefixed and {search r(n)} forms parse", () => {
  assert.equal(core.lastReturnCode("{err}variable x not found\n{txt}r(111);\n").rc, 111);
  assert.equal(core.lastReturnCode("{err}x\n{search r(111), local:r(111);}\n").rc, 111);
});
ok("r(n) in another run's log is not confirmed", () => {
  const r = check((i) => { i.lifecycle = { runId: "run_other", logPath: LOG }; });
  assert.equal(r.confirmed, false);
  assert.ok(r.reasons.includes("lifecycle-not-this-run"));
  const s = check((i) => { i.result.logPath = "/tmp/other.log"; });
  assert.equal(s.confirmed, false);
  assert.ok(s.reasons.includes("log-not-bound-to-run"));
});
ok("rc mismatch between mcp-stata and the log is not confirmed", () => {
  const r = check((i) => { i.result.rc = 198; i.result.raw.error.rc = 198; });
  assert.equal(r.confirmed, false);
  assert.ok(r.reasons.includes("rc-mismatch"));
});
ok("Stop, watchdog and Break stay unconfirmed", () => {
  assert.ok(check((i) => { i.cancelled = true; }).reasons.includes("cancelled"));
  assert.ok(check((i) => { i.result.__codexWatchdogRelease = true; }).reasons.includes("cancelled"));
  assert.ok(check((i) => { i.error = new Error("Request cancelled"); i.result.stderr = "Request cancelled"; }).reasons.includes("cancel-text"));
  const brk = check((i) => { i.result.rc = 1; i.result.raw.error.rc = 1; i.logText = "--Break--\nr(1);\n"; });
  assert.equal(brk.confirmed, false);
  assert.ok(brk.reasons.includes("break-rc"));
});
ok("missing or empty log is not confirmed", () => {
  assert.ok(check((i) => { i.logText = null; }).reasons.includes("log-missing"));
  assert.ok(check((i) => { i.logText = ""; }).reasons.includes("log-missing"));
});
ok("an r(n) line followed by more output, or a completion marker, is not the final error", () => {
  assert.ok(check((i) => { i.logText += ". display 1\n1\n"; }).reasons.includes("rc-line-not-last"));
  assert.ok(check((i) => { i.logText += "___CODEX_RUN_DONE_" + RUN + "___\n"; }).reasons.includes("completion-marker-present"));
});
ok("a successful result is not reclassified", () => {
  const r = check((i) => { i.result = { success: true, rc: 0, logPath: LOG }; i.logText = ". display 1\n1\n"; });
  assert.equal(r.confirmed, false);
  assert.ok(r.reasons.includes("not-a-failure"));
});
ok("no mcp result (transport failure) is not confirmed", () => {
  assert.ok(check((i) => { i.result = null; }).reasons.includes("no-mcp-result"));
});
console.log("STATA_ERROR_OUTCOME_CORE_OK checks=" + n);
