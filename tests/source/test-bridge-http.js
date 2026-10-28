"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createExecutionLifecycle } = require("../../src/shared-session/execution-lifecycle");
const { createBridgeHttp } = require("../../src/shared-session/bridge-http");

function request(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method,
      headers: payload ? { "content-type": "application/json" } : {} }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (payload) req.end(JSON.stringify(payload)); else req.end();
  });
}

(async () => {
  const lifecycle = createExecutionLifecycle({ now: () => 1700000000000 });
  const bridge = createBridgeHttp({ lifecycle, runCommand: async payload => ({ rc: 0, success: true, logPath: `${payload.runId}.log` }) });
  const bound = await bridge.start();
  assert.equal(bound.bound, true);
  const status = await request(bound.port, "GET", "/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.lifecycle, null);
  const run = await request(bound.port, "POST", "/run-command", { runId: "bridge-run-1", code: "display 1" });
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, true);
  assert.equal(run.body.lifecycle.phase, "completed");
  const invalid = await request(bound.port, "POST", "/run-command", { code: "   " });
  assert.equal(invalid.status, 400);
  const missing = await request(bound.port, "GET", "/missing");
  assert.equal(missing.status, 404);
  await bridge.close();
  console.log(JSON.stringify({ verdict: "PASS_SOURCE_BRIDGE_HTTP", port: bound.port }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
