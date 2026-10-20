"use strict";
/**
 * test_packaging_require_chain.js —— 打包 require 链解析门禁（codex 打包阻塞）
 *
 * 背景：prerun_stage_guard.js 现 `require("./execution_guard.js")`。若打包时漏带
 * execution_guard.js（rc.7.0 vsix 正是如此），装机后 snapshot/enrich 阶段一进
 * guardStage 就 MODULE_NOT_FOUND 崩溃。仓库工作树两文件俱全掩盖了这一点。
 *
 * 本门禁**不是 grep 文件是否存在**（"seen ≠ works"），而是：
 *   ① 把「打包会带的 scripts 文件」复制进一个隔离临时目录（脱离本仓 node_modules 与兄弟文件）
 *   ② 在**子进程**里从该隔离目录 require prerun_stage_guard.js
 *   ③ 真正调用 guardStage 跑一次，证明整条 require 链在打包后布局里可解析、可运行
 *
 * 若只带 prerun 不带 execution_guard，子进程会以 MODULE_NOT_FOUND 失败，门禁红。
 *
 * 纯 Node，零外部依赖。`node scripts/test_packaging_require_chain.js`。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPTS_DIR = __dirname;

// guardStage 的完整依赖闭包（打包必须整组带上，缺一即崩）
const REQUIRED_CLOSURE = ["prerun_stage_guard.js", "execution_guard.js"];
const DARWIN_CLOSURE = [
  "darwin_compat_adapter.js", "stata_source_compat_core.js", "stata_do_references.js",
  "mac/png_compat_transform.js", "mac/png_compat_sips.sh", "mac/docx_image_inject.py",
];

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { failures.push(name + " — " + ((e && e.message) || e));
              console.log("  FAIL " + name + "  — " + ((e && e.message) || e)); }
}

function mkIsolatedTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-gate-"));
  const scripts = path.join(dir, "scripts");
  fs.mkdirSync(scripts);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(scripts, f)), { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS_DIR, f), path.join(scripts, f));
  }
  return { dir, scripts };
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

(function main() {
  console.log("=== 打包 require 链解析门禁 ===\n");

  console.log("[A] 依赖闭包源文件齐备");
  t("A.1 闭包内每个文件都存在于 scripts/", () => {
    for (const f of REQUIRED_CLOSURE) {
      assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, f)), "缺 " + f);
    }
  });

  console.log("\n[B] 隔离布局里整条 require 链可解析并运行（子进程真跑）");
  t("B.1 带全闭包 → require + guardStage 正常完成", () => {
    const { dir, scripts } = mkIsolatedTree(REQUIRED_CLOSURE);
    try {
      const probe =
        "const G=require(" + JSON.stringify(path.join(scripts, "prerun_stage_guard.js")) + ");" +
        "G.guardStage('snapshot',async()=>({rc:0}),{timeoutMs:2000})" +
        ".then(r=>{if(!r.ok)throw new Error('guardStage ok=false');" +
        "process.stdout.write('CHAIN_OK');})" +
        ".catch(e=>{process.stderr.write('CHAIN_ERR:'+(e&&e.message||e));process.exit(3);});";
      const out = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      assert.strictEqual(out.trim(), "CHAIN_OK", "子进程未输出 CHAIN_OK：" + out);
    } finally { rmrf(dir); }
  });

  console.log("\n[C] 反证：只带 prerun 不带 execution_guard → 必红（证明门禁有效）");
  t("C.1 缺 execution_guard.js → MODULE_NOT_FOUND（门禁能失败）", () => {
    const { dir, scripts } = mkIsolatedTree(["prerun_stage_guard.js"]);  // 故意漏
    try {
      const probe =
        "require(" + JSON.stringify(path.join(scripts, "prerun_stage_guard.js")) + ");";
      let threw = false, msg = "";
      try { execFileSync(process.execPath, ["-e", probe], { encoding: "utf8", stdio: "pipe" }); }
      catch (e) { threw = true; msg = String((e && e.stderr) || (e && e.message) || e); }
      assert.ok(threw, "缺依赖竟未失败 —— 门禁形同虚设");
      assert.ok(/Cannot find module|MODULE_NOT_FOUND/.test(msg),
                "失败原因不是缺模块：" + msg.slice(0, 200));
    } finally { rmrf(dir); }
  });

  t("D.1 Darwin nested DO preparation works in an isolated package layout", () => {
    const { dir, scripts } = mkIsolatedTree(DARWIN_CLOSURE);
    try {
      const leaf = path.join(dir, "leaf.do");
      const wrapper = path.join(dir, "wrapper.do");
      fs.writeFileSync(leaf, 'graph export "test.png", replace\n');
      fs.writeFileSync(wrapper, `do "${leaf}"\n`);
      const probe = `
        const a = require(${JSON.stringify(path.join(scripts, "darwin_compat_adapter.js"))});
        const r = a.prepareVisibleExecution(${JSON.stringify(`do "${wrapper}"`)}, {
          platform: "darwin", cwd: ${JSON.stringify(dir)}, tempRoot: ${JSON.stringify(dir)},
          extensionRoot: ${JSON.stringify(dir)}
        });
        if (!r.darwinDiagnostics.ok || r.darwinDiagnostics.replacements !== 1 ||
            r.sourceDiagnostics.referencedDoCopies.length !== 2) throw new Error(JSON.stringify(r));
        process.stdout.write("DARWIN_CHAIN_OK");`;
      const out = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" });
      assert.strictEqual(out, "DARWIN_CHAIN_OK");
      fs.unlinkSync(path.join(scripts, "stata_do_references.js"));
      assert.throws(() => execFileSync(process.execPath, ["-e", probe], { stdio: "pipe" }), /Command failed/);
    } finally { rmrf(dir); }
  });

  console.log("\n" + "=".repeat(58));
  console.log("  PASS=" + pass + "  FAIL=" + failures.length);
  if (failures.length) { failures.forEach((f) => console.log("   - " + f)); process.exit(1); }
})();
