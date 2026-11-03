#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const {
  transformDoSource,
  validatePngBuffer,
  convertSvgToRaster,
  hasRasterGraphExport,
  findResidualRasterExports,
  PNG_SIGNATURE,
  defaultHelperScript,
} = require("./png_compat_transform");

const fixtures = path.join(__dirname, "fixtures");
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (e) {
    failed++;
    console.error("FAIL", name, e && e.message || e);
  }
}

check("non-darwin no-op", () => {
  const src = fs.readFileSync(path.join(fixtures, "simple_png_export.do"), "utf8");
  const r = transformDoSource(src, { platform: "win32" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, false);
  assert.strictEqual(r.code, src);
});

check("simple png rewrite uses sh helper + confirm", () => {
  const src = fs.readFileSync(path.join(fixtures, "simple_png_export.do"), "utf8");
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, true);
  assert.ok(r.code.includes("as(svg)"), r.code);
  assert.ok(r.code.includes("png_compat_sips.sh"), r.code);
  assert.ok(r.code.includes("/bin/sh"), r.code);
  assert.ok(r.code.includes("confirm file"), r.code);
  assert.ok(r.code.includes("exit 693"), r.code);
  assert.ok(r.code.includes(".__pngcompat__.svg"), r.code);
  assert.ok(!/graph export\s+"out\/simple\.png"/i.test(r.code));
  // erase only after confirms (appears after exit 693 blocks)
  const eraseIdx = r.code.indexOf("capture erase");
  const confIdx = r.code.indexOf("confirm file");
  assert.ok(eraseIdx > confIdx);
});

check("macro path opaque rewrite", () => {
  const src = 'graph export "${figdir}/doc_fig_`i\'.png", name(doc_fig_`i\') replace width(1200)\n';
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, true);
  assert.ok(r.code.includes("${figdir}/doc_fig_`i'.__pngcompat__.svg") || r.code.includes(".__pngcompat__.svg"));
  assert.ok(r.code.includes("name(doc_fig_`i')") || r.code.includes("name(doc_fig_`i')"));
  assert.ok(r.code.includes("--width 1200"));
});

check("block comment does not poison file", () => {
  const src = '/* graph export "x.png", replace */\nscatter y x\ngraph export "y.png", replace\n';
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, true);
  assert.strictEqual(r.replacements.length, 1);
});

check("star comment line ignored", () => {
  const src = '* graph export "x.png", replace\ngraph export "y.png", replace\n';
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.replacements.length, 1);
});

check("name() with local macro allowed", () => {
  const src = 'graph export "x.png", name(g`i\') replace\n';
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, true);
});

check("svg export noop", () => {
  const src = fs.readFileSync(path.join(fixtures, "svg_export_noop.do"), "utf8");
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, false);
});

check("no graph noop", () => {
  const src = fs.readFileSync(path.join(fixtures, "no_graph.do"), "utf8");
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, false);
});

check("original source SHA invariant", () => {
  const src = fs.readFileSync(path.join(fixtures, "simple_png_export.do"), "utf8");
  const crypto = require("crypto");
  const before = crypto.createHash("sha256").update(src).digest("hex");
  transformDoSource(src, { platform: "darwin" });
  const after = crypto.createHash("sha256").update(src).digest("hex");
  assert.strictEqual(before, after);
});

check("helper script exists and executable path packaged", () => {
  const h = defaultHelperScript();
  assert.ok(fs.existsSync(h), h);
  const helperText = fs.readFileSync(h, "utf8");
  assert.ok(helperText.includes("codex patch rc.7.10.19"));
  assert.ok(!helperText.includes('echo "PNG_COMPAT_OK'));
  assert.ok(fs.existsSync(path.join(__dirname, "png_opaque_rgb.rb")));
  if (process.platform === "darwin") {
    const syntax = require("child_process").spawnSync(
      "/usr/bin/ruby",
      ["-c", path.join(__dirname, "png_opaque_rgb.rb")],
      { encoding: "utf8" }
    );
    assert.strictEqual(syntax.status, 0, syntax.stderr || syntax.stdout);
  }
});

check("validatePngBuffer signature", () => {
  const bad = validatePngBuffer(Buffer.from("notpng"));
  assert.strictEqual(bad.ok, false);
  const hdr = Buffer.alloc(24);
  PNG_SIGNATURE.copy(hdr);
  hdr.writeUInt32BE(800, 16);
  hdr.writeUInt32BE(600, 20);
  const ok = validatePngBuffer(hdr, 800);
  assert.strictEqual(ok.ok, true);
});

check("sips helper convert smoke produces putdocx-safe RGB PNG", () => {
  if (process.platform !== "darwin") return;
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "pngcompat-"));
  const svg = path.join(dir, "t.svg");
  const out = path.join(dir, "t.png");
  fs.writeFileSync(
    svg,
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#09c"/></svg>'
  );
  const r = convertSvgToRaster(svg, out, "png", 200);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(out));
  const v = validatePngBuffer(fs.readFileSync(out), 200);
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(fs.readFileSync(out)[25], 2, "PNG must use RGB color type 2");
});

// 按 raster 预筛逐个 .do 分类；目录缺失、没有 .do、没有 raster 导出时返回 skip 原因。
function scanRasterCorpus(dir) {
  if (!fs.existsSync(dir)) return { skip: "dir missing" };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".do")).sort();
  if (!files.length) return { skip: "no .do files" };
  let raster = 0,
    transformed = 0,
    unsupported = 0,
    noop = 0;
  const reasons = {};
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    if (!/\bgraph\s+export\b/i.test(src)) continue;
    if (!/\.(png|jpg|jpeg)\b/i.test(src) && !/\bas\s*\(\s*(png|jpg|jpeg)\s*\)/i.test(src)) continue;
    raster++;
    const r = transformDoSource(src, { platform: "darwin" });
    if (!r.ok) {
      unsupported++;
      reasons[r.reason || r.error] = (reasons[r.reason || r.error] || 0) + 1;
    } else if (r.transformed) transformed++;
    else noop++;
  }
  if (!raster) return { skip: "no raster graph export in " + files.length + " .do files" };
  return { files: files.length, raster, transformed, unsupported, noop, reasons };
}

check("synthetic realbatch corpus: exact classification", () => {
  const c = scanRasterCorpus(path.join(fixtures, "realbatch-synthetic"));
  console.log("  synthetic corpus", JSON.stringify(c));
  assert.deepStrictEqual(c, {
    files: 5,
    raster: 4,
    transformed: 2,
    unsupported: 1,
    noop: 1,
    reasons: { delimit_semicolon_with_darwin_compat_command: 1 },
  });
});

check("realbatch raster corpus: no unsupported poison", () => {
  // 本机真实语料，只在作者的 Mac 上有，也可能是空目录；CI 上靠上面的合成语料真跑。
  const c = scanRasterCorpus(path.join(__dirname, "..", "..", "..", "开题报告", "7_temp", "realbatch", "tmpdo"));
  if (c.skip) {
    console.log("SKIP corpus (" + c.skip + ")");
    return;
  }
  console.log("  corpus", JSON.stringify(c));
  assert.strictEqual(c.unsupported, 0, "unsupported should be 0: " + JSON.stringify(c.reasons));
  assert.ok(c.transformed >= 1, "expected some transformed");
});

check("hasRasterGraphExport helper", () => {
  assert.strictEqual(hasRasterGraphExport('display "hi"\n'), false);
  assert.strictEqual(hasRasterGraphExport('graph export "a.png", replace\n'), true);
});


check("single-quoted local path rewrites", () => {
  const src = "graph export '`f'.png', replace\n";
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, true);
  assert.ok(r.code.includes(".__pngcompat__.svg"));
});

check("residual fail-closed for unparsed-looking raster is empty on svg-only", () => {
  const src = 'graph export "a.svg", replace\n';
  const r = transformDoSource(src, { platform: "darwin" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transformed, false);
  assert.strictEqual((r.residuals || []).length, 0);
});

check("findResidualRasterExports statement-level not shell png", () => {
  const { findResidualRasterExports } = require("./png_compat_transform");
  const src =
    'graph export "a.svg", replace\n' +
    'shell sips -s format png in.svg --out out.png\n';
  const r = findResidualRasterExports(src);
  assert.strictEqual(r.length, 0, JSON.stringify(r));
});

if (failed) {
  console.error("\n" + failed + " failure(s)");
  process.exit(1);
}
console.log("\nALL_UNIT_PASS");
