"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const DEFAULT_ROOT = path.join(os.homedir(), ".stata-workbench-next", "sessions");

function validatePart(value, name) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(name + " is invalid");
  return text;
}

function tokenHex(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32);
  if (!Buffer.isBuffer(token) || token.length !== 32) throw new Error("token generator must return 32 bytes");
  return token.toString("hex");
}

function atomicWrite(file, value, fsApi = fs) {
  const dir = path.dirname(file);
  fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + crypto.randomBytes(8).toString("hex") + ".tmp");
  const fd = fsApi.openSync(temp, "wx", 0o600);
  try {
    fsApi.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsApi.fsyncSync(fd);
  } finally {
    fsApi.closeSync(fd);
  }
  try { fsApi.chmodSync(temp, 0o600); } catch {}
  fsApi.renameSync(temp, file);
  if (process.platform === "win32") {
    try {
      require("node:child_process").spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME || process.env.USER || "%USERNAME%"}:R,W`], { stdio: "ignore" });
    } catch {}
  }
}

function createSession({ sessionId, sessionName, port, extensionHostPid, bundleSha, root = DEFAULT_ROOT, now = () => new Date().toISOString(), randomBytes } = {}) {
  const id = validatePart(sessionId || crypto.randomUUID(), "sessionId");
  const record = {
    sessionId: id,
    sessionName: validatePart(sessionName || "stata-workbench-next", "sessionName"),
    port: Number(port),
    token: tokenHex(randomBytes),
    extensionHostPid: Number(extensionHostPid || process.pid),
    startedAt: now(),
    bundleSha: String(bundleSha || ""),
  };
  if (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535) throw new Error("port is invalid");
  if (!Number.isInteger(record.extensionHostPid) || record.extensionHostPid <= 0) throw new Error("extensionHostPid is invalid");
  if (!/^[0-9a-f]{64}$/i.test(record.bundleSha)) throw new Error("bundleSha must be SHA-256");
  const file = path.join(root, id + ".json");
  atomicWrite(file, record);
  return { ...record, file, eventLog: path.join(root, id + ".events.jsonl") };
}

function recordRejection(session, details, append = fs.appendFileSync) {
  const line = JSON.stringify({ at: new Date().toISOString(), type: "bridge_rejected", ...details }) + "\n";
  append(session.eventLog, line, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(session.eventLog, 0o600); } catch {}
}

module.exports = { DEFAULT_ROOT, tokenHex, atomicWrite, createSession, recordRejection };
