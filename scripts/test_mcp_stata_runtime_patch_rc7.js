#!/usr/bin/env node
"use strict";

const sessionHealth = require("./stata_session_health_patch");
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sessionOriginal = fs.readFileSync(path.join(__dirname, "../tests/fixtures/stata_sessions.original.py"), "utf8");
const runtimePatch = require("./mcp_stata_runtime_patch");
const graphNameBoundary = require("./stata_graph_name_boundary_patch");
require("./test_stata_graph_name_boundary_patch");
const graphTaskDrain = require("./stata_graph_task_drain_patch");
const graphErrors = require("./stata_graph_error_patch");
const graphCallbacks = require("./stata_graph_callback_patch");
const detectorErrors = require("./stata_detector_error_patch");
const detectorState = require("./stata_detector_state_patch");
const detectorSreturn = require("./stata_detector_sreturn_patch");
const cacheTransaction = require("./stata_cache_transaction_patch");
const cacheFixture = require("../tests/fixtures/stata_cache_transaction.original.json");
const finalDetectorBlock = body => {
  let result = body.replace(detectorSreturn.previous, () => detectorSreturn.replacement);
  for (const block of cacheTransaction.BLOCKS) result = result.replace(block.previous, () => block.replacement);
  return result;
};
const graphInventory = require("./stata_graph_inventory_patch");
const streamLifecycle = require("./stata_stream_lifecycle_patch");
const helpState = require("./stata_help_state_patch");
const exportState = require("./stata_export_state_patch");
const storedResults = require("./stata_stored_results_patch");
const storedFixture = require("../tests/fixtures/stata_stored_results.original.json");
const startupState = require("./stata_startup_state_patch");
const startupFixture = require("../tests/fixtures/stata_startup_state.original.json");
const bulkCache = require("./stata_bulk_cache_patch");
const bulkOriginal = name => bulkCache.BLOCKS.find(b => b.name === name).original;
const startupMethods = startupState.INIT_ORIGINAL + startupState.BLOCKS[0].end + "\n        pass\n\n"
  + startupFixture.blocks.map(block => block.original + block.end
    + (block.name === "load" ? "\n" : "self):\n        pass\n\n")).join("");
const exportMethods = require("../tests/fixtures/stata_export.original.json").original
  + require("../tests/fixtures/stata_help.original.json").original
  + storedFixture.original + bulkOriginal("manage")
  + "    def _get_content_hash(self, content):\n        return content.hex()\n\n"
  + startupMethods;
const lifecycleBoundary = streamLifecycle.BLOCKS.find(b => b.name === "execution-error-and-close");
const finalLifecycleBoundary = source =>
  source.replace(lifecycleBoundary.original, lifecycleBoundary.replacement);
const inventoryFixture = require("../tests/fixtures/stata_graph_inventory.original.json");
const inventoryMethods = inventoryFixture.blocks.map(block => block.original +
  (block.name === "list_graphs" ? exportMethods :
    block.name === "_capture_graph_state" ? "    async def _cache_new_graphs(self):\n        pass\n\n" :
      "    @staticmethod\n    def _inventory_end():\n        pass\n\n")).join("");
const originalInventoryMethods = inventoryMethods.replace(
  runtimePatch.PATCHED_CLIENT_GRAPH_INVENTORY, runtimePatch.ORIGINAL_CLIENT_GRAPH_INVENTORY);
const detectorFixture = require("../tests/fixtures/stata_detector_errors.original.json");
const detectorMethods = detectorFixture.blocks.map(block => block.original +
  (block.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        return self._get_graph_timestamps([name]).get(name, '')\n\n" : "")).join("") +
  "    def should_cache_graph(self, name):\n        raise NotImplementedError\n" +
  cacheFixture.blocks.find(b => b.name === "lifecycle").original + "class StreamingGraphCache:\n";
// These frozen blocks already contain the deployed quiet-probe patch. Undo only
// those substitutions here so the integration covers migration from raw source.
const originalDetectorMethods = detectorMethods
  .replaceAll(runtimePatch.PATCHED_DETECTOR_GRAPH_DIR, runtimePatch.ORIGINAL_DETECTOR_GRAPH_DIR)
  .replace(runtimePatch.PATCHED_DETECTOR_GRAPH_DESCRIBE, runtimePatch.ORIGINAL_DETECTOR_GRAPH_DESCRIBE);
// A malformed dry-run invocation must not discover or touch any live runtime.
const ioMethods = ["existsSync", "statSync", "readdirSync", "readFileSync", "writeFileSync", "renameSync"];
const originalIo = Object.fromEntries(ioMethods.map(name => [name, fs[name]]));
let invalidOptionIo = 0;
try {
  for (const name of ioMethods) fs[name] = () => { invalidOptionIo++; throw new Error("unexpected runtime IO"); };
  for (const args of [
    ["/a/runtime", { dryRun: true }], ["/a/runtime"], [null], [[]], [false], [1],
    [{ dryRun: "false" }], [{ dryRun: null }], [{ dryRun: 0 }],
    [{ dryRun: true }, { runtimeRoot: "/a/runtime" }],
  ]) {
    const result = runtimePatch.patchRuntime(...args);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "invalid-options");
  }
  assert.strictEqual(invalidOptionIo, 0);
} finally {
  for (const name of ioMethods) fs[name] = originalIo[name];
}
const streamStateFixture = fs.readFileSync(path.join(__dirname,
  "../tests/fixtures/stata_streaming_blocking.original.py"), "utf8")
  + "    def _resolve_do_file_path(self):\n        pass\n"
  // The two graph patches below already supply both execution/close boundaries.
  + streamLifecycle.BLOCKS.filter(block => block.name !== "execution-error-and-close")
    .map(block => block.original.repeat(block.count)).join("\n")
  + require("../tests/fixtures/stata_smcl_logs.original.json").source
  + "    def _restore_results_from_hold(self):\n        pass\n"
  + require("../tests/fixtures/stata_response_rc.original.json").blocks.map(block =>
    block.name === "_exec_with_capture"
      ? require("../tests/fixtures/stata_capture_state.original.json").source
      : (block.name === "run_do_file" ? bulkOriginal("exports") : "")
        + `    def ${block.name}(self):\n` + block.source + block.success + "        return rc, success\n\n").join("")
  + require("../tests/fixtures/stata_rc_read.original.json").source
  + "    def _parse_rc_from_text(self):\n        pass\n"
  + require("../tests/fixtures/stata_silent_state.original.json").blocks.map(block =>
    block.source.replace(runtimePatch.PATCHED_INTERNAL_SILENT_EXEC, runtimePatch.ORIGINAL_INTERNAL_SILENT_EXEC)
      + block.end + "self):\n        pass\n\n").join("");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stata-runtime-patch-"));
try {
  const compileSpawnSync = () => ({ status: 0, stdout: "", stderr: "" });
  const patchOptions = {
    runtimeRoot: root,
    pythonCommand: process.execPath,
    compileSpawnSync,
  };
  const backgroundNotifyFixture = [
    runtimePatch.ORIGINAL_BACKGROUND_NOTIFY_HEAD.trimEnd(),
    "            payload_to_send = text",
    runtimePatch.ORIGINAL_BACKGROUND_NOTIFY_SEND,
  ].join("\n");
  // The frozen graph finalizers contain the existing cache anchors exactly once.
  const graphCacheFixture = graphErrors.BLOCKS.map(block =>
    (block.name === "emission" ? cacheFixture.notification.original + bulkOriginal("get") : "") + block.original
    + (block.name === "emission" ? "    @staticmethod\n    def _extract_named_graphs(text):\n        return []\n\n" : "")).join("\n")
    .replace(runtimePatch.PATCHED_BACKGROUND_GRAPH_CACHE_COMMAND, runtimePatch.ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND)
    .replace(runtimePatch.PATCHED_BACKGROUND_GRAPH_CACHE_DOFILE, runtimePatch.ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE);
  const streamTailFixture = [
    runtimePatch.ORIGINAL_STREAM_TAIL_SIGNATURE,
    runtimePatch.ORIGINAL_POST_DONE_DRAIN,
    runtimePatch.ORIGINAL_STREAM_CALL_TAIL,
    runtimePatch.ORIGINAL_STREAM_CALL_TAIL,
  ].join("\n");
  const backgroundGraphReadyFixture = [
    runtimePatch.ORIGINAL_BACKGROUND_GRAPH_READY_OPTION,
    runtimePatch.ORIGINAL_BACKGROUND_GRAPH_READY_OPTION,
  ].join("\n");
  const checkpointGraphReadyFixture = [
    runtimePatch.PATCHED_BACKGROUND_GRAPH_READY_OPTION,
    runtimePatch.PATCHED_BACKGROUND_GRAPH_READY_OPTION,
  ].join("\n");
  const backgroundSignaturesFixture = [
    runtimePatch.ORIGINAL_DOFILE_BACKGROUND_SIGNATURE,
    runtimePatch.ORIGINAL_COMMAND_BACKGROUND_SIGNATURE,
  ].join("\n");
  const packageDir = path.join(
    root,
    "lib",
    "python3.12",
    "site-packages",
    "mcp_stata"
  );
  fs.mkdirSync(packageDir, { recursive: true });
  const serverPath = path.join(packageDir, "server.py");
  const clientPath = path.join(packageDir, "stata_client.py");
  const graphDetectorPath = path.join(packageDir, "graph_detector.py");
  const sessionPath = path.join(packageDir, "sessions.py");
  fs.writeFileSync(
    serverPath,
    [
      "# fixture",
      runtimePatch.ORIGINAL_CALL_SYNC,
      runtimePatch.ORIGINAL_TASK_DONE_NOTIFY,
      sessionHealth.SERVER_ORIGINAL,
      backgroundNotifyFixture,
      backgroundNotifyFixture,
      backgroundSignaturesFixture,
      backgroundGraphReadyFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(sessionPath, [
    "# fixture",
    sessionOriginal.replace(runtimePatch.PATCHED_SESSION_CALL, runtimePatch.ORIGINAL_SESSION_CALL),
    "# end",
  ].join("\n"), "utf8");
  fs.writeFileSync(
    clientPath,
    [
      "# fixture",
      runtimePatch.ORIGINAL_STATA_BREAK_REQUEST,
      ...graphNameBoundary.BLOCKS.map(block => block.original),
      streamStateFixture,
      graphTaskDrain.ORIGINAL_POLL,
      graphTaskDrain.ORIGINAL_EXIT,
      runtimePatch.ORIGINAL_STREAM_HELPER,
      runtimePatch.ORIGINAL_STREAM_NOTIFY,
      runtimePatch.ORIGINAL_FINAL_STREAM_NOTIFY,
      runtimePatch.ORIGINAL_STREAM_TAIL_SIGNATURE,
      runtimePatch.ORIGINAL_POST_DONE_DRAIN,
      runtimePatch.ORIGINAL_STREAM_CALL_TAIL,
      runtimePatch.ORIGINAL_STREAM_CALL_TAIL,
      originalInventoryMethods,
      graphCacheFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    graphDetectorPath,
    [
      "# fixture",
      "class GraphCreationDetector:",
      originalDetectorMethods,
      graphCallbacks.ORIGINAL,
      graphTaskDrain.ORIGINAL_DETECTOR + cacheFixture.scaffold.cacheTail.source,
      "# end",
    ].join("\n"),
    "utf8"
  );

  // Windows installs carry CRLF (10-29 Windows: every LF anchor missed -> unsupported-source,
  // then the unpatched graph name() rewrite mangled st_isname(...) in the checkpoint).
  const runtimeFiles = [serverPath, clientPath, graphDetectorPath, sessionPath];
  const lfOriginals = runtimeFiles.map(file => fs.readFileSync(file, "utf8"));
  const first = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.status, "applied");
  {
    const crlfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stata-runtime-crlf-"));
    try {
      const crlfDir = path.join(crlfRoot, "lib", "python3.12", "site-packages", "mcp_stata");
      fs.mkdirSync(crlfDir, { recursive: true });
      const names = ["server.py", "stata_client.py", "graph_detector.py", "sessions.py"];
      names.forEach((name, i) => fs.writeFileSync(path.join(crlfDir, name), lfOriginals[i].replace(/\n/g, "\r\n"), "utf8"));
      const crlf = runtimePatch.patchRuntime({ ...patchOptions, runtimeRoot: crlfRoot });
      assert.strictEqual(crlf.ok, true, JSON.stringify(crlf));
      assert.strictEqual(crlf.status, "applied");
      const lfPatched = runtimeFiles.map(file => fs.readFileSync(file, "utf8"));
      names.forEach((name, i) => {
        const text = fs.readFileSync(path.join(crlfDir, name), "utf8");
        assert.ok(!/[^\r]\n/.test(text), name + " keeps CRLF line endings");
        assert.strictEqual(text.replace(/\r\n/g, "\n"), lfPatched[i], name + " gets the same patch as LF");
      });
      assert.ok(fs.readFileSync(path.join(crlfDir, "stata_client.py"), "utf8").includes("(?<![\\w.])name\\("));
      const again = runtimePatch.patchRuntime({ ...patchOptions, runtimeRoot: crlfRoot });
      assert.strictEqual(again.status, "already-applied", JSON.stringify(again));
    } finally {
      fs.rmSync(crlfRoot, { recursive: true, force: true });
    }
  }
  const firstBytes = fs.readFileSync(serverPath);
  assert.ok(firstBytes.toString("utf8").includes(runtimePatch.PATCH_MARKER));
  assert.ok(firstBytes.toString("utf8").includes("listener_task.get_loop()"));
  assert.ok(firstBytes.toString("utf8").includes("run_coroutine_threadsafe"));
  assert.ok(firstBytes.toString("utf8").includes(runtimePatch.TASK_DONE_PATCH_MARKER));
  assert.ok(firstBytes.toString("utf8").includes("await asyncio.wait_for("));
  assert.ok(firstBytes.toString("utf8").includes("timeout=0.25"));
  assert.ok(firstBytes.toString("utf8").includes("releasing transport"));
  const firstServerText = firstBytes.toString("utf8");
  assert.strictEqual(
    firstServerText.split(runtimePatch.LOG_PATH_NOTIFY_PATCH_MARKER).length - 1,
    2
  );
  assert.strictEqual(
    firstServerText.split(runtimePatch.CHECKPOINT_NOTIFY_PATCH_MARKER).length - 1,
    2
  );
  assert.strictEqual(
    firstServerText.split("workbench_quiet_checkpoint = (").length - 1,
    2
  );
  assert.strictEqual(
    firstServerText.split(runtimePatch.RESPECT_BACKGROUND_GRAPH_READY_PATCH_MARKER).length - 1,
    2
  );
  assert.ok(!firstServerText.includes(runtimePatch.ORIGINAL_BACKGROUND_GRAPH_READY_OPTION));
  assert.ok(!firstServerText.includes(runtimePatch.PATCHED_BACKGROUND_GRAPH_READY_OPTION));
  assert.strictEqual(
    firstServerText.split(runtimePatch.PATCHED_RESPECT_BACKGROUND_GRAPH_READY_OPTION).length - 1,
    2
  );
  assert.strictEqual(
    firstServerText.split('"emit_graph_ready": emit_graph_ready').length - 1,
    2
  );
  assert.strictEqual(
    firstServerText.split("emit_graph_ready: bool = True").length - 1,
    2
  );
  assert.ok(firstServerText.includes(
    '"___CODEX_CHECKPOINT_DONE___" in str(locals().get("code") or "")'));
  assert.strictEqual(
    firstServerText.split(runtimePatch.PATCHED_BACKGROUND_NOTIFY_SEND).length - 1,
    2
  );
  for (const block of firstServerText.split("    async def notify_log(text: str) -> None:").slice(1)) {
    assert.ok(
      block.indexOf("task_info.log_path = payload.get") <
        block.indexOf(runtimePatch.PATCHED_BACKGROUND_NOTIFY_SEND.trim()),
      "authoritative log_path must be recorded before the bounded notification"
    );
    assert.ok(
      block.indexOf(runtimePatch.CHECKPOINT_NOTIFY_PATCH_MARKER) <
        block.indexOf(runtimePatch.PATCHED_BACKGROUND_NOTIFY_SEND.trim()),
      "checkpoint output must be suppressed before the optional notification"
    );
  }
  const firstClientBytes = fs.readFileSync(clientPath);
  const logQuery = require("./stata_log_query_patch");
  const firstClientRawText = firstClientBytes.toString("utf8");
  for (const block of logQuery.BLOCKS) {
    assert.equal(firstClientRawText.split(block.replacement).length - 1, block.count);
    assert.equal(firstClientRawText.split(block.old).length - 1, 0);
  }
  // Check earlier source transforms in their canonical pre-query form.
  const firstClientText = logQuery.normalizeClient(firstClientRawText);
  assert.ok(firstClientText.includes(runtimePatch.STATA_SET_BREAK_PATCH_MARKER));
  assert.ok(firstClientText.includes('getattr(pystata_config.stlib, "StataSO_SetBreak", None)'));
  assert.ok(firstClientText.includes("self._set_stata_break()"));
  assert.ok(!firstClientText.includes('getattr(sfi, "breakIn", None)'));
  assert.ok(firstClientText.includes(runtimePatch.STREAM_PATCH_MARKER));
  assert.ok(firstClientText.includes(runtimePatch.STREAM_TAIL_PATCH_MARKER));
  assert.ok(firstClientText.includes("required_tail_marker: Optional[str] = None"));
  assert.ok(firstClientText.includes(
    're.search(r"___CODEX_RUN_DONE_[A-Za-z0-9_.:-]+___", code)'));
  assert.ok(firstClientText.includes(
    're.search(r"___CODEX_RUN_DONE_[A-Za-z0-9_.:-]+___", dofile_text)'));
  assert.ok(firstClientText.includes("completion_deadline = time.monotonic() + 5.0"));
  assert.ok(firstClientText.includes('r"(?:^|\\n)(?:\\{(?:res|txt)\\})*"'));
  assert.ok(firstClientText.includes("if saw_required_tail or time.monotonic() >= completion_deadline:"));
  assert.ok(!firstClientText.includes(runtimePatch.ORIGINAL_POST_DONE_DRAIN));
  assert.ok(firstClientText.includes(
    'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"'));
  assert.ok(firstClientText.includes("max_notify_chars = 4000"));
  assert.ok(firstClientText.includes("notify_budget_remaining = 4000"));
  assert.ok(firstClientText.includes(
    "nonlocal notifications_enabled, notify_budget_remaining"));
  assert.ok(firstClientText.includes("notify_budget_remaining -= len(piece)"));
  assert.ok(firstClientText.includes("await asyncio.wait_for("));
  assert.ok(firstClientText.includes("timeout=0.25"));
  assert.ok(firstClientText.includes("notifications_enabled = False"));
  assert.ok(firstClientText.includes(runtimePatch.GRAPH_PROBE_PATCH_MARKER));
  assert.ok(firstClientText.includes(runtimePatch.INTERNAL_SILENT_PATCH_MARKER));
  assert.strictEqual(
    firstClientText.split(runtimePatch.GRAPH_CACHE_DRAIN_PATCH_MARKER).length - 1,
    2
  );
  for (const block of graphErrors.BLOCKS.filter(b => b.name !== "emission")) {
    assert.ok(firstClientText.includes(finalLifecycleBoundary(block.replacement)), block.name);
  }
  assert.ok(!firstClientText.includes(runtimePatch.ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND));
  assert.ok(!firstClientText.includes(runtimePatch.ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE));
  assert.ok(!firstClientText.includes("asyncio.create_task(\n                self._cache_new_graphs("));
  for (const block of streamLifecycle.BLOCKS) {
    assert.strictEqual(firstClientText.split(block.replacement).length - 1, block.count);
  }
  for (const block of graphInventory.BLOCKS) {
    assert.ok(firstClientText.includes(block.replacement), block.name);
  }
  assert.ok(firstClientText.includes(helpState.BLOCK.replacement));
  assert.ok(firstClientText.includes(exportState.BLOCK.replacement));
  assert.ok(firstClientText.includes(storedResults.BLOCK.replacement));
  for (const block of startupState.BLOCKS) assert.ok(firstClientText.includes(block.replacement), block.name);
  for (const block of bulkCache.BLOCKS) assert.ok(firstClientText.includes(block.replacement), block.name);
  assert.ok(!firstClientText.includes(runtimePatch.PATCHED_CLIENT_GRAPH_INVENTORY));
  assert.ok(firstClientText.includes('self.stata.run("capture quietly " + inner_code'));
  assert.ok(!firstClientText.includes('f"capture noisily {inner_code}\\n"'));
  assert.ok(firstClientText.indexOf("tee.write(cleaned_chunk)") <
    firstClientText.indexOf("await asyncio.wait_for("),
  "the complete visible log must be written before timeout-bounded MCP notifications");
  const firstGraphDetectorBytes = fs.readFileSync(graphDetectorPath);
  const firstGraphDetectorText = firstGraphDetectorBytes.toString("utf8");
  assert.ok(firstGraphDetectorText.includes(runtimePatch.GRAPH_PROBE_PATCH_MARKER));
  assert.strictEqual(
    firstGraphDetectorText.split("run('graph dir, memory')").length - 1,
    1
  );
  for (const block of [...detectorState.BLOCKS, ...detectorErrors.BLOCKS.slice(2)]) {
    assert.ok(firstGraphDetectorText.includes(finalDetectorBlock(block.replacement)), block.name);
  }
  assert.ok(!firstGraphDetectorText.includes(runtimePatch.PATCHED_DETECTOR_GRAPH_DESCRIBE));
  const firstSessionBytes = fs.readFileSync(sessionPath);
  const firstSessionText = firstSessionBytes.toString("utf8");
  assert.ok(firstSessionText.includes(runtimePatch.SESSION_BREAK_DRAIN_PATCH_MARKER));
  assert.ok(firstSessionText.includes(sessionHealth.REPLACEMENT));
  assert.ok(firstSessionText.includes("while not future.done():"));
  assert.ok(!firstSessionText.includes("timeout=3.0"));
  assert.ok(!firstSessionText.includes("did not acknowledge break within timeout"));

  const second = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.status, "already-applied");
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(clientPath), firstClientBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);

  // The last released state candidate migrates without changing the other files.
  fs.writeFileSync(graphDetectorPath, detectorSreturn.normalizeDetector(firstGraphDetectorText));
  const sreturnUpgrade = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(sreturnUpgrade.ok, true, JSON.stringify(sreturnUpgrade));
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(clientPath), firstClientBytes);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);

  fs.writeFileSync(clientPath, firstClientText.replace(storedResults.BLOCK.replacement, () => storedFixture.original));
  const storedUpgrade = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(storedUpgrade.ok, true, JSON.stringify(storedUpgrade));
  assert.deepStrictEqual(fs.readFileSync(clientPath), firstClientBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);

  let beforeStartup = firstClientText.replace(startupState.BLOCKS[0].replacement, () => startupState.INIT_ORIGINAL);
  for (const block of startupFixture.blocks) {
    beforeStartup = beforeStartup.replace(startupState.BLOCKS.find(b => b.name === block.name).replacement, () => block.original);
  }
  fs.writeFileSync(clientPath, beforeStartup);
  const startupUpgrade = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(startupUpgrade.ok, true, JSON.stringify(startupUpgrade));
  assert.deepStrictEqual(fs.readFileSync(clientPath), firstClientBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);

  let beforeBulk = firstClientText;
  for (const block of bulkCache.BLOCKS) beforeBulk = beforeBulk.replace(block.replacement, () => block.original);
  fs.writeFileSync(clientPath, beforeBulk);
  const bulkUpgrade = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(bulkUpgrade.ok, true, JSON.stringify(bulkUpgrade));
  assert.deepStrictEqual(fs.readFileSync(clientPath), firstClientBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);

  // An altered response decision rejects the entire transaction before any write.
  const rcPatch = require("./stata_response_rc_patch");
  assert.strictEqual(firstClientText.split(rcPatch.MARKER).length - 1, 4);
  const alteredClient = firstClientText.replace(rcPatch.replacement(rcPatch.BLOCKS[0]),
    rcPatch.replacement(rcPatch.BLOCKS[0]).replace("rc = 1", "rc = 0"));
  fs.writeFileSync(clientPath, alteredClient);
  const alteredResult = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(alteredResult.ok, false);
  assert.strictEqual(alteredResult.anchor, "execution-response-rc");
  assert.strictEqual(fs.readFileSync(clientPath, "utf8"), alteredClient);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);
  fs.writeFileSync(clientPath, firstClientBytes);

  // Graph ownership and thread shields are also all-or-nothing runtime members.
  for (const [file, original, changed, anchor] of [
    ...bulkCache.BLOCKS.flatMap(block => [
      [clientPath, firstClientText,
        firstClientText.replace(block.replacement, () => block.replacement + "    # tampered bulk cache\n"), "bulk-cache"],
      [clientPath, firstClientText,
        firstClientText.replace(block.replacement, () => block.original), "bulk-cache"],
    ]),
    ...startupState.BLOCKS.map(block => [clientPath, firstClientText,
      firstClientText.replace(block.replacement, () => block.replacement + "    # tampered startup\n"),
      "startup-state"]),
    [clientPath, firstClientText,
      firstClientText.replace(storedResults.BLOCK.replacement,
        () => storedResults.BLOCK.replacement.replace('raise errors[0]', 'return {}')),
      "stored-results"],
    [clientPath, firstClientText,
      firstClientText.replace(exportState.BLOCK.replacement,
        () => exportState.BLOCK.replacement.replace('os.replace(staged, target)', 'staged.unlink()')),
      "export-state"],
    [clientPath, firstClientText,
      firstClientText.replace(cacheTransaction.NOTIFICATION_BLOCK.replacement,
        cacheTransaction.NOTIFICATION_BLOCK.replacement.replace('errors.append(error)', 'pass')),
      "cache-transaction"],
    ...[...cacheTransaction.BLOCKS, cacheTransaction.LIFECYCLE_BLOCK].map(block =>
      [graphDetectorPath, firstGraphDetectorText,
        firstGraphDetectorText.replace(block.replacement, block.replacement.replace(/\S/, "#tamper#")),
        "cache-transaction"]),
    [clientPath, firstClientText,
      firstClientText.replace(helpState.BLOCK.replacement,
        helpState.BLOCK.replacement.replace("== 601", "== 602")), "help-state"],
    ...streamLifecycle.BLOCKS.map(block => [clientPath, firstClientText,
      firstClientText.replace(block.replacement, block.replacement.replace(/\S/, "#tamper#")),
      "streaming-lifecycle"]),
    ...graphInventory.BLOCKS.map(block => [clientPath, firstClientText,
      firstClientText.replace(block.replacement, block.replacement.replace(/\S/, "#changed#")),
      "graph-inventory-state"]),
    ...graphErrors.BLOCKS.filter(b => b.name !== "emission").map(block => [clientPath, firstClientText,
      firstClientText.replace(finalLifecycleBoundary(block.replacement),
        block.name === "dofile-task-errors"
          ? finalLifecycleBoundary(block.replacement).replace("Do-file streaming maintenance failed", "corrupted")
          : finalLifecycleBoundary(block.replacement).replace(/\S/, "#changed#")),
      "graph-error-propagation"]),
    ...[...detectorState.BLOCKS, ...detectorErrors.BLOCKS.slice(2)].map(block => [graphDetectorPath, firstGraphDetectorText,
      firstGraphDetectorText.replace(finalDetectorBlock(block.replacement),
        finalDetectorBlock(block.replacement).replace(/\S/, "#changed#")),
      cacheTransaction.BLOCKS.some(b => b.previous === block.replacement || b.end === block.start)
        ? "cache-transaction" : "detector-error-propagation"]),
    [graphDetectorPath, firstGraphDetectorText,
      firstGraphDetectorText.replace('saved_s = read_s()', 'saved_s = {}'),
      "detector-error-propagation"],
    [clientPath, firstClientText, firstClientText.replace(graphTaskDrain.POLL,
      graphTaskDrain.POLL.replace("tg.start_soon(owned_graph_check)",
        "asyncio.create_task(owned_graph_check())")), "graph-task-drain"],
    [clientPath, firstClientText, firstClientText.replace(finalLifecycleBoundary(graphTaskDrain.EXIT),
      finalLifecycleBoundary(graphTaskDrain.EXIT).replace("+ graph_poll_errors", "+ []")),
      "graph-task-drain"],
    [graphDetectorPath, firstGraphDetectorBytes.toString("utf8"),
      firstGraphDetectorBytes.toString("utf8").replace("await asyncio.wait({worker})",
        "await worker"), "cache-transaction"],
    [graphDetectorPath, firstGraphDetectorBytes.toString("utf8"),
      firstGraphDetectorBytes.toString("utf8").replace(graphCallbacks.CANDIDATE,
        graphCallbacks.CANDIDATE.replace("errors.append(error)", "pass")), "graph-callback-errors"],
  ]) {
    assert.notStrictEqual(changed, original);
    fs.writeFileSync(file, changed);
    const files = [serverPath, clientPath, graphDetectorPath, sessionPath];
    const before = files.map(name => fs.readFileSync(name));
    const refused = runtimePatch.patchRuntime(patchOptions);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.anchor, anchor, JSON.stringify(refused));
    files.forEach((name, index) => assert.deepStrictEqual(fs.readFileSync(name), before[index]));
    fs.writeFileSync(file, original);
  }

  // Tampering with the readonly getter also refuses all runtime writes.
  const rcReadPatch = require("./stata_rc_read_patch");
  assert.ok(firstClientText.includes(rcReadPatch.REPLACEMENT));
  const alteredReader = firstClientText.replace(rcReadPatch.REPLACEMENT,
    rcReadPatch.REPLACEMENT.replace("return -1", "return 0"));
  fs.writeFileSync(clientPath, alteredReader);
  const readerResult = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(readerResult.ok, false);
  assert.strictEqual(readerResult.anchor, "readonly-rc-reader");
  assert.strictEqual(fs.readFileSync(clientPath, "utf8"), alteredReader);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);
  fs.writeFileSync(clientPath, firstClientBytes);

  // Altered maintenance guards must never lead to partially patched runtimes.
  const silentPatch = require("./stata_silent_state_patch");
  const silentBlock = silentPatch.BLOCKS[1].replacement;
  assert.ok(firstClientText.includes(silentBlock));
  const alteredSilent = firstClientText.replace(silentBlock,
    silentBlock.replace("held = True", "held = False"));
  fs.writeFileSync(clientPath, alteredSilent);
  const silentResult = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(silentResult.ok, false);
  assert.strictEqual(silentResult.anchor, "silent-maintenance-state");
  assert.strictEqual(fs.readFileSync(clientPath, "utf8"), alteredSilent);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);
  fs.writeFileSync(clientPath, firstClientBytes);

  const capturePatch = require("./stata_capture_state_patch");
  assert.ok(firstClientText.includes(capturePatch.REPLACEMENT));
  const alteredCapture = firstClientText.replace(capturePatch.REPLACEMENT,
    capturePatch.REPLACEMENT.replace("set more off", "set more on"));
  fs.writeFileSync(clientPath, alteredCapture);
  const captureResult = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(captureResult.ok, false);
  assert.strictEqual(captureResult.anchor, "capture-request-state");
  assert.strictEqual(fs.readFileSync(clientPath, "utf8"), alteredCapture);
  assert.deepStrictEqual(fs.readFileSync(serverPath), firstBytes);
  assert.deepStrictEqual(fs.readFileSync(graphDetectorPath), firstGraphDetectorBytes);
  assert.deepStrictEqual(fs.readFileSync(sessionPath), firstSessionBytes);
  fs.writeFileSync(clientPath, firstClientBytes);

  fs.writeFileSync(
    serverPath,
    [
      "# fixture",
      runtimePatch.PATCHED_CALL_SYNC,
      runtimePatch.ORIGINAL_TASK_DONE_NOTIFY,
      sessionHealth.SERVER_ORIGINAL,
      backgroundNotifyFixture,
      backgroundNotifyFixture,
      backgroundSignaturesFixture,
      backgroundGraphReadyFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  const migratedServer = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedServer.ok, true);
  assert.strictEqual(migratedServer.status, "applied");
  assert.strictEqual(migratedServer.serverStatus, "applied");
  assert.strictEqual(migratedServer.clientStatus, "already-applied");
  const migratedServerBytes = fs.readFileSync(serverPath);
  assert.ok(migratedServerBytes.toString("utf8").includes(runtimePatch.TASK_DONE_PATCH_MARKER));
  const migratedServerAgain = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedServerAgain.status, "already-applied");
  assert.deepStrictEqual(fs.readFileSync(serverPath), migratedServerBytes);

  const legacyBackgroundNotifyFixture = [
    runtimePatch.PATCHED_BACKGROUND_NOTIFY_HEAD_V1.trimEnd(),
    "            payload_to_send = text",
    runtimePatch.PATCHED_BACKGROUND_NOTIFY_SEND,
  ].join("\n");
  fs.writeFileSync(
    serverPath,
    [
      "# fixture",
      runtimePatch.PATCHED_CALL_SYNC,
      runtimePatch.PATCHED_TASK_DONE_NOTIFY,
      sessionHealth.SERVER_ORIGINAL,
      legacyBackgroundNotifyFixture,
      legacyBackgroundNotifyFixture,
      backgroundSignaturesFixture,
      checkpointGraphReadyFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  const migratedCheckpointNotify = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedCheckpointNotify.ok, true);
  assert.strictEqual(migratedCheckpointNotify.status, "applied");
  const migratedCheckpointBytes = fs.readFileSync(serverPath);
  assert.ok(migratedCheckpointBytes.toString("utf8").includes(
    runtimePatch.CHECKPOINT_NOTIFY_PATCH_MARKER));
  const migratedCheckpointAgain = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedCheckpointAgain.status, "already-applied");
  assert.deepStrictEqual(fs.readFileSync(serverPath), migratedCheckpointBytes);

  fs.writeFileSync(
    clientPath,
    [
      "# fixture",
      runtimePatch.PATCHED_STATA_BREAK_REQUEST,
      ...graphNameBoundary.BLOCKS.map(block => block.original),
      streamStateFixture,
      graphTaskDrain.ORIGINAL_POLL,
      graphTaskDrain.ORIGINAL_EXIT,
      runtimePatch.PATCHED_STREAM_HELPER_V18,
      runtimePatch.PATCHED_STREAM_NOTIFY,
      runtimePatch.PATCHED_FINAL_STREAM_NOTIFY,
      streamTailFixture,
      originalInventoryMethods,
      graphCacheFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  const migratedV18 = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedV18.ok, true);
  assert.strictEqual(migratedV18.status, "applied");
  assert.strictEqual(migratedV18.serverStatus, "already-applied");
  assert.strictEqual(migratedV18.clientStatus, "applied");
  const migratedV18Bytes = fs.readFileSync(clientPath);
  const migratedV18Text = migratedV18Bytes.toString("utf8");
  assert.ok(migratedV18Text.includes(runtimePatch.STREAM_PATCH_MARKER));
  assert.ok(!migratedV18Text.includes(runtimePatch.STREAM_PATCH_MARKER_V18));
  const migratedV18Again = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedV18Again.status, "already-applied");
  assert.deepStrictEqual(fs.readFileSync(clientPath), migratedV18Bytes);

  fs.writeFileSync(
    clientPath,
    [
      "# fixture",
      runtimePatch.PATCHED_STATA_BREAK_REQUEST,
      ...graphNameBoundary.BLOCKS.map(block => block.original),
      streamStateFixture,
      graphTaskDrain.ORIGINAL_POLL,
      graphTaskDrain.ORIGINAL_EXIT,
      runtimePatch.PATCHED_STREAM_HELPER_V17,
      runtimePatch.PATCHED_STREAM_NOTIFY,
      runtimePatch.PATCHED_FINAL_STREAM_NOTIFY,
      streamTailFixture,
      originalInventoryMethods,
      graphCacheFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  const migrated = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migrated.ok, true);
  assert.strictEqual(migrated.status, "applied");
  assert.strictEqual(migrated.serverStatus, "already-applied");
  assert.strictEqual(migrated.clientStatus, "applied");
  const migratedClientBytes = fs.readFileSync(clientPath);
  const migratedClientText = migratedClientBytes.toString("utf8");
  assert.ok(migratedClientText.includes(runtimePatch.STREAM_PATCH_MARKER));
  assert.ok(!migratedClientText.includes(runtimePatch.STREAM_PATCH_MARKER_V17));
  const migratedAgain = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedAgain.status, "already-applied");
  assert.deepStrictEqual(fs.readFileSync(clientPath), migratedClientBytes);

  fs.writeFileSync(
    clientPath,
    [
      "# fixture",
      runtimePatch.PATCHED_STATA_BREAK_REQUEST,
      ...graphNameBoundary.BLOCKS.map(block => block.original),
      streamStateFixture,
      graphTaskDrain.ORIGINAL_POLL,
      graphTaskDrain.ORIGINAL_EXIT,
      runtimePatch.PATCHED_STREAM_HELPER_V19,
      runtimePatch.PATCHED_STREAM_NOTIFY,
      runtimePatch.PATCHED_FINAL_STREAM_NOTIFY,
      streamTailFixture,
      originalInventoryMethods,
      graphCacheFixture,
      "# end",
    ].join("\n"),
    "utf8"
  );
  const migratedV19 = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedV19.ok, true);
  assert.strictEqual(migratedV19.status, "applied");
  assert.strictEqual(migratedV19.clientStatus, "applied");
  const migratedV19Text = fs.readFileSync(clientPath, "utf8");
  assert.ok(migratedV19Text.includes(runtimePatch.STREAM_PATCH_MARKER));
  assert.ok(!migratedV19Text.includes(runtimePatch.STREAM_PATCH_MARKER_V19));
  assert.ok(migratedV19Text.includes(
    'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"'));
  const migratedV19Again = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(migratedV19Again.status, "already-applied");

  fs.writeFileSync(serverPath, "# incompatible upstream\n", "utf8");
  const refused = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.status, "unsupported-source");
  assert.strictEqual(fs.readFileSync(serverPath, "utf8"), "# incompatible upstream\n");

  fs.writeFileSync(serverPath, firstServerText, "utf8");
  fs.writeFileSync(sessionPath, "# incompatible session upstream\n", "utf8");
  const sessionRefused = runtimePatch.patchRuntime(patchOptions);
  assert.strictEqual(sessionRefused.ok, false);
  assert.strictEqual(sessionRefused.status, "unsupported-source");
  assert.strictEqual(sessionRefused.component, "session");
  assert.strictEqual(fs.readFileSync(sessionPath, "utf8"), "# incompatible session upstream\n");
  fs.writeFileSync(sessionPath, firstSessionText, "utf8");

  const command = path.join(root, "bin", "mcp-stata");
  assert.strictEqual(runtimePatch.runtimeRootFromCommand(command), root);
  const uvRoot = runtimePatch.runtimeRootFromUvCommand("uvx", {
    spawnSync: (commandName, args) => ({
      status: commandName === "uvx" && args.includes("mcp-stata==1.26.1") ? 0 : 1,
      stdout: `${root}\n`,
      stderr: "",
    }),
  });
  assert.strictEqual(uvRoot, root);
  const uvFirst = runtimePatch.candidateRuntimeRoots({
    uvCommand: "uvx",
    command,
    spawnSync: () => ({ status: 0, stdout: `${root}\n`, stderr: "" }),
  });
  assert.strictEqual(uvFirst[0], root);

  const precedenceHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stata-precedence-"));
  const configuredRoot = path.join(precedenceHome, "configured");
  const envRoot = path.join(precedenceHome, "env");
  const fixedRoot = path.join(
    precedenceHome,
    ".local",
    "share",
    "stata-workbench",
    "mcp-stata-1.26.1"
  );
  const uvRuntimeRoot = path.join(precedenceHome, "uv-cache");
  const ordered = runtimePatch.candidateRuntimeRoots({
    runtimeRoot: path.join(precedenceHome, "explicit"),
    command: path.join(configuredRoot, "bin", "mcp-stata"),
    env: { MCP_STATA_RUNTIME_ROOT: envRoot },
    homedir: precedenceHome,
    uvRuntimeRoot,
    uvCommand: "uvx",
    spawnSync: () => ({
      status: 0,
      stdout: `${path.join(precedenceHome, "uv-discovered")}\n`,
      stderr: "",
    }),
  });
  assert.deepStrictEqual(ordered, [path.join(precedenceHome, "explicit")]);
  const defaultRoots = runtimePatch.candidateRuntimeRoots({
    env: {}, homedir: precedenceHome, uvRuntimeRoot,
    command: "/opt/homebrew/bin/uvx", uvCommand: "uvx",
    spawnSync: () => ({ status: 0, stdout: `${path.join(precedenceHome, "uv-discovered")}\n` }),
  });
  assert.deepStrictEqual(defaultRoots, [fixedRoot,
    path.join(precedenceHome, "AppData", "Local", "stata-workbench", "mcp-stata-1.26.1"),
    uvRuntimeRoot, path.join(precedenceHome, "uv-discovered")]);

  const realPython = process.execPath;
  const validCompile = runtimePatch.compilePythonSources(root, [
    { path: "valid.py", source: "value = 1\n" },
  ], { pythonCommand: realPython });
  assert.strictEqual(validCompile.ok, false);
  assert.strictEqual(validCompile.status, "python-compile-failed");

  const hostPython = [process.env.PYTHON, "python3", "python"]
    .filter(Boolean)
    .find((candidate) => {
      const probe = childProcess.spawnSync(candidate, ["-I", "-c", "compile('x = 1', 'probe.py', 'exec')"]);
      return probe && probe.status === 0;
    });
  assert.ok(hostPython, "a host Python interpreter is required for syntax-gate tests");
  // Reproduce the deployed partial upgrade using its complete real method.
  // Running isolated drain fragments with hand-written local variables missed
  // the NameError when the notification marker caused initialization to skip.
  {
  const legacyStream = fs.readFileSync(path.join(__dirname,
    "../tests/fixtures/stata_stream_smcl.legacy.py"), "utf8");
  assert.equal(require("crypto").createHash("sha256").update(legacyStream).digest("hex"),
    "e79638d2616a56873b3f07aee17b60159e7d50fd1ea047a2d2b7d8f1b07c0db5",
    "deployed legacy method fixture must retain its original bytes");
  const streamFragments = [runtimePatch.PATCHED_STREAM_HELPER,
    runtimePatch.PATCHED_STREAM_NOTIFY, runtimePatch.PATCHED_FINAL_STREAM_NOTIFY,
    runtimePatch.PATCHED_STREAM_TAIL_SIGNATURE, runtimePatch.PATCHED_POST_DONE_DRAIN].join("\n");
  assert.equal(firstClientRawText.split(streamFragments).length - 1, 1);
  const deployedComposition = firstClientRawText.replace(streamFragments, () => legacyStream);
  fs.writeFileSync(serverPath, firstServerText);
  fs.writeFileSync(graphDetectorPath, firstGraphDetectorText);
  fs.writeFileSync(sessionPath, firstSessionText);
  fs.writeFileSync(clientPath, deployedComposition);
  const migrated = runtimePatch.patchRuntime(patchOptions);
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  assert.equal(migrated.clientStatus, "applied");
  const composed = fs.readFileSync(clientPath, "utf8");
  assert.equal(runtimePatch.patchRuntime(patchOptions).status, "already-applied");
  const methodStart = "    async def _stream_smcl_log(";
  const methodEnd = "            logger.warning(f\"Log streaming failed: {e}\")";
  const method = text => text.slice(text.indexOf(methodStart), text.indexOf(methodEnd) + methodEnd.length) + "\n";
  const composedBehavior = childProcess.spawnSync(hostPython,
    ["-I", "-B", path.join(__dirname, "test_stata_stream_composition.py")],
    { input: JSON.stringify({ legacy: method(legacyStream), candidate: method(composed) }),
      encoding: "utf8", timeout: 10000 });
  assert.equal(composedBehavior.status, 0, composedBehavior.stderr || composedBehavior.stdout);
  // Unknown edits and duplicate helpers must be rejected before any write.
  for (const bad of [deployedComposition.replace("has_written = False", "has_written = None"),
    deployedComposition + runtimePatch.LEGACY_STREAM_HELPER_WITHOUT_TAIL]) {
    fs.writeFileSync(clientPath, bad);
    const rejected = runtimePatch.patchRuntime(patchOptions);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.anchor, "completion-tail-helper");
    assert.equal(fs.readFileSync(clientPath, "utf8"), bad);
  }
  fs.writeFileSync(clientPath, firstClientRawText);
  }
  const breakBehaviorSource = `
import logging
import sys
import types

calls = []
def set_break():
    calls.append("break")

pystata = types.ModuleType("pystata")
pystata.config = types.SimpleNamespace(
    stlib=types.SimpleNamespace(StataSO_SetBreak=set_break)
)
sys.modules["pystata"] = pystata
logger = logging.getLogger("test")

class Client:
${runtimePatch.PATCHED_STATA_BREAK_REQUEST}

client = Client()
client._break_requested = False
client._request_break_in()
assert client._break_requested is True
client._request_break_in_fast()
assert calls == ["break", "break"], calls
`;
  const breakBehavior = childProcess.spawnSync(
    hostPython,
    ["-I", "-c", breakBehaviorSource],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.strictEqual(
    breakBehavior.status,
    0,
    `supported Stata break behavior failed: ${breakBehavior.stderr || breakBehavior.stdout}`
  );
  const drainBody = runtimePatch.PATCHED_POST_DONE_DRAIN
    .split("\n")
    .map((line) => line.startsWith("        ") ? line.slice(8) : line)
    .join("\n");
  const behaviorSource = `
import asyncio
import re

class Clock:
    value = 0.0

class FakeTime:
    @staticmethod
    def monotonic():
        return Clock.value

class FakeThread:
    @staticmethod
    async def run_sync(fn):
        return fn()

class FakeAnyio:
    to_thread = FakeThread()

    @staticmethod
    async def sleep(seconds):
        Clock.value += seconds

class Cleaner:
    def _clean_internal_smcl(self, chunk, **_kwargs):
        return chunk

time = FakeTime()
anyio = FakeAnyio()

async def exercise(chunks, required_tail_marker, pre_done_chunks=None):
    self = Cleaner()
    last_pos = 0
    has_written = False
    on_chunk = None
    tee = []
    calls = 0
    tail_marker_buffer = ""
    saw_required_tail = required_tail_marker is None
    tail_marker_line = (
        re.compile(
            r"(?:^|\\n)(?:\\{(?:res|txt)\\})*"
            + re.escape(required_tail_marker)
            + r"\\s*(?:\\n|$)"
        )
        if required_tail_marker
        else None
    )

    def _read_content():
        nonlocal calls
        calls += 1
        if chunks:
            value = chunks.pop(0)
            return value, len(value.encode("utf-8"))
        return "", 0

    async def _write_and_notify(cleaned_chunk, _label):
        nonlocal tail_marker_buffer, saw_required_tail
        tee.append(cleaned_chunk)
        if tail_marker_line and not saw_required_tail:
            tail_marker_buffer = (tail_marker_buffer + "\\n" + cleaned_chunk)[-8192:]
            if tail_marker_line.search(tail_marker_buffer):
                saw_required_tail = True

    for pre_done_chunk in pre_done_chunks or []:
        await _write_and_notify(pre_done_chunk, "notify_log")

${drainBody}
    return saw_required_tail, "".join(tee), calls, Clock.value

async def main():
    marker = "___CODEX_RUN_DONE_run_behavior___"
    echo = '. display as text "' + marker + '"\\n'
    result = "{res}{txt}" + marker + "\\n"

    Clock.value = 0.0
    verified = await exercise([echo, "", "business-tail\\n", result], marker)
    assert verified[0] is True, verified
    assert "business-tail" in verified[1], verified
    assert verified[2] >= 5, verified
    assert verified[3] < 5.0, verified

    Clock.value = 0.0
    already_seen = await exercise([], marker, [result])
    assert already_seen[0] is True, already_seen
    assert already_seen[2] == 1, already_seen
    assert already_seen[3] == 0.0, already_seen

    Clock.value = 0.0
    echo_only = await exercise([echo], marker)
    assert echo_only[0] is False, echo_only
    assert echo_only[2] >= 100, echo_only
    assert echo_only[3] >= 5.0, echo_only

    Clock.value = 0.0
    absent = await exercise(["business-tail-without-marker\\n"], marker)
    assert absent[0] is False, absent
    assert absent[3] >= 5.0, absent

asyncio.run(main())
`;
  const behavior = childProcess.spawnSync(
    hostPython,
    ["-I", "-c", behaviorSource],
    { encoding: "utf8", timeout: 15000 }
  );
  assert.strictEqual(
    behavior.status,
    0,
    `patched post-done drain behavior failed: ${behavior.stderr || behavior.stdout}`
  );
  const realValidCompile = runtimePatch.compilePythonSources(root, [
    { path: "valid.py", source: "value = 1\n" },
  ], { pythonCommand: hostPython });
  assert.strictEqual(realValidCompile.ok, true);
  const invalidCompile = runtimePatch.compilePythonSources(root, [
    { path: "invalid.py", source: "value = \"\n" },
  ], { pythonCommand: hostPython });
  assert.strictEqual(invalidCompile.ok, false);
  assert.strictEqual(invalidCompile.status, "python-compile-failed");
  assert.ok(invalidCompile.stderr.includes("SyntaxError"));

  fs.writeFileSync(serverPath, firstServerText, "utf8");
  fs.writeFileSync(clientPath, firstClientText.replace(
    runtimePatch.STREAM_PATCH_MARKER,
    runtimePatch.STREAM_PATCH_MARKER_V19
  ).replace(
    'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"',
    'notice = "\n[Stata Workbench: further progress available in log_path]\n"'
  ), "utf8");
  fs.writeFileSync(graphDetectorPath, firstGraphDetectorText, "utf8");
  fs.writeFileSync(sessionPath, firstSessionText, "utf8");
  const corruptBefore = [serverPath, clientPath, graphDetectorPath, sessionPath].map(
    (file) => fs.readFileSync(file)
  );
  let rejectedCandidateHadFixedNotice = false;
  const syntaxRefused = runtimePatch.patchRuntime({
    runtimeRoot: root,
    pythonCommand: process.execPath,
    compileSpawnSync(commandName, args, options) {
      const sources = JSON.parse(options.input);
      const client = sources.find((entry) => entry.path === clientPath);
      rejectedCandidateHadFixedNotice = Boolean(client && client.source.includes(
        'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"'
      ));
      return {
        status: 1,
        stdout: "",
        stderr: "SyntaxError: injected candidate compilation failure",
      };
    },
  });
  assert.strictEqual(syntaxRefused.ok, false);
  assert.strictEqual(syntaxRefused.status, "pre-write-compile-failed");
  assert.strictEqual(syntaxRefused.compile.status, "python-compile-failed");
  assert.strictEqual(rejectedCandidateHadFixedNotice, true);
  [serverPath, clientPath, graphDetectorPath, sessionPath].forEach((file, index) => {
    assert.deepStrictEqual(fs.readFileSync(file), corruptBefore[index]);
  });

  fs.writeFileSync(serverPath, firstServerText, "utf8");
  fs.writeFileSync(
    clientPath,
    firstClientText
      .replace(runtimePatch.STREAM_PATCH_MARKER, runtimePatch.STREAM_PATCH_MARKER_V19)
      .replace(
        'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"',
        'notice = "\n[Stata Workbench: further progress available in log_path]\n"'
      ),
    "utf8"
  );
  fs.writeFileSync(
    graphDetectorPath,
    [
      "# fixture",
      "class GraphCreationDetector:",
      originalDetectorMethods,
      graphCallbacks.ORIGINAL,
      graphTaskDrain.ORIGINAL_DETECTOR + cacheFixture.scaffold.cacheTail.source,
      "# end",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(sessionPath, sessionOriginal.replace(runtimePatch.PATCHED_SESSION_CALL, runtimePatch.ORIGINAL_SESSION_CALL), "utf8");
  const transactionBefore = [serverPath, clientPath, graphDetectorPath, sessionPath].map(
    (file) => fs.readFileSync(file)
  );
  let writeCalls = 0;
  const rolledBack = runtimePatch.patchRuntime({
    runtimeRoot: root,
    pythonCommand: process.execPath,
    compileSpawnSync,
    atomicWrite(file, content) {
      writeCalls += 1;
      if (writeCalls === 1) {
        runtimePatch.atomicWrite(file, content);
        return;
      }
      if (writeCalls === 2) throw new Error("injected second write failure");
      runtimePatch.atomicWrite(file, content);
    },
  });
  assert.strictEqual(rolledBack.ok, false);
  assert.strictEqual(rolledBack.status, "write-transaction-rolled-back");
  assert.strictEqual(rolledBack.rollbackOk, true);
  assert.ok(writeCalls >= 6, "rollback must rewrite all four original files");
  [serverPath, clientPath, graphDetectorPath, sessionPath].forEach((file, index) => {
    assert.deepStrictEqual(fs.readFileSync(file), transactionBefore[index]);
  });

  function writePatchedRuntime(runtimeRoot) {
    const runtimePackage = path.join(
      runtimeRoot,
      "lib",
      "python3.12",
      "site-packages",
      "mcp_stata"
    );
    fs.mkdirSync(runtimePackage, { recursive: true });
    fs.writeFileSync(path.join(runtimePackage, "server.py"), firstServerText, "utf8");
    fs.writeFileSync(path.join(runtimePackage, "stata_client.py"), firstClientText, "utf8");
    fs.writeFileSync(
      path.join(runtimePackage, "graph_detector.py"),
      firstGraphDetectorText,
      "utf8"
    );
    fs.writeFileSync(
      path.join(runtimePackage, "sessions.py"),
      firstSessionText,
      "utf8"
    );
  }
  writePatchedRuntime(fixedRoot);
  writePatchedRuntime(uvRuntimeRoot);
  const selected = runtimePatch.patchRuntime({
    homedir: precedenceHome,
    env: {},
    uvRuntimeRoot,
    pythonCommand: process.execPath,
    compileSpawnSync,
  });
  assert.strictEqual(selected.ok, true);
  assert.strictEqual(selected.root, path.resolve(fixedRoot));
  assert.notStrictEqual(selected.root, path.resolve(uvRuntimeRoot));
  {
    // Real interpreter, non-ASCII source: Windows text stdin decodes with the ANSI code
    // page (10-29: cp936 -> '\udc94' surrogate -> pre-write-compile-failed).
    const realPython = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const compiled = runtimePatch.compilePythonSources(root, [
      { path: "unicode_fixture.py", source: 'label = "合成样本 — O\'Brien"\nassert label\n' },
    ], { pythonCommand: realPython });
    assert.strictEqual(compiled.ok, true, JSON.stringify(compiled));
  }
  console.log("MCP_STATA_RUNTIME_PATCH_RC7_PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
