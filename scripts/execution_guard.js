"use strict";
/**
 * execution_guard.js —— 通用执行守卫（R1-128/R1-118 统一保护，codex A' 方案内核）
 *
 * 背景：dist/extension.js 有 19 处 zg.runSelection，任一不 resolve 都会让 bridge
 * 永久 busy（logPath=null、CPU≈0.014、600-1200s 不自解，仅 reopen 可救）。
 * 19 处按调用性质分四类 policy（见 manifest v3）。本模块提供统一守卫内核。
 *
 * 与 prerun_stage_guard.js(v4) 的关系：后者只做 ABSOLUTE（固定超时）。本模块把
 * 四类 policy 收进一个可单测内核；prerun_stage_guard 将改成本模块 ABSOLUTE 的适配层。
 *
 * 四类 policy：
 *   ABSOLUTE       固定绝对上限（snapshot 60s / enrich 120s）
 *   PROGRESS       进展感知：started 后 pre-log 门限（短 120s / 长 300s）；
 *                  首日志出现后不设固定总时长，改用「进展空闲窗口」（idleMs 内无增长才判挂）
 *   SHORT_INTERNAL 短 deadline；超时必须取消并 drain（探测类，挂住不致命但不能漏跑）
 *   RECOVERY       Stop 恢复路径；保留 snapshot，失败返恢复专用结果；
 *                  **禁止**内部递归 softStop / 自动 force-reset
 *
 * 两维状态（codex：避免单个 result 覆盖信息）：
 *   cause:      COMPLETED / SYNC_THREW / REJECTED / TIMED_OUT / PROGRESS_STALL
 *   settlement: NOT_NEEDED / CANCELLED / CANCEL_TIMEOUT / DRAINED / DRAIN_FAILED
 *   业务结果由 mapOutcome() 映射为 ok / BAD / HARNESS_BLOCKING + 具体 code
 *
 * transport 取消与 session 恢复分离（codex）：
 *   本模块只负责「有界取消 transport + 等 settle」。是否恢复 checkpoint 由调用方
 *   在 guard 返回后按 policy 决定，**不在 guard 内部做 restore**，避免同 transport 死锁。
 *   cancel 原语（cancelRun/cancelAll）由调用方**注入**，本模块不直接引用 zg —— 可单测。
 *
 * 纯 Node，无 vscode / 无 zg 直接依赖。
 */

const POLICY = {
  ABSOLUTE: "ABSOLUTE",
  PROGRESS: "PROGRESS",
  SHORT_INTERNAL: "SHORT_INTERNAL",
  RECOVERY: "RECOVERY",
};

const CAUSE = {
  COMPLETED: "COMPLETED",
  SYNC_THREW: "SYNC_THREW",
  REJECTED: "REJECTED",
  TIMED_OUT: "TIMED_OUT",
  PROGRESS_STALL: "PROGRESS_STALL",
  SUPERSEDED: "SUPERSEDED",       // codex 阻塞3：属主换代（新 run 接管），非「无进展」
};

// 挂起子原因（codex 阻塞5）：cause 保持 PROGRESS_STALL/SUPERSEDED，
// stallReason 细分四类，分别落盘，诊断不再把四种情况折叠成一个码。
const STALL = {
  PRE_LOG: "PRE_LOG",         // 首日志前超过 pre-log 门限
  IDLE: "IDLE",               // 首日志后进展空闲超 idle 窗口
  HARD_BUDGET: "HARD_BUDGET", // 命中可选硬预算（默认关闭）
  OWNER_LOST: "OWNER_LOST",   // 属主换代（→ cause=SUPERSEDED）
};

const SETTLEMENT = {
  NOT_NEEDED: "NOT_NEEDED",       // 正常完成/rejection/同步异常：无需取消
  CANCELLED: "CANCELLED",         // cancelRun 成功且原 promise settle
  CANCEL_TIMEOUT: "CANCEL_TIMEOUT", // 两级取消都超时
  DRAINED: "DRAINED",             // 未主动取消但原 promise 自行 settle
  DRAIN_FAILED: "DRAIN_FAILED",   // 原 promise 始终不 settle
};

// 业务结果码（映射到判定网；每个都要有归属）
const OUTCOME = {
  OK: { code: "OK", belongsTo: "ok" },
  REJECTED: { code: "EXEC_REJECTED", belongsTo: "BAD" },
  SYNC_THREW: { code: "EXEC_SYNC_THREW", belongsTo: "BAD" },
  ABSOLUTE_TIMEOUT: { code: "PRE_RUN_STAGE_TIMEOUT", belongsTo: "BAD" },
  PROGRESS_STALL: { code: "EXEC_PRELOG_STALL", belongsTo: "BAD" },
  // SUPERSEDED（属主换代）计分（codex 否决「一律 ok」；并否决 belongsTo:"EXPECTED_ABORT"
  // —— 该 token 已被现有 harness 占用为 verdict 维度（ws_phase3.py 设 verdict=
  // "EXPECTED_ABORT"），同名会让计分网把两个不同轴混淆）：
  //   · 换代**有控制面证据**（Stop/force-reset 登记且 runId+generation+reason 全匹配）
  //     且旧 transport 干净收敛 → belongsTo:"EXCLUDED" + exclusionReason
  //     （既非 PASS 也非缺陷：仅在有证据时从计分中排除）
  //   · 无证据/证据不符的换代 = 缺陷（BAD）：不该发生的 run 被顶掉
  //   · 任一情形旧 transport 不收敛 → HARNESS_BLOCKING（见 mapOutcome）
  SUPERSEDED_EXPECTED: { code: "EXEC_SUPERSEDED_EXPECTED", belongsTo: "EXCLUDED",
                         exclusionReason: "EXPECTED_SUPERSEDE" },
  SUPERSEDED_UNEXPECTED: { code: "EXEC_SUPERSEDED_UNEXPECTED", belongsTo: "BAD" },
  CANCEL_TIMEOUT: { code: "EXEC_CANCEL_TIMEOUT", belongsTo: "HARNESS_BLOCKING" },
  DRAIN_FAILED: { code: "EXEC_DRAIN_FAILED", belongsTo: "HARNESS_BLOCKING" },
  STOP_RESTORE_TIMEOUT: { code: "STOP_RESTORE_TIMEOUT", belongsTo: "HARNESS_BLOCKING" },
  GRAPH_PRECONDITION_FAILED: { code: "GRAPH_PRECONDITION_FAILED", belongsTo: "HARNESS_BLOCKING" },
};

const DEFAULT_CANCEL_DEADLINE_MS = 15000;
const DEFAULT_DRAIN_DEADLINE_MS = 15000;
const DEFAULT_PRELOG_SHORT_MS = 120000;
const DEFAULT_PRELOG_LONG_MS = 300000;
const DEFAULT_IDLE_SHORT_MS = 60000;      // codex 阻塞4：短任务首日志后空闲窗口
const DEFAULT_IDLE_LONG_MS = 1800000;     // 结构性长任务 30 分钟（长 MI 估计可久无输出）
const DEFAULT_PROGRESS_POLL_MS = 3000;

// D0a：允许「排除计分」的控制面换代原因白名单。只有明确的 Stop / force-reset
// 才可排除；其它任何换代（包括未知原因）一律按缺陷计（codex）。
const SUPERSEDE_KINDS = {
  SOFT_STOP: "soft-stop",
  FORCE_RESET: "force-reset",
};
const ALLOWED_SUPERSEDE_KINDS = [SUPERSEDE_KINDS.SOFT_STOP, SUPERSEDE_KINDS.FORCE_RESET];
// C5-4：证据时效上限。超过此龄的登记不得用于排除计分（防用陈旧 Stop 洗掉新缺陷）。
const SUPERSEDE_EVIDENCE_MAX_AGE_MS = 300000;   // 5 分钟

function nowIso() { return new Date().toISOString(); }

/**
 * C5-4：换代证据核验（codex 复核后收紧）。
 *
 * 为什么不能用 run-start 布尔：预设 true 会把**后来真实发生的 owner 丢失**也当成预期，掩盖缺陷。
 * 故本函数在**检测到换代的那一刻**才向控制面查证。
 *
 * 强制条件（缺一即拒，拒因记 state.supersedeRejectReason）：
 *   · runId 非空且与本 run 一致
 *   · token 非空，且**一次性消费**（已 consumedAt 的记录不得再用 → 复用即 BAD）
 *   · kind ∈ ALLOWED_SUPERSEDE_KINDS（只认 soft-stop / force-reset）
 *   · fromGeneration 精确等于本 run 的 generation（登记侧显式落盘，不由 toGen-1 推导）
 *   · 新属主 generation 可观测时，toGeneration **必须存在且精确相等**（不再「缺失也放过」）
 *   · 记录年龄 ≤ 5 分钟
 */
function verifySupersedeEvidence(state, currentOwner, opts) {
  const lookup = opts && typeof opts.supersedeLookup === "function"
    ? opts.supersedeLookup : null;
  if (!lookup) { state.supersedeRejectReason = "NO_LOOKUP"; return false; }

  let rec = null;
  try {
    rec = lookup({ runId: state.runId, fromGeneration: state.generation,
                   toGeneration: currentOwner ? currentOwner.generation : null });
  } catch (e) {
    state.supersedeRejectReason = "LOOKUP_THREW";
    return false;
  }
  if (!rec || typeof rec !== "object") {
    state.supersedeRejectReason = "NO_RECORD"; return false;
  }
  // runId 必须一致（两侧都得有身份，不能靠 null==null 蒙过）
  if (rec.runId == null || state.runId == null
      || String(rec.runId) !== String(state.runId)) {
    state.supersedeRejectReason = "RUNID_MISMATCH"; return false;
  }
  // token 必须存在
  if (rec.token == null || String(rec.token) === "") {
    state.supersedeRejectReason = "TOKEN_MISSING"; return false;
  }
  // token 一次性：已消费过的证据不得复用
  if (rec.consumedAt != null) {
    state.supersedeRejectReason = "TOKEN_ALREADY_CONSUMED"; return false;
  }
  // fromGeneration 必须显式落盘且精确等于本 run 的 generation
  if (rec.fromGeneration == null || state.generation == null
      || rec.fromGeneration !== state.generation) {
    state.supersedeRejectReason = "FROM_GENERATION_MISMATCH"; return false;
  }
  // toGeneration：新属主可观测时**必须存在且相等**
  const toGen = currentOwner ? currentOwner.generation : null;
  if (toGen != null) {
    if (rec.toGeneration == null) {
      state.supersedeRejectReason = "TO_GENERATION_MISSING"; return false;
    }
    if (rec.toGeneration !== toGen) {
      state.supersedeRejectReason = "TO_GENERATION_MISMATCH"; return false;
    }
  }
  // 原因必须在白名单内
  if (!rec.kind || ALLOWED_SUPERSEDE_KINDS.indexOf(String(rec.kind)) < 0) {
    state.supersedeRejectReason = "KIND_NOT_ALLOWED"; return false;
  }
  // 时效：登记须带 at，且不超过上限
  if (!rec.at) { state.supersedeRejectReason = "TIMESTAMP_MISSING"; return false; }
  const age = Date.now() - new Date(rec.at).getTime();
  if (!(age >= 0) || age > SUPERSEDE_EVIDENCE_MAX_AGE_MS) {
    state.supersedeRejectReason = "EVIDENCE_EXPIRED"; return false;
  }

  // 通过前置检查 → 消费 token（一次性）。
  // C5.1-1 **fail-closed**（codex 抓到我这里原是 fail-open）：消费失败/抛错
  // 一律拒绝排除计分。理由：token 消费是「这条证据已被用掉」的唯一记录，
  // 消费不成功就无法阻止同一证据被复用 → 必须当作证据不可信，而不是「不影响判定」。
  const consumedAt = nowIso();
  try {
    if (opts && typeof opts.consumeSupersedeToken === "function") {
      opts.consumeSupersedeToken(rec.token, consumedAt);
    } else {
      rec.consumedAt = consumedAt;
      // 就地标记必须真的生效（冻结对象/只读代理会静默失败）
      if (rec.consumedAt !== consumedAt) {
        state.supersedeRejectReason = "TOKEN_CONSUME_FAILED"; return false;
      }
    }
  } catch (e) {
    state.supersedeConsumeError = (e && e.message) || String(e);
    state.supersedeRejectReason = "TOKEN_CONSUME_FAILED";
    return false;
  }

  state.supersedeEvidence = {
    runId: rec.runId, fromGeneration: rec.fromGeneration,
    toGeneration: rec.toGeneration == null ? null : rec.toGeneration,
    kind: String(rec.kind), token: rec.token, at: rec.at,
    consumedAt: consumedAt, ageMs: age,
  };
  state.supersedeRejectReason = null;
  return true;
}

/**
 * generation ownership 检查（codex 阻塞1）。
 * 迟到回调/probe/写入前必须验证：该 state 仍是当前 run 的属主。
 * ownerRef 由调用方提供 { generation, runId } 的实时读取器（函数或对象）。
 */
function isCurrent(state, ownerRef) {
  if (!ownerRef) return true;                    // 未提供属主判据 → 不拦（向后兼容）
  const cur = typeof ownerRef === "function" ? ownerRef() : ownerRef;
  if (!cur) return true;
  if (cur.generation != null && state.generation != null
      && cur.generation !== state.generation) return false;
  if (cur.runId != null && state.runId != null
      && String(cur.runId) !== String(state.runId)) return false;
  return true;
}

/**
 * 归一化取消回执（codex 阻塞3）。zg.cancelRun/cancelAll 返回 boolean，
 * 但未来可能返回 {ok}/{confirmed}。只有**明确确认且终态**才算成功。
 * false / {ok:false} / 空 / undefined / 非终态 → confirmed=false（继续 fallback）。
 */
function normalizeCancelReceipt(raw) {
  if (raw === true) return { confirmed: true, terminal: true, target: "ok", raw: true };
  if (raw === false || raw == null)
    return { confirmed: false, terminal: false, target: "none", raw: raw };
  if (typeof raw === "object") {
    const ok = raw.confirmed === true || raw.ok === true;
    // codex 阻塞1：对象回执必须**显式** terminal===true 才算终态确认。
    // 缺省（undefined）不再当终态 —— ack≠terminal：{ok:true} 只代表「收到取消请求」，
    // 不代表 run 已终止；当终态会重演 R1-128 的「假成功」。
    const term = raw.terminal === true;
    return { confirmed: ok && term, terminal: term,
             target: raw.target || "obj", raw: raw };
  }
  // 其他真值（字符串等）：不明确 → 不算确认
  return { confirmed: false, terminal: false, target: String(raw), raw: raw };
}

function createState(policy, meta) {
  meta = meta || {};
  return {
    policy: policy,
    startedAt: nowIso(),
    startedMs: Date.now(),
    runId: meta.runId || null,
    taskId: meta.taskId || null,
    sourceMode: meta.sourceMode || null,
    snapshotPath: meta.snapshotPath || null,
    generation: meta.generation == null ? null : meta.generation,
    // 进展维度
    transportAck: false,
    firstLogAt: null,
    lastProgressAt: null,
    lastLogBytes: null,
    hardBudgetHit: false,      // codex 阻塞4：可选硬预算触顶
    probeRunMismatch: 0,       // probe 报告的日志**身份不符**当前 run 的次数
    probeUnidentified: 0,      // C4.1#1：probe 缺身份(runId/logRunId 皆无)被丢弃的次数
    // D0a：换代是否「预期」**只能**由检测时的控制面证据决定，不接受 run-start 预设。
    supersedeExpected: false,        // 仅由 verifySupersedeEvidence 置位
    supersedeEvidence: null,         // 命中的控制面记录（审计）
    supersedeRejectReason: null,     // 未能排除的原因（审计）
    // 若调用方仍传了 expectedSupersede 布尔 → 记录「已忽略」，防止悄悄依赖旧语义
    supersedePresetIgnored: meta.expectedSupersede !== undefined,
    // 两维结果
    cause: null,
    settlement: SETTLEMENT.NOT_NEEDED,
    // 取消细节
    cancelAttempted: false,
    cancelConfirmed: false,  // codex 阻塞2：某一级 confirmed 才 true（区分 CANCELLED/DRAINED）
    cancelPrecise: null,     // cancelRun(runId) 是否成功（本地 token 释放）
    remoteTerminal: null,    // C5-2：cancelTask 判定的远端终态（Task.status ∈ 终态集）
    cancelFallback: null,    // cancelAll() 是否用过
    cancelTimedOut: false,
    stallReason: null,       // codex 阻塞5：PRE_LOG / IDLE / HARD_BUDGET / OWNER_LOST
    drainMs: null,
    // 收尾
    elapsedMs: null,
    recoveryRequired: false,
    payloadDispatched: false,
    // The guarded value and the underlying MCP transport are not always the
    // same promise. Atomic pre-run checkpoints resolve a readiness promise
    // before the original runSelection transport has settled. Keep explicit
    // evidence for that underlying transport so timeout handling can drain it.
    transportRunId: meta.transportRunId || null,
    transportTaskId: meta.transportTaskId || null,
    transportPromiseAttached: false,
    transportSettled: null,
    transportSettlementAt: null,
    transportLogPath: null,
    transportLogBytes: null,
    snapshotPreserved: null, // RECOVERY: 失败时是否保留 snapshot
    completedAt: null,
    error: null,
  };
}

function resolveTransportPromise(opts, fallback) {
  const candidate = opts && opts.drainPromise;
  let promise = null;
  try {
    promise = typeof candidate === "function" ? candidate() : candidate;
  } catch {
    promise = null;
  }
  if (!promise || typeof promise.then !== "function") return fallback;
  return Promise.resolve(promise);
}

function recordTransportProbe(state, probe) {
  if (!state || !probe || typeof probe !== "object") return state;
  if (probe.runId != null) state.transportRunId = String(probe.runId);
  if (probe.taskId != null) state.transportTaskId = String(probe.taskId);
  if (probe.transportAck != null) state.transportAck = !!probe.transportAck;
  if (probe.logPath != null) state.transportLogPath = String(probe.logPath);
  if (probe.logBytes != null && Number.isFinite(Number(probe.logBytes))) {
    state.transportLogBytes = Number(probe.logBytes);
  }
  if (probe.settled === true || probe.transportSettled === true) {
    state.transportSettled = true;
    state.transportSettlementAt = state.transportSettlementAt || nowIso();
  }
  return state;
}

/** 有界取消（codex C5：**互补动作**，非简单三级 fallback）。
 *
 *  读 dist 源码实证的真实语义：
 *    · zg.cancelTask(taskId) → 协议 `tasks/cancel`，返回 **Task**。终态由
 *      `status ∈ {completed,failed,cancelled}` 判定；`{working,input_required}`
 *      只代表受理/仍在跑。**远端**动作。
 *      ⚠️ 直接传 taskId 给 zg.cancelTask；不要按「taskId→_runsByTaskId→runId→cancelRun」
 *         改写（那会把远端中止降级成本地 token 取消）。`_runsByTaskId` 用于 probe 解析身份。
 *    · zg.cancelRun(runId) → 本地 CancellationTokenSource.cancel()，释放**本地** token/Promise
 *    · zg.cancelAll()      → 本地全量 abort（可能误伤他 run）
 *
 *  故编排为：
 *    ① cancelTask 判远端终态（有 taskId 才可用）
 *    ② **无论远端是否终态，都执行精确 cancelRun** —— 远端已终止仍需释放本地 token/Promise，
 *       两者互补；只做①会留下悬挂的本地 promise，只做②会留下远端仍在跑的任务。
 *    ③ 仅当**远端未终态且精确本地取消失败**时才允许 cancelAll()；
 *       SUPERSEDED 路径（preciseOnly）**始终禁止** cancelAll，防误伤已接管的新 run。
 *
 *  最终是否需要恢复，仍以原 promise 是否在 drain 窗口内 settle 为准（见 boundedDrain）。 */
async function boundedCancel(state, opts) {
  const deadline = Number.isFinite(opts.cancelDeadlineMs)
    ? opts.cancelDeadlineMs : DEFAULT_CANCEL_DEADLINE_MS;
  const preciseOnly = opts.preciseOnly === true;
  state.cancelAttempted = true;
  state.cancelLevels = [];

  async function tryLevel(label, fn, arg) {
    if (typeof fn !== "function") {
      // C4.1#2：缺原语（如产品无 cancelTask）→ 记 skipped 进 cancelLevels，不静默丢
      const rec = { level: label, target: arg, skipped: true, confirmed: false };
      state.cancelLevels.push(rec);
      return rec;
    }
    const TO = Symbol("cancel-to");
    let tmr = null;
    const toP = new Promise((res) => { tmr = setTimeout(() => res(TO), deadline); });
    let p;
    try { p = Promise.resolve(fn(arg)); }
    catch (e) { p = Promise.reject(e); }
    p.catch(() => {});
    let raw, timedOut = false;
    try {
      raw = await Promise.race([p.then((v) => ({ v: v }), (e) => ({ err: e })), toP]);
    } catch (e) { raw = TO; }
    clearTimeout(tmr);
    if (raw === TO) {
      const rec = { level: label, target: arg, timedOut: true, confirmed: false };
      state.cancelLevels.push(rec);
      return rec;
    }
    if (raw && raw.err !== undefined) {
      const rec = { level: label, target: arg, rejected: true, confirmed: false };
      state.cancelLevels.push(rec);
      return rec;
    }
    const norm = normalizeCancelReceipt(raw ? raw.v : undefined);
    const rec = { level: label, target: arg, timedOut: false,
                  confirmed: norm.confirmed, receipt: norm };
    state.cancelLevels.push(rec);
    return rec;
  }

  // ① cancelTask(taskId)：判**远端**是否已终态（须有 taskId）
  let remoteTerminal = false;
  if (state.taskId != null) {
    const r1 = await tryLevel("cancelTask", opts.cancelTask, state.taskId);
    remoteTerminal = !!r1.confirmed;          // confirmed ⇔ Task.status 属终态
    state.remoteTerminal = remoteTerminal;
    if (remoteTerminal) state.cancelHitLevel = "cancelTask";
  }
  // ② cancelRun(runId)：**互补动作，无条件执行** —— 远端已终止也要释放本地 token/Promise
  const r2 = await tryLevel("cancelRun", opts.cancelRun, state.runId);
  state.cancelPrecise = !!r2.confirmed;
  if (r2.confirmed && !state.cancelHitLevel) state.cancelHitLevel = "cancelRun";
  // 远端终态或本地精确成功，任一成立即算「已确认取消」
  if (remoteTerminal || r2.confirmed) { state.cancelConfirmed = true; }
  // ③ cancelAll()：仅当**远端未终态 且 精确本地取消失败**；preciseOnly 始终禁止
  if (!remoteTerminal && !r2.confirmed && !preciseOnly) {
    const r3 = await tryLevel("cancelAll", opts.cancelAll, undefined);
    if (!r3.skipped) state.cancelFallback = true;
    if (r3.confirmed) { state.cancelHitLevel = "cancelAll"; state.cancelConfirmed = true; }
  }

  // 没有任何一级确认时，若有超时记录则升级为 CANCEL_TIMEOUT
  if (!state.cancelConfirmed) {
    const anyTimeout = state.cancelLevels.some((l) => l.timedOut);
    if (anyTimeout) {
      state.cancelTimedOut = true;
      state.settlement = SETTLEMENT.CANCEL_TIMEOUT;
    }
  }
}

/** 有界 drain：等原 promise settle，超上限则 DRAIN_FAILED。 */
async function boundedDrain(state, workPromise, opts) {
  const drainMs = Number.isFinite(opts.drainDeadlineMs)
    ? opts.drainDeadlineMs : DEFAULT_DRAIN_DEADLINE_MS;
  const t0 = Date.now();
  const TO = Symbol("drain-to");
  let tmr = null;
  const toP = new Promise((res) => { tmr = setTimeout(() => res(TO), drainMs); });
  let r;
  const drainPromise = Promise.resolve(workPromise);
  state.transportPromiseAttached = true;
  try {
    r = await Promise.race([
      drainPromise.then(() => "settled", () => "settled"),
      toP,
    ]);
  } catch (e) { r = TO; }
  clearTimeout(tmr);
  state.drainMs = Date.now() - t0;
  const settled = r !== TO;
  state.transportSettled = settled;
  if (settled) state.transportSettlementAt = nowIso();
  // C4.1#3：若原 work 在 drain 窗口内**自行收敛**，transport 已释放 —— 即便某级
  // cancel 调用曾超时（cancelTimedOut=true 仍作审计保留），也不该报 CANCEL_TIMEOUT/503。
  // 收敛即按 confirmed 记 CANCELLED、否则 DRAINED；未收敛才保留 CANCEL_TIMEOUT/DRAIN_FAILED。
  if (settled) {
    state.settlement = state.cancelConfirmed ? SETTLEMENT.CANCELLED : SETTLEMENT.DRAINED;
  } else if (state.settlement !== SETTLEMENT.CANCEL_TIMEOUT) {
    state.settlement = SETTLEMENT.DRAIN_FAILED;
  }
  // 仅当原 work 未收敛（transport 仍被占）才需恢复；收敛=false，cancelTimedOut 只作审计
  state.recoveryRequired = !settled;
  return settled;
}

/**
 * ABSOLUTE / SHORT_INTERNAL / RECOVERY 共用：固定上限竞速。
 * work() 返回 promise；opts 见文件头。返回 {ok, cause, settlement, state, value?}。
 */
// RECOVERY 的默认上限。soft Stop 的 L1 完整 restore 不传 timeoutMs，外层另有按
// checkpoint 计算的竞速期限（stop_checkpoint_core.restoreTimeoutMs）。win32 上那个
// 期限最高 300 s（job 405：160 estimates + 80 graphs 需约 190–225 s），60 s 的
// guard 会先把它切断，所以 win32 放宽到同一上限。其他平台与其他策略不变。
const RECOVERY_LIMIT_MS = 60000;
const RECOVERY_LIMIT_MS_WIN32 = 300000;

function defaultFixedLimitMs(policy, platform = process.platform) {
  if (policy === POLICY.SHORT_INTERNAL) return 30000;
  if (policy === POLICY.RECOVERY && platform === "win32") return RECOVERY_LIMIT_MS_WIN32;
  return RECOVERY_LIMIT_MS;
}

async function guardFixed(policy, work, opts) {
  opts = opts || {};
  const state = opts.state || createState(policy, opts.meta);
  const limitMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs
    : defaultFixedLimitMs(policy);
  const started = Date.now();
  const TO = Symbol("fixed-to");
  let tmr = null;
  const toP = new Promise((res) => { tmr = setTimeout(() => res(TO), limitMs); });

  let wp;
  try { wp = Promise.resolve(work()); }
  catch (e) {
    clearTimeout(tmr);
    state.cause = CAUSE.SYNC_THREW;
    state.settlement = SETTLEMENT.NOT_NEEDED;
    state.error = (e && e.message) || String(e);
    state.elapsedMs = Date.now() - started;
    state.completedAt = nowIso();
    return finish(false, state, opts, e);
  }
  wp.catch(() => {});
  state.transportPromiseAttached = !!(opts.drainPromise &&
    (typeof opts.drainPromise === "function" || typeof opts.drainPromise.then === "function"));

  let raced;
  try { raced = await Promise.race([wp, toP]); }
  catch (e) {
    clearTimeout(tmr);
    state.cause = CAUSE.REJECTED;
    state.settlement = SETTLEMENT.NOT_NEEDED;
    state.error = (e && e.message) || String(e);
    state.elapsedMs = Date.now() - started;
    state.completedAt = nowIso();
    return finish(false, state, opts, e);
  }

  if (raced !== TO) {
    clearTimeout(tmr);
    state.cause = CAUSE.COMPLETED;
    state.settlement = SETTLEMENT.NOT_NEEDED;
    state.elapsedMs = Date.now() - started;
    state.completedAt = nowIso();
    return finish(true, state, opts, null, raced);
  }

  // 超时 → 有界取消 + drain（RECOVERY 禁止递归 softStop，只用 cancelRun/cancelAll）
  state.cause = CAUSE.TIMED_OUT;
  state.elapsedMs = Date.now() - started;
  (opts.log || noop)("[exec-guard] " + policy + " timed out " + limitMs + "ms; bounded cancel");
  await boundedCancel(state, opts);
  await boundedDrain(state, resolveTransportPromise(opts, wp), opts);
  if (policy === POLICY.RECOVERY) {
    // 恢复路径：保留 snapshot，不在此 restore
    state.snapshotPreserved = true;
  }
  state.completedAt = nowIso();
  return finish(false, state, opts, null);
}

/** PROGRESS：pre-log 门限 + 首日志后进展空闲窗口。opts.probe() → {logPath, logBytes}。 */
async function guardProgress(work, opts) {
  opts = opts || {};
  const state = opts.state || createState(POLICY.PROGRESS, opts.meta);
  const preLogMs = Number.isFinite(opts.preLogMs) ? opts.preLogMs
    : (opts.structuralLong ? DEFAULT_PRELOG_LONG_MS : DEFAULT_PRELOG_SHORT_MS);
  const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs
    : (opts.structuralLong ? DEFAULT_IDLE_LONG_MS : DEFAULT_IDLE_SHORT_MS);
  const hardBudgetMs = Number.isFinite(opts.hardBudgetMs) ? opts.hardBudgetMs : null;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_PROGRESS_POLL_MS;
  const probe = typeof opts.probe === "function" ? opts.probe : () => ({});
  const owner = opts.ownerRef;
  const started = Date.now();

  let wp, done = false, value, workErr = null;
  try { wp = Promise.resolve(work()); }
  catch (e) {
    state.cause = CAUSE.SYNC_THREW; state.error = (e && e.message) || String(e);
    state.elapsedMs = Date.now() - started; state.completedAt = nowIso();
    return finish(false, state, opts, e);
  }
  wp.then((v) => { done = true; value = v; }, (e) => { done = true; workErr = e; });
  state.transportPromiseAttached = !!(opts.drainPromise &&
    (typeof opts.drainPromise === "function" || typeof opts.drainPromise.then === "function"));

  // 轮询进展
  for (;;) {
    if (done) break;
    let pr = {};
    try { pr = probe() || {}; } catch (e) { pr = {}; }
    // C4.1#1：probe 身份统一 probeRunId = pr.runId ?? pr.logRunId。
    //   · 身份与当前 run 不符 → probeRunMismatch，丢弃（别的 run/旧文件不得续命）
    //   · state.runId 已知但 probe **缺身份**（两者皆无）→ probeUnidentified，丢弃
    //     （无法证明属于当前 run 的数据，不得续命，更不得注入 taskId）
    if (state.runId != null) {
      const probeRunId = pr.runId != null ? pr.runId
                       : (pr.logRunId != null ? pr.logRunId : null);
      if (probeRunId == null) {
        // 有 payload（logPath/logBytes/taskId 等）却无身份 → 不可信，丢弃
        if (pr.logPath != null || pr.logBytes != null || pr.taskId != null
            || pr.transportAck) state.probeUnidentified++;
        pr = {};
      } else if (String(probeRunId) !== String(state.runId)) {
        state.probeRunMismatch++;
        pr = {};   // 丢弃：别的 run / 旧文件的增长不得续命
      }
    }
    if (owner && !isCurrent(state, owner)) {
      // 属主已换 → 本 run 不再是当前（迟到）。codex 阻塞3+5：这是 SUPERSEDED，
      // 不是「无进展」，且收尾只能精确取消旧 task/run，禁止 cancelAll 误伤新 run。
      state.cause = CAUSE.SUPERSEDED; state.stallReason = STALL.OWNER_LOST;
      // D0a：**此刻**才向控制面查证是否为预期换代（Stop/force-reset），
      // 不用 run-start 预设布尔（否则真实 owner 丢失会被掩盖）。
      const curOwner = typeof owner === "function" ? owner() : owner;
      state.supersedeExpected = verifySupersedeEvidence(state, curOwner, opts);
      break;
    }
    recordTransportProbe(state, pr);
    if (pr.transportAck) state.transportAck = true;
    // codex 阻塞4：probe 定义 {runId,taskId,transportAck,logPath,logBytes}；
    // taskId 动态捕获 → 三级取消的第一层 cancelTask 在生产中才可达。
    if (pr.taskId != null && state.taskId == null) state.taskId = pr.taskId;
    const el = Date.now() - started;
    if (pr.logPath && state.firstLogAt == null) {
      state.firstLogAt = Date.now();
      state.lastProgressAt = Date.now();
      state.lastLogBytes = pr.logBytes || 0;
    } else if (state.firstLogAt != null && pr.logBytes != null
               && pr.logBytes > (state.lastLogBytes || 0)) {
      state.lastProgressAt = Date.now();
      state.lastLogBytes = pr.logBytes;
    }
    // hard budget（codex 阻塞4）：即便有伪日志也不能无限续命
    if (hardBudgetMs != null && el >= hardBudgetMs) {
      state.hardBudgetHit = true; state.cause = CAUSE.PROGRESS_STALL;
      state.stallReason = STALL.HARD_BUDGET; break;
    }
    // 判挂
    if (state.firstLogAt == null) {
      if (el >= preLogMs) {                                            // pre-log stall
        state.cause = CAUSE.PROGRESS_STALL; state.stallReason = STALL.PRE_LOG; break;
      }
    } else {
      if (Date.now() - state.lastProgressAt >= idleMs) {               // 首日志后空闲
        state.cause = CAUSE.PROGRESS_STALL; state.stallReason = STALL.IDLE; break;
      }
    }
    await sleep(pollMs);
  }

  state.elapsedMs = Date.now() - started;
  if (done && workErr == null) {
    state.cause = CAUSE.COMPLETED; state.settlement = SETTLEMENT.NOT_NEEDED;
    state.completedAt = nowIso();
    return finish(true, state, opts, null, value);
  }
  if (done && workErr != null) {
    state.cause = CAUSE.REJECTED; state.settlement = SETTLEMENT.NOT_NEEDED;
    state.error = (workErr && workErr.message) || String(workErr);
    state.completedAt = nowIso();
    return finish(false, state, opts, workErr);
  }
  // PROGRESS_STALL / SUPERSEDED → 有界取消 + drain。SUPERSEDED 走精确取消（禁 cancelAll）。
  const supersededNow = state.cause === CAUSE.SUPERSEDED;
  (opts.log || noop)("[exec-guard] " + (supersededNow ? "SUPERSEDED" : "PROGRESS stall")
    + " (" + (state.stallReason || "?") + "); bounded cancel"
    + (supersededNow ? " (precise-only)" : ""));
  await boundedCancel(state, Object.assign({}, opts, { preciseOnly: supersededNow }));
  await boundedDrain(state, resolveTransportPromise(opts, wp), opts);
  state.completedAt = nowIso();
  return finish(false, state, opts, null);
}

function mapOutcome(state) {
  if (state.cause === CAUSE.COMPLETED) return OUTCOME.OK;
  if (state.cause === CAUSE.SYNC_THREW) return OUTCOME.SYNC_THREW;
  if (state.cause === CAUSE.REJECTED) return OUTCOME.REJECTED;
  // 失败类映射优先级（codex：避免 settlement 覆盖 cause/policy 信息）：
  // 1) RECOVERY 路径身份最优先 —— 它挂住的业务含义是「恢复超时」，
  //    无论收尾是 cancel-timeout 还是 drain-failed，都应报 STOP_RESTORE_TIMEOUT
  //    （settlement 细节仍保留在 state 里供审计）。
  if (state.policy === POLICY.RECOVERY) return OUTCOME.STOP_RESTORE_TIMEOUT;
  // 2) SUPERSEDED（属主换代）：旧 transport 卡住（cancel 超时/drain 失败）→ 一律
  //    HARNESS_BLOCKING（旧计算仍占 transport，会阻塞新 run）；收敛后按**控制面证据**
  //    二分：有据=EXCLUDED（排除计分）、无据=BAD（缺陷）。证据在检测时核验，非预设。
  if (state.cause === CAUSE.SUPERSEDED) {
    if (state.settlement === SETTLEMENT.CANCEL_TIMEOUT) return OUTCOME.CANCEL_TIMEOUT;
    if (state.settlement === SETTLEMENT.DRAIN_FAILED) return OUTCOME.DRAIN_FAILED;
    return state.supersedeExpected ? OUTCOME.SUPERSEDED_EXPECTED
                                   : OUTCOME.SUPERSEDED_UNEXPECTED;
  }
  // 3) PROGRESS_STALL 的业务含义是「无进展」，比通用 drain-failed 更具体。
  if (state.cause === CAUSE.PROGRESS_STALL) return OUTCOME.PROGRESS_STALL;
  // 4) 其余（cause=TIMED_OUT 的 ABSOLUTE/SHORT_INTERNAL）按收尾严重度。
  if (state.settlement === SETTLEMENT.CANCEL_TIMEOUT) return OUTCOME.CANCEL_TIMEOUT;
  if (state.settlement === SETTLEMENT.DRAIN_FAILED) return OUTCOME.DRAIN_FAILED;
  return OUTCOME.ABSOLUTE_TIMEOUT;
}

function finish(ok, state, opts, err, value) {
  const outcome = mapOutcome(state);
  return { ok: ok, cause: state.cause, settlement: state.settlement,
           outcome: outcome,
           // D0a：排除计分的原因随结果一并给出（计分网无需自己推断）
           exclusionReason: outcome.exclusionReason || null,
           state: state, error: err, value: value };
}

function markPayloadDispatched(state) {
  if (state) state.payloadDispatched = true;
  return state;
}

function publicSummary(state) {
  if (!state) return null;
  return {
    policy: state.policy, startedAt: state.startedAt, runId: state.runId,
    taskId: state.taskId, sourceMode: state.sourceMode,
    snapshotPath: state.snapshotPath, transportAck: !!state.transportAck,
    firstLogAt: state.firstLogAt ? new Date(state.firstLogAt).toISOString() : null,
    cause: state.cause, settlement: state.settlement, stallReason: state.stallReason || null,
    cancelAttempted: !!state.cancelAttempted, cancelConfirmed: !!state.cancelConfirmed,
    cancelPrecise: state.cancelPrecise,
    remoteTerminal: state.remoteTerminal,
    cancelFallback: state.cancelFallback, cancelTimedOut: !!state.cancelTimedOut,
    cancelHitLevel: state.cancelHitLevel || null,
    cancelLevels: Array.isArray(state.cancelLevels) ? state.cancelLevels : null,
    hardBudgetHit: !!state.hardBudgetHit, probeRunMismatch: state.probeRunMismatch || 0,
    probeUnidentified: state.probeUnidentified || 0,
    supersedeExpected: !!state.supersedeExpected,
    supersedeEvidence: state.supersedeEvidence || null,
    supersedeRejectReason: state.supersedeRejectReason || null,
    supersedePresetIgnored: !!state.supersedePresetIgnored,
    drainMs: state.drainMs, elapsedMs: state.elapsedMs,
    recoveryRequired: !!state.recoveryRequired,
    snapshotPreserved: state.snapshotPreserved,
    payloadDispatched: !!state.payloadDispatched,
    transportRunId: state.transportRunId || null,
    transportTaskId: state.transportTaskId || null,
    transportAck: !!state.transportAck,
    transportPromiseAttached: !!state.transportPromiseAttached,
    transportSettled: state.transportSettled,
    transportSettlementAt: state.transportSettlementAt || null,
    transportLogPath: state.transportLogPath || null,
    transportLogBytes: state.transportLogBytes,
    completedAt: state.completedAt,
  };
}

function noop() {}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  POLICY, CAUSE, SETTLEMENT, STALL, OUTCOME,
  SUPERSEDE_KINDS, ALLOWED_SUPERSEDE_KINDS,
  DEFAULT_CANCEL_DEADLINE_MS, DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_PRELOG_SHORT_MS, DEFAULT_PRELOG_LONG_MS,
  DEFAULT_IDLE_SHORT_MS, DEFAULT_IDLE_LONG_MS,
  createState, isCurrent, normalizeCancelReceipt, verifySupersedeEvidence,
  SUPERSEDE_EVIDENCE_MAX_AGE_MS,
  boundedCancel, boundedDrain,
  resolveTransportPromise, recordTransportProbe,
  guardFixed, guardProgress, mapOutcome, markPayloadDispatched, publicSummary,
  defaultFixedLimitMs, RECOVERY_LIMIT_MS, RECOVERY_LIMIT_MS_WIN32,
};
