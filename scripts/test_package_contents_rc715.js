#!/usr/bin/env node
"use strict";
// rc.7.15 R2 · 打包内容门禁（fail-closed）
//
// 背景（P1 审计发现）：R1 在 dist/ 里留下 extension.js.rc715-prechange-backup-20260810-211620，
// 而当时 .vscodeignore 的 *.bak / *.bak-* / *.backup* 三类模式**全部打不中**这种中缀形态，
// 于是 `vsce ls` 把一个 5.5MB 的陈旧 bundle 也列进了包内容。单纯"数字符串"的检查发现不了这个，
// 必须去问 vsce 本体要真实文件清单。
//
// 本门禁两层：
//   L1 分类器单测：纯函数 classify()，含对抗样例（就是 R1 那个确切文件名）+ 反向样例
//                  （正典 dist/extension.js 必须放行），并证明分类器不是"恒真/恒假"。
//   L2 实况断言：跑本地 vsce ls，要求 恰好 1 个 dist 扩展 bundle、0 个禁止条目、必需文件在位。
//
// fail-closed 约定：vsce 缺失 / 非零退出 / 输出为空 / 解析不出条目 —— 全部判失败，绝不 skip。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.resolve(__dirname, "..");
const VSCE = path.join(ROOT, "node_modules", ".bin", "vsce");

// ---------------------------------------------------------------- L1 分类器

// 正典 bundle：包里必须**恰好**有这一个扩展主 bundle
const CANONICAL_BUNDLE = "dist/extension.js";

// 禁止类：备份 / prechange 快照 / 打补丁残留 / 正典 bundle 的任何兄弟文件
const FORBIDDEN_RULES = [
  { name: "backup-infix", re: /backup/i },
  { name: "prechange", re: /prechange/i },
  { name: "bak-suffix", re: /\.bak(\b|[-_.]|$)/i },
  { name: "patch-leftover", re: /\.(orig|rej)$/i },
  { name: "editor-tilde", re: /~$/ },
  // dist/extension.js 的兄弟（dist/extension.js.<任何东西>）：只允许正典本体
  { name: "dist-bundle-sibling", re: /^dist\/extension\.js\.[^/]+$/ },
];

/**
 * 判定一个包内相对路径是否为禁止条目。
 * @param {string} p vsce ls 输出的相对路径（POSIX 分隔符）
 * @returns {{forbidden: boolean, rule: string|null}}
 */
function classify(p) {
  const norm = String(p).replace(/\\/g, "/").trim();
  if (norm === CANONICAL_BUNDLE) return { forbidden: false, rule: null }; // 正典优先放行
  for (const r of FORBIDDEN_RULES) {
    if (r.re.test(norm)) return { forbidden: true, rule: r.name };
  }
  return { forbidden: false, rule: null };
}

/** 从包内容清单里挑出所有"扩展主 bundle"候选（正典 + 任何兄弟变体） */
function bundleCandidates(entries) {
  return entries.filter((e) => /^dist\/extension\.js(\.|$)/.test(e.replace(/\\/g, "/").trim()));
}

// ---------------------------------------------------------------- 测试脚手架

let pass = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS  " + name);
  } catch (e) {
    failures.push(name + ": " + (e && e.message ? e.message : String(e)));
    console.log("  FAIL  " + name + "  -> " + (e && e.message ? e.message : String(e)));
  }
}

// ---------------------------------------------------------------- L1 用例

// 对抗样例：R1 那个确切文件名（审计要求逐字证明能被抓住）
const R1_EXACT = "dist/extension.js.rc715-prechange-backup-20260810-211620";

const FORBIDDEN_FIXTURES = [
  R1_EXACT,
  "dist/extension.js.bak-pre-r1128-20260807_150726",
  "dist/extension.js.bak-pre-rc714e-20260810_115344",
  "dist/extension.js.backup",
  "dist/extension.js.rc715-prechange-backup-20991231-235959",
  "dist/extension.js.prechange",
  "dist/extension.js.codex-smcl-fallback-backup-20260723-202028",
  "dist/extension.js.orig",
  "dist/extension.js.rej",
  "dist/extension.js~",
  "scripts/execution_guard.js.bak",
  "scripts/patch_manager.js.orig",
  "some/deep/dir/whatever-backup-20260810.js",
];

const ALLOWED_FIXTURES = [
  CANONICAL_BUNDLE,
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "media/icon.png",
  "dist/ui-shared/main.js",
  "dist/ui-shared/design.css",
  "scripts/execution_guard.js",
  "scripts/stop_checkpoint_core.js",
  "scripts/checkpoint_global_export_rc715.js",
  "syntaxes/stata.tmLanguage.json",
];

console.log("L1 分类器单测");

t("L1.1 对抗样例：R1 确切文件名必须被判禁止且归因 backup/prechange", () => {
  const c = classify(R1_EXACT);
  assert.strictEqual(c.forbidden, true, "R1 文件名居然被放行：" + R1_EXACT);
  assert.ok(
    ["backup-infix", "prechange", "dist-bundle-sibling"].includes(c.rule),
    "命中规则不合预期：" + c.rule
  );
});

t("L1.2 全部禁止样例都被抓住", () => {
  const missed = FORBIDDEN_FIXTURES.filter((f) => !classify(f).forbidden);
  assert.deepStrictEqual(missed, [], "漏放行了：" + JSON.stringify(missed));
});

t("L1.3 全部合法样例都被放行（分类器不是恒真）", () => {
  const wrong = ALLOWED_FIXTURES.filter((f) => classify(f).forbidden).map(
    (f) => f + "(rule=" + classify(f).rule + ")"
  );
  assert.deepStrictEqual(wrong, [], "误杀了：" + JSON.stringify(wrong));
});

t("L1.4 正典 bundle 永不被禁（即使规则表将来被加宽）", () => {
  assert.strictEqual(classify(CANONICAL_BUNDLE).forbidden, false);
  assert.strictEqual(classify("dist/extension.js").rule, null);
});

t("L1.5 bundleCandidates 能同时看见正典与变体（用于唯一性判定）", () => {
  const cands = bundleCandidates([
    "package.json",
    CANONICAL_BUNDLE,
    R1_EXACT,
    "dist/ui-shared/main.js",
  ]);
  assert.deepStrictEqual(cands.sort(), [CANONICAL_BUNDLE, R1_EXACT].sort());
});

t("L1.6 分类器不是恒假：至少一条规则对至少一个样例生效，且规则名互不为空", () => {
  const hit = FORBIDDEN_FIXTURES.map((f) => classify(f).rule).filter(Boolean);
  assert.ok(hit.length === FORBIDDEN_FIXTURES.length, "有样例命中了空规则名");
  assert.ok(new Set(hit).size >= 3, "规则覆盖过窄，只命中 " + new Set(hit).size + " 类");
});

t("L1.7 .vscodeignore 必须真的覆盖 R1 文件名类（用 vsce 自带 minimatch 实测，非字符串比对）", () => {
  // Resolve from vsce so this check uses its actual matcher, including nested installs.
  const vsceRequire = createRequire(require.resolve("@vscode/vsce/package.json"));
  const { minimatch: mm } = vsceRequire("minimatch");
  assert.strictEqual(typeof mm, "function", "vsce minimatch export must be callable");
  const igPath = path.join(ROOT, ".vscodeignore");
  const raw = fs.readFileSync(igPath, "utf8");
  const pats = raw
    .split(/[\n\r]/)
    .map((s) => s.trim())
    .filter((s) => !!s)
    .filter((s) => !/^\s*#/.test(s))
    .filter((s) => !/^\s*!/.test(s));
  // vsce 4 用 minimatch 的具名导出 + {dot:true}（out/package.js）。
  const hits = pats.filter((p) => mm(R1_EXACT, p, { dot: true }));
  assert.ok(hits.length > 0, ".vscodeignore 没有任何模式能打中 " + R1_EXACT);
  // 反向：这些模式绝不能同时打中正典 bundle
  const canonicalHits = pats.filter((p) => mm(CANONICAL_BUNDLE, p, { dot: true }));
  assert.deepStrictEqual(
    canonicalHits,
    [],
    ".vscodeignore 把正典 dist/extension.js 也排除了：" + JSON.stringify(canonicalHits)
  );
});

// ---------------------------------------------------------------- L2 实况断言

console.log("\nL2 实况断言（本地 vsce ls）");

/**
 * 取真实包内容清单。fail-closed：任何异常都抛，不返回空数组、不 skip。
 */
function vsceLs() {
  if (!fs.existsSync(VSCE)) {
    throw new Error("本地 vsce 不存在：" + VSCE + "（@vscode/vsce 是 devDependency，必须可用）");
  }
  let out;
  try {
    out = execFileSync(process.execPath, [VSCE, "ls"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 240000, // macOS 无 timeout 命令，用 execFileSync 自带超时
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const extra =
      (e && e.stdout ? "\n--stdout--\n" + String(e.stdout).slice(-2000) : "") +
      (e && e.stderr ? "\n--stderr--\n" + String(e.stderr).slice(-2000) : "");
    throw new Error("vsce ls 执行失败（fail-closed）：" + (e && e.message) + extra);
  }
  const entries = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => !!s)
    // vsce ls 只输出相对路径；把任何看起来不是路径的行剔掉但要记账
    .filter((s) => !/^(DONE|INFO|WARNING|ERROR)\b/.test(s));
  if (entries.length === 0) {
    throw new Error("vsce ls 输出为空（fail-closed）");
  }
  return entries;
}

let LS_ENTRIES = null;
let LS_ERROR = null;
try {
  LS_ENTRIES = vsceLs();
  console.log("  vsce ls entries = " + LS_ENTRIES.length);
} catch (e) {
  LS_ERROR = e;
}

t("L2.0 vsce ls 必须成功且有条目（fail-closed，不允许 skip）", () => {
  if (LS_ERROR) throw LS_ERROR;
  assert.ok(Array.isArray(LS_ENTRIES) && LS_ENTRIES.length > 0);
});

t("L2.1 零禁止条目", () => {
  if (LS_ERROR) throw LS_ERROR;
  const bad = LS_ENTRIES.map((e) => ({ e: e, c: classify(e) }))
    .filter((x) => x.c.forbidden)
    .map((x) => x.e + " [" + x.c.rule + "]");
  assert.deepStrictEqual(bad, [], "包内出现禁止条目：\n    " + bad.join("\n    "));
});

t("L2.2 恰好一个 dist 扩展 bundle，且就是正典 dist/extension.js", () => {
  if (LS_ERROR) throw LS_ERROR;
  const cands = bundleCandidates(LS_ENTRIES);
  assert.strictEqual(
    cands.length,
    1,
    "dist bundle 候选数 = " + cands.length + "（应为 1）：" + JSON.stringify(cands)
  );
  assert.strictEqual(cands[0].trim(), CANONICAL_BUNDLE);
});

t("L2.3 必需文件仍在包内（防止 .vscodeignore 收紧后误杀）", () => {
  if (LS_ERROR) throw LS_ERROR;
  const set = new Set(LS_ENTRIES.map((s) => s.replace(/\\/g, "/").trim()));
  for (const req of [
    CANONICAL_BUNDLE,
    "package.json",
    "media/icon.png",
    // R16J89: the runtime requires this gate through the packaged script chain.
    // If vsce drops it, `_enqueue` fails closed on every execution op, so a
    // missing entry must redden here rather than at first live dispatch.
    "scripts/data_browser_execution_gate.js",
  ]) {
    assert.ok(set.has(req), "包内缺少必需文件：" + req);
  }
  // ui-shared 整包缺失曾导致终端乱码（见 MAINTENANCE_MAC.md），这里钉一个下限
  const uiShared = LS_ENTRIES.filter((s) => s.startsWith("dist/ui-shared/"));
  assert.ok(uiShared.length >= 5, "dist/ui-shared/ 条目过少：" + uiShared.length);
});

t("L2.4 磁盘上若存在备份文件，vsce 必须已把它们挡在包外（端到端证否）", () => {
  if (LS_ERROR) throw LS_ERROR;
  const distDir = path.join(ROOT, "dist");
  const onDisk = fs
    .readdirSync(distDir)
    .filter((n) => classify("dist/" + n).forbidden)
    .map((n) => "dist/" + n);
  const set = new Set(LS_ENTRIES.map((s) => s.replace(/\\/g, "/").trim()));
  const leaked = onDisk.filter((p) => set.has(p));
  assert.deepStrictEqual(leaked, [], "磁盘备份泄漏进包：" + JSON.stringify(leaked));
  // 记账：这条断言只有在磁盘真有备份文件时才有区分力，打印出来供审计
  console.log(
    "        dist/ 内被分类为禁止的磁盘文件 = " + onDisk.length + (onDisk.length ? " -> " + onDisk.join(", ") : "")
  );
});

// ---------------------------------------------------------------- 汇总

console.log("");
if (failures.length) {
  console.log("PACKAGE_CONTENTS_RC715_FAILED  PASS=" + pass + " FAIL=" + failures.length);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("PACKAGE_CONTENTS_RC715_OK  PASS=" + pass + " FAIL=0");

module.exports = { classify, bundleCandidates, CANONICAL_BUNDLE, FORBIDDEN_RULES, R1_EXACT, vsceLs };
