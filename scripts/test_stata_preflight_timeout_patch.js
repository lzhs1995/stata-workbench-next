#!/usr/bin/env node
"use strict";
// 回归：Windows rc.7.44 runbook 第 1 步（2026-10-30）。mcp-stata 1.26.1 的 preflight 子进程写死
// 60 s，负载重时 Stata 18 MP 打出横幅却没在 60 s 内返回，worker 初始化失败。补丁改为读
// MCP_STATA_PREFLIGHT_TIMEOUT（默认 180 s，夹在 60..900 s）；原文不认识就拒绝。
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const patch = require("./stata_preflight_timeout_patch");

const fixture = "class StataClient:\n    def init(self):\n        try:\n            if True:\n" + patch.ORIGINAL
  + "                                pass\n";
const patched = patch.patchClient(fixture);
assert.notEqual(patched, fixture);
assert.equal(patch.patchClient(patched), patched, "idempotent");
assert.equal(patched.split(patch.MARKER).length - 1, 1);
assert.ok(!patched.includes("timeout=60, env=env"), "hard-coded 60 s removed");
// fail closed: 缺锚点、重复锚点、补丁被改过、新旧混在一起。
assert.throws(() => patch.patchClient(fixture.replace("timeout=60", "timeout=61")), /unsupported/);
assert.throws(() => patch.patchClient(fixture + patch.ORIGINAL), /unsupported/);
assert.throws(() => patch.patchClient(patched.replace("900.0)", "901.0)")), /unsupported/);
assert.throws(() => patch.patchClient(patched + patch.ORIGINAL), /unsupported/);

// 部署件只有两种合法状态：未打补丁（锚点 1 处、无补丁块、无 marker），或已打补丁（完整补丁块
// 1 处、marker 1 处、锚点 0 处）。其余（都没有、重复、改过、半截）都不认。
const count = (s, x) => s.split(x).length - 1;
function classifyDeployed(source) {
  const o = count(source, patch.ORIGINAL), r = count(source, patch.REPLACEMENT), m = count(source, patch.MARKER);
  if (o === 1 && r === 0 && m === 0) return "unpatched";
  if (o === 0 && r === 1 && m === 1) return "patched";
  return "unsupported";
}
assert.equal(classifyDeployed(fixture), "unpatched");
assert.equal(classifyDeployed(patched), "patched");

// 已部署的 1.26.1 源码（若本机有）：两种合法状态之一；补丁结果（已打补丁时即原文）恰 1 个完整补丁块且能编译。
const candidates = [process.env.MCP_STATA_CLIENT_SOURCE,
  path.join(process.env.HOME || "", ".local/share/stata-workbench/mcp-stata-1.26.1/lib/python3.11/site-packages/mcp_stata/stata_client.py")]
  .filter(p => p && fs.existsSync(p));
const python = process.env.STATA_PATCH_TEST_PYTHON || (process.platform === "darwin"
  ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
let deployed = "absent";
if (candidates.length) {
  const real = fs.readFileSync(candidates[0], "utf8").replace(/\r\n/g, "\n");
  const state = classifyDeployed(real);
  assert.notEqual(state, "unsupported", "deployed source state");
  const out = patch.patchClient(real);
  if (state === "patched") assert.equal(out, real, "deployed patched source is a fixed point");
  assert.equal(patch.patchClient(out), out, "deployed idempotent");
  assert.equal(classifyDeployed(out), "patched");
  const compiled = cp.spawnSync(python, ["-B", "-c", "import sys,ast; ast.parse(sys.stdin.read())"], { input: out, encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  checkMutants(out, "deployed");
  deployed = state + "-and-parsed";
}
// 变异对照：从一份已打补丁的源（合成夹具总跑；本机有部署件时再跑一遍）在内存里构造，不碰原文件。
function checkMutants(base, label) {
  const half = patch.REPLACEMENT.split("\n").slice(0, 4).join("\n") + "\n";
  const mutants = {
    "marker duplicated": base + "# " + patch.MARKER + "\n",
    "replacement duplicated": base + patch.REPLACEMENT,
    "replacement altered": base.replace("900.0)", "901.0)"),
    "anchor altered": base.replace(patch.REPLACEMENT, () => patch.ORIGINAL.replace("timeout=60", "timeout=61")),
    "half patch": base.replace(patch.REPLACEMENT, () => half),
    "anchor and patch both": base + patch.ORIGINAL,
    "neither": base.replace(patch.REPLACEMENT, ""),
  };
  assert.equal(classifyDeployed(base), "patched", label + " base");
  for (const [name, text] of Object.entries(mutants)) {
    assert.notEqual(text, base, label + " mutant applied: " + name);
    assert.equal(classifyDeployed(text), "unsupported", label + " mutant caught: " + name);
  }
  return Object.keys(mutants).length;
}
const mutantsCaught = checkMutants(patched, "fixture");

// 行为：把替换块里的取值逻辑单独跑一遍。
const lines = patch.REPLACEMENT.split("\n");
const body = lines.slice(lines.findIndex(l => l.includes("try:")), lines.findIndex(l => l.includes("res = subprocess.run(")))
  .map(l => l.slice(32)).join("\n");
const probe = "import os\nimport json\nout = {}\nfor v in [None, '30', '240', 'abc', 'nan', '1e9', '-5']:\n"
  + "    os.environ.pop('MCP_STATA_PREFLIGHT_TIMEOUT', None)\n"
  + "    if v is not None: os.environ['MCP_STATA_PREFLIGHT_TIMEOUT'] = v\n"
  + body.split("\n").map(l => "    " + l).join("\n") + "\n    out[str(v)] = preflight_timeout\nprint(json.dumps(out))\n";
const r = cp.spawnSync(python, ["-B", "-c", probe], { encoding: "utf8" });
assert.equal(r.status, 0, r.stderr);
const values = JSON.parse(r.stdout);
assert.deepEqual(values, { None: 180, 30: 60, 240: 240, abc: 180, nan: 180, "1e9": 900, "-5": 60 });
console.log(JSON.stringify({ verdict: "PREFLIGHT_TIMEOUT_PASS", deployed, mutantsCaught, values }));
