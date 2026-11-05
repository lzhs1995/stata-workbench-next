#!/usr/bin/env node
"use strict";
// rc.7.88 (V3-W2 D5): /status gets a read-only `watchdogCpu` field. Offline: checks the
// sealed dist, exact revert/replay, idempotence, anchor failure, and evaluates the
// injected expression against the real execution_guard with fake globals.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const patch = require("./apply_watchdog_cpu_status_patch");
const G = require("./execution_guard");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const dist = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
ok(dist.includes(patch.MARKER), "dist carries the rc.7.88 marker");
for (const [, after] of patch.EDITS) ok(dist.split(after).length === 2, "edit present exactly once");
const reverted = patch.revertBundle(dist);
ok(!reverted.includes("watchdogCpu:") && patch.patchBundle(reverted) === dist, "revert/replay byte-exact");
ok(patch.patchBundle(dist) === dist, "patch is idempotent");
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[0][0], "X")), /anchor/); checks++;
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[0][0], patch.EDITS[0][0] + "watchdogCpu:1,")), /partial/); checks++;

// The injected object-literal entry, evaluated as the /status literal would.
const after = patch.EDITS[0][1];
const expr = after.slice(after.indexOf("watchdogCpu:") + "watchdogCpu:".length, -1);
const evalWith = (globals) => vm.runInNewContext("(" + expr + ")", { globalThis: globals });
const summary = { runId: "run_1", sourceMode: "terminal-input", cause: "PROGRESS_STALL", stallReason: "IDLE",
  cpuSamples: 7, cpuSampleErrors: 2, cpuProgressCount: 3, cpuSamplesExpired: 0, cpuProbeVersion: "rc.7.88-v3",
  cpuErrorKinds: { "ps:timeout": 2 }, lastCpuProgressAt: "2026-11-05T00:00:00.000Z", logPath: "/secret/path.log" };
let v = evalWith({ __codexExecGuardRef: G, __codexLastTerminalGuard: summary, __codexWorkerCpuProbe: () => null });
ok(v && v.probeInstalled === true && v.live === null && v.lastAgent === null, "status: probe installed, nothing running, no agent run");
ok(v.lastTerminal.cpuSampleErrors === 2 && v.lastTerminal.cpuErrorKinds["ps:timeout"] === 2 && v.lastTerminal.cpuProbeVersion === "rc.7.88-v3",
   "status: last Terminal guard CPU counters and error kinds");
ok(JSON.stringify(v).indexOf("/") < 0 && !("logPath" in v.lastTerminal), "status: no paths copied");
v = evalWith({});
ok(v === null, "status: no guard module -> null, never throws");
v = evalWith({ __codexExecGuardRef: { cpuStatus: () => { throw new Error("x"); } } });
ok(v && v.error === "watchdogCpu unavailable", "status: a throwing cpuStatus is contained");
v = evalWith({ __codexExecGuardRef: G });
ok(v && v.probeInstalled === false, "status: probe missing is reported, not hidden");
console.log("WATCHDOG_CPU_STATUS_PATCH_OK checks=" + checks);
