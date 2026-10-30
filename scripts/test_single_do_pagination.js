#!/usr/bin/env node
"use strict";

// 回归：rc.7.44 FULL45 S8/S25/S28（2026-10-30，macOS）。Agent 请求 do "<file>" 经 darwin 兼容层
// 前置 "set more off" 后，bridge 两处「单个 do 文件」判断都失配，命名图导出没有激活，
// graph export …, name(g) 报 r(693) could not find Graph window。
// 从生产 bundle 取真实判断代码在 vm 里运行，配真实 stata_source_compat_core；不启动 Stata。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const fingerprint = require("./finalize_bundle_identity");
const patch = require("./apply_single_do_pagination_patch");
const compat = require("./stata_source_compat_core");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const legacy = patch.revertBundle(bundle);

// 补丁幂等、精确可逆，锚点 fail closed。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
assert.equal(patch.patchBundle(legacy), bundle, "replay reproduces the sealed bundle");
assert.equal(fingerprint.verify(bundle).ok, true);
assert.throws(() => patch.patchBundle(legacy + patch.ANCHORS.bridgeStrip[0]), /anchor/);
assert.throws(() => patch.patchBundle(legacy.replace(patch.ANCHORS.graphRunPrefix[0], "")), /anchor/);
assert.throws(() => patch.patchBundle(legacy + "__codexBridgePagination"), /partial/);
assert.equal(legacy.includes(patch.MARKER), false);

function slice(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0 && source.indexOf(start, a + 1) < 0, "unique start " + start.slice(0, 60));
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, "end after " + start.slice(0, 60));
  return source.slice(a, b);
}

// 真实 bundle 的两处判断：__codexResolveSingleDoFilePath（经 __codexGraphScanTextForCode）与
// visible bridge 的 __codexBridgeSingleDo / __codexPreparedBridgeRun 分支。
function load(source) {
  const helperStart = source.includes(patch.MARKER + "\n// Leading") ? patch.MARKER + "\n// Leading" : "function __codexResolveSingleDoFilePath(code, cwd) {";
  const functions = slice(source, helperStart, "function __codexGraphLineStartsBlockComment(");
  const bridge = slice(source, "let __codexBridgeDocScanText=__code,__codexBridgeDoFile=null;", "/* codex patch v7.23:");
  const replace = slice(source, "if(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.code)__code=", "let __codexBridgeExactMarker=");
  const ctx = vm.createContext({ rg: path, JA: fs, process, String, Number, RegExp });
  vm.runInContext(functions + "\nglobalThis.__scan = __codexGraphScanTextForCode;", ctx);
  // bridge 分支：记录走了哪条准备路径，返回最终送给 Stata 的代码。
  const bridgeFn = vm.runInContext("(function(__code,__run,__cwd,calls){"
    + "const globalThis=this;const __codexPrepareHumanFileGraphRun=(f,r,c)=>{calls.push(['human',f]);return {code:'do \"/tmp/prepared/'+require_basename(f)+'\"'}};"
    + "const __codexPrepareGraphRunCode=(c,r,s,w)=>{calls.push(['graph',c]);return null};"
    + "function require_basename(f){return String(f).split('/').pop()}"
    + "this.__codexPrepareHumanFileGraphRun=__codexPrepareHumanFileGraphRun;this.__codexPrepareGraphRunCode=__codexPrepareGraphRunCode;"
    + bridge + replace + "return __code})", ctx);
  return {
    scan: (code, cwd) => ctx.__scan(code, cwd),
    bridge: (code) => { const calls = []; const out = bridgeFn.call(ctx, code, "run_test", path.dirname(fixture), calls); return { calls, out }; },
  };
}

// 夹具：一个真实存在的 do 文件，再用真实兼容层得到 Agent 路径实际送进 bridge 的代码。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-single-do-"));
const fixture = path.join(tmp, "named_graphs.do");
fs.writeFileSync(fixture, "sysuse auto, clear\ntwoway scatter price mpg, name(g1, replace)\n"
  + "twoway scatter price weight, name(g2, replace)\ngraph export \"g1.png\", name(g1) replace\n");
const compatPrepared = compat.prepareExecutionCode(`do "${fixture}"`, { cwd: tmp, sourceMode: "agent", tempRoot: tmp });
const compatCode = typeof compatPrepared === "string" ? compatPrepared : compatPrepared.code;
assert.match(compatCode, /^set more off\r?\ndo "/, "compat layer prefixes set more off (the trigger)");
const compatCopy = compatCode.match(/do "([^"]+)"/)[1];
assert.ok(fs.existsSync(compatCopy), "compat copy exists");

const CASES = {
  plain: `do "${fixture}"`,
  compatPrefixed: compatCode,
  captureFixed: `capture set more off\ndo "${fixture}"`,
  multiPrefix: `\nset more off // pagination\r\nset more off\ndo "${fixture}"\n`,
};
const expectedPath = { plain: fixture, compatPrefixed: compatCopy, captureFixed: fixture, multiPrefix: fixture };
// 仍然不是单个 do 文件：前面有别的命令、后面跟别的命令、只有 set more off。
const NEGATIVE = {
  displayThenDo: `display 1\ndo "${fixture}"`,
  doThenDisplay: `set more off\ndo "${fixture}"\ndisplay 1`,
  onlyPagination: "set more off\n",
  setMoreOn: `set more on\ndo "${fixture}"`,
};

function check(api) {
  const result = {};
  for (const [name, code] of Object.entries(CASES)) {
    const scan = api.scan(code, tmp);
    const bridge = api.bridge(code);
    result[name] = { scanPath: scan.doFilePath, readOk: scan.readOk, route: bridge.calls.map(c => c[0]).join(","), out: bridge.out };
  }
  for (const [name, code] of Object.entries(NEGATIVE)) {
    const scan = api.scan(code, tmp);
    const bridge = api.bridge(code);
    result[name] = { scanPath: scan.doFilePath, route: bridge.calls.map(c => c[0]).join(","), out: bridge.out };
  }
  return result;
}

const fixed = check(load(bundle));
for (const name of Object.keys(CASES)) {
  assert.equal(fixed[name].scanPath, expectedPath[name], name + ": resolver finds the do-file");
  assert.equal(fixed[name].readOk, true, name + ": graph scan reads the do-file");
  assert.equal(fixed[name].route, "human", name + ": bridge takes the human-file graph activation route");
}
// 准备后的代码仍以分页保护开头（原请求有的话），且只出现一次。
assert.match(fixed.compatPrefixed.out, /^set more off\r?\ndo "\/tmp\/prepared\//);
assert.equal((fixed.compatPrefixed.out.match(/set more off/g) || []).length, 1);
assert.equal(fixed.plain.out.startsWith('do "/tmp/prepared/'), true, "plain request gains no prefix");
for (const name of Object.keys(NEGATIVE)) {
  assert.equal(fixed[name].scanPath, null, name + ": still not a single do-file");
  assert.equal(fixed[name].route, "graph", name + ": bridge keeps the generic route");
  assert.equal(fixed[name].out, NEGATIVE[name], name + ": code unchanged");
}

// 负控：同样的断言在补丁前的 bundle 上必须失败（compat 前缀形式两处都失配）。
const old = check(load(legacy));
assert.equal(old.plain.route, "human", "legacy: plain request already worked");
assert.equal(old.compatPrefixed.scanPath, null, "legacy: resolver misses the compat-prefixed request");
assert.equal(old.compatPrefixed.route, "graph", "legacy: bridge misses the compat-prefixed request");
assert.equal(old.captureFixed.route, "graph");
assert.throws(() => assert.equal(old.compatPrefixed.route, fixed.compatPrefixed.route), "negative control differs");

// __codexPrepareGraphRunCode：换成 do "<activated>" 时保留原请求的分页保护。
const graphRunLine = patch.ANCHORS.graphRunPrefix[1].split("\n").find(l => l.includes("preparedCode = __codexSplitPaginationPrefix"));
const ctx2 = vm.createContext({});
vm.runInContext(slice(bundle, patch.MARKER + "\n// Leading", "function __codexResolveSingleDoFilePath(") , ctx2);
const restore = vm.runInContext("(function(text, preparedCode, graphScan){" + graphRunLine + " return preparedCode})", ctx2);
assert.equal(restore(compatCode, 'do "/tmp/a.activated.do"', { doFilePath: compatCopy }), 'set more off\ndo "/tmp/a.activated.do"');
assert.equal(restore(`do "${fixture}"`, 'do "/tmp/a.activated.do"', { doFilePath: fixture }), 'do "/tmp/a.activated.do"');
assert.equal(restore("set more off\ndisplay 1", "set more off\ndisplay 1", { doFilePath: null }), "set more off\ndisplay 1");
assert.equal(bundle.split(graphRunLine).length, 2, "restore line sits in __codexPrepareGraphRunCode once");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("SINGLE_DO_PAGINATION_PASS", JSON.stringify({ cases: Object.keys(CASES).length, negatives: Object.keys(NEGATIVE).length }));
