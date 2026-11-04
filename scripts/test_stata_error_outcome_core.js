"use strict";
// rc.7.85 core: a Stata error is confirmed only when every check holds.
// fixtures/stata-error-logs/ are real mcp-stata 1.26.1 per-run logs from the
// Mac live run (V3-A, 2026-11-04 13:39): Terminal `display nosuchvar_v3a`,
// agent `regress nosuchvar_v3a`, and an agent `display 3+3` that succeeded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./stata_error_outcome_core");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "stata-error-logs", name), "utf8");

const RUN = "run_m5_1";
const LOG = "/tmp/mcp_stata_m5.log";
const base = () => ({
  runId: RUN,
  result: { success: false, rc: 111, logPath: LOG, stderr: "variable nosuchvar_v3a not found",
    raw: { event: "task_done", status: "done", rc: 111, log_path: LOG, error: "variable nosuchvar_v3a not found" } },
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
ok("real Terminal and agent error logs are confirmed as rc 111", () => {
  for (const [name, runId] of [["terminal-display-r111.txt", "debug_terminal_1793770744628_p7yag0qsj1b"],
    ["agent-regress-r111.txt", "run_mw1oskrn_4bzth2dm"]]) {
    const r = check((i) => {
      i.runId = runId; i.lifecycle.runId = runId; i.logText = fixture(name);
      i.completionMarker = "___CODEX_RUN_DONE_" + runId + "___";
    });
    assert.deepEqual([name, r.confirmed, r.stataRc, r.reasons], [name, true, 111, []]);
  }
});
ok("an echoed marker command does not count; a printed marker does", () => {
  const good = fixture("agent-display-ok.txt");
  assert.equal(core.markerPrinted(good, "___CODEX_RUN_DONE_run_mw1ossm8_pwud0vvd___"), true);
  assert.equal(core.markerPrinted(fixture("agent-regress-r111.txt"), "___CODEX_RUN_DONE_run_mw1oskrn_4bzth2dm___"), false);
  assert.equal(core.lastReturnCode(good).rc, null);
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
  const r = check((i) => { i.result.rc = 198; i.result.raw.rc = 198; });
  assert.equal(r.confirmed, false);
  assert.ok(r.reasons.includes("rc-mismatch"));
});
ok("Stop, watchdog and Break stay unconfirmed", () => {
  assert.ok(check((i) => { i.cancelled = true; }).reasons.includes("cancelled"));
  assert.ok(check((i) => { i.result.__codexWatchdogRelease = true; }).reasons.includes("cancelled"));
  assert.ok(check((i) => { i.error = new Error("Request cancelled"); i.result.stderr = "Request cancelled"; }).reasons.includes("cancel-text"));
  const brk = check((i) => { i.result.rc = 1; i.result.raw.rc = 1; i.logText = "--Break--\nr(1);\n"; });
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
ok("R1: the MCP rc must be a positive integer from task_done and agree with every other rc field", () => {
  const cases = {
    missing: (i) => { delete i.result.raw.rc; },
    zero: (i) => { i.result.raw.rc = 0; },
    negative: (i) => { i.result.raw.rc = -1; },
    string: (i) => { i.result.raw.rc = "111"; },
    float: (i) => { i.result.raw.rc = 111.5; },
    "no raw event": (i) => { i.result.raw = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = check(mutate);
    assert.equal(r.confirmed, false, name);
    assert.ok(r.reasons.includes("mcp-rc-missing"), name + " " + r.reasons);
  }
  for (const [name, mutate] of Object.entries({
    "result.rc differs": (i) => { i.result.rc = 198; },
    "raw.error.rc differs": (i) => { i.result.raw.error = { message: "x", rc: 198 }; },
    "result.error.rc differs": (i) => { i.result.error = { message: "x", rc: 0 }; },
  })) {
    const r = check(mutate);
    assert.equal(r.confirmed, false, name);
    assert.ok(r.reasons.includes("mcp-rc-conflict"), name + " " + r.reasons);
  }
});
ok("R1: codex's transport-timeout and rc 0 counterexamples are not confirmed", () => {
  const timeout = core.classify({ runId: "R", result: { success: false, logPath: "/x", stderr: "transport timed out" },
    lifecycle: { runId: "R", logPath: "/x" }, logText: "r(111);\n", completionMarker: "___CODEX_RUN_DONE_R___" });
  assert.equal(timeout.confirmed, false);
  assert.ok(timeout.reasons.includes("mcp-rc-missing") && timeout.reasons.includes("cancel-text"));
  const zero = core.classify({ runId: "R", result: { success: false, rc: 0, logPath: "/x", error: { message: "unknown transport error" } },
    lifecycle: { runId: "R", logPath: "/x" }, logText: "r(111);\n" });
  assert.equal(zero.confirmed, false);
});
ok("R2: no independent lifecycle log binding is not confirmed", () => {
  assert.ok(check((i) => { i.lifecycle.logPath = null; }).reasons.includes("log-not-bound-to-run"));
  assert.ok(check((i) => { i.lifecycle.logPath = "/tmp/mcp_stata_old.log"; }).reasons.includes("log-not-bound-to-run"));
});
ok("R3: cancellation text in stderr or a structured raw.error is seen through a wrapper message", () => {
  const throwLike = (r) => new Error(String((r.raw && r.raw.error) || (r.error && r.error.message) || r.stderr || "Stata execution failed"));
  const cases = [
    (i) => { i.result.stderr = "Request cancelled"; i.result.raw.error = { message: "Request cancelled", rc: 111 }; },
    (i) => { i.result.raw.error = { message: "Operation cancelled" }; },
    (i) => { i.result.raw.status = "unknown"; },
    (i) => { i.result.guardFailure = { reasonCode: "EXEC_PRELOG_STALL" }; },
  ];
  for (const mutate of cases) {
    const input = base(); mutate(input); input.error = throwLike(input.result);
    const r = core.classify(input);
    assert.equal(r.confirmed, false, JSON.stringify(input.result.raw) + " " + input.error.message);
  }
  assert.equal(core.messageText({ message: "Request cancelled" }), "Request cancelled");
});
ok("R3: an error log that already exists does not survive a later cancel", () => {
  const input = base();
  input.logText = fixture("agent-regress-r111.txt");
  input.result.stderr = "Operation cancelled";
  input.result.raw.error = "Operation cancelled";
  input.error = new Error(String(input.result.raw.error));
  assert.equal(core.classify(input).confirmed, false);
});
ok("SMCL boundaries: nested tags, extra tags, wrapped and marker echoes", () => {
  assert.equal(core.lastReturnCode("{txt}{res}{err}{search r(459), local:r(459);}\n").rc, 459);
  assert.equal(core.lastReturnCode("{err}{search r(111)}\n").rc, 111, "search without local form");
  assert.equal(core.lastReturnCode("{txt}{search r(111), local:r(111);}\r\n{com}. scalar _wb_rc_x = _rc\r\n{txt}\r\n").trailing, false);
  assert.equal(core.lastReturnCode("{txt}{search r(111), local:r(111);}\n{res}1\n").trailing, true, "real output after r(n)");
  assert.equal(core.lastReturnCode("{com}. display \"r(111);\"\n").rc, null, "echoed command mentioning r(n)");
  assert.equal(core.lastReturnCode("{txt}r(111);x\n").rc, null, "no partial line match");
  assert.equal(core.lastReturnCode("{bf:r(111);}\n").rc, null, "unknown tag is not stripped");
  assert.equal(core.markerPrinted("{com}. display as text \"M\"\n> \"M\"\n", "M"), false, "wrapped echo continuation");
  assert.equal(core.markerPrinted("{res}{txt}M\n", "M"), true);
});
ok("no mcp result (transport failure) is not confirmed", () => {
  assert.ok(check((i) => { i.result = null; }).reasons.includes("no-mcp-result"));
});
console.log("STATA_ERROR_OUTCOME_CORE_OK checks=" + n);
