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

  // Each case gets its own lifecycle: result state must match lifecycle state.
  async function once(runCommand, payloads) {
    const life = createExecutionLifecycle();
    const b = createBridgeHttp({ lifecycle: life, runCommand });
    const { port } = await b.start();
    try {
      const out = [];
      for (const payload of payloads) out.push(await request(port, "POST", "/run-command", payload));
      return { out, life };
    } finally { await b.close(); }
  }
  const failed = await once(async () => ({ success: false, rc: 198, stderr: "r(198)" }), [{ runId: "f1", code: "x" }]);
  assert.equal(failed.out[0].status, 200);
  assert.equal(failed.out[0].body.ok, false);
  assert.equal(failed.out[0].body.lifecycle.phase, "failed");
  const missingResult = await once(async () => undefined, [{ runId: "m1", code: "x" }, { runId: "m2", code: "y" }]);
  assert.equal(missingResult.out[0].status, 502);
  assert.equal(missingResult.out[0].body.kind, "unknown-result");
  assert.equal(missingResult.out[0].body.lifecycle.releasedAt, null);
  assert.equal(missingResult.out[1].status, 409, "unknown owner stays held");
  const thrown = await once(async () => { throw new Error("transport lost"); }, [{ runId: "t1", code: "x" }, { runId: "t2", code: "y" }]);
  assert.equal(thrown.out[0].status, 500);
  assert.equal(thrown.out[0].body.lifecycle.phase, "unknown");
  assert.equal(thrown.out[1].status, 409);
  // The received cwd reaches the dispatcher unchanged.
  let seen;
  await once(async payload => { seen = payload.cwd; return { success: true, rc: 0 }; },
    [{ runId: "c1", code: "x", cwd: "/tmp/中文 O'Brien" }]);
  assert.equal(seen, "/tmp/中文 O'Brien");
  // Queued editor work ahead of the request is visible to admission.
  const life = createExecutionLifecycle();
  const queuedBridge = createBridgeHttp({ lifecycle: life, runCommand: async () => ({ success: true, rc: 0 }) });
  const q = await queuedBridge.start();
  life.begin({ runId: "editor-1", sourceMode: "selection" });
  life.begin({ runId: "editor-2", sourceMode: "selection" });
  life.finish("editor-1", { rc: 0 });
  assert.equal(life.status().runId, "editor-2");
  const busy = await request(q.port, "POST", "/run-command", { runId: "late", code: "x" });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.runId, "editor-2");
  await queuedBridge.close();
  console.log(JSON.stringify({ verdict: "PASS_SOURCE_BRIDGE_HTTP", port: bound.port }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
