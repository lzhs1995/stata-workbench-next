"use strict";
/**
 * test_replay_convergence_rc714.js —— 三路收敛门禁
 *
 * 要证的命题（任务包硬要求）：
 *   「两次独立的基线重放」+「从已验收 rc.7.13 迁移」必须产出**同一个**最终 dist：
 *   同 SHA、同归一化指纹、同版本、同覆盖率、同 policy、同作用域判定。
 *
 * 为什么迁移这条腿不能省：
 *   基线路径遇到的是**未包装**的调用点（wiring 会新注入 wrapper，wrapped=12）；
 *   rc.7.13 路径遇到的是**已包装但裸引用**的调用点（wiring 走
 *   `alreadyWired` 分支，逐字节比对 8 个未变 wrapper，并把 rc.7.25 的
 *   4 个固定短窗 PROGRESS wrapper 精确迁移为动态 long-run 策略，且
 *   guard_wiring_rc713.js:474 明令「已接线时 apply() 必须字节幂等」）。
 *   两条路径在代码里走的是**不同分支**，只测一条等于没测。
 *   这也正是全局化改写必须排在 wiring **之前**、且 POLICY_EXPR 本身就发射
 *   全局形态的原因——否则 rc.7.13 路径会在那句字节比对上炸掉。
 *
 * 收敛机制（为什么它能收敛而不是碰巧）：
 *   改写规则是**最终文本的性质**（"除声明点与包装器闭包外不得有裸 guard 引用"），
 *   不是历史的函数，所以路径无关且幂等。两条路径在 finalize 前唯一的差异是
 *   64 位指纹槽（基线=全 0；迁移=rc.7.13 的旧指纹 6fd716cb…），
 *   finalize_bundle_identity 归一化该槽后即逐字节相同。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.join(__dirname, "..");
const REPLAY = require("./test_replay_rc713.js");
const FIN = require("./finalize_bundle_identity.js");
const AST = require("./ast_reachability_gate.js");
const SCOPE = require("./guard_scope_gate.js");
const WIRING = require("./guard_wiring_rc713.js");
const { recreateRc713 } = require("./test_guard_scope_gate.js");

const sha256 = REPLAY.sha256;
const REAL_DIST = path.join(REPO, "dist", "extension.js");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

/** 已验收 rc.7.13 的**字节精确**副本（本任务证据目录，随交付留存） */
const RC713_FIXTURE = process.env.RC713_FIXTURE || path.join(
  REPO, "tests", "fixtures", "extension.js.rc713-54e645da"
);
const RC713_SHA = "54e645dae0087d072dcb7d3c5aacbba072e97708e64c47084628469ff7972067";
const RC713_STALE_FINGERPRINT = "6fd716cb1a19cdbd59ace2810afd97a8d636e5f062007be9e3447a6b096fcb65";
const BASELINE_SHA16 = "95aa8079aa18dcab";

let pass = 0; const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fails.push(name + " — " + ((e && e.message) || e));
              console.log("  FAIL " + name + "  — " + ((e && e.message) || e)); }
}

const trees = [];
/** 造树 → （可选）换种子 → 跑真补丁 → finalize → 提取全部可比指标 */
function replayLeg(label, seedPath) {
  const root = REPLAY.makeReplayTree({});
  trees.push(root);
  if (seedPath) fs.copyFileSync(seedPath, path.join(root, "dist", "extension.js"));
  const seedSha = sha256(fs.readFileSync(path.join(root, "dist", "extension.js")));
  const r = REPLAY.runPatchInTree(root);          // 内含"真仓库 dist 未被动过"断言
  const pre = fs.readFileSync(r.distPath, "utf8");
  const finalized = FIN.finalize(pre);
  const text = typeof finalized === "string" ? finalized : finalized.text;

  const reach = AST.analyze(text);
  const kinds = {};
  reach.callsites.filter((c) => c.guarded).forEach((c) => { kinds[c.guardKind] = (kinds[c.guardKind] || 0) + 1; });
  const gate = SCOPE.gateReport(text);

  return {
    label, seedSha,
    preSha: sha256(Buffer.from(pre, "utf8")),
    preFingerprintSlot: FIN.locateSlot(pre).value,
    finalSha: sha256(Buffer.from(text, "utf8")),
    fingerprint: FIN.fingerprintOf(text),
    bytes: Buffer.byteLength(text, "utf8"),
    coverage: {
      total: reach.callsites.length,
      reachable: reach.callsites.filter((c) => c.reachable).length,
      guarded: reach.callsites.filter((c) => c.reachable && c.guarded).length,
      deadGuarded: reach.callsites.filter((c) => !c.reachable && c.guarded).length,
      kinds,
    },
    scope: {
      ok: gate.ok,
      counts: {
        total: gate.counts.totalCallsites, retired: gate.counts.retired,
        reachable: gate.counts.reachable, guarded: gate.counts.guarded,
        scopeResolvable: gate.counts.scopeResolvable, unresolvable: gate.counts.unresolvable,
        policyMatched: gate.counts.policyMatched, bareViolations: gate.counts.bareViolations,
      },
      exports: gate.counts.exports.map((e) => e.global + ":" + e.exportCount).join(","),
      // rc.7.15：StopCheckpoint 作用域维（块粒度）也必须跨腿一致
      checkpoint: {
        bareViolations: gate.counts.checkpoint.bareViolations,
        outOfScope: gate.counts.checkpoint.outOfScope,
        globalRefs: gate.counts.checkpoint.globalRefs,
        declKind: gate.counts.checkpoint.declKind,
        exports: gate.counts.checkpoint.exports.map((e) => e.global + ":" + e.exportCount).join(","),
      },
    },
    policies: WIRING.POLICY_TABLE.map((e) => e.ord + ":" + e.id + ":" + e.policy).join("|"),
    // 补丁块版本账本：dist **不含**完整 semver（`0.1.3-rc.7.14` 只在 package.json），
    // 里面只有补丁块标记 rc.7.10 / rc.7.13a / rc.7.14 / rc.7.14d 这种形态。
    // 旧写法用 /0\.1\.3-rc\.7\.\d+/ 抽取，三条腿全抽到空串 → 该项跨腿比较恒真（空==空==空），
    // 是我自己门禁里的一处空断言。改为抽真实标记的**计数多重集**：
    // 既能跨腿比对（任一腿少打一个补丁块就会不等），也能证伪"版本块没落进 dist"。
    versionInBundle: (function () {
      const hits = text.match(/rc\.7\.[0-9]+[a-z]*/g) || [];
      const tally = new Map();
      for (const h of hits) tally.set(h, (tally.get(h) || 0) + 1);
      return [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, n]) => k + "×" + n).join("|");
    })(),
    stdout: r.stdout,
  };
}

function main() {
  console.log("=== rc.7.14 三路收敛门禁（基线×2 + rc.7.13 迁移）===\n");

  t("0.1 基线不可变且 sha16=" + BASELINE_SHA16, () => {
    const s = sha256(fs.readFileSync(REPLAY.BASELINE));
    assert.strictEqual(s.slice(0, 16), BASELINE_SHA16, "基线漂移：" + s.slice(0, 16));
  });
  t("0.2 已验收 rc.7.13 夹具在场且字节精确（" + RC713_SHA.slice(0, 16) + "）", () => {
    assert.ok(fs.existsSync(RC713_FIXTURE), "rc.7.13 夹具缺失：" + RC713_FIXTURE);
    assert.strictEqual(sha256(fs.readFileSync(RC713_FIXTURE)), RC713_SHA, "rc.7.13 夹具不是已验收字节");
  });
  t("0.3 夹具确是 rc.7.13 形态：已接线 12 wrapper / 零全局导出 / 旧指纹在槽", () => {
    const src = fs.readFileSync(RC713_FIXTURE, "utf8");
    assert.strictEqual(WIRING.countOccurrences(src, WIRING.WRAP_HEAD), 12, "wrapper 数不是 12（不是已接线态）");
    for (const g of SCOPE.GLOBAL_NAMES) {
      assert.strictEqual(src.split("globalThis." + g + "=").length - 1, 0, g + " 竟已导出（不是 rc.7.13）");
    }
    assert.strictEqual(FIN.locateSlot(src).value, RC713_STALE_FINGERPRINT, "槽位不是 rc.7.13 旧指纹");
  });

  console.log("\n[A] 三条腿各自重放");
  const legs = [];
  t("A.1 基线重放 #1", () => { legs.push(replayLeg("baseline#1", null)); });
  t("A.2 基线重放 #2（独立树）", () => { legs.push(replayLeg("baseline#2", null)); });
  t("A.3 从已验收 rc.7.13 迁移", () => { legs.push(replayLeg("migrate-rc713", RC713_FIXTURE)); });
  if (legs.length !== 3) {
    console.log("\n  三条腿未全部产出（" + legs.length + "/3），后续比较无意义 —— 直接判失败");
    fails.forEach((f) => console.log("   - " + f));
    process.exit(1);
  }

  t("A.4 三条腿的**输入种子确实不同**（否则收敛是同义反复）", () => {
    assert.strictEqual(legs[0].seedSha, legs[1].seedSha, "两次基线重放种子应相同");
    assert.notStrictEqual(legs[2].seedSha, legs[0].seedSha, "迁移腿种子必须不是基线");
    assert.strictEqual(legs[2].seedSha, RC713_SHA);
  });
  t("A.5 两条路径确实走了**不同代码分支**（wrapped vs verifiedWrapped）", () => {
    assert.ok(/RC713_GUARD_WIRING\s+wrapped=12\s+verifiedWrapped=0\s+migratedWrapped=0\s+verifiedCore=3\s+retired=2\s+total=17/.test(legs[0].stdout),
      "基线腿应新注入 12 个 wrapper：" + (legs[0].stdout.match(/RC713_GUARD_WIRING.*/) || ["(无)"])[0]);
    assert.ok(/RC713_GUARD_WIRING\s+wrapped=0\s+verifiedWrapped=8\s+migratedWrapped=4\s+verifiedCore=3\s+retired=2\s+total=17/.test(legs[2].stdout),
      "迁移腿应逐字节校验 8 个既有 wrapper 并精确迁移 4 个 PROGRESS wrapper：" +
        (legs[2].stdout.match(/RC713_GUARD_WIRING.*/) || ["(无)"])[0]);
    // 全局化改写量也必须不同：基线只需改核心引用，rc.7.13 要改全部 33 处
    const g0 = (legs[0].stdout.match(/RC714_GUARD_GLOBALS\s+rewritten=(\d+)/) || [])[1];
    const g2 = (legs[2].stdout.match(/RC714_GUARD_GLOBALS\s+rewritten=(\d+)/) || [])[1];
    assert.ok(g0 && g2, "缺 RC714_GUARD_GLOBALS 日志");
    assert.notStrictEqual(g0, g2, "两条路径改写量竟相同（说明种子没生效）");
    assert.strictEqual(g0, "21", "基线腿应改写 21 处，实际 " + g0);
    assert.strictEqual(g2, "33", "迁移腿应改写 33 处（含 12 个已存在 wrapper 的裸引用），实际 " + g2);
  });
  t("A.5b rc.7.15 StopCheckpoint 全局化在两条腿都真的执行了", () => {
    // 与 guard 全局化不同：rc.7.13 夹具和基线**都**处于「零 checkpoint 导出」态，
    // 故两腿改写量相同（各 8 处）不是"种子没生效"，而是该缺陷在两条历史上同样存在。
    // 这里要断的是「真的跑了且量对」，以及越界数恰为 2（即真机 P0 的那两处）。
    for (const idx of [0, 2]) {
      const m = legs[idx].stdout.match(
        /RC715_CHECKPOINT_GLOBALS\s+export=(\w+)\s+rewritten=(\d+)\s+\(wasResolvable=(\d+), wasOutOfScope=(\d+)\)/
      );
      assert.ok(m, legs[idx].label + " 缺 RC715_CHECKPOINT_GLOBALS 日志：" +
        (legs[idx].stdout.match(/RC715.*/) || ["(无)"])[0]);
      assert.strictEqual(m[1], "injected", legs[idx].label + " 导出应为新注入");
      assert.strictEqual(m[2], "8", legs[idx].label + " 应改写 8 处消费点，实际 " + m[2]);
      assert.strictEqual(m[3], "6", legs[idx].label + " 词法可解析应 6 处");
      assert.strictEqual(m[4], "2", legs[idx].label + " 越界应恰 2 处（human-file enrich / 完成清理）");
    }
  });
  t("A.6 finalize **前**指纹槽不同（这是两条路径唯一的差异来源）", () => {
    assert.strictEqual(legs[0].preFingerprintSlot, FIN.ZERO_SLOT, "基线腿槽位应为 UNFINALIZED 全 0");
    assert.strictEqual(legs[2].preFingerprintSlot, RC713_STALE_FINGERPRINT, "迁移腿槽位应仍是 rc.7.13 旧指纹");
    assert.notStrictEqual(legs[0].preSha, legs[2].preSha, "finalize 前两者不该同 sha");
  });

  console.log("\n[B] 收敛：finalize 后六项指标必须完全一致");
  const ref = legs[0];
  for (const field of ["finalSha", "fingerprint", "bytes", "policies", "versionInBundle"]) {
    t("B." + field + " 三腿一致", () => {
      // 非空断言：跨腿相等对空值恒真，所以先证明这个字段真的抽到了东西。
      assert.ok(String(ref[field]).length > 0, field + " 抽取为空 → 跨腿比较将是空断言");
      for (const l of legs) {
        assert.strictEqual(String(l[field]), String(ref[field]),
          l.label + " 的 " + field + " 不一致：" + String(l[field]).slice(0, 40) +
            " ≠ " + String(ref[field]).slice(0, 40));
      }
    });
  }
  t("B.versionInBundle 确有判别力：含 rc.7.14/14d/14e/15 块，而 rc.7.13 夹具没有", () => {
    // 证明这个字段不是"随便抽点什么都相等"：rc.7.14 系列与 rc.7.15 补丁块标记必须在，
    // 且已验收 rc.7.13 字节里必须**不在**（否则该字段区分不了两个版本）。
    // rc.7.14e = 身份准入 fail-closed 块；rc.7.15 = 本轮 StopCheckpoint 全局化块。
    const ledger = String(ref.versionInBundle);
    for (const mark of ["rc.7.14×", "rc.7.14d×", "rc.7.14e×", "rc.7.15×", "rc.7.16×", "rc.7.17×", "rc.7.18×", "rc.7.19×", "rc.7.19b×", "rc.7.20×", "rc.7.21×", "rc.7.22×", "rc.7.23×", "rc.7.24×", "rc.7.25×", "rc.7.26×", "rc.7.27×", "rc.7.28×"]) {
      assert.ok(ledger.includes(mark), "最终产物缺补丁块标记 " + mark + "：" + ledger);
    }
    const fixture = fs.readFileSync(RC713_FIXTURE, "utf8");
    for (const mark of ["rc.7.14", "rc.7.14d", "rc.7.14e", "rc.7.15", "rc.7.16", "rc.7.17", "rc.7.18", "rc.7.19", "rc.7.19b", "rc.7.20", "rc.7.21", "rc.7.22", "rc.7.23", "rc.7.24", "rc.7.25", "rc.7.26", "rc.7.27", "rc.7.28"]) {
      assert.strictEqual(fixture.includes(mark), false, "rc.7.13 夹具竟含 " + mark + " → 字段无判别力");
    }
  });
  t("B.coverage 三腿覆盖率与 guardKind 分布一致，且为 17/15/15", () => {
    for (const l of legs) {
      assert.deepStrictEqual(l.coverage, ref.coverage, l.label + " 覆盖率不一致");
      assert.strictEqual(l.coverage.total, 17);
      assert.strictEqual(l.coverage.reachable, 15);
      assert.strictEqual(l.coverage.guarded, 15);
      assert.strictEqual(l.coverage.deadGuarded, 0, "退役点被注 guard = 假接线");
      assert.deepStrictEqual(l.coverage.kinds, { guardWrap: 12, guardStage: 2, guardProgress: 1 });
    }
  });
  t("B.scope 三腿作用域判定一致，且全部 15/15 可解析、导出各一次", () => {
    for (const l of legs) {
      assert.deepStrictEqual(l.scope, ref.scope, l.label + " 作用域判定不一致：" + JSON.stringify(l.scope));
      assert.strictEqual(l.scope.ok, true, l.label + " 作用域闸门未通过");
      assert.strictEqual(l.scope.counts.scopeResolvable, 15);
      assert.strictEqual(l.scope.counts.unresolvable, 0);
      assert.strictEqual(l.scope.counts.bareViolations, 0);
      assert.strictEqual(l.scope.exports, "__codexExecGuardRef:1,__codexPreRunGuardRef:1");
    }
  });
  t("B.checkpoint 三腿 StopCheckpoint 作用域一致：零违规、零越界、导出各一次", () => {
    for (const l of legs) {
      assert.deepStrictEqual(l.scope.checkpoint, ref.scope.checkpoint,
        l.label + " checkpoint 判定不一致：" + JSON.stringify(l.scope.checkpoint));
      assert.strictEqual(l.scope.checkpoint.bareViolations, 0, l.label + " 仍有裸消费点");
      assert.strictEqual(l.scope.checkpoint.outOfScope, 0, l.label + " 仍有越界消费点");
      assert.strictEqual(l.scope.checkpoint.exports, "__codexStopCheckpointRef:1");
      assert.strictEqual(l.scope.checkpoint.globalRefs, 28,
        l.label + " 全局引用数应为 28（新增 R16J114 失败恢复保全判断；含 rc.7.30 两条 payload tracking、两次 Stop"
        + " settlement probe，以及 rc.7.35 阶梯的 4 处：hard-fallback 一处别名"
        + " __codexCkpt + force-reset 三处 forceResetReconnectTimeoutMs 探测）");
      assert.ok(/__codexStopCheckpoint:let/.test(l.scope.checkpoint.declKind),
        l.label + " 声明应为 let：" + l.scope.checkpoint.declKind);
    }
  });

  console.log("\n[C] 与真仓库 dist / 版本对齐");
  t("C.1 三腿产物与真仓库 dist 逐字节相同", () => {
    const realSha = sha256(fs.readFileSync(REAL_DIST));
    for (const l of legs) {
      assert.strictEqual(l.finalSha, realSha,
        l.label + " ≠ 真 dist：" + l.finalSha.slice(0, 16) + " vs " + realSha.slice(0, 16));
    }
  });
  t("C.2 package.json / package-lock.json 与版本化 runtime manifest 一致", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "release/runtime-manifest.json"), "utf8"));
    assert.strictEqual(PKG_VERSION, manifest.version, "package.json 与 runtime manifest 版本不一致");
    assert.strictEqual(lock.version, PKG_VERSION, "lock 顶层版本不一致：" + lock.version);
    assert.strictEqual(lock.packages[""].version, PKG_VERSION, "lock packages[\"\"] 版本不一致");
  });
  t("C.2a editor state 以活动标签精确绑定真实 handler 目标，同时保留 raw active", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const start = src.indexOf('if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state"))');
    const end = src.indexOf('if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/debug-active-editor"))', start);
    assert.ok(start >= 0 && end > start, "editor-state GET 路由缺失");
    const route = src.slice(start, end);
    assert.ok(route.includes("rawActive:null"), "未保留原始 activeTextEditor 诊断");
    assert.ok(route.includes("activeTabPath:null"), "未记录 active tab 精确路径");
    assert.ok(route.includes('effectiveEditorSource="active-tab-visible-target"'),
      "未将唯一可见、活动标签精确匹配的编辑器绑定为 handler 目标");
    assert.ok(route.includes("__activeTabPath===__editorStateTarget&&__editorState.visibleTargetCount===1"),
      "active-tab fallback 未同时绑定绝对路径与唯一可见目标");
    assert.ok(route.includes("__editorState.rawActive=__editorStateSnapshot"),
      "raw active 与有效 handler target 未分开记账");
    assert.strictEqual(route.includes("basename"), false,
      "editor-state 不得以 basename 近似匹配 handler 目标");
  });
  t("C.2b rc.7.50 editor focus 默认只聚焦 clean editor，显式恢复模式可聚焦 dirty editor", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const start = src.indexOf('if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus"))');
    const end = src.indexOf('if(__req.method==="GET"&&__req.url&&__req.url.startsWith("/editor-state"))', start);
    assert.ok(start >= 0 && end > start, "editor-focus POST 路由缺失");
    const route = src.slice(start, end);
    assert.ok(route.includes("__editorFocusVisible.length!==1"), "未严格要求唯一 visible target");
    assert.ok(route.includes('__editorFocusQuery.get("allowDirty")==="1"'),
      "dirty recovery 必须由 allowDirty=1 显式启用");
    assert.ok(route.includes("document.isDirty&&!__editorFocusAllowDirty"),
      "默认模式未 fail-closed 拒绝 dirty target");
    assert.ok(route.includes("allowDirty:__editorFocusAllowDirty"),
      "结果未记录 dirty recovery 模式");
    assert.ok(route.includes("isDirty:null"), "结果未预留严格 dirty 状态证据");
    assert.ok(route.includes("__editorFocus.isDirty===true:__editorFocus.isDirty===false"),
      "聚焦成功未绑定到请求的 dirty/clean 状态");
    assert.ok(route.includes("window.showTextDocument"), "未聚焦已有 text editor");
    assert.ok(route.includes("__editorFocusActivePath!==__editorFocusReal"),
      "group fallback 只能在首次全局 active 路径不收敛时执行");
    assert.ok(route.includes("workbench.action.focusSeventhEditorGroup"),
      "未覆盖实测失败的第七 editor group");
    assert.strictEqual(route.includes("focusNinthEditorGroup"), false,
      "未明确定义的第九及更高组必须 fail closed");
    assert.ok(route.includes("groupFallbackAttempted:false"),
      "未记录 group fallback 是否实际执行");
    assert.ok(route.includes("editorAreaFocusAttempted:false"),
      "未记录 group fallback 前的 editor-area focus 是否执行");
    assert.ok(route.includes("windowFocusAttempted:false"),
      "未记录 group fallback 前的 workbench-window focus 是否执行");
    assert.ok(route.includes("handlerTargetBound:false"),
      "未记录真实快捷键 handler 的目标绑定");
    assert.ok(route.includes("activeTextEditorPath:null") && route.includes("activeTabPath:null"),
      "未分开记录 stale activeTextEditor 与 active tab");
    assert.ok(route.includes("if(!__editorFocus.handlerTargetBound&&__editorFocusActivePath!==__editorFocusReal)"),
      "活动标签已经精确绑定时仍会执行无效 group churn");
    assert.ok(route.includes("__editorFocus.ok=__editorFocus.handlerTargetBound&&"),
      "focus 成功没有绑定到真实 handler 将消费的活动标签");
    assert.ok(route.includes("if(__editorFocus.handlerTargetBound){") &&
      route.includes("__editorFocus.editorAreaFocusAttempted=true;"),
      "活动标签已精确绑定时未把焦点从 Output 等面板移回 editor area");
    const boundFocusStart = route.indexOf("if(__editorFocus.handlerTargetBound){");
    const fallbackStart = route.indexOf("if(!__editorFocus.handlerTargetBound&&", boundFocusStart);
    const boundFocus = route.slice(boundFocusStart, fallbackStart);
    assert.ok(boundFocus.includes('executeCommand("workbench.action.focusActiveEditorGroup")'),
      "handler-bound 分支未执行无按键 editor-area focus");
    assert.ok(boundFocus.includes("iA.window.state?.focused===true") &&
      boundFocus.includes('executeCommand("workbench.action.focusWindow")'),
      "已在前台的 handler-bound 分支未恢复 workbench 命令上下文");
    assert.ok(boundFocus.includes("__editorFocusActive=iA.window.activeTextEditor"),
      "handler-bound editor-area focus 后未重读 active editor");
    assert.strictEqual(
      boundFocus.includes('if(iA.window.state?.focused===true){__editorFocus.windowFocusAttempted=true;'),
      true, "focusWindow 必须只在 Code 窗口已处于前台时执行");
    assert.ok(route.includes("groupFallbackWaited:false"),
      "未记录 group fallback 有界等待证据");
    assert.ok(route.includes("groupFallbackObserved:false"),
      "未记录 group fallback 全局 active editor 证明");
    assert.ok(route.includes("cycleFallbackAttempted:false"),
      "未记录 bounded group-cycle 是否实际执行");
    assert.ok(route.includes("cycleFallbackVisitedColumns:[]"),
      "未记录 bounded group-cycle 访问过的 editor groups");
    assert.ok(route.includes("commands.executeCommand(__editorFocusGroupCommand)"),
      "未通过精确 editor-group command 执行有界 focus fallback");
    assert.ok(route.includes('executeCommand("workbench.action.focusActiveEditorGroup")'),
      "切换 editor group 前未先把工作台焦点放回 active editor area");
    const groupCommand = route.indexOf("executeCommand(__editorFocusGroupCommand)");
    const fallbackWindowFocus = route.lastIndexOf(
      'executeCommand("workbench.action.focusWindow")', groupCommand);
    const fallbackEditorAreaFocus = route.lastIndexOf(
      'executeCommand("workbench.action.focusActiveEditorGroup")', groupCommand);
    assert.ok(
      fallbackWindowFocus >= 0 && fallbackWindowFocus < fallbackEditorAreaFocus,
      "workbench-window focus 必须严格先于 editor-area focus");
    assert.ok(
      fallbackEditorAreaFocus < groupCommand,
      "editor-area focus 必须严格先于精确 group command");
    assert.ok(route.includes("onDidChangeActiveTextEditor(__editorFocusFinish)"),
      "group focus 后未有界等待 active editor 事件");
    assert.ok(route.includes("setTimeout(__editorFocusFinish,500)"),
      "group focus 事件等待必须固定为 500ms");
    assert.strictEqual(
      route.includes("executeCommand(__editorFocusGroupCommand);await iA.window.showTextDocument"),
      false, "group command 后不得立即二次 showTextDocument 覆盖未落地的组焦点");
    assert.ok(route.includes('cycleFallbackCommand="workbench.action.focusPreviousGroup"'),
      "精确组命令失败后未按现有组拓扑执行 bounded previous-group fallback");
    assert.ok(route.includes("Math.min(32,Math.max(1,__editorFocusVisibleColumns.length))"),
      "group-cycle 未同时受可见组数与硬上限约束");
    assert.ok(route.includes("setTimeout(__editorFocusCycleFinish,200)"),
      "每次 group-cycle 未使用固定 200ms 有界观察窗");
    assert.ok(
      route.indexOf("onDidChangeActiveTextEditor(__editorFocusCycleFinish)") <
        route.indexOf("executeCommand(__editorFocus.cycleFallbackCommand)"),
      "group-cycle 必须先安装 active-editor 监听再执行 focus command");
    assert.ok(route.includes("cycleFallbackObserved=true;break"),
      "group-cycle 未以全局 active 路径和原始 viewColumn 收敛为唯一退出条件");
    assert.ok(route.includes("commandOpenFallbackAttempted:false"),
      "未记录 vscode.open fallback 是否实际执行");
    assert.ok(route.includes('executeCommand("vscode.open",__editorFocusEditor.document.uri'),
      "最终 workbench fallback 必须复用唯一可见 target 的既有 URI");
    assert.ok(route.includes("viewColumn:__editorFocusEditor.viewColumn,preserveFocus:false,preview:false"),
      "vscode.open fallback 未绑定原始 viewColumn 且显式获取焦点");
    assert.ok(
      route.indexOf("onDidChangeActiveTextEditor(__editorFocusOpenFinish)") <
        route.indexOf('executeCommand("vscode.open"'),
      "vscode.open fallback 必须先安装 active-editor 监听");
    assert.ok(route.includes("setTimeout(__editorFocusOpenFinish,500)"),
      "vscode.open fallback 未使用固定 500ms 有界观察窗");
    assert.ok(route.includes("commandOpenFallbackObserved=__editorFocusActivePath===__editorFocusReal"),
      "vscode.open fallback 未以最终全局 active 身份作为结果证据");
    assert.ok(route.includes("__editorFocusActive?.viewColumn===__editorFocusEditor.viewColumn"),
      "fallback 后必须仍以全局 active 路径与原 editor group 为终局证明");
    assert.strictEqual(route.includes("openTextDocument"), false, "不得打开新 renderer");
    assert.strictEqual(/\.edit\s*\(|applyEdit|save\s*\(/.test(route), false,
      "focus-only 路由不得编辑或保存文档");
  });
  t("C.2c rc.7.33 editor select 合同只设置 clean editor 选区", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const start = src.indexOf('if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-select"))');
    const end = src.indexOf('if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus"))', start);
    assert.ok(start >= 0 && end > start, "editor-select POST 路由缺失");
    const route = src.slice(start, end);
    assert.ok(route.includes("__editorSelectVisible.length!==1"), "未严格要求唯一 visible target");
    assert.ok(route.includes("document.isDirty"), "未 fail-closed 拒绝 dirty target");
    assert.ok(route.includes("new iA.Selection"), "未通过 VS Code Selection API 设置选区");
    assert.ok(route.includes("selectionSha256"), "未返回选区 SHA 证据");
    assert.ok(route.includes("handlerTargetBound:false"),
      "selection 未记录真实快捷键 handler 的目标绑定");
    assert.ok(route.includes("__editorSelectActual=__editorSelectEditor.selection"),
      "selection 仍错误地从 stale activeTextEditor 取证");
    assert.ok(route.includes("__editorSelect.ok=__editorSelect.handlerTargetBound&&"),
      "selection 成功没有绑定到活动标签精确路径");
    assert.ok(route.includes("__editorSelectTabPath===__editorSelectReal"),
      "selection 未要求活动标签绝对路径精确匹配");
    assert.ok(route.includes("codex patch r16j106: select blank-line terminator"),
      "selection 未包含单空行换行符修复标记");
    assert.ok(route.includes("__editorSelectStartPos.isEqual(__editorSelectEndBase)"),
      "selection 未把零长度范围限定为单空行分支");
    assert.ok(route.includes("__editorSelectEnd<__editorSelectDocument.lineCount"),
      "selection 未在读取下一行前证明下一行存在");
    assert.ok(route.includes("__editorSelectDocument.lineAt(__editorSelectEnd).range.start:__editorSelectEndBase"),
      "selection 未以下一行行首表示空行的既有换行符");
    const blankRangeExpressions = route.match(
      /__editorSelectUsesLineTerminator=([^,]+),__editorSelectEndPos=([^,]+),__editorSelectRange=/);
    assert.ok(blankRangeExpressions, "无法从真实路由提取空行范围表达式");
    const chooseEnd = new Function(
      "__editorSelectStartPos", "__editorSelectEndBase",
      "__editorSelectEnd", "__editorSelectDocument",
      `const __editorSelectUsesLineTerminator=${blankRangeExpressions[1]};` +
      `const __editorSelectEndPos=${blankRangeExpressions[2]};` +
      "return {usesLineTerminator:__editorSelectUsesLineTerminator,endPos:__editorSelectEndPos};");
    const position = (line, character) => ({
      line, character,
      isEqual(other) {
        return !!other && other.line === line && other.character === character;
      },
    });
    const document = {
      lineCount: 10,
      lineAt(index) { return {range: {start: position(index, 0)}}; },
    };
    const normalEnd = position(7, 12);
    const normal = chooseEnd(position(7, 0), normalEnd, 8, document);
    assert.strictEqual(normal.usesLineTerminator, false,
      "普通非空单行不得扩展到下一行");
    assert.strictEqual(normal.endPos, normalEnd,
      "普通非空单行必须保留既有行尾");
    const blankStart = position(7, 0);
    const blank = chooseEnd(blankStart, position(7, 0), 8, document);
    assert.strictEqual(blank.usesLineTerminator, true,
      "中间单空行必须选择其换行符");
    assert.deepStrictEqual(
      {line: blank.endPos.line, character: blank.endPos.character},
      {line: 8, character: 0},
      "中间单空行的终点必须是下一行行首");
    assert.strictEqual(blankStart.isEqual(blank.endPos), false,
      "中间单空行修复后必须形成非空换行符范围");
    assert.strictEqual(
      (route.match(/&&!__editorSelectActual\.isEmpty/g) || []).length, 1,
      "editor-select 必须继续唯一地强制真实选区非空，不能靠放宽门禁通过");
    const eofEnd = position(9, 0);
    const eofStart = position(9, 0);
    const eofBlank = chooseEnd(eofStart, eofEnd, 10, document);
    assert.strictEqual(eofBlank.usesLineTerminator, false,
      "无后继行的 EOF 空行必须继续 fail-closed");
    assert.strictEqual(eofBlank.endPos, eofEnd,
      "EOF 空行不得读取不存在的下一行");
    assert.strictEqual(eofStart.isEqual(eofBlank.endPos), true,
      "EOF 空行必须保持空范围并由严格 isEmpty 门禁 fail-closed");
    assert.strictEqual(route.includes("openTextDocument"), false, "不得打开新 renderer");
    assert.strictEqual(/\.edit\s*\(|applyEdit|save\s*\(/.test(route), false,
      "selection-only 路由不得编辑或保存文档");
  });
  t("C.2c2 rc.7.66 editor close 以唯一 clean active tab 对象为关闭权限", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const start = src.indexOf('if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-close"))');
    const end = src.indexOf('if(__req.method==="POST"&&__req.url&&__req.url.startsWith("/editor-focus"))', start);
    assert.ok(start >= 0 && end > start, "editor-close POST 路由缺失");
    const route = src.slice(start, end);
    for (const token of ["visibleTargetCountBefore!==1", "active-tab-mismatch",
      "active-tab-not-active", "window-not-focused", "target-editor-not-clean",
      "tabGroups.close(__editorCloseTab,true)", "tabCloseAccepted",
      "visibleTargetCountAfter===0"]) {
      assert.ok(route.includes(token), `editor-close 缺少闭环证据: ${token}`);
    }
    assert.strictEqual(route.includes("active-text-editor-mismatch"), false,
      "activeTextEditor 是诊断字段，不得否决已精确绑定的 active tab");
    assert.strictEqual(route.includes('executeCommand("workbench.action.closeActiveEditor")'), false,
      "不得通过可能受 stale activeTextEditor 影响的 command context 关闭");
    assert.strictEqual(/keystroke|key code|showTextDocument|openTextDocument|save\s*\(/.test(route), false,
      "editor-close 不得发键、打开、保存或修改文档");
  });
  t("C.2d 真实 Run Selection/File handler 均按活动标签重同步 stale activeTextEditor", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    for (const [name, startNeedle, endNeedle] of [
      ["selection", "async function OHg()", "async function xHg()"],
      ["file", "async function xHg()", "async function VHg()"],
    ]) {
      const start = src.indexOf(startNeedle);
      const end = src.indexOf(endNeedle, start + startNeedle.length);
      assert.ok(start >= 0 && end > start, name + " handler 边界缺失");
      const body = src.slice(start, end);
      assert.ok(body.includes("tabGroups?.activeTabGroup?.activeTab"),
        name + " handler 未读取活动标签");
      assert.ok(body.includes("__codexActiveTabPath") && body.includes("showTextDocument(__codexActiveTabDoc"),
        name + " handler 未按活动标签重取精确 TextEditor");
      assert.ok(body.includes("Run Selection/File resync stale activeTextEditor from active tab"),
        name + " handler 缺少 active-tab resync 归属标记");
    }
  });
  t("C.3 幂等：对最终产物再跑一遍 finalize 不改字节", () => {
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const again = FIN.finalize(src);
    const text = typeof again === "string" ? again : again.text;
    assert.strictEqual(sha256(Buffer.from(text, "utf8")), sha256(Buffer.from(src, "utf8")),
      "finalize 非幂等");
  });
  t("C.4 逆变换重建的 rc.7.13 形态仍被闸门判死（判据不依赖夹具是否在场）", () => {
    const rebuilt = recreateRc713(fs.readFileSync(REAL_DIST, "utf8"));
    const g = SCOPE.gateReport(rebuilt);
    assert.strictEqual(g.ok, false, "重建的 rc.7.13 形态竟通过闸门");
    assert.strictEqual(g.counts.unresolvable, 9, "重建体不可解析数应为 9");
  });
  t("C.5 逆变换重建的 rc.7.14 checkpoint 形态被判死，且越界恰 7 处", () => {
    // rc.7.15 的判别力证明：把最终产物折回 rc.7.14 的 checkpoint 形态后，
    // 同一打包门必须失败，且 guard 侧 15/15 不受影响（说明两维互不污染）。
    const CKPT_TEST = require("./test_checkpoint_scope_rc715.js");
    const rebuilt = CKPT_TEST.recreateRc714(fs.readFileSync(REAL_DIST, "utf8"));
    const g = SCOPE.gateReport(rebuilt);
    assert.strictEqual(g.ok, false, "重建的 rc.7.14 checkpoint 形态竟通过闸门");
    assert.strictEqual(g.counts.checkpoint.outOfScope, 7, "越界数应为 7");
    assert.strictEqual(g.counts.scopeResolvable, 15, "guard 侧不该受影响");
    assert.strictEqual(g.counts.unresolvable, 0, "guard 侧不该受影响");
  });

  t("C.6 R16J91 Data Browser/execution isolation gate is wired into the bundle", () => {
    // Probes copied verbatim out of the patched bundle, never typed from memory.
    const src = fs.readFileSync(REAL_DIST, "utf8");
    const one = (needle, why) => assert.strictEqual(
      src.split(needle).length - 1, 1, why + " (expected exactly 1)");

    one('"scripts","data_browser_execution_gate.js"',
      "网关模块未通过打包 require 链载入");
    one("globalThis.__codexDbGate=globalThis.__codexDbGate||__codexDbGateMod.getSharedGate({",
      "MCP 与 Data Browser 未共享同一 gate 单例");

    // Synchronous reservation must sit before this._pending and before any await.
    one("let __execGate=globalThis.__codexDbGate||null,__execRes=null;",
      "_enqueue 未同步预约执行权");
    const reserveAt = src.indexOf("__execGate.reserveExecution({op:A,runId:String(n)})");
    const pendingAt = src.indexOf("this._pending+=1", reserveAt);
    assert.ok(reserveAt > 0 && pendingAt > reserveAt,
      "预约必须发生在 this._pending+=1 之前");
    const firstAwaitAt = src.indexOf("await", reserveAt);
    assert.ok(firstAwaitAt > pendingAt, "预约与首个 await 之间不得有等待");

    // Drain strictly precedes _ensureClient and Q(m).
    const drainAt = src.indexOf("__execGate.waitForHttpDrain(__execRes,5e3)");
    const ensureAt = src.indexOf("await this._ensureClient()", drainAt);
    assert.ok(drainAt > 0 && ensureAt > drainAt,
      "drain 必须在 _ensureClient 之前");
    one("__drainErr.gateCode=__execDrain.code", "drain 失败未产生独立 fail-closed 错误");

    // Release from the real promise d, never from the outer race.
    one("__execRes&&__execGate&&__execGate.releaseExecution(__execRes)}})();",
      "释放未绑定到真实 promise d 的 finally");
    const raceAt = src.indexOf("Promise.race([d,c])");
    const releaseAt = src.indexOf("__execGate.releaseExecution(__execRes)");
    assert.ok(releaseAt > 0 && raceAt > releaseAt,
      "释放必须先于 Promise.race，即位于 d 内部而非外层竞速");

    // HTTP admission + exactly-once settlement.
    one("__dbGate.beginHttp({path:E.pathname,method:I.method,baseUrl:E.origin})",
      "_performRequest 未在建立 socket 前申请准入");
    one('__dbSettle("response-end")', "response end 不是唯一的安全结算点");
    one('__dbSettle("timeout")', "socket timeout 未标记不确定");
    assert.ok(src.includes('__dbSettle("error")'), "socket error 未标记不确定");
    one("__dbGate.markHttpStarted(__dbTok),__dbStarted=true,__dbGate.armWallWatchdog(__dbTok)",
      "未记录 socket 已启动/未设置私有 started 标志/未武装 32s 看门狗");

    // Gate refusals are excluded from credential recovery.
    one("let __dbGateCode=(B&&B.gateCode)||null,__dbRecoverable=!__dbGateCode&&",
      "gate 拒绝仍会消费 dataset 凭据恢复次数");

    // R16J91 audit repairs: lexical scope, settle-once adapter, response
    // emitters, Map-shaped PIDs with liveness, real run id, capture ordering.
    const locals = src.indexOf("__dbTok=null,__dbStarted=false,__dbSettled=false");
    const tryAt = src.indexOf("try{let E=new URL(A)", locals < 0 ? 0 : locals);
    assert.ok(locals > 0 && locals < tryAt,
      "lifecycle locals 必须声明在 try 之外，否则 catch 里是 ReferenceError");
    assert.strictEqual(src.includes('t.Connection="close";let __dbGate='), false,
      "内层重复声明会遮蔽外层 locals（P0-1 回归）");
    one("__dbSettle=function(__oc)", "缺少 settle-once 适配器");
    assert.strictEqual(src.includes("__dbTok.startedAt"), false,
      "冻结的公开 token 没有 startedAt，不得据此判断是否已开始");
    one("__dbSettle(__dbStarted?", "catch 未使用私有 started 标志");
    one("pidAlive:function(__pid)", "共享 gate 未注入非侵入式 PID 存活探针");
    assert.ok(src.includes("Array.from((globalThis.__codexOwnedBackendPids||new Map).keys())"),
      "owned PID 是 Map，必须用 keys() 提取");
    assert.strictEqual(src.includes("__codexOwnedBackendPids||[]).slice"), false,
      "对 Map 调用 .slice 会抛错并静默记成空数组");
    one("runId:(s&&s.runId)||null", "run id 必须取自 bridge 而非不存在的全局");
    assert.strictEqual(src.includes("__codexLifecycleRunId"), false,
      "该全局没有写入者，取值恒为 null");
    const capAt = src.indexOf('__dbResetGate.captureDiagnostic({reason:"force-reset:');
    for (const [needle, why] of [
      ["__codexForceResetWasBusy=!!s.busy", "取证必须早于 reset 路径首次读写 busy"],
      ["__codexExecution.finishRun", "取证必须早于 finishRun"],
      ["powershell.exe", "取证必须早于 Windows panic-kill 分支"],
      ["s.runId=null", "取证必须早于 runId 清除"],
    ]) {
      assert.ok(capAt > 0 && src.indexOf(needle, capAt) > capAt, why);
    }
    // r16j92 P1-1: 提前收尾必须 reject，而不是只把 gate 结算掉。
    for (const [needle, why] of [
      ['n.on("close",()=>{__dbSettle("abort")&&C(', "response 提前 close 未 reject"],
      ['s.on("close",()=>{__dbSettle("abort")&&C(', "request 提前 close 未 reject"],
      ['s.on("abort",()=>{__dbSettle("abort")&&C(', "request abort 未 reject"],
      ['n.on("aborted",()=>{__dbSettle("abort")&&C(', "response aborted 未 reject"],
    ]) { assert.ok(src.includes(needle), why); }
    one("__reconnect.ok===true&&__dbResetGen!==null){",
      "健康世代的 force reset 也必须围栏旧 token");
    one("__dbRotGate.rotateChannel({verifiedFresh:true", "凭据 origin 变更未旋转 generation");
    one("__dbResetGate.resetAfterReconnect({reconnectOk:true,expectedGeneration:__dbResetGen,expectedUncertaintyId:__dbResetUnc})",
      "reconnect 清除未绑定 generation + uncertainty 身份");
    one("executionGate:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.snapshot()",
      "/status 未暴露 gate 快照");
    one("executionGateDiagnostic:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.lastDiagnostic",
      "/status 未暴露最后一次 wedge 取证");

    // The pre-existing progress sentinel must be untouched.
    assert.ok(src.includes("Workbench progress sentinel"),
      "既有 progress sentinel 不得被移除");
  });

  for (const root of trees) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ } }

  console.log("\n" + "=".repeat(60));
  console.log("  PASS=" + pass + "  FAIL=" + fails.length);
  console.log("  CONVERGED finalSha=" + ref.finalSha.slice(0, 16) +
              "  fingerprint=" + String(ref.fingerprint).slice(0, 16) +
              "  bytes=" + ref.bytes + "  version=" + PKG_VERSION);
  if (fails.length) { fails.forEach((f) => console.log("   - " + f)); process.exit(1); }
  console.log("  RC714_THREE_WAY_CONVERGENCE_OK");
}

if (require.main === module) main();
module.exports = { replayLeg, RC713_FIXTURE, RC713_SHA };
