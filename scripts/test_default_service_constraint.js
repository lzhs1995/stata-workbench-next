#!/usr/bin/env node
"use strict";

// 回归：默认 uvx/uv 路由约束 mcp<2（S58 default-service 候选，Codex 独立审阅的行为测试移入仓库）。
// 从生产 bundle 与 runtime 补丁源取真实函数，在 darwin/win32 两种 VM 上下文里跑；
// transport/config I/O 是替身，不启动 Stata，不读写用户配置。
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const acorn = require("acorn"), walk = require("acorn-walk");
const patch = require("./apply_default_service_constraint_patch");
const coldStart = require("./apply_backend_cold_start_patch");
const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const runtime = fs.readFileSync(path.join(__dirname, "mcp_stata_runtime_patch.js"), "utf8");
function extract(source, names = ["_createClient", "_loadServerConfig", "_ensureLatestServerForMissingTool", "ORA", "jRA", "ZRA", "bRA", "qRA", "$_"]) {
  const wanted = new Set(names);
  const found = {};
  const tree = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  walk.full(tree, (node) => {
    const name = node.type === "MethodDefinition" ? node.key.name :
      node.type === "FunctionDeclaration" ? node.id?.name : null;
    if (!wanted.has(name)) return;
    if (found[name]) throw new Error(`Duplicate function ${name}`);
    found[name] = { type: node.type, start: node.start, end: node.end, source: source.slice(node.start, node.end) };
  });
  for (const name of wanted) if (!found[name]) throw new Error(`Missing ${name}`);
  return found;
}
const functions = extract(bundle);
const runtimeNames = ["runtimeRootFromCommand", "runtimeOptionsFromConfig", "hasExplicitRuntime", "explicitRuntimeRoot", "runtimeRootFromUvCommand", "candidateRuntimeRoots", "addCandidate"];
const runtimeFunctions = extract(runtime, runtimeNames);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");

// 补丁幂等、精确可逆（还原出 Windows 上验收过的 dev.6 字节），部分状态 fail closed。
assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
const dev6 = patch.revertBundle(bundle);
assert.equal(hash(dev6), "7cd398d1aa92a9f1fa1885b425d3fa07a6f71dcf3be3c9b9a0da5cf64721c40b", "dev.6 bytes");
assert.equal(patch.patchBundle(dev6), bundle, "maintenance replay reproduces the sealed bundle");
assert.equal(patch.fromArrays(bundle).filter(a => a.constrained).length, patch.ARRAYS);
assert.throws(() => patch.patchBundle(bundle.replace(patch.DEFAULT_AFTER, patch.DEFAULT_BEFORE)), /anchor/);
const partial = dev6.replace('"--from",e,Ao]', '"--from",e' + patch.CONSTRAINT + ',Ao]');
assert.notEqual(partial, dev6);
assert.throws(() => patch.patchBundle(partial), /partial/);
// Codex 候选 = bdb8359 + 这些改动；去掉冷启动补丁后应逐字节相同。
const codexCandidate = coldStart.revertBundle(bundle);
const runtimeDiscovery = '"--from", packageSpec, "--with", "mcp<2", "python"';
assert.equal(runtime.split(runtimeDiscovery).length - 1, 1, "runtime discovery shares the constraint");
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));
const constrained = args => {
  const position = args.indexOf("--from"), withAt = args.indexOf("--with");
  assert(position >= 0, "tool has --from");
  assert.equal(withAt, position + 2, "constraint follows package and precedes executable");
  assert.equal(args[withAt + 1], "mcp<2");
};
async function check(name, fn) {
  try { const evidence = await fn(); results.push({ name, status: "PASS", ...(evidence ? { evidence } : {}) }); }
  catch (error) { results.push({ name, status: "FAIL", error: error.stack }); }
}
function runtimeApi(platform) {
  const context = vm.createContext({ path: platform === "win32" ? path.win32 : path.posix, process: { env: {} }, os: { homedir: () => "/unused" }, childProcess: { spawnSync() { throw new Error("Unmocked runtime process"); } } });
  return vm.runInContext(runtimeNames.map(n => runtimeFunctions[n].source).join("\n") + `\n({${runtimeNames.join(",")}})`, context);
}
function clientHarness({ platform = "darwin", config, env = {}, force = false, pypi = "1.26.1", failCommand, commands = [] } = {}) {
  const calls = [], transports = [], logs = [], events = [], files = new Map();
  const configPath = platform === "win32" ? "C:\\fixture\\mcp.json" : "/fixture/mcp.json";
  if (config) files.set(configPath, JSON.stringify({ servers: { mcp_stata: config } }));
  class Transport { constructor(options) { this.options = options; transports.push(plain(options)); } on() {} }
  class Client { on() {} }
  const context = vm.createContext({
    EE: { workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) }, commands: { getCommands: async () => commands } },
    MM: () => env, Ao: "mcp-stata", RF: "mcp_stata", bA: platform === "win32" ? path.win32 : path.posix,
    Lt: { existsSync: p => files.has(p), readFileSync: p => { if (!files.has(p)) throw new Error("no fixture"); return files.get(p); } },
    require: name => { assert.equal(name, "../scripts/mcp_stata_runtime_patch"); return runtimeApi(platform); },
    j_: Client, Z_: Transport, W_: null, uF: null, dF: null,
    wHg: () => ({ spawnSync: (command, args, options) => { calls.push(plain({ command, args, options })); return command === failCommand ? { status: 1, error: Object.assign(new Error("missing"), { code: "ENOENT" }) } : { status: 0, stdout: "uv 1", stderr: "" }; } }),
    process: { platform }, console,
  });
  const instance = {
    _statusEmitter: { emit: (...args) => events.push(args) }, _log: text => logs.push(text), _forceLatestServer: force,
    _pypiVersion: pypi, _clientVersion: "review", _safeParseJson: JSON.parse,
    _candidateMcpConfigPaths: () => [configPath], _hostMcpConfigPaths: () => [configPath],
    _resolveWorkspaceRoot: () => "/synthetic/workspace", _attachStderrListener() {}, _rejectPendingTaskWaiters() {},
    _requiredToolNames: () => new Set(["needed"]), _resetClientState() { this.resetCount = (this.resetCount || 0) + 1; },
    _transport: { async close() { instance.closeCount = (instance.closeCount || 0) + 1; } },
  };
  for (const name of ["_createClient", "_loadServerConfig", "_ensureLatestServerForMissingTool"]) instance[name] = vm.runInContext(`({${functions[name].source}}).${name}`, context);
  return { instance, calls, transports, logs, events, configPath };
}
function generatorHarness({ platform = "darwin", command = "uvx", version = "1.26.1", settings = {}, existing = "", explicit = false, probeFallback = false } = {}) {
  let output = existing; const calls = [], logs = [];
  const context = vm.createContext({
    iA: { workspace: { getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback }) }, ExtensionMode: { Test: 3 } },
    yC: { extensionMode: 1 }, JI: command, Kg: version, HI: "mcp-stata", ND: "mcp-stata==1.26.1", Ig: "mcp_stata",
    JA: { mkdirSync() {}, existsSync: () => Boolean(output), readFileSync: () => output, writeFileSync: (p, data) => { output = data; } }, rg: path,
    WRA: text => { try { return { data: text ? JSON.parse(text) : {} }; } catch (error) { return { error }; } },
    UA: { appendLine: text => logs.push(text) }, RI: text => logs.push(text), LF() {},
    mB: { spawnSync: (cmd, args, options) => { calls.push(plain({ command: cmd, args, options })); return { status: 0, stdout: probeFallback && calls.length === 1 ? "" : "1.26.1", stderr: "" }; } },
    __stataHasExplicitRuntime: () => explicit, RM: text => /1\.26\.1/.test(text) ? "1.26.1" : null, process: { platform }, console,
  });
  vm.runInContext(["bRA", "ORA", "jRA", "ZRA", "qRA", "$_"].map(n => functions[n].source).join("\n"), context);
  return { context, calls, logs, output: () => output };
}

async function main() {
  for (const platform of ["darwin", "win32"]) {
    await check(`${platform}: default launch constrained`, async () => {
      const h = clientHarness({ platform }); await h.instance._createClient();
      assert.equal(h.transports.length, 1); constrained(h.transports[0].args);
      assert.equal(h.transports[0].args.at(-1), "mcp-stata");
      assert.equal(h.transports[0].env.PYTHONUNBUFFERED, "1");
      assert.equal(h.calls.length, 1); return h.transports[0];
    });
    await check(`${platform}: failed discovered uvx uses constrained fallback`, async () => {
      const command = platform === "win32" ? "C:\\gone\\uvx.exe" : "/gone/uvx";
      const h = clientHarness({ platform, config: { command, args: ["old"] }, failCommand: command });
      await h.instance._createClient(); constrained(h.transports[0].args); assert.equal(h.transports[0].command, "uvx"); assert.equal(h.calls.length, 2);
    });
    await check(`${platform}: explicit argv preserved`, async () => {
      const args = ["--from", "mcp-stata==1.24.0", "--with", "mcp==1.27.0", "mcp-stata"];
      const h = clientHarness({ platform, config: { command: "custom-runner", args, env: { KEEP: "yes" } } });
      await h.instance._createClient(); assert.deepEqual(h.transports[0].args, args); assert.equal(h.transports[0].env.KEEP, "yes");
    });
    await check(`${platform}: explicit empty argv preserved`, async () => {
      const h = clientHarness({ platform, config: { command: "custom-runner", args: [] } }); await h.instance._createClient(); assert.deepEqual(h.transports[0].args, []);
    });
    await check(`${platform}: explicit command with omitted argv gets no uv flags`, async () => {
      const h = clientHarness({ platform, config: { command: "custom-runner" } }); await h.instance._createClient(); assert.deepEqual(h.transports[0].args, []);
    });
    await check(`${platform}: forced refresh preserves environment and constrains new default`, async () => {
      const h = clientHarness({ platform, force: true, pypi: "9.0", config: { command: "old-uvx", args: ["old"], env: { KEEP: "kept" } } });
      await h.instance._createClient(); constrained(h.transports[0].args); assert.equal(h.transports[0].args[1], "mcp-stata==1.26.1"); assert.equal(h.transports[0].env.KEEP, "kept");
    });
    await check(`${platform}: explicit config path survives refresh`, async () => {
      const configPath = platform === "win32" ? "C:\\fixture\\mcp.json" : "/fixture/mcp.json";
      const h = clientHarness({ platform, force: true, env: { MCP_STATA_CONFIG_PATH: configPath }, config: { command: "private-python", args: ["-m", "mcp_stata"] } });
      await h.instance._createClient(); assert.equal(h.transports[0].command, "private-python"); assert.deepEqual(h.transports[0].args, ["-m", "mcp_stata"]);
    });
    await check(`${platform}: explicit runtime failure cannot fall back`, async () => {
      const command = platform === "win32" ? "C:\\private\\Scripts\\python.exe" : "/private/bin/python";
      const h = clientHarness({ platform, config: { command, args: [] }, failCommand: command });
      await assert.rejects(h.instance._createClient()); assert.equal(h.calls.length, 1); assert.equal(h.transports.length, 0);
    });
    await check(`${platform}: explicit missing tool cannot refresh runtime`, async () => {
      const command = platform === "win32" ? "C:\\private\\Scripts\\python.exe" : "/private/bin/python";
      const h = clientHarness({ platform, config: { command, args: [] } });
      await h.instance._ensureLatestServerForMissingTool("needed"); assert.equal(h.instance.closeCount, undefined); assert.equal(h.instance._forceLatestServer, false);
    });
    await check(`${platform}: missing tool refresh is bounded to once`, async () => {
      const h = clientHarness({ platform });
      await h.instance._ensureLatestServerForMissingTool("needed"); await h.instance._ensureLatestServerForMissingTool("needed");
      assert.equal(h.instance.closeCount, 1); assert.equal(h.instance.resetCount, 1); await h.instance._createClient(); constrained(h.transports[0].args);
    });
  }
  await check("package selection remains configurable", async () => {
    const h = clientHarness({ env: { MCP_STATA_PACKAGE_SPEC: "mcp-stata==1.25.0" }, force: true });
    await h.instance._createClient(); constrained(h.transports[0].args); assert.equal(h.transports[0].args[1], "mcp-stata==1.25.0");
  });
  await check("Cursor bridge does not spawn a stdio service", async () => {
    const h = clientHarness({ commands: ["cursor.mcp.invoke"] }); const result = await h.instance._createClient();
    assert.equal(result.type, "cursor-bridge"); assert.equal(h.calls.length, 0); assert.equal(h.transports.length, 0);
  });
  for (const command of ["uvx", "/opt/homebrew/bin/uv", "uvx.exe", "uv.exe"]) {
    const prefix = command.endsWith("uv") || command.endsWith("uv.exe") ? ["tool", "run"] : [];
    for (const destination of ["claude", "codex", "vscode", "cursor"]) {
      await check(`${destination}: generated arguments for ${command}`, () => {
        const old = { keep: "root", servers: { unrelated: { command: "keep" }, mcp_stata: { command: "previous", env: { CUSTOM: "kept" }, disabled: true } } };
        const h = generatorHarness({ command, existing: destination === "codex" ? '[mcp_servers.other]\ncommand = "keep"\n' : JSON.stringify(old), settings: { stataPath: "C:\\含 空格\\Stata.exe", noReloadOnClear: true } });
        let args;
        if (destination === "claude") {
          h.context.ORA({}); const call = h.calls.find(c => c.args[1] === "add-json"); const entry = JSON.parse(call.args[3]); args = entry.args; assert.equal(entry.env.STATA_PATH, "C:\\含 空格\\Stata.exe");
        } else if (destination === "codex") {
          h.context.jRA({ configPath: "/fixture/config.toml" }); args = JSON.parse(h.output().match(/^args = (.+)$/m)[1]); assert(h.output().includes('[mcp_servers.other]\ncommand = "keep"'));
        } else {
          h.context.ZRA({ configPath: "/fixture/mcp.json", writeVscode: destination === "vscode", writeCursor: destination === "cursor" });
          const output = JSON.parse(h.output()), entry = destination === "vscode" ? output.servers.mcp_stata : output.mcpServers.mcp_stata;
          args = entry.args; assert.equal(entry.env.CUSTOM, "kept"); assert.equal(output.keep, "root"); assert.equal(output.servers.unrelated.command, "keep");
        }
        constrained(args); assert.deepEqual(args.slice(0, prefix.length), prefix); assert.equal(args.at(-1), "mcp-stata");
      });
    }
    for (const probeFallback of [false, true]) {
      await check(`version probe ${command}, metadata fallback=${probeFallback}`, () => {
        const h = generatorHarness({ command, probeFallback }); assert.equal(h.context.qRA(), "1.26.1"); assert.equal(h.calls.length, probeFallback ? 2 : 1);
        for (const call of h.calls) constrained(call.args);
      });
    }
    await check(`refresh command ${command}`, () => { const h = generatorHarness({ command }); assert.equal(h.context.$_(), "1.26.1"); constrained(h.calls[0].args); });
    await check(`runtime lookup shares constraint ${command}`, () => {
      const platform = command.endsWith(".exe") ? "win32" : "darwin", api = runtimeApi(platform); const calls = [];
      const expected = platform === "win32" ? "C:\\fixture\\runtime" : "/fixture/runtime";
      const root = api.runtimeRootFromUvCommand(command, { spawnSync: (cmd, args) => { calls.push(plain({ cmd, args })); return { status: 0, stdout: expected + "\n" }; } });
      assert.equal(root, expected); constrained(calls[0].args); assert.deepEqual(calls[0].args.slice(0, prefix.length), prefix);
    });
  }
  await check("explicit runtime bypasses version/refresh probes", () => {
    const h = generatorHarness({ explicit: true }); assert.equal(h.context.qRA(), "configured"); assert.equal(h.context.$_(), null); assert.equal(h.calls.length, 0);
  });
  await check("explicit runtime discovery never invokes uv", () => {
    const api = runtimeApi("darwin"); const roots = api.candidateRuntimeRoots({ runtimeRoot: "/private/runtime", uvCommand: "uvx", spawnSync() { throw new Error("must not spawn"); } });
    assert.deepEqual(plain(roots), ["/private/runtime"]);
  });
  await check("malformed JSON config remains unchanged", () => {
    const h = generatorHarness({ existing: "{ not valid" }); h.context.ZRA({ configPath: "/fixture/mcp.json", writeVscode: true }); assert.equal(h.output(), "{ not valid");
  });
  await check("development package label retains pinned default spec", () => {
    const h = generatorHarness({ version: "1.27.0.dev1" }); h.context.ORA({}); const args = JSON.parse(h.calls[1].args[3]).args; constrained(args); assert.equal(args[1], "mcp-stata==1.26.1");
  });
  const failed = results.filter(r => r.status === "FAIL");
  console.log(JSON.stringify({ verdict: failed.length ? "FAIL" : "DEFAULT_SERVICE_CONSTRAINT_PASS", total: results.length,
    passed: results.length - failed.length, failures: failed.map(r => ({ name: r.name, error: r.error.split("\n").slice(0, 3).join("\n") })),
    bundleSha256: hash(bundle), runtimeSha256: hash(runtime), codexCandidateFingerprintedSha256: hash(codexCandidate), liveStata: false }));
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
