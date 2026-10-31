#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const checkpoint = require("./stop_checkpoint_core");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-checkpoint-core-"));
const snapshot = {
  path: path.join(root, "state.dta"),
  bytes: 1024,
  runId: "unit-run",
  sourceMode: "agent",
};

function writeCheckpointFiles(target) {
  const paths = checkpoint.checkpointPaths(target);
  fs.writeFileSync(paths.globalsPath, "RC7_GLOBAL\tdmFsdWU=\n", "utf8");
  fs.writeFileSync(paths.estimatesPath, "good_est\n../bad\n", "utf8");
  fs.writeFileSync(paths.graphsPath, "good_graph\nbad-name\n", "utf8");
  fs.writeFileSync(paths.currentGraphPath, "good_graph\n", "utf8");
  fs.writeFileSync(paths.defaultGraphObjectPath, "0\n", "utf8");
  fs.writeFileSync(path.join(paths.stateDir, "estimate_good_est.ster"), "est", "utf8");
  fs.writeFileSync(path.join(paths.stateDir, "graph_good_graph.gph"), "graph", "utf8");
}

function writeSnapshotReady(target) {
  const paths = checkpoint.checkpointPaths(target);
  fs.writeFileSync(
    paths.snapshotReadyPath,
    `ready\t${target.checkpointNonce}\t${target.snapshotKind || "data"}\n`,
    "utf8"
  );
}

// Inspect the generated DO's control scopes, not just the presence of nobreak.
// Cleanup must remain outside every break scope and inside the outer nobreak.
// Native Stata validation is separate from this code-generation contract.
function assertCleanupScopes(code, cleanupLines) {
  const scopes = [];
  const found = new Set();
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line === "}") {
      assert.ok(scopes.length, "unexpected closing block in generated DO");
      scopes.pop();
    } else if (line.endsWith(" {")) {
      scopes.push(line);
    }
    for (const cleanup of cleanupLines) {
      if (line === cleanup) {
        found.add(cleanup);
        assert.strictEqual(scopes[0], "nobreak {", `${cleanup}: missing outer Break guard`);
        assert.ok(!scopes.some((scope) => /(?:^| )break \{$/.test(scope)),
          `${cleanup}: cleanup is interruptible`);
      }
    }
  }
  assert.deepStrictEqual(scopes, [], "unclosed generated Stata block");
  assert.deepStrictEqual([...found].sort(), [...cleanupLines].sort());
}

try {
  snapshot.checkpointNonce = "1".repeat(32);
  fs.writeFileSync(snapshot.path, Buffer.alloc(1024, 1));
  assert.strictEqual(checkpoint.isRestoreCapable(snapshot), true);
  assert.strictEqual(checkpoint.isSnapshotReady(snapshot), false);
  fs.mkdirSync(checkpoint.checkpointPaths(snapshot).stateDir, { recursive: true });
  writeSnapshotReady(snapshot);
  assert.strictEqual(checkpoint.isSnapshotReady(snapshot), true);
  assert.strictEqual(checkpoint.snapshotReadyRecord(snapshot).kind, "data");
  fs.writeFileSync(
    checkpoint.checkpointPaths(snapshot).snapshotReadyPath,
    `ready\t${"2".repeat(32)}\tdata\n`,
    "utf8"
  );
  assert.strictEqual(checkpoint.isSnapshotReady(snapshot), false, "stale nonce must be rejected");
  writeSnapshotReady(snapshot);
  assert.strictEqual(checkpoint.isRestoreCapable(null), false);
  assert.strictEqual(checkpoint.isRestoreCapable({}), false);
  assert.strictEqual(checkpoint.isRestoreCapable({ path: path.join(root, "missing.dta") }), false);
  const partialPath = path.join(root, "partial.dta");
  fs.writeFileSync(partialPath, Buffer.alloc(511, 1));
  assert.strictEqual(checkpoint.isRestoreCapable(Object.freeze({ path: partialPath })), false);
  fs.writeFileSync(partialPath, Buffer.alloc(512, 1));
  assert.strictEqual(checkpoint.isRestoreCapable(Object.freeze({ path: partialPath })), true);
  assert.strictEqual(checkpoint.shouldCleanupAfterFailure(null), true);
  assert.strictEqual(checkpoint.shouldCleanupAfterFailure(Object.freeze({ stopOwned: false })), true);
  assert.strictEqual(checkpoint.shouldCleanupAfterFailure(Object.freeze({ stopOwned: true })), false);
  assert.strictEqual(checkpoint.restoreTimeoutMs(null, "darwin"), 30000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 4, graphCount: 8 }, "darwin"), 33000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 60, graphCount: 60 }, "darwin"), 45000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: -1, graphCount: "bad" }, "darwin"), 30000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 100000, graphCount: 100000 }, "darwin"), 45000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 160, graphCount: 80 }, "win32"), 300000);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 4, graphCount: 8 }, "win32"), 55600);
  assert.strictEqual(checkpoint.restoreTimeoutMs({ estimateCount: 100000, graphCount: 100000 }, "win32"), 300000);
  const unreadableOwnership = {};
  Object.defineProperty(unreadableOwnership, "stopOwned", {
    get() { throw new Error("ownership unavailable"); },
  });
  assert.strictEqual(
    checkpoint.shouldCleanupAfterFailure(unreadableOwnership),
    false,
    "unreadable cleanup ownership must retain the only restore-capable snapshot"
  );
  assert.deepStrictEqual(
    checkpoint.softStopReadiness({ ok: true }, null),
    {
      ready: true,
      readinessState: "ready",
      readinessReason: "soft-stop-complete",
      lastClientError: null,
      recoveryClass: "RECOVERED_FULL",
      continuityLost: null,
    }
  );
  const degradedRecovery = checkpoint.softStopReadiness({
    ok: true,
    degraded: {
      mode: "dataset-only",
      skippedEstimates: 3,
      skippedGraphs: 2,
      datasetRestored: true,
      globalsRestored: true,
    },
  }, null);
  assert.strictEqual(degradedRecovery.ready, false);
  assert.strictEqual(degradedRecovery.readinessState, "stale");
  assert.strictEqual(degradedRecovery.readinessReason, "soft-stop-degraded-recovery");
  assert.strictEqual(degradedRecovery.recoveryClass, "RECOVERED_DEGRADED");
  assert.deepStrictEqual(degradedRecovery.continuityLost, {
    reason: "soft-stop-degraded-recovery",
    detail: "dataset/globals restored, but 3 estimates and 2 graphs were not restored",
    skippedEstimates: 3,
    skippedGraphs: 2,
    datasetRestored: true,
    globalsRestored: true,
  });
  const zeroLossDowngrade = checkpoint.softStopReadiness({
    ok: true,
    degraded: {
      mode: "dataset-only",
      skippedEstimates: 0,
      skippedGraphs: 0,
      datasetRestored: true,
      globalsRestored: true,
    },
  }, null);
  assert.strictEqual(zeroLossDowngrade.ready, true);
  assert.strictEqual(zeroLossDowngrade.recoveryClass, "RECOVERED_FULL");
  const resetRecovered = checkpoint.softStopReadiness(
    { ok: false, error: "STOP_RESTORE_TIMEOUT" },
    { ok: true, trueReady: true }
  );
  assert.strictEqual(resetRecovered.ready, false);
  assert.strictEqual(resetRecovered.readinessReason, "soft-stop-checkpoint-not-restored");
  assert.strictEqual(resetRecovered.recoveryClass, "RECOVERY_FAILED");
  assert.strictEqual(resetRecovered.continuityLost.reason,
    "soft-stop-checkpoint-not-restored");
  assert.ok(resetRecovered.lastClientError.includes("STOP_RESTORE_TIMEOUT"));
  for (const hardReset of [
    null,
    {},
    { ok: false, trueReady: true },
    { ok: true, trueReady: false },
    { ok: true, trueReady: true, retry: { ok: false, trueReady: false } },
  ]) {
    const failed = checkpoint.softStopReadiness(
      { ok: false, error: "STOP_RESTORE_TIMEOUT" }, hardReset
    );
    assert.strictEqual(failed.ready, false);
    assert.strictEqual(failed.readinessState, "stale");
    assert.strictEqual(failed.recoveryClass, "RECOVERY_FAILED");
    assert.ok(failed.continuityLost);
  }
  const throwingReset = {};
  Object.defineProperty(throwingReset, "retry", {
    get() { throw new Error("reset identity unreadable"); },
  });
  const unreadableReadiness = checkpoint.softStopReadiness(
    { ok: false, error: "STOP_RESTORE_TIMEOUT" }, throwingReset
  );
  assert.strictEqual(unreadableReadiness.ready, false);
  assert.strictEqual(unreadableReadiness.readinessReason, "soft-stop readiness arbitration failed");
  assert.strictEqual(unreadableReadiness.recoveryClass, "RECOVERY_FAILED");
  assert.ok(unreadableReadiness.continuityLost);
  let observedCode = "";
  checkpoint.enrich({
    snapshot,
    cwd: root,
    stataString: (value) => String(value).replace(/\\/g, "/").replace(/"/g, '""'),
    runSelection: async (code, options) => {
      observedCode = code;
      assert.strictEqual(options.runId, "pre-run-full-state-unit-run");
      writeCheckpointFiles(snapshot);
      return { success: true, rc: 0, logPath: "/tmp/checkpoint.log" };
    },
  }).then(async () => {
    assert.ok(observedCode.includes("local __codex_names : all globals"));
    assert.ok(observedCode.includes('base64encode(st_global(st_local("__codex_name")))'));
    assert.ok(observedCode.includes("estimates save"));
    assert.ok(observedCode.includes("graph save"));
    assert.ok(observedCode.includes("classutil describe Graph"));
    assert.ok(observedCode.includes(snapshot.defaultGraphObjectPath.replace(/\\/g, "/")));
    assert.ok(observedCode.includes("    break {"), "expensive checkpoint work must allow Break");
    assert.ok(observedCode.indexOf("_estimates hold") < observedCode.indexOf("    break {"),
      "hold and held flag must be established without a Break window");
    const cleanupSteps = [
      "capture _estimates unhold `__codex_cp_e'",
      'capture mata: st_global("estimates_save_cleanup", st_local("__codex_cp_estcleanup"))',
      'capture mata: st_updata(strtoreal(st_local("__codex_cp_changed")))',
      "capture _return restore `__codex_cp_r'",
    ];
    assertCleanupScopes(observedCode, cleanupSteps);
    const changedCleanup = observedCode.indexOf(cleanupSteps[2]);
    const returnCleanup = observedCode.indexOf(cleanupSteps[3]);
    assert.ok(changedCleanup < returnCleanup);
    assert.ok(observedCode.indexOf("local __codex_cp_d_rc = _rc", changedCleanup) < returnCleanup);
    for (const state of ["e", "g", "s", "d", "r"]) {
      assert.ok(observedCode.indexOf(`if \`__codex_cp_${state}_rc' != 0 exit`) > returnCleanup,
        `${state} failure must be checked only after all cleanup has run`);
    }
    const generatedIdentifiers = Array.from(
      observedCode.matchAll(/\b__codex_[A-Za-z0-9_]+\b/g),
      (match) => match[0]
    );
    assert.ok(generatedIdentifiers.length > 0);
    assert.deepStrictEqual(
      generatedIdentifiers.filter((name) => name.length > 31),
      [],
      "generated Stata/Mata identifiers must stay within Stata's 31-character limit"
    );
    assert.strictEqual(snapshot.stateComplete, true);
    assert.strictEqual(snapshot.defaultGraphObjectPreexisting, false);
    assert.strictEqual(snapshot.globalCount, 1);
    assert.strictEqual(snapshot.estimateCount, 1);
    assert.strictEqual(snapshot.graphCount, 1);

    let rejectTransport;
    const pendingTransport = new Promise((resolve, reject) => {
      rejectTransport = reject;
    });
    const transportSnapshot = { runId: "payload-run", sourceMode: "human-file" };
    checkpoint.trackTransport(transportSnapshot, pendingTransport, {
      runId: "payload-run",
      sourceMode: "human-file",
    });
    const terminalRun = {
      _runId: "payload-run",
      taskId: "task-1",
      _taskDonePayload: { event: "task_done", status: "done" },
    };
    const drainedClient = {
      _active: false,
      _pending: 0,
      _activeRun: null,
      _runsByTaskId: new Map([["task-1", terminalRun]]),
      _cancellationSourcesByRunId: new Map(),
    };
    const pendingSummary = checkpoint.transportSummary(
      transportSnapshot, drainedClient, "task-1"
    );
    assert.strictEqual(pendingSummary.serverTaskTerminal, true);
    assert.strictEqual(pendingSummary.transportPromiseSettled, false);
    assert.strictEqual(pendingSummary.safeForRestore, false);
    rejectTransport(new Error("cancelled after worker acknowledgement"));
    await pendingTransport.catch(() => {});
    await Promise.resolve();
    const settledSummary = checkpoint.transportSummary(
      transportSnapshot, drainedClient, "task-1"
    );
    assert.strictEqual(settledSummary.transportPromiseOutcome, "rejected");
    assert.strictEqual(settledSummary.transportPromiseError,
      "cancelled after worker acknowledgement");
    assert.strictEqual(settledSummary.safeForRestore, true);
    drainedClient._activeRun = terminalRun;
    drainedClient._cancellationSourcesByRunId.set("payload-run", {});
    assert.strictEqual(
      checkpoint.transportSummary(transportSnapshot, drainedClient, "task-1").safeForRestore,
      false,
      "matching local ownership must be removed before restore"
    );
    drainedClient._activeRun = null;
    drainedClient._cancellationSourcesByRunId.clear();

    const restore = checkpoint.restoreCode(snapshot, (value) => String(value).replace(/\\/g, "/"));
    assert.ok(restore.includes(`use "${snapshot.path.replace(/\\/g, "/")}", clear`));
    assert.ok(restore.indexOf("st_isname(") < restore.indexOf(`use "${snapshot.path.replace(/\\/g, "/")}", clear`),
      "native name validation must precede every destructive restore operation");
    assert.ok(restore.includes("base64decode"));
    assert.ok(restore.includes("estimates store good_est"));
    assert.ok(!restore.includes("../bad"));
    assert.ok(restore.includes("name(good_graph, replace)"));
    assert.strictEqual(restore.split("\n").filter((line) => line === "discard").length, 1,
      "full Stop restoration must clear the interrupted graphics class cache exactly once");
    assert.ok(restore.indexOf("\ndiscard\n") < restore.indexOf("estimates use"),
      "discard clears estimates too, so it must precede all checkpoint rehydration");
    assert.ok(!checkpoint.restoreCode(snapshot, null, { datasetOnly: true }).split("\n").includes("discard"),
      "dataset-only degraded restoration must not clear the non-data state it cannot restore");
    assert.ok(restore.includes("classutil drop .Graph"));
    assert.ok(restore.includes("graph drop good_graph"));
    assert.ok(restore.includes("classutil drop .good_graph"));
    const namedGraphCleanup = restore.slice(
      restore.indexOf("classutil drop .good_graph"),
      restore.indexOf("graph use", restore.indexOf("classutil drop .good_graph"))
    );
    assert.ok(!namedGraphCleanup.includes("local __codex_restore_rc = _rc"),
      "non-critical named class cleanup must defer failure authority to graph use");
    assert.ok(restore.includes("if `__codex_restore_rc' != 0 exit `__codex_restore_rc'"));
    assert.ok(!restore.includes("bad-name"));
    assert.ok(restore.includes("graph display good_graph"));
    // R16J113: the real selection transport returned r(198) after losing the
    // closing lines of Stata if-blocks. Mata blocks survive that transport, but
    // generated Stata restoration must use self-contained conditional lines.
    const stataRestore = restore;
    assert.ok(!/[{}]/.test(stataRestore),
      "checkpoint Stata restore must not depend on multiline brace replay");
    assert.ok(stataRestore.includes("if `__codex_step_rc' == 0 capture estimates store good_est"));
    assert.ok(stataRestore.includes("if `__codex_step_rc' == 0 local __codex_step_rc = _rc"),
      "a failed estimates use must not be replaced with the store result");
    assert.ok(stataRestore.includes("if !_rc capture quietly classutil drop .good_graph"));

    const globalsFile = checkpoint.checkpointPaths(snapshot).globalsPath;
    const savedGlobals = fs.readFileSync(globalsFile);
    const trickyGlobals = new Map([
      ["模型", "中文\n\t\" ${unchanged} `literal' \\ tail"],
      ["mode\u0301le", "combining character: Stata validates without JS normalization"],
      ["emptyValue", ""],
      ["longValue", "a".repeat(100000)],
    ]);
    fs.writeFileSync(globalsFile, [...trickyGlobals].map(([name, value]) =>
      `${name}\t${Buffer.from(value).toString("base64")}\n`).join(""));
    const globalRestore = checkpoint.restoreCode(snapshot);
    const decodedGlobals = new Map();
    for (const line of globalRestore.split("\n").filter((line) => line.startsWith("mata: st_global("))) {
      const match = /^mata: st_global\(base64decode\("([A-Za-z0-9+/=]+)"\), base64decode\("([A-Za-z0-9+/=]*)"\)\)$/.exec(line);
      assert.ok(match, "globals use only literal base64 expressions, with no Mata assignments");
      decodedGlobals.set(Buffer.from(match[1], "base64").toString(), Buffer.from(match[2], "base64").toString());
    }
    assert.deepStrictEqual(decodedGlobals, trickyGlobals,
      "Unicode, whitespace, macro syntax and long values must round-trip without source interpolation");
    const nativeChecks = [...globalRestore.matchAll(/st_isname\(base64decode\("([A-Za-z0-9+/=]+)"\)\)/g)];
    assert.deepStrictEqual(nativeChecks.map((m) => Buffer.from(m[1], "base64").toString()),
      [...trickyGlobals.keys()], "every exported name uses the same native predicate before restoration");
    assert.ok(nativeChecks.every((m) => m.index < globalRestore.indexOf(`use "${snapshot.path.replace(/\\/g, "/")}"`)));
    assert.ok(!/[{}]/.test(globalRestore), "Unicode preflight must preserve brace-free replay");
    for (const invalid of [
      "bad name\tdmFsdWU=\n", "!1fe\tdmFsdWU=\n", "r(result)\tdmFsdWU=\n",
      "A\tnot-base64\n", "A\tYQ\n", "A\tYQ==\textra\n", "A\tYQ==\nA\tYg==\n",
      `${"名".repeat(33)}\tYQ==\n`, Buffer.from([0xff, 0x09, 0x59, 0x51, 0x3d, 0x3d, 0x0a]),
    ]) {
      fs.writeFileSync(globalsFile, invalid);
      assert.strictEqual(checkpoint.restoreCode(snapshot), "exit 459\n",
        "invalid globals must fail before changing the live dataset");
      assert.strictEqual(checkpoint.restoreCode(snapshot, null, { datasetOnly: true }), "exit 459\n");
    }
    fs.unlinkSync(globalsFile);
    assert.strictEqual(checkpoint.restoreCode(snapshot, null, { datasetOnly: true }), "exit 459\n",
      "a missing global inventory is not a successful degraded restore");
    fs.writeFileSync(globalsFile, savedGlobals);

    fs.writeFileSync(snapshot.defaultGraphObjectPath, "1\n", "utf8");
    const preexistingObjectRestore = checkpoint.restoreCode(
      snapshot,
      (value) => String(value).replace(/\\/g, "/")
    );
    assert.ok(!preexistingObjectRestore.includes("classutil drop .Graph"),
      "a preexisting user .Graph object must not be removed");
    assert.ok(!preexistingObjectRestore.split("\n").includes("discard"),
      "an uncheckpointed preexisting .Graph object forbids resetting the class system");
    fs.writeFileSync(snapshot.defaultGraphObjectPath, "0\n", "utf8");
    const estimateFile = path.join(snapshot.stateDir, "estimate_good_est.ster");
    const savedEstimate = fs.readFileSync(estimateFile);
    fs.unlinkSync(estimateFile);
    assert.strictEqual(checkpoint.restoreCode(snapshot), "exit 459\n",
      "missing saved estimates must reject before a reset can discard the remaining live state");
    fs.writeFileSync(estimateFile, savedEstimate);
    const graphFile = path.join(snapshot.stateDir, "graph_good_graph.gph");
    const savedGraph = fs.readFileSync(graphFile);
    fs.unlinkSync(graphFile);
    assert.strictEqual(checkpoint.restoreCode(snapshot), "exit 459\n",
      "a missing graph must fail closed before discard, never be silently skipped");
    fs.writeFileSync(graphFile, savedGraph);
    fs.writeFileSync(snapshot.defaultGraphObjectPath, "invalid\n", "utf8");
    assert.strictEqual(checkpoint.restoreCode(snapshot), "exit 459\n",
      "a malformed object-presence checkpoint must fail closed");

    const summary = checkpoint.publicSummary(snapshot);
    assert.strictEqual(summary.stateComplete, true);
    assert.strictEqual(summary.exists, true);
    assert.strictEqual(summary.defaultGraphObjectPreexisting, false);
    checkpoint.cleanup(snapshot);
    assert.strictEqual(fs.existsSync(snapshot.path), false);
    assert.strictEqual(fs.existsSync(snapshot.stateDir), false);
    checkpoint.cleanup(snapshot);
    fs.rmSync(partialPath, { force: true });

    const atomicSnapshot = {
      path: path.join(root, "atomic.dta"), runId: "atomic-run",
      sourceMode: "visible-bridge", provisional: true,
    };
    let atomicCalls = 0;
    let fallbackCalls = 0;
    const atomic = checkpoint.beginAtomic({
      snapshot: atomicSnapshot,
      cwd: root,
      stataString: (value) => String(value).replace(/\\/g, "/").replace(/"/g, '""'),
      runSelection: async (code, options) => {
        atomicCalls += 1;
        assert.ok(code.indexOf('save "') < code.indexOf("local __codex_names : all globals"));
        assert.strictEqual(options.runId, "pre-run-full-state-atomic-run");
        fs.writeFileSync(atomicSnapshot.path, Buffer.alloc(1024, 2));
        atomicSnapshot.snapshotKind = "data";
        writeSnapshotReady(atomicSnapshot);
        writeCheckpointFiles(atomicSnapshot);
        return { success: true, rc: 0, logPath: "/tmp/atomic.log" };
      },
    });
    await atomic.snapshotReady;
    const atomicDone = await checkpoint.completeAtomic(atomic, {
      legacyRunSelection: async () => { fallbackCalls += 1; },
    });
    assert.strictEqual(atomicCalls, 1, "normal atomic path must dispatch exactly once");
    assert.strictEqual(fallbackCalls, 0, "normal atomic path must not reuse transport");
    assert.strictEqual(atomic.fallbackDispatchCount, 0);
    assert.strictEqual(atomicDone.stateComplete, true);
    assert.strictEqual(atomicDone.provisional, false);
    assert.strictEqual(atomicDone.snapshotKind, "data");
    assert.strictEqual(atomicSnapshot.transportPromiseAttached, true);
    assert.strictEqual(atomicSnapshot.transportPromiseSettled, true);
    assert.strictEqual(atomicSnapshot.transportPromiseOutcome, "fulfilled");

    const emptySnapshot = {
      path: path.join(root, "empty.dta"), runId: "empty-run",
      sourceMode: "visible-bridge", provisional: true,
    };
    let emptyCode = "";
    const emptyAtomic = checkpoint.beginAtomic({
      snapshot: emptySnapshot,
      runSelection: async (code) => {
        emptyCode = code;
        fs.writeFileSync(emptySnapshot.path, Buffer.alloc(1024, 5));
        emptySnapshot.snapshotKind = "empty";
        writeSnapshotReady(emptySnapshot);
        writeCheckpointFiles(emptySnapshot);
        return { success: true, rc: 0, logPath: "/tmp/empty.log" };
      },
    });
    await emptyAtomic.snapshotReady;
    await checkpoint.completeAtomic(emptyAtomic);
    assert.ok(emptyCode.includes("if c(k) == 0"));
    assert.ok(emptyCode.includes("generate byte __codex_empty_state = ."));
    const expectedReadyWrite =
      `file write \`__codex_sfh' "ready" _tab "${emptySnapshot.checkpointNonce}" _tab "\`__codex_snapshot_kind'"`;
    assert.ok(emptyCode.includes(expectedReadyWrite));
    assert.ok(emptyCode.includes(
      `if "\`__codex_snapshot_kind'" == "obs" file write \`__codex_sfh' _tab "\`__codex_snapshot_obs'"`));
    assert.ok(emptyCode.includes("file write `__codex_sfh' _n"));
    const snapshotOnlyCode = checkpoint.snapshotCode(emptySnapshot);
    assert.ok(snapshotOnlyCode.includes("capture noisily break {"));
    assertCleanupScopes(snapshotOnlyCode, [
      "_return hold `__codex_snap_r'",
      "capture frame drop `__codex_snap_frame'",
      "capture _return restore `__codex_snap_r'",
      expectedReadyWrite,
    ]);
    assert.ok(snapshotOnlyCode.indexOf(expectedReadyWrite) <
      snapshotOnlyCode.indexOf("capture _return restore"),
    "ready-file commands, including errors, must run before restoring caller r()");
    assert.ok(!/^\s*(?:clear|preserve|restore|frame change)\b/m.test(snapshotOnlyCode),
      "snapshot must not change the original frame or its preserve stack");
    assert.strictEqual(
      emptyCode.includes(`ready\t${emptySnapshot.checkpointNonce}\t`),
      false,
      "literal tabs inside a Stata string are normalized to spaces and must never encode the marker"
    );
    const transportedReadyBytes = Buffer.from(
      `ready\t${emptySnapshot.checkpointNonce}\tempty\n`,
      "utf8"
    );
    assert.strictEqual(transportedReadyBytes[5], 0x09);
    assert.strictEqual(transportedReadyBytes[38], 0x09);
    fs.writeFileSync(
      checkpoint.checkpointPaths(emptySnapshot).snapshotReadyPath,
      transportedReadyBytes
    );
    assert.deepStrictEqual(
      checkpoint.snapshotReadyRecord(emptySnapshot),
      {
        nonce: emptySnapshot.checkpointNonce,
        kind: "empty",
        path: checkpoint.checkpointPaths(emptySnapshot).snapshotReadyPath,
      },
      "the bytes emitted by Stata _tab tokens must satisfy the strict parser"
    );
    const emptyRestore = checkpoint.restoreCode(emptySnapshot);
    assert.ok(emptyRestore.split("\n").includes("clear"));
    assert.ok(emptyRestore.indexOf("st_isname(") < emptyRestore.indexOf("\nclear\n"));
    assert.ok(!checkpoint.restoreCode(emptySnapshot).includes(`use "${emptySnapshot.path}"`));

    const fallbackSnapshot = {
      path: path.join(root, "fallback.dta"), runId: "fallback-run",
      sourceMode: "human-file", provisional: true,
    };
    let fallbackPrimaryCalls = 0;
    const fallbackAtomic = checkpoint.beginAtomic({
      snapshot: fallbackSnapshot,
      cwd: root,
      runSelection: async () => {
        fallbackPrimaryCalls += 1;
        fs.writeFileSync(fallbackSnapshot.path, Buffer.alloc(1024, 3));
        writeSnapshotReady(fallbackSnapshot);
        if (fallbackPrimaryCalls > 1) writeCheckpointFiles(fallbackSnapshot);
        return { success: true, rc: 0, logPath: "/tmp/incomplete.log" };
      },
    });
    await fallbackAtomic.snapshotReady;
    await checkpoint.completeAtomic(fallbackAtomic, { cwd: root });
    assert.strictEqual(fallbackPrimaryCalls, 2, "incomplete atomic state reuses the runner exactly once");
    assert.strictEqual(fallbackAtomic.fallbackDispatchCount, 1);

    const invalidSnapshot = {
      path: path.join(root, "invalid.dta"), runId: "invalid-run",
    };
    const invalidAtomic = checkpoint.beginAtomic({
      snapshot: invalidSnapshot,
      runSelection: async () => ({ success: true, rc: 0 }),
    });
    await assert.rejects(invalidAtomic.snapshotReady, /without a restore-capable snapshot/);
    await assert.rejects(
      checkpoint.completeAtomic(invalidAtomic),
      /atomic checkpoint state incomplete/
    );

    const rejectedSnapshot = {
      path: path.join(root, "rejected.dta"), runId: "rejected-run",
    };
    const rejectedAtomic = checkpoint.beginAtomic({
      snapshot: rejectedSnapshot,
      runSelection: async () => { throw new Error("transport rejected"); },
    });
    await assert.rejects(rejectedAtomic.snapshotReady, /transport rejected/);
    await assert.rejects(rejectedAtomic.complete, /transport rejected/);
    assert.strictEqual(checkpoint.isSnapshotReady(rejectedSnapshot), false);

    const staleSnapshot = {
      path: path.join(root, "stale.dta"), runId: "stale-run",
    };
    fs.writeFileSync(staleSnapshot.path, Buffer.alloc(1024, 4));
    fs.mkdirSync(checkpoint.checkpointPaths(staleSnapshot).stateDir, { recursive: true });
    writeSnapshotReady(staleSnapshot);
    const staleAtomic = checkpoint.beginAtomic({
      snapshot: staleSnapshot,
      runSelection: async () => ({ success: true, rc: 0 }),
    });
    await assert.rejects(staleAtomic.snapshotReady, /without a restore-capable snapshot/);
    assert.strictEqual(fs.existsSync(staleSnapshot.path), false, "stale DTA must be removed before dispatch");
    assert.strictEqual(
      fs.existsSync(checkpoint.checkpointPaths(staleSnapshot).snapshotReadyPath),
      false,
      "stale milestone must be removed before dispatch"
    );
    checkpoint.cleanup(atomicSnapshot);
    checkpoint.cleanup(fallbackSnapshot);
    checkpoint.cleanup(invalidSnapshot);
    checkpoint.cleanup(staleSnapshot);
    checkpoint.cleanup(emptySnapshot);
    checkpoint.cleanup(rejectedSnapshot);
    console.log("STOP_CHECKPOINT_CORE_PASS");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} catch (error) {
  fs.rmSync(root, { recursive: true, force: true });
  throw error;
}
