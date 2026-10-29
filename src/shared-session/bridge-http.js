"use strict";

const http = require("node:http");

const MAX_BODY_BYTES = 1024 * 1024;

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", body.length);
  res.end(body);
}

function createBridgeHttp({ lifecycle, runCommand, host = "127.0.0.1", port = 0 } = {}) {
  if (!lifecycle || typeof lifecycle.status !== "function" || typeof lifecycle.busy !== "function") {
    throw new TypeError("bridge HTTP requires an execution lifecycle");
  }
  const state = { host, port: Number(port), bound: false, boundAt: null, lastError: null };
  let server = null;

  function status() {
    const address = server?.address?.();
    return {
      bridgeVersion: "source-1",
      host: state.host,
      port: address && typeof address === "object" ? address.port : state.port,
      bound: state.bound,
      boundAt: state.boundAt,
      lastError: state.lastError,
      lifecycle: lifecycle.status(),
    };
  }

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch (_) { throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 }); }
  }

  async function handle(req, res) {
    if (req.method === "GET" && req.url === "/status") return json(res, 200, status());
    if (req.method !== "POST" || req.url !== "/run-command") return json(res, 404, { ok: false, error: "not found" });
    if (typeof runCommand !== "function") return json(res, 503, { ok: false, error: "run dispatch unavailable" });
    let owned = null;
    try {
      const payload = await body(req);
      if (!payload || typeof payload.code !== "string" || !payload.code.trim()) {
        return json(res, 400, { ok: false, error: "code is required" });
      }
      const runId = String(payload.runId || `bridge-${Date.now()}`);
      // Queued editor/Terminal work is still ahead of this request on the serial backend.
      if (lifecycle.busy()) return json(res, 409, { ok: false, kind: "busy", runId: lifecycle.status()?.runId || null });
      lifecycle.begin({ runId, requestId: payload.requestId || runId, sourceMode: "bridge" });
      owned = runId;
      lifecycle.started(runId);
      const result = await runCommand({ ...payload, runId });
      // The response carries this request's own record, not the latest global one.
      const record = lifecycle.finish(runId, result);
      if (!result || typeof result !== "object") {
        return json(res, 502, { ok: false, kind: "unknown-result", runId, result: null, lifecycle: record });
      }
      return json(res, 200, { ok: result.success !== false && !record?.failure, runId, result, lifecycle: record });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      // A thrown dispatch leaves the owner held (unknown outcome); later requests get 409.
      const record = owned ? lifecycle.unknown(owned, error) : null;
      return json(res, statusCode, { ok: false, error: String(error?.message || error), runId: owned, lifecycle: record });
    }
  }

  function start(portOverride) {
    if (server) return Promise.resolve(status());
    if (portOverride != null) state.port = Number(portOverride);
    server = http.createServer((req, res) => {
      handle(req, res).catch(error => json(res, 500, { ok: false, error: String(error?.message || error) }));
    });
    return new Promise((resolve, reject) => {
      const onError = error => {
        state.lastError = String(error?.message || error);
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        state.bound = true;
        state.boundAt = new Date().toISOString();
        server.removeListener("error", onError);
        resolve(status());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(state.port, state.host);
    });
  }

  function close() {
    if (!server) return Promise.resolve();
    const current = server;
    server = null;
    state.bound = false;
    return new Promise(resolve => current.close(() => resolve()));
  }

  return { close, start, status };
}

module.exports = { MAX_BODY_BYTES, createBridgeHttp };
