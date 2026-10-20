#!/usr/bin/env node
"use strict";

// Offline tests of actual bundle functions, file identity and log consumption.
// No Stata interpreter is mocked here; native execution still needs a live test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const lifecycle = require("./execution_lifecycle_core");
const finalizer = require("./runfile_finalizer_core");
const compat = require("./stata_source_compat_core");
const patcher = require("./apply_inline_error_finalizer_patch");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist/extension.js"), "utf8");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const tick = String.fromCharCode(96);
const runId = "run_error_601";
const done = "___CODEX_RUN_DONE_" + runId + "___";
const rcLine = (rc) => "___CODEX_RUN_RC_" + runId + "___=         " + rc;

function extract(source, start, end) {
  const lo = source.indexOf(start);
  const hi = source.indexOf(end, lo + start.length);
  assert.ok(lo >= 0 && hi > lo, "actual source function must exist");
  return source.slice(lo, hi);
}
const writerSource = extract(bundle,
  "function __codexWriteVerifiedInlineSnapshot(",
  "globalThis.__codexWriteVerifiedInlineSnapshot");

function writer(api = fs) {
  const factory = new Function("JA", "rg", "yC", "require", "process", "__dirname",
    "__codexStataString", "__codexGraphMark", "__codexGraphLog",
    writerSource + "\nreturn __codexWriteVerifiedInlineSnapshot;");
  return factory(api, path, { extensionUri: { fsPath: root } }, require,
    { platform: "linux", cwd: () => root }, __dirname,
    (s) => String(s).replace(/"/g, '""'), () => {}, () => {});
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-finalizer-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("actual writer keeps author exit and finalizer in separate execution scopes", (t) => {
  const dir = temp(t);
  const author = "local author_rc = 601\nexit " + tick + "author_rc'\ndisplay 999\n";
  const record = writer()(dir, author, runId, path.join(dir, "author.do"), "test");
  assert.equal(record.ok, true);
  const body = fs.readFileSync(record.tempDoFile, "utf8");
  assert.equal(body, "set more off\n" + author + "\n");
  assert.equal(body.includes(done), false, "an early author exit must not bypass the marker");
  assert.equal(body.includes("save "), false, "snapshot belongs to the outer driver");
  assert.equal(record.bodySha256, sha(body));
  assert.equal(record.executionCodeSha256, sha(record.executionCode));
  assert.ok(record.executionCode.startsWith('capture noisily do "' + record.tempDoFile + '"\nlocal __codex_body_rc = _rc\n'));
  assert.match(record.executionCode, /save "[^"]+", replace emptyok/);
  assert.ok(record.executionCode.indexOf("local __codex_snapshot_rc = _rc") < record.executionCode.indexOf(done));
  assert.equal(record.executionCode.split(done).length - 1, 1);
  assert.ok(record.executionCode.endsWith("exit " + tick + "__codex_run_rc'\n"));
});

test("write corruption is still repaired before source is admitted", (t) => {
  const dir = temp(t);
  let writes = 0;
  const api = Object.create(fs);
  api.writeFileSync = (p, text, encoding) => {
    writes += 1;
    fs.writeFileSync(p, writes === 1 ? "corrupt\n" + text : text, encoding);
  };
  const record = writer(api)(dir, "exit 601\n", runId, path.join(dir, "author.do"), "test");
  assert.equal(record.ok, true);
  assert.equal(record.repaired, true);
  assert.equal(record.attempts, 2);
  assert.equal(sha(fs.readFileSync(record.tempDoFile)), record.bodySha256);
});

test("driver still passes the body through the real Mac compatibility adapter", (t) => {
  const dir = temp(t);
  const author = 'cd "C:\\Users\\LZHS\\Desktop\\cnm\\tasks\\07_Stata-workbench\\开题报告"\nexit 601\n';
  const record = writer()(dir, author, runId, path.join(dir, "author.do"), "test");
  const before = fs.readFileSync(record.tempDoFile);
  const prepared = compat.prepareExecutionCode(record.executionCode, {
    platform: "darwin", cwd: dir, tempRoot: dir,
    stataRoot: "/Users/fixture/stata", cnmRoot: "/Users/fixture/cnm", documentsRoot: "/Users/fixture"
  });
  assert.equal(prepared.diagnostics.referencedDoCopies.length, 1);
  const copy = prepared.diagnostics.referencedDoCopies[0];
  assert.equal(copy.sourceSha256, sha(before));
  assert.equal(fs.readFileSync(record.tempDoFile).equals(before), true);
  assert.ok(fs.readFileSync(copy.tempPath, "utf8").includes("/Users/fixture/cnm/tasks/07_Stata-workbench/开题报告"));
  assert.ok(prepared.code.includes('capture noisily do "' + copy.tempPath + '"'));
});

test("actual return record beats stale inner errors and preserves a real 601", () => {
  for (const [prior, final] of [[0, 601], [601, 0], [693, 601], [0, 603]]) {
    const log = "r(" + prior + ");\n{txt}" + rcLine(final) + "\n{res}" + done + "\n";
    const result = lifecycle.inspectLogText(log, runId);
    assert.equal(result.finalizerReturnCodeVerified, true);
    assert.equal(result.completionMarkerVerified, true);
    assert.equal(result.rc, final);
  }
  // Negative control: the legacy reader infers 0 from the old r(0) and ignores
  // the newly authoritative do-file return. Same log, different conclusion.
  const log = "r(0);\n" + rcLine(601) + "\n" + done;
  const legacyRc = [...log.matchAll(/^r\((\d+)\);$/gm)].map((m) => Number(m[1])).pop();
  assert.equal(legacyRc, 0);
  assert.equal(lifecycle.inspectLogText(log, runId).rc, 601);
});

test("echoed, duplicate, wrong-run and misordered finalizer evidence is rejected", () => {
  for (const log of [
    ". display as text " + JSON.stringify(rcLine(601)) + "\n. display as text " + JSON.stringify(done),
    rcLine(601) + "\n" + rcLine(0) + "\n" + done,
    done + "\n" + rcLine(601),
    rcLine("not-a-code") + "\n" + done,
    rcLine(601) + "\n" + done + "\n" + done,
    rcLine(601),
  ]) {
    const result = lifecycle.inspectLogText(log, runId);
    assert.equal(result.finalizerReturnCodeVerified, false);
    assert.equal(result.completionMarkerVerified, false);
  }
  assert.equal(lifecycle.inspectLogText(rcLine(601) + "\n" + done, "other").completionMarkerVerified, false);
});

test("real exact-marker settlement retains nonzero rc instead of manufacturing success", () => {
  const source = extract(bundle, "settleRunFromExactMarker(A,I={}){",
    "/* codex patch rc.7.10.24: exact marker settles missing task_done */");
  const settle = new Function("return ({" + source + "}).settleRunFromExactMarker;")();
  for (const code of [0, 601, 603]) {
    let payload;
    const run = { _runId: runId, taskId: "task", _taskDoneResolve: (value) => { payload = value; } };
    const client = { _activeRun: run, _runsByTaskId: new Map(), _scheduleRunCleanup() {} };
    assert.equal(settle.call(client, "foreign", { rc: code }), false);
    assert.equal(settle.call(client, runId, { logPath: "/test.log", rc: code }), true);
    assert.equal(payload.rc, code);
    assert.equal(payload.result.success, code === 0);
    assert.equal(payload.status, code === 0 ? "completed" : "failed");
  }
});

test("real release prefers validated finalizer rc over a stale transport rc=0", () => {
  const start = bundle.indexOf("__rc=__inspection&&__inspection.finalizerReturnCodeVerified?");
  const end = bundle.indexOf(",__error=", start);
  assert.ok(start > 0 && end > start);
  const expression = bundle.slice(start + "__rc=".length, end);
  const evaluate = new Function("o", "__life", "__inspection", "return " + expression);
  const inspected = lifecycle.inspectLogText(rcLine(601) + "\n" + done, runId);
  assert.equal(evaluate({ rc: 0 }, { rc: 0 }, inspected), 601);
  assert.equal(evaluate({ rc: 0 }, {}, {}), 0, "legacy successful route is preserved");
});

test("writer branches use driver and cleanup retains a failed-continuity checkpoint", () => {
  assert.ok(bundle.includes("code: __codexWriteCheckA.executionCode,"));
  assert.ok(bundle.includes("code: __codexWriteCheckB.executionCode,"));
  const fragment = extract(bundle,
    "try{if(!(globalThis.__codexContinuityLost&&String(globalThis.__codexContinuityLost.runId)===String(r)))",
    "/* codex patch rc.7.10: normal completion removes pre-run snapshot */");
  const cleanup = new Function("globalThis", "r", "__codexHumanFilePreRunSnapshot", fragment);
  let calls = 0;
  const state = {
    __codexContinuityLost: { runId },
    __codexStopCheckpointRef: { cleanup() { calls += 1; } },
    __codexPreRunSnapshots: new Map([[runId, { path: "/real.dta" }]])
  };
  cleanup(state, runId, state.__codexPreRunSnapshots.get(runId));
  assert.equal(calls, 0);
  assert.equal(state.__codexPreRunSnapshots.has(runId), true);
  state.__codexContinuityLost = null;
  cleanup(state, runId, {});
  assert.equal(calls, 1);
  assert.equal(state.__codexPreRunSnapshots.has(runId), false);
});

test("patch is idempotent and no recovery/admission gate is bypassed", () => {
  assert.equal(patcher.patchBundle(bundle), bundle);
  assert.ok(bundle.includes('reason:"snapshot-missing"'));
  assert.ok(bundle.includes('status:"continuity-lost"'));
  assert.throws(() => finalizer.buildFinalizerCode({ runId: 'bad"\nexit 0' }), /runId/);
});
