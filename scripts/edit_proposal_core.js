"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeName(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "session";
}

function validateRequest(input) {
  const request = input && typeof input === "object" ? input : {};
  const filePath = path.resolve(String(request.path || ""));
  const content = String(request.content == null ? "" : request.content);
  const expectedSha256 = String(request.expectedSha256 || request.beforeSha256 || "").toLowerCase();
  if (!filePath || filePath === path.parse(filePath).root) throw new Error("path is required");
  if (!/\.(do|ado|mata)$/i.test(filePath)) throw new Error("only .do, .ado, and .mata files may be proposed");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("expectedSha256 must be a 64-character SHA-256");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new Error("proposed content exceeds 2 MiB");
  return {
    path: filePath,
    content,
    expectedSha256,
    agentName: String(request.agentName || request.agent || "agent").slice(0, 120),
    reason: String(request.reason || "").slice(0, 1000),
    timeoutMs: Math.max(1000, Math.min(900000, Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS)),
  };
}

function createEditGate(options = {}) {
  const snapshotRoot = path.resolve(options.snapshotRoot || path.join(os.homedir(), ".stata-workbench-next", "edit-snapshots"));
  const eventLogPath = options.eventLogPath ? path.resolve(options.eventLogPath) : null;
  const now = options.now || (() => new Date());
  const pending = new Map();
  let sequence = 0;

  function snapshotPath(request, beforeSha) {
    const stamp = now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return path.join(snapshotRoot, `${stamp}-${safeName(path.basename(request.path))}-${beforeSha.slice(0, 12)}.snapshot`);
  }

  function event(type, fields) {
    const record = { type, at: now().toISOString(), ...fields };
    if (eventLogPath) {
      fs.mkdirSync(path.dirname(eventLogPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(eventLogPath, JSON.stringify(record) + "\n", { mode: 0o600 });
    }
    if (typeof options.onEvent === "function") options.onEvent(record);
    return record;
  }

  async function propose(rawRequest, decide) {
    const request = validateRequest(rawRequest);
    if (!fs.existsSync(request.path)) {
      const result = { status: "rejected", reasonCode: "FILE_NOT_FOUND", path: request.path };
      event("edit_proposal_rejected", result);
      return result;
    }
    const before = fs.readFileSync(request.path);
    const beforeSha256 = sha256(before);
    if (beforeSha256 !== request.expectedSha256) {
      const result = { status: "rejected", reasonCode: "SHA_MISMATCH", path: request.path, expectedSha256: request.expectedSha256, actualSha256: beforeSha256, agentName: request.agentName };
      event("edit_proposal_rejected", result);
      return result;
    }
    const id = `edit_${Date.now()}_${++sequence}`;
    const record = Object.freeze({
      id, path: request.path, beforeSha256, proposedSha256: sha256(Buffer.from(request.content, "utf8")),
      agentName: request.agentName, reason: request.reason, createdAt: now().toISOString(), status: "pending",
    });
    pending.set(id, record);
    event("edit_proposal_pending", record);
    let decision;
    try {
      decision = await Promise.race([
        Promise.resolve().then(() => decide(record, request.content)),
        new Promise(resolve => setTimeout(() => resolve({ status: "timeout", reasonCode: "DECISION_TIMEOUT" }), request.timeoutMs)),
      ]);
    } catch (error) {
      const result = { ...record, status: "rejected", reasonCode: "REVIEW_ERROR", error: String(error?.message || error) };
      event("edit_proposal_rejected", result);
      return result;
    } finally {
      pending.delete(id);
    }
    const status = String(decision && decision.status || "rejected").toLowerCase();
    if (status !== "accepted") {
      const result = { ...record, status: status === "timeout" ? "timeout" : "rejected", reasonCode: decision?.reasonCode || (status === "timeout" ? "DECISION_TIMEOUT" : "USER_REJECTED") };
      event(status === "timeout" ? "edit_proposal_timeout" : "edit_proposal_rejected", result);
      return result;
    }
    const current = fs.readFileSync(request.path);
    const currentSha256 = sha256(current);
    if (currentSha256 !== beforeSha256) {
      const result = { ...record, status: "rejected", reasonCode: "SHA_CHANGED_DURING_REVIEW", actualSha256: currentSha256 };
      event("edit_proposal_rejected", result);
      return result;
    }
    fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    const savedSnapshot = snapshotPath(request, beforeSha256);
    fs.writeFileSync(savedSnapshot, current, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(request.path, request.content, { mode: 0o600 });
    const result = { ...record, status: "accepted", snapshotPath: savedSnapshot, acceptedAt: now().toISOString(), finalSha256: sha256(Buffer.from(request.content, "utf8")) };
    event("edit_proposal_accepted", result);
    return result;
  }

  return { propose, pending: () => Array.from(pending.values()), validateRequest, sha256 };
}

module.exports = { createEditGate, validateRequest, sha256, MAX_CONTENT_BYTES, DEFAULT_TIMEOUT_MS };
