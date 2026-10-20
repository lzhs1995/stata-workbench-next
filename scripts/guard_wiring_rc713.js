"use strict";
/**
 * guard_wiring_rc713.js —— rc.7.13：guard 接线的**唯一权威纯函数模块**
 *
 * 为什么存在（rc.7.13b 的教训）：
 *   旧的 wire_rc713b_remaining.js 依赖两样脆弱的东西：
 *     1. 生成物 manifest（runselection_callsite_manifest_v5_*.json）里记录的 policy，
 *        用「上下文模糊匹配」回查；查不到就**静默回落 SHORT_INTERNAL**。
 *     2. manifest 里的 charOffset —— 一旦 bundle 重新生成，偏移全部失效。
 *   两者都会让「接线正确」这件事取决于一份可能过期的生成物。本模块把 policy 变成
 *   **声明式常量表**，把定位变成**基线派生的长锚点 + AST 序号双向校验**，
 *   并且是**纯函数**：apply(text) 只吃字符串、吐字符串，不读任何文件。
 *
 * 设计红线：
 *   · 锚点 ≥ MIN_ANCHOR_BYTES 字节且必须纯 ASCII；缺失 / 非唯一 → 立即抛错（绝不静默）。
 *   · 锚点在 raw 基线 95aa8079 与 post-core/pre-wiring 中间态里都唯一（见 test_guard_wiring_rc713.js）。
 *   · 退役调用点（AST 证明不可达）恰好 2 个，只允许 RETIRED_ORDINALS 里那两个。
 *   · 已接线的调用点走**逐字节重建比对**，而不是"看起来包过了就算"。
 *   · 保持 promise 形状：原地包一层，周边 race / 赋值 / return / await 写法逐字不变。
 */

const AST = require("./ast_reachability_gate.js");

/** rc.7.13b 段落 marker：整段注入的幂等闸门 */
const MARKER = "codex patch rc.7.13b: remaining callsites guarded";
/** 包装器注入锚：挂在 rc.7.12 的 supersede 登记器旁（此处 zg / __codexExecGuard 均在作用域内） */
const WRAPPER_HOOK = "globalThis.__codexRecordSupersede=";
/** 被包裹的调用头 */
const CALL_HEAD = "zg.runSelection(";
/** 包装器调用头 */
const WRAP_HEAD = "__codexGuardWrap(";
/** 锚点最小字节数（决策要求：>=80 ASCII 字节） */
const MIN_ANCHOR_BYTES = 80;
/** bundle 内 zg.runSelection 调用点总数（含 2 个退役点） */
const TOTAL_CALLSITES = 17;
/** AST 证明不可达的退役调用点序号（按 charOffset 升序的 1-based ordinal） */
const RETIRED_ORDINALS = [8, 12];

/** policy 名 → execution_guard 的 POLICY 常量表达式 */
// rc.7.14：一律用**显式全局绑定**而非裸词法标识符。
// 原因（rc.7.13 真机血证）：裸 `__codexExecGuard` 是 activate() 内的 `let`，
// 17 个调用点里 10 个在该函数之外 → `ReferenceError: __codexExecGuard is not defined`，
// guard 一行未跑，而静态覆盖率仍然 17/17「全绿」。
// 全局形态由 guard_global_export_rc714.js 在本模块之前统一注入并改写。
const POLICY_EXPR = {
  PROGRESS: "globalThis.__codexExecGuardRef.POLICY.PROGRESS",
  SHORT_INTERNAL: "globalThis.__codexExecGuardRef.POLICY.SHORT_INTERNAL",
  RECOVERY: "globalThis.__codexExecGuardRef.POLICY.RECOVERY",
  "ABSOLUTE-60s": "globalThis.__codexExecGuardRef.POLICY.ABSOLUTE",
  "ABSOLUTE-120s": "globalThis.__codexExecGuardRef.POLICY.ABSOLUTE",
};
/** 固定超时（仅 ABSOLUTE / SHORT_INTERNAL 需要显式毫秒） */
const TIMEOUT_MS = { "ABSOLUTE-60s": 60000, "ABSOLUTE-120s": 120000, SHORT_INTERNAL: 30000 };
/** policy → sourceMode 标签（用于 /status 与守卫摘要归因） */
const SOURCE_MODE = { RECOVERY: "recovery", PROGRESS: "progress" };

/** 17 个活跃调用点的声明式策略表（锚点由基线机器派生，非手抄；见 scripts/ 下派生记录） */
const POLICY_TABLE = [
  {
    ord: 1, id: "softstop-restore", mode: "wrap", policy: "RECOVERY", runId: "\"soft-stop-restore-\"+String(__runId||Date.now())",
    anchor:
      "_codexStataString);try{let __restoreAttempt=await Promise.race([Promise.resolve(",
    finalAnchor:
      "_codexStataString);try{let __restoreTimeoutMs=globalThis.__codexStopCheckpointRef.restoreTimeoutMs(__snapshot),__restoreAttempt=await Promise.race([Promise.resolve(",
  },
  {
    ord: 2, id: "softstop-hard-restore", mode: "wrap", policy: "RECOVERY", runId: "\"soft-stop-hard-restore-\"+String(__runId||Date.now())",
    anchor:
      "_reconnectAttempt.error);let __retryAttempt=await Promise.race([Promise.resolve(",
  },
  {
    ord: 3, id: "softstop-hard-restore-retry", mode: "wrap", policy: "RECOVERY", runId: "\"soft-stop-hard-restore-retry-\"+String(__runId||Date.now())",
    anchor:
      "or(__reconnectAttempt.error);__retryAttempt=await Promise.race([Promise.resolve(",
  },
  {
    ord: 4, id: "softstop-quiescence", mode: "wrap", policy: "SHORT_INTERNAL", runId: "\"soft-stop-quiescence-\"+String(__runId||Date.now())",
    anchor:
      ",\"_\")+\"___\\\"\\n\";try{let __quiescenceAttempt=await Promise.race([Promise.resolve(",
  },
  {
    ord: 5, id: "bridge-prerun-atomic", mode: "core", policy: "ABSOLUTE-60s", guardKind: "guardStage",
    // rc.7.14：anchor 指向**已全局化**的文本；baselineAnchor 仍是裸形态（原始基线里就是裸的）
    anchor:
      "codexSnapGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"snapshot\",()=>{__codexBridgeAtomic=globalThis.__codexStopCheckpointRef.beginAtomic({snapshot:__codexBridgePreRunSnapshot,runSelection:(__code,__options)=>",
    baselineAnchor:
      "apStage;let __codexSnapGuard=await __codexPreRunGuard.guardStage(\"snapshot\",()=>",
  },
  {
    ord: 6, id: "bridge-visible-run", mode: "wrap", policy: "PROGRESS", runId: "__run",
    structuralLong: "__codexBridgeLongRun",
    anchor:
      ".10.36: visible bridge snapshots pre-run dataset */try{let __codexBridgePromise=",
  },
  {
    ord: 7, id: "manual-selection-run", mode: "wrap", policy: "PROGRESS", runId: "e",
    structuralLong: "__codexManualSelectionLongRun",
    anchor:
      "!__codexPreparedGraphRun.captureBaseline);try{let __codexManualSelectionPromise=",
  },
  {
    ord: 9, id: "humanfile-prerun-atomic", mode: "core", policy: "ABSOLUTE-60s", guardKind: "guardStage",
    // rc.7.14：同 ord5，anchor 走全局化形态
    anchor:
      "dexHfSnapGuard=await globalThis.__codexPreRunGuardRef.guardStage(\"snapshot\",()=>{__codexHfAtomic=globalThis.__codexStopCheckpointRef.beginAtomic({snapshot:__codexHumanFilePreRunSnapshot,runSelection:(__code,__options)=>",
    baselineAnchor:
      "e \\\"\"+__codexStataString(__snapshotPath)+\"\\\", replace\\ncapture restore\\n\";await ",
  },
  {
    ord: 10, id: "humanfile-runmethod-source", mode: "wrap", policy: "PROGRESS", runId: "r",
    structuralLong: "!!(__codexHumanFileIsHugeMiDocumentRun||(globalThis.__codexManualRunPolicy&&globalThis.__codexManualRunPolicy.isLongManualSelection(__runner)))",
    anchor:
      "leRunMethod=function(__runner,__opts){return __codexHumanFileUseSourceSelection?",
  },
  {
    ord: 11, id: "humanfile-runmethod-fallback", mode: "wrap", policy: "PROGRESS", runId: "r",
    structuralLong: "!!(__codexHumanFileIsHugeMiDocumentRun||(globalThis.__codexManualRunPolicy&&globalThis.__codexManualRunPolicy.isLongManualSelection(__runner)))",
    anchor:
      "mpDoFile?zg.runFile(__codexHumanFileTempDoFile,{...(__opts||{}),cwd:C,runId:r}):",
  },
  {
    ord: 13, id: "humanfile-state-restore", mode: "wrap", policy: "RECOVERY", runId: "r",
    anchor:
      "eSnapshot}}catch{}}\nelse{let __codexRestoreRes=null;try{__codexRestoreRes=await ",
  },
  {
    ord: 14, id: "mcp-test-connection", mode: "wrap", policy: "SHORT_INTERNAL", runId: "null",
    anchor:
      "nsion.operation\"},async()=>{await IP(\"Testing MCP server\",async g=>{let A=await ",
  },
  {
    ord: 15, id: "graph-inventory-probe", mode: "wrap", policy: "SHORT_INTERNAL", runId: "null",
    anchor:
      "e close __codex_graph_meta\",\n    \"}\"\n  ].join(\"\\n\");\n  const inventoryPromise = ",
    finalAnchor:
      "    // Await the guard itself, including its cancellation and drain deadline.\n    const result = await ",
    finalRunId: "probeRunId",
  },
  {
    ord: 16, id: "graph-export-batch", mode: "wrap", policy: "SHORT_INTERNAL", runId: "null",
    anchor:
      "exportLines.push(\"}\");\n    const exportCode = exportLines.join(\"\\n\");\n    await ",
  },
  {
    ord: 17, id: "terminal-input-run", mode: "core", policy: "PROGRESS", guardKind: "guardProgress",
    // rc.7.14：同 ord5/ord10，anchor 走全局化形态
    anchor:
      "n||0)}),__codexTermGuard=await globalThis.__codexExecGuardRef.guardProgress(()=>",
    baselineAnchor:
      "t completion marker */let __codexTerminalResult;try{__codexTerminalResult=await ",
  },
];

/* ------------------------------------------------------------------ *
 *  基础断言工具：任何异常都必须**抛**，不许静默回落
 * ------------------------------------------------------------------ */

/** 纯 ASCII（可打印 + 常见空白）判定 —— 锚点必须逐字节可预测 */
function isPureAscii(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** 出现次数（不重叠不去重，用于唯一性判定） */
function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    n += 1;
    i = at + 1;
  }
  return n;
}

/** 定位唯一锚点：缺失和非唯一都抛（等价于 apply_rc7 里的 replaceOnce 闸门语义） */
function findUniqueAnchor(text, anchor, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error("missing rc.7.13 anchor: " + label);
  const second = text.indexOf(anchor, first + anchor.length);
  if (second >= 0) throw new Error("non-unique rc.7.13 anchor: " + label);
  return first;
}

/** 策略表自检：id 唯一、序号唯一且不撞退役点、锚点长度与 ASCII 合规 */
function assertTableWellFormed() {
  const ids = new Set();
  const ords = new Set();
  for (const e of POLICY_TABLE) {
    if (ids.has(e.id)) throw new Error("duplicate rc.7.13 policy id: " + e.id);
    ids.add(e.id);
    if (ords.has(e.ord)) throw new Error("duplicate rc.7.13 ordinal: #" + e.ord);
    ords.add(e.ord);
    if (RETIRED_ORDINALS.indexOf(e.ord) >= 0) {
      throw new Error("rc.7.13 policy table must not cover retired ordinal #" + e.ord);
    }
    if (!POLICY_EXPR[e.policy]) throw new Error("unknown rc.7.13 policy: " + e.policy + " (#" + e.ord + ")");
    if (e.mode !== "wrap" && e.mode !== "core") throw new Error("unknown rc.7.13 mode: " + e.mode);
    for (const key of ["anchor", "baselineAnchor", "finalAnchor"]) {
      const a = e[key];
      if (a === undefined) continue;
      if (typeof a !== "string" || a.length < MIN_ANCHOR_BYTES) {
        throw new Error(
          "rc.7.13 " + key + " shorter than " + MIN_ANCHOR_BYTES + " bytes: #" + e.ord + " " + e.id
        );
      }
      if (!isPureAscii(a)) throw new Error("rc.7.13 " + key + " is not pure ASCII: #" + e.ord + " " + e.id);
    }
    if (e.mode === "wrap" && typeof e.runId !== "string") {
      throw new Error("rc.7.13 wrap entry missing runId expression: #" + e.ord);
    }
    if (e.finalRunId !== undefined &&
        (!e.finalAnchor || e.mode !== "wrap" || typeof e.finalRunId !== "string" || !e.finalRunId.trim())) {
      throw new Error("rc.7.13 invalid final runId variant: #" + e.ord);
    }
    if (e.mode === "wrap" && e.policy === "PROGRESS"
        && (typeof e.structuralLong !== "string" || !e.structuralLong.trim())) {
      throw new Error("rc.7.13 PROGRESS wrap entry missing structuralLong expression: #" + e.ord);
    }
    if (e.mode === "core" && !e.guardKind) {
      throw new Error("rc.7.13 core entry missing guardKind: #" + e.ord);
    }
  }
  const active = TOTAL_CALLSITES - RETIRED_ORDINALS.length;
  if (POLICY_TABLE.length !== active) {
    throw new Error(
      "rc.7.13 policy table covers " + POLICY_TABLE.length + " sites, expected " + active + " active"
    );
  }
  return true;
}

/**
 * 锚点唯一性门禁：在给定文本里逐条校验。
 * @param {string} text 被校验的 bundle 文本
 * @param {"apply"|"baseline"} which apply=接线期形态；baseline=raw 95aa8079 形态
 */
function assertAnchorUniqueness(text, which) {
  assertTableWellFormed();
  const rows = [];
  for (const e of POLICY_TABLE) {
    // core 站点的前缀会被 rc.7.12 / rc.7.13a 改写，故基线形态单列一条锚点
    const anchor = which === "baseline" && e.baselineAnchor
      ? e.baselineAnchor
      : (e.finalAnchor && countOccurrences(text, e.finalAnchor) === 1 ? e.finalAnchor : e.anchor);
    const n = countOccurrences(text, anchor);
    if (n !== 1) {
      throw new Error(
        "rc.7.13 anchor not unique in " + which + " text: #" + e.ord + " " + e.id + " count=" + n
      );
    }
    rows.push({ ord: e.ord, id: e.id, bytes: anchor.length });
  }
  return rows;
}

/** 生成某个调用点的 guard 包装替换文本（policy / runId / options 全部来自声明式表） */
function buildReplacement(entry, innerCallText, legacyProgressShort) {
  const pexpr = POLICY_EXPR[entry.policy];
  const timeout = TIMEOUT_MS[entry.policy];
  const opts = [
    'sourceMode:"' + (SOURCE_MODE[entry.policy] || "internal") + '"',
    timeout ? "timeoutMs:" + timeout : null,
    entry.policy === "PROGRESS"
      ? "structuralLong:" + (legacyProgressShort ? "!1" : entry.structuralLong)
      : null,
  ]
    .filter(Boolean)
    .join(",");
  return WRAP_HEAD + pexpr + "," + entry.runId + ",()=>" + innerCallText + ",{" + opts + "})";
}

/** 从参数切片里机器提取 runId 表达式（用于与声明值做一致性交叉校验） */
function extractRunId(args) {
  const i = args.indexOf("runId:");
  if (i < 0) return null;
  let j = i + 6;
  let depth = 0;
  while (j < args.length) {
    const c = args[j];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === "," && depth === 0) break;
    else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      j += 1;
      while (j < args.length && args[j] !== q) {
        if (args[j] === "\\") j += 1;
        j += 1;
      }
    }
    j += 1;
  }
  const expr = args.slice(i + 6, j).trim();
  return expr || null;
}

/**
 * 统一 guard 包装器源码（逐字保持 rc.7.13b 的运行时语义）。
 * 契约：__codexGuardWrap(policy, runId, work, options) → Promise，
 *   · PROGRESS 走 guardProgress（带 probe / ownerRef 心跳）
 *   · 其余走 guardFixed（带 timeoutMs）
 *   · 失败时抛出的 Error 挂 __codexGuardFailure（并兼容旧字段 __codexPreRunTimeout）
 * 三级 cancel 逐级降强度，绝不把 taskId 重映射成 runId（那会把服务端 abort 降级成本地 token）。
 */
function buildWrapper() {
  return (
    "globalThis.__codexGuardWrap=async(__pol,__rid,__work,__o)=>{" +
    "let __EG=__codexExecGuard,__so=__o||{}," +
    "__st=__EG.createState(__pol,{runId:__rid,sourceMode:__so.sourceMode||null," +
    "generation:Number(globalThis.__codexResetGeneration||0)})," +
    "__T=globalThis.__codexGuardTransport," +
    "__common={state:__st,log:(m)=>{try{RI(m)}catch{}}," +
    "cancelTask:(__t)=>(__T?__T.cancelTask(__t):false)," +
    "cancelRun:()=>(__T?__T.cancelRun(__rid):false)," +
    "cancelAll:()=>(__T?__T.cancelAll():false)," +
    "supersedeLookup:(__q)=>(__T?__T.supersedeLookup(__q):null)},__r;" +
    "try{" +
    "if(__pol===__EG.POLICY.PROGRESS){" +
    "__r=await __EG.guardProgress(__work,Object.assign({},__common,{" +
    "structuralLong:!!__so.structuralLong," +
    "probe:()=>{try{let __s=__T?__T.getRunExecutionState(__rid):null;" +
    "return __s?{runId:__s.runId,taskId:__s.taskId,transportAck:__s.transportAck," +
    "logPath:__s.logPath,logBytes:__s.logBytes}:{}}catch(__e){return{}}}," +
    "ownerRef:()=>{try{let __bs=globalThis.__codexBridgeState||{}," +
    "__lc=__bs.__codexLifecycle||null;" +
    "return{runId:((__lc&&__lc.runId)||__bs.runId||null)," +
    "generation:Number(globalThis.__codexResetGeneration||0)}}" +
    "catch(__e){return{runId:null,generation:Number(globalThis.__codexResetGeneration||0)}}}}))" +
    "}else{" +
    "__r=await __EG.guardFixed(__pol,__work,Object.assign({},__common," +
    "(__so.timeoutMs?{timeoutMs:__so.timeoutMs}:{})))" +
    "}" +
    "}catch(__ge){throw __ge}" +
    "globalThis.__codexLastGuard=__EG.publicSummary(__st);" +
    "if(!__r.ok){" +
    "if(__r.error)throw __r.error;" +
    'let __code=__r.outcome?__r.outcome.code:"EXEC_GUARD_FAILED",' +
    "__e2=new Error(__code);" +
    "__e2.__codexGuardFailure={ok:false,status:(__st.recoveryRequired?503:504)," +
    "error:__code,reasonCode:__code,policy:__pol,runId:__rid," +
    "sourceMode:__so.sourceMode||null,cause:__r.cause,settlement:__r.settlement," +
    "outcome:__code,outcomeBelongsTo:(__r.outcome?__r.outcome.belongsTo:null)," +
    "exclusionReason:(__r.exclusionReason||null),stallReason:__st.stallReason," +
    "cancelHitLevel:__st.cancelHitLevel,cancelLevels:__st.cancelLevels||null," +
    "supersedeEvidence:__st.supersedeEvidence||null," +
    "recoveryRequired:!!__st.recoveryRequired,elapsedMs:__st.elapsedMs};" +
    "__e2.__codexPreRunTimeout=__e2.__codexGuardFailure;" +
    "throw __e2}" +
    "return __r.value};/* " +
    MARKER +
    " */"
  );
}

/* ------------------------------------------------------------------ *
 *  apply(text) —— 纯函数：吃 bundle 文本，吐接线后的 bundle 文本
 * ------------------------------------------------------------------ */

/**
 * 把全部 17 个活跃 zg.runSelection 调用点接入 execution guard。
 *
 * 幂等语义：
 *   · 首次运行：注入包装器 + 包裹 12 处裸调用；core 的 5 处只做验证。
 *   · 再次运行（文本已含 MARKER）：**逐字节校验全部 17 处**，返回原文本不动一个字节。
 *
 * @param {string} text bundle 文本（应为 post-core/pre-wiring 中间态或已接线态）
 * @returns {{text: string, report: object}}
 */
function apply(text) {
  if (typeof text !== "string") throw new Error("rc.7.13 apply() expects a string");
  assertTableWellFormed();

  const alreadyWired = text.includes(MARKER);
  let out = text;

  // 1) 注入统一包装器（先注入，后面 AST 偏移才与最终文本一致）
  if (!alreadyWired) {
    const hookAt = findUniqueAnchor(out, WRAPPER_HOOK, "guard wrapper hook (rc.7.12 supersede registrar)");
    out = out.slice(0, hookAt) + buildWrapper() + out.slice(hookAt);
  }

  // 2) AST 可达性分析：调用点总数与退役点必须逐一对上
  const ast = AST.analyze(out);
  const sites = ast.callsites.slice().sort((a, b) => a.start - b.start);
  if (sites.length !== TOTAL_CALLSITES) {
    throw new Error("rc.7.13 expected " + TOTAL_CALLSITES + " zg.runSelection callsites, found " + sites.length);
  }
  const deadOrdinals = sites.map((s, i) => (s.reachable ? null : i + 1)).filter((x) => x !== null);
  if (deadOrdinals.join(",") !== RETIRED_ORDINALS.join(",")) {
    throw new Error(
      "rc.7.13 retired-callsite set drifted: got [" + deadOrdinals + "] expected [" + RETIRED_ORDINALS + "]"
    );
  }

  // 3) 先把 17 条锚点全部定位（唯一性闸门），再按位置**降序**改写，
  //    保证靠前的偏移不会因为靠后的改写而漂移。
  const plan = POLICY_TABLE.map((entry) => {
    const anchor = entry.finalAnchor && countOccurrences(out, entry.finalAnchor) === 1
      ? entry.finalAnchor
      : entry.anchor;
    const at = findUniqueAnchor(out, anchor, "#" + entry.ord + " " + entry.id);
    // Historical replay still uses its original null owner. The final probe
    // binds cancellation to the same unique runId supplied to runSelection.
    const resolved = anchor === entry.finalAnchor && entry.finalRunId !== undefined
      ? { ...entry, runId: entry.finalRunId } : entry;
    return { entry: resolved, anchorEnd: at + anchor.length };
  }).sort((a, b) => b.anchorEnd - a.anchorEnd);

  const report = {
    alreadyWired,
    wrapped: [],
    verifiedWrapped: [],
    migratedWrapped: [],
    verifiedCore: [],
    retired: RETIRED_ORDINALS.slice(),
    totalCallsites: sites.length,
  };

  for (const p of plan) {
    const entry = p.entry;
    const label = "#" + entry.ord + " " + entry.id;

    // 锚点位置 ↔ AST 序号双向校验：取 start >= anchorEnd 的最近调用点
    let site = null;
    let ordinal = -1;
    for (let i = 0; i < sites.length; i++) {
      if (sites[i].start >= p.anchorEnd) {
        site = sites[i];
        ordinal = i + 1;
        break;
      }
    }
    if (!site) throw new Error("rc.7.13 no callsite follows anchor: " + label);
    if (ordinal !== entry.ord) {
      throw new Error("rc.7.13 anchor/AST ordinal mismatch for " + label + ": AST ordinal #" + ordinal);
    }
    if (!site.reachable) throw new Error("rc.7.13 anchor resolved to a retired callsite: " + label);

    const innerCall = out.slice(site.start, site.end);
    if (!innerCall.startsWith(CALL_HEAD) || !innerCall.endsWith(")")) {
      throw new Error("rc.7.13 malformed callsite slice for " + label);
    }

    if (entry.mode === "core") {
      // core：guard 由 rc.7.12 / rc.7.13a 注入，锚点本身已含 guardStage(/guardProgress(
      if (site.start !== p.anchorEnd) {
        throw new Error("rc.7.13 core callsite is not adjacent to its anchor: " + label);
      }
      if (!site.guarded || String(site.guardKind) !== entry.guardKind) {
        throw new Error(
          "rc.7.13 core callsite not guarded as declared: " +
            label +
            " expected " +
            entry.guardKind +
            " got " +
            (site.guarded ? site.guardKind : "naked")
        );
      }
      if (entry.anchor.indexOf(entry.guardKind + "(") < 0) {
        throw new Error("rc.7.13 core anchor does not embed its guard call: " + label);
      }
      report.verifiedCore.push({ ord: entry.ord, id: entry.id, policy: entry.policy, guardKind: entry.guardKind });
      continue;
    }

    // wrap：声明的 runId 必须与参数里机器提取的 runId 一致（防止表与实参脱节）
    const args = innerCall.slice(CALL_HEAD.length, innerCall.length - 1);
    const foundRunId = extractRunId(args);
    const declared = entry.runId === "null" ? null : entry.runId;
    if (foundRunId !== declared) {
      throw new Error(
        "rc.7.13 runId mismatch for " +
          label +
          ": declared " +
          JSON.stringify(declared) +
          " but callsite has " +
          JSON.stringify(foundRunId)
      );
    }
    const replacement = buildReplacement(entry, innerCall, false);

    if (site.start === p.anchorEnd) {
      // 裸调用 → 就地包一层（promise 形状不变）
      if (site.guarded) throw new Error("rc.7.13 callsite adjacent to anchor is already guarded: " + label);
      out = out.slice(0, site.start) + replacement + out.slice(site.end);
      report.wrapped.push({ ord: entry.ord, id: entry.id, policy: entry.policy, runId: entry.runId });
    } else {
      // 已包裹 → 逐字节重建比对（policy / runId / options / 实参一次性全验）
      const region = out.slice(p.anchorEnd, p.anchorEnd + replacement.length);
      const legacyReplacement = entry.policy === "PROGRESS"
        ? buildReplacement(entry, innerCall, true) : null;
      const legacyRegion = legacyReplacement
        ? out.slice(p.anchorEnd, p.anchorEnd + legacyReplacement.length) : null;
      if (region === replacement) {
        report.verifiedWrapped.push({ ord: entry.ord, id: entry.id,
          policy: entry.policy, runId: entry.runId });
      } else if (legacyReplacement && legacyRegion === legacyReplacement) {
        out = out.slice(0, p.anchorEnd) + replacement
          + out.slice(p.anchorEnd + legacyReplacement.length);
        report.migratedWrapped.push({ ord: entry.ord, id: entry.id,
          policy: entry.policy, runId: entry.runId,
          fromStructuralLong: "!1", toStructuralLong: entry.structuralLong });
      } else {
        throw new Error("rc.7.13 wired callsite does not match declared policy byte-for-byte: " + label);
      }
      if (String(site.guardKind) !== "guardWrap") {
        throw new Error("rc.7.13 wired callsite has unexpected guardKind for " + label + ": " + site.guardKind);
      }
    }
  }

  const covered = report.wrapped.length + report.verifiedWrapped.length
    + report.migratedWrapped.length + report.verifiedCore.length;
  if (covered !== POLICY_TABLE.length) {
    throw new Error("rc.7.13 covered " + covered + " sites, expected " + POLICY_TABLE.length);
  }
  if (alreadyWired && out !== text && report.migratedWrapped.length === 0) {
    throw new Error("rc.7.13 apply() must be byte-idempotent on an already-wired bundle");
  }
  return { text: out, report };
}

module.exports = {
  apply,
  buildWrapper,
  buildReplacement,
  extractRunId,
  assertTableWellFormed,
  assertAnchorUniqueness,
  isPureAscii,
  countOccurrences,
  findUniqueAnchor,
  MARKER,
  WRAPPER_HOOK,
  CALL_HEAD,
  WRAP_HEAD,
  MIN_ANCHOR_BYTES,
  TOTAL_CALLSITES,
  RETIRED_ORDINALS,
  POLICY_EXPR,
  TIMEOUT_MS,
  SOURCE_MODE,
  POLICY_TABLE,
};
