#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const patch = require("./stata_graph_task_drain_patch");
const response = require("./stata_response_rc_patch");
const fixture = require("../tests/fixtures/stata_graph_task_drain.original.json");

assert.equal(fixture.clientPoll, patch.ORIGINAL_POLL);
assert.equal(fixture.detectorMethods, patch.ORIGINAL_DETECTOR);
const client = patch.patchClient(fixture.run_command_streaming);
const detector = patch.patchDetector(fixture.detectorMethods);
assert.equal(patch.patchClient(client), client);
assert.equal(patch.patchDetector(detector), detector);
for (const source of [fixture.run_command_streaming.repeat(2),
  fixture.run_command_streaming.replace(patch.ORIGINAL_POLL, ""),
  client.replace("tg.start_soon(owned_graph_check)", "asyncio.create_task(owned_graph_check())"),
  client.replace("graph_poll_errors.append(exc_group)", "pass")]) {
  assert.throws(() => patch.patchClient(source));
}
for (const source of [fixture.detectorMethods.repeat(2),
  detector.replace("asyncio.wait({worker})", "worker"),
  detector.replace("await anyio.lowlevel.checkpoint()", "pass")]) {
  assert.throws(() => patch.patchDetector(source));
}
// The shared exception tail in do-file execution must remain untouched.
const other = "    async def other(self):\n" + patch.ORIGINAL_EXIT.split(
  "        # Re-run startup .do files when programs have been dropped.")[0] + "        pass\n";
assert.equal(patch.patchClient(fixture.run_command_streaming + other), client + other);
const block = response.BLOCKS.find(item => item.name === "run_command_streaming");
const start = client.indexOf(block.start), end = client.indexOf(block.success);
assert.ok(start > 0 && end > start);
const integrated = client.slice(0, start) + response.replacement(block) + client.slice(end);
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
const result = cp.spawnSync(python, ["-B", path.join(__dirname, "test_stata_graph_task_drain.py")], {
  input: JSON.stringify({originalClient: fixture.run_command_streaming, client: integrated,
    originalDetector: fixture.detectorMethods, detector}),
  encoding: "utf8", timeout: 30000,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const report = JSON.parse(result.stdout);
assert.equal(report.verdict, "PASS");
assert.equal(report.nativeVerified, false);
console.log(JSON.stringify(report));
