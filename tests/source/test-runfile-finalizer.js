"use strict";

// Stage 4: source run-file finalizer. Ports the maintained rc.7.40 cases to the
// readable module and checks parity with the maintained log reader. Offline;
// no Stata interpreter is mocked, so native execution still needs live tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fin = require("../../src/shared-session/runfile-finalizer");
const maintained = require("../../scripts/execution_lifecycle_core");
const migration = require("../../src/migrations/terminal-preview");

const root = path.resolve(__dirname, "../..");
const runId = "run_mh2k9x_ab12cd34";
const done = "___CODEX_RUN_DONE_" + runId + "___";
const rcLine = rc => "___CODEX_RUN_RC_" + runId + "___=         " + rc;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-finalizer-test-"));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

try {
  // 1. Driver: the body is a separate do-file; an author exit cannot skip the record.
  // Windows forbids '"' in file names, so quoting is checked on a path that is never written.
  const quoted = fin.buildFinalizerCode({ runId, bodyPath: 'C:\\research\\author "q" 开题报告.do' });
  ok(quoted.startsWith('capture noisily do "C:\\research\\author ""q"" 开题报告.do"\n'), "Stata quotes doubled");
  const body = path.join(dir, "author 开题报告's file.do");
  fs.writeFileSync(body, "exit 601\ndisplay 999\n");
  const run = fin.prepareFinalizedRun({ runId, bodyPath: body, tempDir: dir });
  const code = fs.readFileSync(run.driverPath, "utf8");
  ok(code.startsWith('capture noisily do "' + body.replace(/"/g, '""') + '"\nlocal __codex_body_rc = _rc\n'), "driver calls the body");
  ok(code.split(done).length - 1 === 1, "one completion marker");
  ok(code.indexOf("___CODEX_RUN_RC_" + runId) < code.indexOf(done), "record before marker");
  ok(code.endsWith("exit `__codex_run_rc'\n"), "driver returns the run rc");
  ok(!code.includes("save "), "no snapshot without a snapshot path");
  ok(fs.readFileSync(body, "utf8") === "exit 601\ndisplay 999\n", "researcher file unchanged");
  run.cleanup();
  ok(!fs.existsSync(run.driverPath), "driver removed");
  ok(fin.buildFinalizerCode({ runId, bodyPath: body, snapshotPath: path.join(dir, "s.dta") }).includes('save "'), "snapshot variant keeps save");
  assert.throws(() => fin.buildFinalizerCode({ runId: 'bad"\nexit 0', bodyPath: body }), /runId/); checks += 1;

  // 2. The verified record wins in both directions; parity with the maintained reader.
  for (const [prior, final] of [[0, 601], [601, 0], [693, 601], [0, 603]]) {
    const log = "r(" + prior + ");\n{txt}" + rcLine(final) + "\n{res}" + done + "\n";
    const source = fin.inspectFinalizerLog(log, runId);
    const old = maintained.inspectLogText(log, runId);
    ok(source.finalizerReturnCodeVerified && source.rc === final, "source rc " + final);
    ok(old.finalizerReturnCodeVerified === true && old.rc === source.rc, "maintained parity " + final);
    const settled = fin.settleFinalizedResult({ rc: prior, success: prior === 0 }, runId, log);
    ok(settled.rc === final && settled.success === (final === 0) && settled.completionMarkerVerified === true, "settled " + final);
  }

  // 3. Echoed, duplicate, misordered, malformed and foreign evidence is rejected.
  const bad = [
    ". display as text " + JSON.stringify(rcLine(601)) + "\n. display as text " + JSON.stringify(done),
    rcLine(601) + "\n" + rcLine(0) + "\n" + done,
    done + "\n" + rcLine(601),
    rcLine("not-a-code") + "\n" + done,
    rcLine(601) + "\n" + done + "\n" + done,
    rcLine(601),
  ];
  for (const log of bad) {
    const source = fin.inspectFinalizerLog(log, runId);
    ok(!source.finalizerReturnCodeVerified && !source.completionMarkerVerified, "rejected: " + log.slice(0, 40));
    ok(maintained.inspectLogText(log, runId).finalizerReturnCodeVerified === false, "maintained also rejects");
    const settled = fin.settleFinalizedResult({ rc: 0, success: true, completionMarkerVerified: true }, runId, log);
    ok(settled.completionMarkerVerified === false && settled.rc === 0, "invalid evidence is reported, not trusted");
  }
  ok(!fin.inspectFinalizerLog(rcLine(601) + "\n" + done, "other_run").completionMarkerVerified, "foreign run");
  const missing = fin.settleFinalizedResult({ rc: 0, success: true, completionMarkerVerified: true }, runId, "plain log\n");
  ok(missing.rc === 0 && missing.success === true && missing.completionMarkerVerified === false
    && missing.finalizerReturnCodeVerified === false && !missing.finalizerEvidenceInvalid, "no record: rc kept, completion unverified");

  // 4. Long logs: only the tail is read, and the records at the end still settle rc.
  const log = path.join(dir, "long.log");
  fs.writeFileSync(log, "x".repeat(fin.TAIL_BYTES + 5000) + "\nr(0);\n" + rcLine(601) + "\n" + done + "\n");
  const tail = fin.readLogTail(log);
  ok(tail.length <= fin.TAIL_BYTES && !tail.startsWith("x".repeat(10) + "\n") , "tail is bounded");
  ok(fin.settleFinalizedResult({ rc: 0, success: true }, runId, tail).rc === 601, "tail record wins over rc=0");
  ok(fin.readLogTail(path.join(dir, "missing.log")) === null && fin.readLogTail(null) === null, "missing log is null");

  // 5. Source transform: the file path is routed through the driver, cleaned up in
  // finally, and settled before the Terminal finishes; the selection path is unchanged.
  const original = fs.readFileSync(path.join(root, "upstream/stata-workbench/src/extension.js"), "utf8");
  const out = migration.transform("extension.js", original);
  ok(out.startsWith(migration.FINALIZER_REQUIRE) || out.includes(migration.FINALIZER_REQUIRE), "finalizer required");
  ok(out.split("prepareFinalizedRun({ runId, bodyPath: effectiveFilePath").length - 1 === 1, "one driver route");
  ok(out.includes("mcpClient.runFile(sourceFinalized ? sourceFinalized.driverPath : effectiveFilePath, {"), "driver path used");
  const iCleanup = out.indexOf("} finally { if (sourceFinalized) sourceFinalized.cleanup(); }");
  const iSettle = out.indexOf("result = settleFinalizedResult(result, runId, readLogTail(result && result.logPath));");
  const iFinish = out.indexOf("TerminalPanel.finishStreamingEntry(runId, result);", iSettle);
  ok(iCleanup > 0 && iSettle > iCleanup && iFinish > iSettle, "cleanup, settle, finish order");
  ok(out.split("const result = await mcpClient.runFile(").length - 1 === 0, "file call rebound to let result");
  ok(original.split("mcpClient.run(").length === out.split("mcpClient.run(").length, "selection path call count unchanged");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ verdict: "PASS_SOURCE_RUNFILE_FINALIZER", checks }));