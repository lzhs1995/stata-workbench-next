#!/usr/bin/env node
"use strict";

// 回归：Next 开发线身份。bundle 的端口回退值、package.json 默认端口、工具默认值都必须
// 是 17601，任何地方都不能回落到稳定版和研究实例占用的 17485。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const patch = require("./apply_next_identity_patch");
const fingerprint = require("./finalize_bundle_identity");
const { LATER, revertAfter } = require("./later_bundle_patches");

const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// 1. 幂等、精确可逆，锚点 fail closed。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(fingerprint.verify(bundle).ok, true);
const name = "./apply_next_identity_patch";
const sealed = revertAfter(bundle, name);
const legacy = patch.revertBundle(sealed);
const previous = LATER[LATER.indexOf(name) - 1];
assert.equal(legacy, revertAfter(bundle, previous), "this patch directly follows the previous later layer");
assert.equal(patch.patchBundle(legacy), sealed, "replay reproduces the sealed layer");
assert.throws(() => patch.patchBundle(legacy.replace(patch.ANCHORS.catchDefault[0], "")), /anchor/);
assert.throws(() => patch.patchBundle(legacy + patch.ANCHORS.configDefault[0]), /anchor/);
assert.throws(() => patch.patchBundle(legacy + 'get("visibleBridgePort",17601)'), /partial/);

// 2. bundle 和清单里都没有 17485。
assert.equal(bundle.includes("17485"), false, "bundle must not fall back to 17485");
assert.equal(legacy.split("17485").length - 1, 2, "the stable layer had exactly two fallbacks");
const port = pkg.contributes.configuration.properties["stataMcp.visibleBridgePort"];
assert.equal(port.default, 17601);
assert.equal(pkg.name, "stata-workbench-next");
assert.match(pkg.version, /^0\.2\.0-next\.\d+$/);
assert.match(pkg.displayName, /\(Next\)$/);

// 3. 工具默认值：端口 17601，配置目录在 ~/.stata-workbench-next 下。
for (const rel of ["tools/verified_workbench.py", "tools/workbench_doctor.py", "examples/platform-acceptance/stress.py",
  "scripts/mac/lib.sh", "scripts/patch_manager.js"]) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  assert.equal(/17485/.test(text), false, rel + " must not default to 17485");
  assert.ok(text.includes("17601"), rel + " defaults to 17601");
}
const verified = fs.readFileSync(path.join(root, "tools", "verified_workbench.py"), "utf8");
assert.ok(verified.includes('".stata-workbench-next" / "profiles" / "default"'), "default profile under ~/.stata-workbench-next");
assert.ok(verified.includes(`"extensions/lzhs1995.stata-workbench-next-${pkg.version}"`), "extension id follows package.json");
console.log("PASS next identity: bundle/package/tools default to 17601, never 17485; patch idempotent and reversible");
