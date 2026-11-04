#!/usr/bin/env node
"use strict";
// rc.7.89: offline checks of the orphan-worker reap bundle edit (sealed dist, exact
// revert/replay, idempotence, anchor refusal, wiring order, platform guard).
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const patch = require("./apply_orphan_worker_reap_patch");
const { revertAfter } = require("./later_bundle_patches");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const sealed = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
ok(sealed.includes(patch.MARKER), "dist carries the rc.7.89 marker");
const dist = revertAfter(sealed, "./apply_orphan_worker_reap_patch");
for (const [, after] of patch.EDITS) ok(dist.split(after).length === 2, "each edit present exactly once");
const reverted = patch.revertBundle(dist);
ok(!reverted.includes("__codexOrphanCaptureP") && !reverted.includes("orphan_worker_core") && patch.patchBundle(reverted) === dist,
   "revert/replay byte-exact");
ok(patch.patchBundle(dist) === dist, "patch is idempotent");
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[1][0], "X")), /anchor/); checks++;
assert.throws(() => patch.patchBundle(reverted.replace(patch.EDITS[0][0], patch.EDITS[0][0] + "__codexOrphanCaptureP")), /partial/); checks++;

// Wiring inside __codexForceReset: capture before the cancel/dispose, reap after dispose
// and before the reconnect, state annotated, /status field present.
const fr = dist.indexOf("globalThis.__codexForceReset=async o=>{");
const cap = dist.indexOf("globalThis.__codexOrphanCaptureP=null;", fr);
const disp = dist.indexOf("/* codex patch rc.7.82: force reset records what dispose actually did */", fr);
const reap = dist.indexOf("/* codex patch rc.7.89: end recorded orphan workers after dispose */", fr);
const rq = dist.indexOf('try{RI("[Codex bridge] force reset requested: "', fr);
ok(fr > 0 && cap > fr && rq > cap && disp > rq && reap > disp, "order: capture < force-reset log < dispose < reap");
ok(/globalThis\.__codexOrphanCaptureP=null;if\(process\.platform!=="win32"\)/.test(dist), "capture is skipped on Windows (rc.7.82 ends the tree)");
ok(dist.includes("orphanWorkers:globalThis.__codexOrphanReap||null,"), "/status shows orphanWorkers");
ok(dist.includes(".startCapture(globalThis.__codexOwnedBackendPids)") && dist.includes(".finishReap(__cp,__d,"), "bundle calls the core entry points");
const core = require("./orphan_worker_core");
ok(/r\(null\), 5000\)/.test(core.startCapture.toString()) && /"reap-timeout"[^]*12000/.test(core.finishReap.toString()), "capture bounded at 5 s, reap at 12 s (core)");
ok(fs.existsSync(path.join(__dirname, "orphan_worker_core.js")), "core module shipped next to the bundle");
console.log("ORPHAN_WORKER_REAP_PATCH_OK checks=" + checks);
