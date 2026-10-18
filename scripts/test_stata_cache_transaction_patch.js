#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const patch = require("./stata_cache_transaction_patch");
const errors = require("./stata_detector_error_patch");
const state = require("./stata_detector_state_patch");
const sreturn = require("./stata_detector_sreturn_patch");
const drain = require("./stata_graph_task_drain_patch");
const callbacks = require("./stata_graph_callback_patch");
const inventory = require("./stata_graph_inventory_patch");
const fixture = require("../tests/fixtures/stata_cache_transaction.original.json");
const df = require("../tests/fixtures/stata_detector_errors.original.json");
const inv = require("../tests/fixtures/stata_graph_inventory.original.json");
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
for (const b of [...fixture.blocks, fixture.notification]) assert.equal(sha(b.original), b.sha256);
for (const b of Object.values(fixture.scaffold)) assert.equal(sha(b.source), b.sha256);
const lifecycle = fixture.blocks.find(b => b.name === "lifecycle").original;
const detectorBase = "class GraphCreationDetector:\n" + df.initialization + df.blocks.map(b => b.original +
  (b.name === "_get_graph_inventory" ? "    def _get_graph_timestamp(self, name):\n        return self._get_graph_timestamps([name]).get(name, '')\n\n" : "")).join("") +
  fixture.scaffold.shouldCache.source + lifecycle + fixture.scaffold.cacheHead.source;
const previous = sreturn.patchDetector(state.patchDetector(errors.patchDetector(detectorBase))) +
  callbacks.CANDIDATE + drain.DETECTOR + fixture.scaffold.cacheTail.source;
const candidate = patch.patchDetector(previous);
assert.equal(patch.patchDetector(candidate), candidate);
assert.equal(patch.patchDetector(patch.normalizeDetector(candidate)), candidate);
assert.equal(patch.normalizeDetector(previous), previous);
const original = "class Client:\n" + inv.blocks.map(b => b.original +
  (b.name === "list_graphs" ? "    def export_graph(self):\n        pass\n\n" :
    b.name === "_capture_graph_state" ? "    async def _cache_new_graphs(self):\n        pass\n\n" :
      "    @staticmethod\n    def _end():\n        pass\n\n")).join("") + fixture.notification.original +
  "    def _get_cached_graph_path(self):\n        pass\n";
const previousClient = inventory.patchClient(original);
const client = patch.patchClient(previousClient);
assert.equal(patch.patchClient(client), client);
for (const b of [...patch.BLOCKS, patch.LIFECYCLE_BLOCK]) {
  for (const source of [candidate.replace(b.replacement, b.replacement.replace(/\S/, "#tamper#")),
    candidate.replace(b.replacement, ""), candidate + b.replacement]) {
    assert.throws(() => patch.patchDetector(source), /cache transaction/);
    assert.throws(() => patch.normalizeDetector(source), /cache transaction/);
  }
}
for (const body of [fixture.notification.original, patch.NOTIFICATION_BLOCK.replacement]) {
  const input = previousClient.replace(fixture.notification.original, body);
  assert.throws(() => patch.patchClient(input.replace(body, body.replace(/\S/, "#tamper#"))), /cache transaction/);
  assert.throws(() => patch.patchClient(input + body), /cache transaction/);
}
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_cache_transaction.py")], {
  input: JSON.stringify({candidate, previous, client, previousClient}), encoding: "utf8", timeout: 60000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
