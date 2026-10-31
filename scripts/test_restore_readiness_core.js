"use strict";

const assert = require("node:assert/strict");
const { createRestoreReadiness } = require("./restore_readiness_core");

let tick = 100;
const gate = createRestoreReadiness({ now: () => tick++ });
assert.equal(gate.status().ready, true);
assert.equal(gate.begin("run-1").ready, false);
assert.equal(gate.status().status, "restoring");
assert.equal(gate.finish("other", { ok: true }).ready, false, "wrong run cannot finish restore");
assert.equal(gate.finish("run-1", { ok: true }).ready, true);
assert.equal(gate.status().status, "ready");
gate.begin("run-2");
assert.equal(gate.finish("run-2", { ok: true, degraded: true }).ready, false, "degraded restore stays stale");
gate.begin("run-3");
assert.equal(gate.fail("run-3", "restore error").ready, false);
assert.match(gate.status().reason, /restore error/);
assert.equal(gate.reset("recovery-smoke-verified").ready, true);
assert.equal(gate.status().status, "ready");
console.log("PASS restore readiness core: begin, run binding, full/degraded completion, and failure");
