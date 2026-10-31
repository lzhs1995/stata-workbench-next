"use strict";
const crypto = require("node:crypto");

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  const width = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(width), bb = Buffer.alloc(width);
  a.copy(aa); b.copy(bb);
  const same = crypto.timingSafeEqual(aa, bb) && a.length === b.length;
  aa.fill(0); bb.fill(0);
  return same;
}

function authorize(headers, { token, port, onReject } = {}) {
  const origin = headers.origin || headers.Origin;
  const host = headers.host || headers.Host;
  const reject = (status, reason) => { if (onReject) onReject({ status, reason }); return { ok: false, status, reason }; };
  if (origin) return reject(403, "ORIGIN_FORBIDDEN");
  if (host !== `127.0.0.1:${port}`) return reject(403, "HOST_FORBIDDEN");
  const auth = headers.authorization || headers.Authorization || "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return reject(401, "TOKEN_REQUIRED");
  if (!constantTimeEqual(auth.slice(prefix.length), token)) return reject(401, "TOKEN_INVALID");
  return { ok: true, status: 200 };
}

module.exports = { constantTimeEqual, authorize };
