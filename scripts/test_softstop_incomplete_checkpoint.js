#!/usr/bin/env node
"use strict";

// 回归：FULL45 S40（Mac rc.7.44，2026-10-30）。Agent 运行 10 s 时 Stop，pre-run 检查点
// 正在保存 160 个 estimates、50 个图；Break 打断了存图循环，graphs.txt 停在半个名字上，
// restoreCode() 给出拒绝哨兵 "exit 459"。soft Stop 仍把它发给 Stata，嵌入式 Stata 对顶层
// exit 回 "--Break-- r(1)"，恢复失败、continuity-lost，而 payload 根本没派发。
// 本测试跑生产 bundle 里 soft Stop 的恢复分支（vm），假 Stata 客户端照 S40 日志回结果。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const core = require("./stop_checkpoint_core");
const guard = require("./execution_guard");
const patch = require("./apply_softstop_incomplete_checkpoint_patch");
const presencePatch = require("./apply_softstop_snapshot_presence_patch");
const fingerprint = require("./finalize_bundle_identity");
const { LATER } = require("./later_bundle_patches");

const productionBundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
// This test owns the previous layer; strip the P3 presence patch before
// checking rc.7.74's exact replay and legacy behavior.
const bundle = presencePatch.revertBundle(productionBundle);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-softstop-incomplete-"));

// 1. 幂等、精确可逆，锚点 fail closed。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(fingerprint.verify(bundle).ok, true);
const sealed = bundle;
const legacy = patch.revertBundle(sealed);
// 前一层取 LATER 里排在本补丁前面的那一项，别的 PR 在中间插层时不用改这里。
const previous = LATER[LATER.indexOf("./apply_softstop_incomplete_checkpoint_patch") - 1];
assert.ok(previous, "previous later patch is registered");
assert.equal(patch.patchBundle(legacy), sealed, "replay reproduces the sealed layer");
assert.throws(() => patch.patchBundle(legacy.replace(patch.ANCHORS.restore[0], "")), /anchor/);
assert.throws(() => patch.patchBundle(legacy + patch.ANCHORS.bridgeAdmit[0]), /anchor/);
assert.throws(() => patch.patchBundle(legacy + "__codexPayloadAdmittedAtStop"), /partial/);

// 2. 接线：两条有 pre-run 快照的路径都在注册时记 false、过最后一道 Stop 栅栏后记 true，
// 中间没有 await；soft Stop 在第一个 await 之前读这个标志。
for (const [mode, fenceRun] of [["visible-bridge", "__run"], ["human-file", "r"]]) {
  assert.equal(bundle.split(`sourceMode:"${mode}",at:null,provisional:true,atomicDispatchCount:0,fallbackDispatchCount:0,payloadAdmitted:false};`).length, 2, mode);
  const fence = `globalThis.__codexPreRunStopFence("enrich",${mode === "human-file" ? "__codexHfEnrichStage" : "__codexEnrichStage"},${fenceRun},"${mode}",`;
  const at = bundle.indexOf(fence);
  const admit = bundle.indexOf("payloadAdmitted:true});", at);
  assert.ok(at > 0 && admit > at && !/\bawait\b/.test(bundle.slice(at, admit)), mode + " admits right after its last fence");
}
const softAt = bundle.indexOf("globalThis.__codexSoftStop=async");
const soft = bundle.slice(softAt, bundle.indexOf("globalThis.__codexForceReset=async", softAt));
const entry = soft.indexOf("__codexPayloadAdmittedAtStop=__snapshot?__snapshot.payloadAdmitted:undefined");
assert.ok(entry > 0 && entry < soft.indexOf("await") && entry < soft.indexOf("globalThis.__codexResetGeneration=Number"),
  "flag is read before the generation advances and before any await");

// 3. 核心判定。
assert.deepEqual(core.restorePlan("use x\n", false), { dispatch: true });
assert.deepEqual(core.restorePlan("use x\n", true), { dispatch: true });
assert.equal(core.restorePlan(core.REFUSED_RESTORE_CODE, false).restore.ok, true);
assert.equal(core.restorePlan("", false).restore.ok, true);
for (const admitted of [true, undefined, null]) {
  const plan = core.restorePlan(core.REFUSED_RESTORE_CODE, admitted);
  assert.equal(plan.dispatch, false);
  assert.equal(plan.restore.ok, false, "payload may have run: never claim a restore");
}

// 4. S40 夹具：检查点目录与 S40 实物同形（graphs.txt 末行是半个名字，无对应 .gph）。
function fixture(name, { truncated }) {
  const snap = { path: path.join(tmp, name + ".dta"), checkpointNonce: "351b75fe00623bf0aec98d4850f1e2a3", bytes: 2470699, runId: "run_s40" };
  fs.writeFileSync(snap.path, Buffer.alloc(4096, 1));
  const st = core.initializeCheckpoint(snap, { checkpointNonce: snap.checkpointNonce });
  fs.writeFileSync(st.snapshotReadyPath, `ready\t${snap.checkpointNonce}\tdata\n`);
  fs.writeFileSync(st.globalsPath, "");
  fs.writeFileSync(st.estimatesPath, "t8_adv01\n");
  fs.writeFileSync(path.join(st.stateDir, "estimate_t8_adv01.ster"), "x");
  fs.writeFileSync(st.defaultGraphObjectPath, "1\n");
  fs.writeFileSync(st.currentGraphPath, "\n");
  fs.writeFileSync(path.join(st.stateDir, "graph_t8_mega_59.gph"), "x");
  fs.writeFileSync(st.graphsPath, truncated ? "t8_mega_59\nt8_mega_" : "t8_mega_59\n");
  return snap;
}
const s40 = fixture("s40", { truncated: true });
assert.equal(core.restoreCode(s40, null), core.REFUSED_RESTORE_CODE, "S40 checkpoint is refused");
const complete = fixture("complete", { truncated: false });
assert.match(core.restoreCode(complete, null), /^use "/m, "positive control: a complete checkpoint restores");

// 5. 跑 bundle 的恢复分支：从 restore 的 if 到 rc.7.35 降级阶梯 catch 之前。
// 修复版从 rc.7.74 的 plan 语句开始（它在原 if 之前，原 if 成为 else 分支）。
const START = "if(__snapshot&&__snapshot.path&&JA.existsSync(__snapshot.path)){let __restoreCode=";
const PLAN_START = "let __codexRestorePlan=";
const END = "}catch(__restoreError){";
async function runRestore(source, snapshot, admitted) {
  const s = source.slice(source.indexOf("globalThis.__codexSoftStop=async"));
  const from = s.includes(PLAN_START) ? s.indexOf(PLAN_START) : s.indexOf(START), to = s.indexOf(END, from);
  assert.ok(from > 0 && to > from, "restore branch located");
  const dispatched = [];
  const ctx = vm.createContext({
    Promise, Error, String, Number, Object, clearTimeout, JSON, Date,
    // 恢复窗口的 30–45 s 计时器不得拖住测试进程退出。
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
    JA: fs, __codexStataString: null, __snapshot: snapshot, __runId: "run_s40", __restore: null,
    __codexPayloadAdmittedAtStop: admitted,
    __codexGuardWrap: (_policy, _id, work) => work(),
    // S40 实测（mcp_stata_ehey3xvi.log）："exit 459" 回 --Break-- r(1)，rc 字段为 0。
    zg: { runSelection: async (code) => {
      dispatched.push(code);
      return code === core.REFUSED_RESTORE_CODE
        ? { success: false, rc: 0, error: "--Break-- r(1)", logPath: "mcp_stata_ehey3xvi.log" }
        : { success: true, rc: 0, logPath: "restore.log" };
    } },
  });
  ctx.globalThis = ctx;
  ctx.globalThis.__codexStopCheckpointRef = core;
  ctx.globalThis.__codexExecGuardRef = guard;
  await vm.runInContext("(async()=>{" + s.slice(from, to) + "}catch(__e){__restore={ok:false,thrown:String(__e&&__e.message||__e)}}}})()", ctx);
  assert.ok(!dispatched.some((code) => code === undefined), "dispatch always carries restore code");
  return { dispatched, restore: ctx.__restore, readiness: core.softStopReadiness(ctx.__restore, null) };
}

(async () => {
  // 负控：撤掉本补丁，S40 原样复现——发出 exit 459，continuity-lost。
  const before = await runRestore(legacy, s40, undefined);
  assert.deepEqual(before.dispatched, [core.REFUSED_RESTORE_CODE], "legacy dispatches the refusal sentinel");
  assert.equal(before.readiness.ready, false);
  assert.equal(before.readiness.continuityLost.reason, "soft-stop-checkpoint-restore-failed");

  // 修复：payload 未放行 → 不发任何恢复命令，Stop 完成、就绪。
  const fixed = await runRestore(bundle, s40, false);
  assert.deepEqual(fixed.dispatched, [], "nothing reaches Stata");
  assert.equal(fixed.restore.ok, true);
  assert.equal(fixed.restore.payloadAdmitted, false);
  assert.equal(fixed.readiness.ready, true);
  assert.equal(fixed.readiness.recoveryClass, "RECOVERED_FULL");

  // payload 可能已运行（已放行或未知）：仍不发哨兵，但如实报恢复失败。
  for (const admitted of [true, undefined]) {
    const r = await runRestore(bundle, s40, admitted);
    assert.deepEqual(r.dispatched, [], "the sentinel is never dispatched");
    assert.equal(r.restore.ok, false);
    assert.equal(r.readiness.continuityLost.reason, "soft-stop-checkpoint-restore-failed");
  }

  // 正控：完整检查点照旧派发真实恢复（放行与否都恢复，行为不变）。
  for (const admitted of [false, true]) {
    const r = await runRestore(bundle, complete, admitted);
    assert.equal(r.dispatched.length, 1);
    assert.match(r.dispatched[0], /^use "/m);
    assert.equal(r.restore.ok, true);
    assert.equal(r.readiness.ready, true);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("SOFTSTOP_INCOMPLETE_CHECKPOINT_PASS", JSON.stringify({ negative: "legacy dispatched exit 459 -> continuity-lost", fixed: "0 dispatches, RECOVERED_FULL", admittedOrUnknown: "0 dispatches, restore failed", complete: "restore dispatched" }));
})().catch((error) => { console.error(error); process.exit(1); });
