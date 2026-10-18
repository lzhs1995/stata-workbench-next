"use strict";
/**
 * test_guard_wiring_rc713.js —— 声明式接线模块（guard_wiring_rc713.js）单测
 *
 * 这份门禁替代的是什么：旧接线脚本从 manifest 里模糊匹配 policy，匹配不上就
 * **静默回落 SHORT_INTERNAL**（30s 超时套到长跑作业上＝错误地取消用户的真作业），
 * 且依赖 charOffset。现在策略是声明式硬表，任何对不上都必须**抛异常而非回落**。
 *
 * 三条最要紧的性质：
 *   1) 15 条策略与 17 个调用点按 ordinal 严格对齐，退役点 [8,12] 永不接线；
 *   2) 每条 anchor 在**基线**与**打完核心补丁的中间态**里都唯一
 *      （只验最终 dist 是自欺：wrapper 前缀会凭空制造唯一性）；
 *   3) 缺锚点 / 锚点重复 / 锚点过短 / policy 未知 / 覆盖退役点 一律 fail-closed。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const G = require("./guard_wiring_rc713.js");
const AST = require("./ast_reachability_gate.js");
const { makeReplayTree, runPatchInTree, BASELINE } = require("./test_replay_rc713.js");

let pass = 0; const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fails.push(name + " — " + ((e && e.message) || e));
              console.log("  FAIL " + name + "  — " + ((e && e.message) || e)); }
}
/** 临时改一条表项跑负例，无论成败都还原（表是按引用导出的，必须还原干净） */
function withMutatedEntry(ord, patch, fn) {
  const e = G.POLICY_TABLE.find((x) => x.ord === ord);
  assert.ok(e, "找不到 ordinal #" + ord);
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = e[k];
  Object.assign(e, patch);
  try { fn(e); } finally { Object.assign(e, saved); }
}
const throws = (fn, re, msg) => assert.throws(fn, re, msg);

(function main() {
  console.log("=== rc.7.13 声明式接线单测 ===\n");

  console.log("[A] 策略表自洽性");
  t("A.1 表结构合法（id/ordinal 无重、policy 已知、mode 合法、锚点 ≥" + G.MIN_ANCHOR_BYTES + "B 且纯 ASCII）", () => {
    G.assertTableWellFormed();
  });
  t("A.2 覆盖 15 条 = 17 个调用点 − 2 个退役点", () => {
    assert.strictEqual(G.POLICY_TABLE.length, 15, "表项数不是 15");
    assert.strictEqual(G.TOTAL_CALLSITES, 17, "调用点总数常量不是 17");
    assert.deepStrictEqual(G.RETIRED_ORDINALS.slice().sort((a, b) => a - b), [8, 12], "退役集不是 [8,12]");
    assert.strictEqual(G.POLICY_TABLE.length + G.RETIRED_ORDINALS.length, G.TOTAL_CALLSITES, "15+2≠17");
  });
  t("A.3 transport policy 分布 = RECOVERY4 / SHORT_INTERNAL4 / ABSOLUTE-60s2 / PROGRESS5", () => {
    const d = {};
    G.POLICY_TABLE.forEach((e) => { d[e.policy] = (d[e.policy] || 0) + 1; });
    assert.deepStrictEqual(d, {
      RECOVERY: 4, SHORT_INTERNAL: 4, "ABSOLUTE-60s": 2, PROGRESS: 5,
    }, "分布不符：" + JSON.stringify(d));
  });
  t("A.4 mode 分布 = wrap12 / core3，且 core 站点的 guardKind 都已声明", () => {
    const m = {};
    G.POLICY_TABLE.forEach((e) => { m[e.mode] = (m[e.mode] || 0) + 1; });
    assert.deepStrictEqual(m, { wrap: 12, core: 3 }, "mode 分布不符：" + JSON.stringify(m));
    G.POLICY_TABLE.filter((e) => e.mode === "core").forEach((e) => {
      assert.ok(/^guard(Stage|Progress|Wrap)$/.test(e.guardKind || ""), "#" + e.ord + " core 站点 guardKind 缺失/非法");
      assert.ok(e.anchor.includes(e.guardKind + "("), "#" + e.ord + " core 锚点未内嵌 " + e.guardKind + "(");
    });
  });
  t("A.5 每个 policy 都有超时/表达式定义，SHORT_INTERNAL=30s、ABSOLUTE-60s=60s、ABSOLUTE-120s=120s", () => {
    for (const e of G.POLICY_TABLE) assert.ok(G.POLICY_EXPR[e.policy], "缺 POLICY_EXPR：" + e.policy);
    assert.strictEqual(G.TIMEOUT_MS.SHORT_INTERNAL, 30000, "SHORT_INTERNAL 不是 30s");
    assert.strictEqual(G.TIMEOUT_MS["ABSOLUTE-60s"], 60000, "ABSOLUTE-60s 不是 60s");
    assert.strictEqual(G.TIMEOUT_MS["ABSOLUTE-120s"], 120000, "ABSOLUTE-120s 不是 120s");
  });
  t("A.6 每个 wrap PROGRESS 点都有同作用域动态 long-run 判定", () => {
    const progress = G.POLICY_TABLE.filter((e) => e.mode === "wrap" && e.policy === "PROGRESS");
    assert.strictEqual(progress.length, 4, "wrap PROGRESS 不是 4 条");
    progress.forEach((e) => {
      assert.ok(typeof e.structuralLong === "string" && e.structuralLong.length > 0,
        "#" + e.ord + " 缺 structuralLong");
      assert.notStrictEqual(e.structuralLong, "!1", "#" + e.ord + " 仍写死短窗");
    });
  });
  console.log("\n[B] 锚点唯一性：基线 + 打完核心补丁的中间态（不只验最终 dist）");
  let intermediate = null;
  t("B.1 15 条锚点在**原始基线** 95aa8079 中各出现恰好 1 次", () => {
    const src = fs.readFileSync(BASELINE, "utf8");
    const rows = G.assertAnchorUniqueness(src, "baseline");
    assert.strictEqual(rows.length, 15, "校验条数不是 15");
    const shortest = rows.reduce((a, b) => (a.bytes <= b.bytes ? a : b));
    assert.ok(shortest.bytes >= G.MIN_ANCHOR_BYTES,
      "最短锚点 " + shortest.bytes + "B < " + G.MIN_ANCHOR_BYTES + "B（#" + shortest.ord + "）");
  });
  t("B.2 取到「打完核心补丁、尚未接线」的中间态原文", () => {
    const capture = path.join(os.tmpdir(), "rc713-intermediate-" + process.pid + ".js");
    const root = makeReplayTree({ captureIntermediate: capture });
    try {
      runPatchInTree(root);
      assert.ok(fs.existsSync(capture), "替身没落盘中间态（apply 未被调用？）");
      intermediate = fs.readFileSync(capture, "utf8");
      assert.strictEqual(G.countOccurrences(intermediate, G.WRAP_HEAD), 0,
        "中间态里竟已有 wrapper，说明抓的不是接线前的文本");
      assert.strictEqual(G.countOccurrences(intermediate, G.CALL_HEAD), 17, "中间态调用点数不是 17");
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
      try { fs.rmSync(capture, { force: true }); } catch { /* 同上 */ }
    }
  });
  t("B.3 15 条锚点在**中间态**中也各出现恰好 1 次（接线真正要改的那份文本）", () => {
    assert.ok(intermediate, "B.2 未取到中间态，无法校验");
    const rows = G.assertAnchorUniqueness(intermediate, "intermediate");
    assert.strictEqual(rows.length, 15, "校验条数不是 15");
  });
  t("B.4 中间态里 17 个调用点按 ordinal 与表对齐，退役点仍为 [8,12]", () => {
    assert.ok(intermediate, "B.2 未取到中间态");
    const r = AST.analyze(intermediate);
    assert.strictEqual(r.callsites.length, 17, "AST 调用点数不是 17");
    const deadOrds = r.callsites.map((c, i) => (c.reachable ? null : i + 1)).filter(Boolean);
    assert.deepStrictEqual(deadOrds, [8, 12], "中间态退役序号不是 [8,12]：" + deadOrds);
  });
  console.log("\n[C] 负例：一律 fail-closed，禁止静默回落");
  t("C.1 锚点在文本中**找不到** → 抛 missing，不静默跳过", () => {
    assert.ok(intermediate, "需要中间态");
    // 改表而不是改文本：删 80 字节压缩代码会先撞 acorn 语法错（也算 fail-closed，
    // 但那是另一道闸门）。这里要精确验的是「锚点定位失败必须抛」。
    const absent = "/*rc713-negative-probe-anchor-that-must-not-exist-in-any-bundle-xxxxxxxxxxxxxxxx*/";
    assert.ok(absent.length >= G.MIN_ANCHOR_BYTES, "负例锚点自身太短");
    assert.strictEqual(G.countOccurrences(intermediate, absent), 0, "负例锚点竟真的在 bundle 里");
    withMutatedEntry(1, { anchor: absent }, () => {
      throws(() => G.apply(intermediate), /missing rc\.7\.13 anchor/, "锚点找不到却没抛错（会漏接线）");
    });
  });
  t("C.2 锚点在文本中**重复** → 抛 non-unique，不赌第一个", () => {
    assert.ok(intermediate, "需要中间态");
    const victim = G.POLICY_TABLE[0];
    // 追加成注释：AST 看不见（调用点仍 19），但字符串计数变 2 → 必须被唯一性闸门拦下
    const broken = intermediate + "\n//" + victim.anchor + "\n";
    throws(() => G.apply(broken), /non-unique rc\.7\.13 anchor|anchor not unique|count=2/,
      "锚点重复却没抛错（可能接到错误位置）");
  });
  t("C.3 锚点**过短**（< " + G.MIN_ANCHOR_BYTES + "B）→ 表结构校验直接抛", () => {
    withMutatedEntry(1, { anchor: "zg.runSelection(" }, () => {
      throws(() => G.assertTableWellFormed(), /shorter than 80 bytes/, "过短锚点竟被放行");
    });
  });
  t("C.4 policy **未知** → 抛 unknown policy，不回落 SHORT_INTERNAL（这正是旧脚本的病）", () => {
    withMutatedEntry(7, { policy: "TOTALLY_MADE_UP" }, () => {
      throws(() => G.assertTableWellFormed(), /unknown rc\.7\.13 policy/, "未知 policy 竟被放行");
    });
  });
  t("C.5 表项**覆盖退役点** → 抛 must not cover retired ordinal", () => {
    withMutatedEntry(16, { ord: 12 }, () => {
      throws(() => G.assertTableWellFormed(), /must not cover retired ordinal #12/, "竟允许给退役点接线");
    });
  });
  t("C.6 mode **非法** → 抛 unknown mode", () => {
    withMutatedEntry(1, { mode: "sorta-wrap" }, () => {
      throws(() => G.assertTableWellFormed(), /unknown rc\.7\.13 mode/, "非法 mode 竟被放行");
    });
  });
  t("C.7 负例跑完后表已完整还原（没污染后续门禁）", () => {
    G.assertTableWellFormed();
    assert.strictEqual(G.POLICY_TABLE.length, 15, "表长变了");
    const d = {};
    G.POLICY_TABLE.forEach((e) => { d[e.policy] = (d[e.policy] || 0) + 1; });
    assert.deepStrictEqual(d, {
      RECOVERY: 4, SHORT_INTERNAL: 4, "ABSOLUTE-60s": 2, PROGRESS: 5,
    }, "policy 分布被负例污染：" + JSON.stringify(d));
  });
  t("C.8 PROGRESS 动态 long-run 表达式缺失 → fail-closed", () => {
    withMutatedEntry(6, { structuralLong: "" }, () => {
      throws(() => G.assertTableWellFormed(), /missing structuralLong expression/,
        "PROGRESS 缺 long-run 判定竟被放行");
    });
  });
  console.log("\n[D] apply() 端到端：真接线 + 幂等 + 替换文本可预测");
  t("D.1 对中间态 apply 一次 → 12 处新接线、3 处核心已守卫、退役 2、总 17", () => {
    assert.ok(intermediate, "需要中间态");
    const { text, report } = G.apply(intermediate);
    assert.strictEqual(report.wrapped.length, 12, "wrapped 不是 12：" + report.wrapped.length);
    assert.strictEqual(report.verifiedCore.length, 3, "verifiedCore 不是 3：" + report.verifiedCore.length);
    assert.strictEqual(report.verifiedWrapped.length, 0, "中间态竟已有已包裹站点");
    assert.strictEqual(report.retired.length, 2, "retired 不是 2");
    assert.strictEqual(report.totalCallsites, 17, "totalCallsites 不是 17");
    assert.strictEqual(report.alreadyWired, false, "中间态竟被判为已接线");
    assert.notStrictEqual(text, intermediate, "文本没变 = 根本没接线");
    // 12 条 wrap 的 policy 必须与表逐条对上（不是「凑够 12 个」就行）
    const got = report.wrapped.map((w) => w.ord + ":" + w.policy).sort();
    const want = G.POLICY_TABLE.filter((e) => e.mode === "wrap").map((e) => e.ord + ":" + e.policy).sort();
    assert.deepStrictEqual(got, want, "接线 policy 与表不符");
  });
  t("D.2 再 apply 一次 → 逐字节不变（幂等），且转为 verifiedWrapped=12", () => {
    const once = G.apply(intermediate).text;
    const twice = G.apply(once);
    assert.strictEqual(twice.text, once, "第二次 apply 改了字节 = 不幂等");
    assert.strictEqual(twice.report.wrapped.length, 0, "第二次竟又接线了 " + twice.report.wrapped.length + " 处");
    assert.strictEqual(twice.report.verifiedWrapped.length, 12,
      "verifiedWrapped 不是 12：" + twice.report.verifiedWrapped.length);
    assert.strictEqual(twice.report.verifiedCore.length, 3, "verifiedCore 不是 3");
    assert.strictEqual(twice.report.alreadyWired, true, "第二次未识别出已接线");
  });
  t("D.2c rc.7.25 的四个 PROGRESS 短窗包装可精确迁移，迁移后二次幂等", () => {
    const current = G.apply(intermediate).text;
    let legacy = current;
    const progress = G.POLICY_TABLE.filter((e) => e.mode === "wrap" && e.policy === "PROGRESS");
    for (const e of progress) {
      const oldText = G.buildReplacement(e, (() => {
        const at = legacy.indexOf(e.anchor) + e.anchor.length;
        const ast = AST.analyze(legacy);
        const site = ast.callsites.slice().sort((a, b) => a.start - b.start)
          .find((row) => row.start >= at);
        return legacy.slice(site.start, site.end);
      })(), true);
      const newText = G.buildReplacement(e, (() => {
        const at = legacy.indexOf(e.anchor) + e.anchor.length;
        const ast = AST.analyze(legacy);
        const site = ast.callsites.slice().sort((a, b) => a.start - b.start)
          .find((row) => row.start >= at);
        return legacy.slice(site.start, site.end);
      })(), false);
      const at = legacy.indexOf(e.anchor) + e.anchor.length;
      assert.strictEqual(legacy.slice(at, at + newText.length), newText,
        "迁移夹具不是当前包装 #" + e.ord);
      legacy = legacy.slice(0, at) + oldText + legacy.slice(at + newText.length);
    }
    const migrated = G.apply(legacy);
    assert.strictEqual(migrated.text, current, "旧包装没有收敛到当前字节");
    assert.strictEqual(migrated.report.migratedWrapped.length, 4, "迁移数不是 4");
    const twice = G.apply(migrated.text);
    assert.strictEqual(twice.text, migrated.text, "迁移后二次 apply 不幂等");
    assert.strictEqual(twice.report.migratedWrapped.length, 0, "二次 apply 仍声称迁移");
  });
  t("D.2b 已接线文本被**篡改 policy** → 逐字节比对必须抛（不能默认放行）", () => {
    const once = G.apply(intermediate).text;
    // 把某处 30s 超时偷偷改成 30s+1ms：字节比对应当立刻发现
    const idx = once.indexOf("timeoutMs:30000");
    assert.ok(idx > 0, "产物里找不到 timeoutMs:30000，样本失效需复核");
    const tampered = once.slice(0, idx) + "timeoutMs:30001" + once.slice(idx + "timeoutMs:30000".length);
    throws(() => G.apply(tampered), /does not match declared policy byte-for-byte/,
      "被篡改的 policy 竟被放行");
  });
  t("D.3 apply 产物：15/15 已守卫、0 裸活跃调用、退役点保持裸态", () => {
    const out = G.apply(intermediate).text;
    const r = AST.analyze(out);
    const live = r.callsites.filter((c) => c.reachable);
    assert.strictEqual(live.length, 15, "可达点不是 15");
    assert.strictEqual(live.filter((c) => !c.guarded).length, 0, "仍有裸活跃调用");
    assert.strictEqual(r.callsites.filter((c) => !c.reachable).filter((c) => c.guarded).length, 0,
      "退役点被注 guard = 假接线");
  });
  t("D.4 每条 wrap 表项的 guard 参数确实按声明生成（policy 表达式 + 超时 + runId）", () => {
    const out = G.apply(intermediate).text;
    for (const e of G.POLICY_TABLE.filter((x) => x.mode === "wrap")) {
      const at = out.indexOf(e.anchor);
      assert.ok(at >= 0, "#" + e.ord + " 锚点在产物中消失");
      const anchorEnd = at + e.anchor.length;
      const site = AST.analyze(out).callsites.slice().sort((a, b) => a.start - b.start)
        .find((row) => row.start >= anchorEnd);
      assert.ok(site, "#" + e.ord + " 锚点后找不到调用点");
      const inner = out.slice(site.start, site.end);
      const expected = G.buildReplacement(e, inner, false);
      const region = out.slice(anchorEnd, anchorEnd + expected.length);
      assert.ok(region.startsWith(G.WRAP_HEAD), "#" + e.ord + " (" + e.id + ") 锚点后不是 " + G.WRAP_HEAD);
      assert.strictEqual(region, expected, "#" + e.ord + " wrapper 不是声明式预期字节");
      assert.ok(region.includes(G.POLICY_EXPR[e.policy]),
        "#" + e.ord + " 未见 policy 表达式 " + G.POLICY_EXPR[e.policy]);
      const to = G.TIMEOUT_MS[e.policy];
      if (to) assert.ok(region.includes("timeoutMs:" + to), "#" + e.ord + " 未见 timeoutMs:" + to);
      if (e.policy === "PROGRESS") {
        assert.ok(region.includes("structuralLong:" + e.structuralLong),
          "#" + e.ord + " 未见动态 structuralLong:" + e.structuralLong);
        assert.ok(!region.includes("structuralLong:!1"),
          "#" + e.ord + " 仍写死短 idle 窗口");
      }
    }
  });
  t("D.5 SHORT_INTERNAL 的 30s 只落在 4 个内部探测点上（绝不套到用户长跑作业）", () => {
    const shortOnes = G.POLICY_TABLE.filter((e) => e.policy === "SHORT_INTERNAL").map((e) => e.id).sort();
    assert.deepStrictEqual(shortOnes,
      ["graph-export-batch", "graph-inventory-probe", "mcp-test-connection", "softstop-quiescence"],
      "SHORT_INTERNAL 名单变了（30s 超时套错对象＝取消用户真作业）：" + shortOnes.join(","));
  });
  t("D.6 用户可见长跑路径全是 PROGRESS（终端输入/手动选区/桥可见运行/human-file）", () => {
    const prog = G.POLICY_TABLE.filter((e) => e.policy === "PROGRESS").map((e) => e.id).sort();
    assert.deepStrictEqual(prog,
      ["bridge-visible-run", "humanfile-runmethod-fallback", "humanfile-runmethod-source",
       "manual-selection-run", "terminal-input-run"],
      "PROGRESS 名单变了：" + prog.join(","));
  });

  t("D.7 final graph probe verifies its unique owner without changing runtime bytes", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
    const result = G.apply(src);
    assert.strictEqual(result.text, src);
    assert.strictEqual(result.report.verifiedWrapped.find((e) => e.ord === 15).runId, "probeRunId");
    G.assertAnchorUniqueness(src, "final");
    const owner = "POLICY.SHORT_INTERNAL,probeRunId,()=>zg.runSelection(probeCode";
    assert.ok(src.includes(owner));
    throws(() => G.apply(src.replace(owner, "POLICY.SHORT_INTERNAL,null,()=>zg.runSelection(probeCode")),
      /does not match declared policy byte-for-byte/);
    throws(() => G.apply(src.replace("runId: probeRunId,", "runId: null,")), /runId mismatch/);
    const entry = G.POLICY_TABLE.find((e) => e.ord === 15);
    throws(() => G.apply(src + "\n/*\n" + entry.finalAnchor + "\n*/"), /missing rc\.7\.13 anchor|non-unique/);
  });

  console.log("\n[E] 【P1-2】台账死分支区间：必须是真实数字偏移，畸形即 fail-closed");
  const GEN = require("./gen_callsite_manifest_v4.js");
  const AST_E = require("./ast_reachability_gate.js");

  t("E.1 最终 dist 的 deadBranchRanges 是 5 个**非空**区间，字段为数字 start/end/testStart", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
    const m = GEN.buildManifest(src);
    const rs = m.reachability.deadBranchRanges;
    assert.strictEqual(m.reachability.deadBranchCount, 5, "死分支区域数不是 5");
    assert.strictEqual(rs.length, 5, "区间数组长度不是 5");
    rs.forEach((r, i) => {
      // 旧实现在这里给出 {}，JSON 里五个空对象 —— 看着像证据，其实什么都没说
      assert.notDeepStrictEqual(r, {}, `deadBranchRanges[${i}] 是空对象（bodyStart/bodyEnd 幽灵字段复发）`);
      assert.deepStrictEqual(Object.keys(r).sort(), ["end", "start", "testStart"],
        `deadBranchRanges[${i}] 字段名不对：` + JSON.stringify(Object.keys(r)));
      for (const k of ["start", "end", "testStart"]) {
        assert.ok(Number.isInteger(r[k]) && r[k] >= 0, `${k} 不是非负整数：` + JSON.stringify(r[k]));
      }
      assert.ok(r.start < r.end, `区间无序：${r.start} !< ${r.end}`);
      assert.ok(r.testStart <= r.start, `testStart 应在 consequent 之前：${r.testStart} > ${r.start}`);
      assert.ok(r.end <= src.length, "区间越过 bundle 末尾");
    });
  });

  t("E.2 区间与 AST 原始输出一致（台账没有自己编偏移）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
    const raw = AST_E.analyze(src).deadRanges
      .map((r) => ({ start: r.start, end: r.end, testStart: r.testStart }));
    const got = GEN.buildManifest(src).reachability.deadBranchRanges;
    assert.deepStrictEqual(got, raw, "台账区间 ≠ analyze() 实际返回");
  });

  t("E.3 退役调用点仍是 [8,12]，且都落在某个死区间内（区域数≠退役点数）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
    const m = GEN.buildManifest(src);
    const retired = m.callsites.filter((c) => !c.reachable).map((c) => c.n);
    assert.deepStrictEqual(retired, [8, 12], "退役点变了：" + JSON.stringify(retired));
    for (const c of m.callsites.filter((x) => !x.reachable)) {
      const inSome = m.reachability.deadBranchRanges
        .some((r) => c.charOffset >= r.start && c.charOffset < r.end);
      assert.ok(inSome, `#${c.n} 判为不可达却不在任何死区间内（证据自相矛盾）`);
    }
    // 5 个区域里只有 2 个含 runSelection —— 这两个数不该被混为一谈
    const withCall = m.reachability.deadBranchRanges.filter((r) =>
      m.callsites.some((c) => c.charOffset >= r.start && c.charOffset < r.end)).length;
    assert.strictEqual(withCall, 2, "含 runSelection 的死区间不是 2 个");
  });

  t("E.4 负例：畸形区间一律抛 DEAD_RANGES_INVALID（不得静默写出空对象）", () => {
    const N = GEN.normalizeDeadRanges;
    const LEN = 1000;
    assert.deepStrictEqual(N([{ start: 10, end: 20, testStart: 5 }], LEN),
      [{ start: 10, end: 20, testStart: 5 }], "合法区间被拒");
    const bad = [
      [[{ start: 10, end: 20 }], "缺 testStart"],
      [[{ start: 10, testStart: 5 }], "缺 end"],
      [[{ start: "10", end: 20, testStart: 5 }], "start 是字符串"],
      [[{ start: 10.5, end: 20, testStart: 5 }], "start 非整数"],
      [[{ start: NaN, end: 20, testStart: 5 }], "start 是 NaN"],
      [[{ start: Infinity, end: 20, testStart: 5 }], "start 无限"],
      [[{ start: -1, end: 20, testStart: 0 }], "start 负数"],
      [[{ start: 20, end: 20, testStart: 5 }], "start==end 区间空"],
      [[{ start: 30, end: 20, testStart: 5 }], "start>end 逆序"],
      [[{ start: 10, end: 2000, testStart: 5 }], "end 越界"],
      [[{ start: 10, end: 20, testStart: 15 }], "testStart 在 consequent 之后"],
      [[{ bodyStart: 10, bodyEnd: 20 }], "**旧幽灵字段**（本 bug 原形）"],
      [[null], "区间是 null"],
      [["nope"], "区间不是对象"],
    ];
    for (const [ranges, why] of bad) {
      assert.throws(() => N(ranges, LEN), /DEAD_RANGES_INVALID/, "未 fail-closed：" + why);
    }
    assert.throws(() => N("not-an-array", LEN), /DEAD_RANGES_INVALID/, "非数组未被拒");
  });

  console.log("\n" + "=".repeat(58));
  console.log("  PASS=" + pass + "  FAIL=" + fails.length);
  if (fails.length) { fails.forEach((f) => console.log("   - " + f)); process.exit(1); }
  console.log("  GUARD_WIRING_RC713_OK");
})();
