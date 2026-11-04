"use strict";
// Offline cross-module test for rc.7.85: the real throw + catch edits and the
// real bundle __release run on the real lifecycle core, then
// tools/shared_stata.py stata_error_checks judges the response. The task_done
// result is built by hand, and UI, identity and window observation are stubs:
// this is not an MCP transport or production end-to-end acceptance test.
// No Stata, no VS Code, no bridge.
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_stata_error_outcome_patch");
const lifecycle = require("./execution_lifecycle_core");

const root = path.join(__dirname, "..");
const dist = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const start = dist.indexOf("let __release=o=>{");
const end = dist.indexOf("s.lastHeartbeatAt=Date.now()};", start) + "s.lastHeartbeatAt=Date.now()};".length;
assert.ok(start > 0 && end > start, "real __release found in dist");
const RELEASE = dist.slice(start, end);
const HELPER = patch.EDITS[0][1].slice(patch.EDITS[0][0].length);
const THROW = patch.EDITS[1][1];
const CATCH = patch.EDITS[2][1];
const catchBody = CATCH.slice(0, CATCH.indexOf("__release();let __codexPrt="))
  + '__release();__send(__res,500,{ok:false,error:e?.message||String(e),runId:__runId,state:__current(),patch:__patch})';

const RUN = "run_e2e_1", REQ = "codex_e2e_req";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v3a-e2e-"));
const log = path.join(tmp, "mcp_stata_e2e.log");
fs.copyFileSync(path.join(__dirname, "fixtures", "stata-error-logs", "agent-regress-r111.txt"), log);

function scenario(result, snapshot) {
  const bridge = { busy: true };
  lifecycle.beginRun(bridge, { requestId: REQ, runId: RUN, sourceMode: "agent" });
  Object.assign(lifecycle.ensureLifecycle(bridge), { logPath: log });
  const sent = [];
  const context = { require, process, Buffer, console, Error, String, Object, JSON, Date, Math,
    yC: { extensionUri: { fsPath: root } }, JA: fs, __codexExecution: lifecycle,
    Gg: { failStreamingEntry() {} }, __run: RUN, __runId: REQ, __res: {}, __patch: "t",
    __codexBridgePreRunSnapshot: snapshot || null, __r: result,
    __send: (res, status, body) => sent.push({ status, body }), __current: () => ({}) };
  context.globalThis = context;
  context.__codexBridgeState = bridge;
  vm.createContext(context);
  vm.runInContext(HELPER + "\n" + RELEASE, context);
  vm.runInContext("(function(){try{(function(){" + THROW + "})()}catch(e){" + catchBody + "}})()", context);
  assert.equal(sent.length, 1);
  return { ...sent[0], completed: JSON.parse(JSON.stringify(bridge.lastCompletedRun)) };
}
const failed = (extra = {}) => ({ success: false, rc: 111, logPath: log, stderr: "no variables defined",
  raw: { event: "task_done", status: "done", rc: 111, log_path: log, error: "no variables defined" }, ...extra });

const py = ["python3", "python"].find((exe) => cp.spawnSync(exe, ["-c", "import sys"], { stdio: "ignore" }).status === 0);
function pyChecks(out) {
  const st = (rid, completed) => ({ status: { busy: false, postRunBusy: false, trueReady: true, recovery: { required: false },
    runId: rid, ownedBackendPids: [14], lastCompletedRun: completed }, identityOk: true, axWindowCount: 1,
    windowObservation: { ok: true, count: 1, status: "OK" } });
  const input = { http: out.status, body: out.body, before: st("old", { requestId: "req-old" }), after: st(RUN, out.completed) };
  const file = path.join(tmp, "in.json");
  fs.writeFileSync(file, JSON.stringify(input));
  const prog = "import json,sys;sys.path.insert(0,sys.argv[2]);import shared_stata as c\n"
    + "from unittest import mock\nd=json.load(open(sys.argv[1]))\n"
    + "with mock.patch.object(c.entry.permissions,'require_window_observation',lambda s:None):\n"
    + " print(json.dumps(c.stata_error_checks(d['http'],d['body'],d['before'],d['after'],'___VERIFIED_CLIENT_e2e___')))";
  const r = cp.spawnSync(py, ["-c", prog, file, path.join(root, "tools")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log("ok", name); };
ok("real error: STATA_ERROR stataRc 111, lifecycle failed rc 111, Python checks all pass", () => {
  const out = scenario(failed());
  assert.equal(out.status, 500);
  assert.equal(out.body.outcome, "STATA_ERROR");
  assert.equal(out.body.stataRc, 111);
  assert.equal(out.body.payloadMayHaveRun, true);
  assert.equal(out.completed.rc, 111);
  assert.equal(out.completed.phase, "failed");
  assert.equal(out.completed.logPath, log);
  if (py) {
    const checks = pyChecks(out);
    assert.deepEqual(Object.entries(checks).filter(([, v]) => v !== true), [], JSON.stringify(checks));
  }
});
ok("Stop after the error (Stop-owned snapshot): old response, not confirmed", () => {
  const out = scenario(failed(), { stopOwned: true });
  assert.equal(out.body.outcome, undefined);
  assert.notEqual(out.completed.rc, 111);
});
ok("timeout text after the error: old response, not confirmed", () => {
  const out = scenario(failed({ stderr: "transport timed out", raw: { event: "task_done", status: "done", rc: 111, log_path: log, error: "transport timed out" } }));
  assert.equal(out.body.outcome, undefined);
});
ok("old runtime (task_done without rc): old response, not confirmed", () => {
  const r = failed(); delete r.raw.rc; r.rc = 0;
  const out = scenario(r);
  assert.equal(out.body.outcome, undefined);
  if (py) assert.equal(Object.values(pyChecks(out)).every((v) => v === true), false);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log("STATA_ERROR_OUTCOME_E2E_OK checks=" + n + (py ? "" : " (python leg skipped)"));
