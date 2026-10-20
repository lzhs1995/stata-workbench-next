#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const runtime = require("./mcp_stata_runtime_patch");
const patch = require("./apply_activation_isolation_patch");
const source = fs.readFileSync(path.join(__dirname, "../dist/extension.js"), "utf8");
const cases = [];
function check(name, fn) { fn(); cases.push(name); }
function between(start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0 && source.indexOf(start, at + 1) < 0, "unique start: " + start);
  const to = source.indexOf(end, at + start.length);
  assert.ok(to > at, "end: " + end);
  return source.slice(at, to);
}
function integrationRun(text, settings, available = true) {
  const calls = [];
  const sandbox = {
    iA: { workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) } },
    TF: () => false, KHg: () => { calls.push("claudeProbe"); return available; },
    ORA: () => calls.push("claudeWrite"), xRA: () => calls.push("claudeDelete"),
    vRA: () => { calls.push("codexPathRead"); return {}; }, mHg: () => ({}),
    JF: () => false, jRA: () => calls.push("codexWrite"), VRA: () => calls.push("codexDelete"),
    JI: "uvx", Kg: "test", zg: {},
  };
  vm.runInNewContext(text + ";FF({});", sandbox);
  return calls;
}
const ff = between("function FF(g){", "function YF(g){");
check("disabled and unset integrations have zero reads, probes, writes or deletes", () => {
  assert.deepEqual(integrationRun(ff, {}), []);
  assert.deepEqual(integrationRun(ff, { configureClaudeCode: false, configureCodex: false }), []);
});
check("enabled integrations retain opt-in configuration", () => {
  assert.deepEqual(integrationRun(ff, { configureClaudeCode: true, configureCodex: true }),
    ["claudeProbe", "claudeWrite", "codexPathRead", "codexWrite"]);
  assert.deepEqual(integrationRun(ff, { configureClaudeCode: true }, false), ["claudeProbe"]);
});
check("old activation deletion is detected by the same harness", () => {
  const oldCalls = integrationRun(patch.OLD_FF, {});
  assert.ok(oldCalls.includes("claudeDelete") && oldCalls.includes("codexDelete"));
});
check("maintained patch is idempotent and rejects ambiguous anchors", () => {
  assert.equal(patch.patchBundle(source), source);
  assert.throws(() => patch.patchBundle(source + patch.NEW_FF), /ambiguous/);
});
check("shared maintenance replay restores activation isolation and remains idempotent", () => {
  const target = path.join(__dirname, "../dist/extension.js");
  const replay = fs.readFileSync(path.join(__dirname, "apply_rc7_shared_execution_patch.js"), "utf8");
  function run(input) {
    let output;
    const memoryFs = {
      readFileSync(file, encoding) { assert.equal(file, target); assert.equal(encoding, "utf8"); return input; },
      writeFileSync(file, text, encoding) { assert.equal(file, target); assert.equal(encoding, "utf8"); output = text; },
    };
    vm.runInNewContext(replay, { __dirname, console: { log() {} },
      require: name => name === "fs" ? memoryFs : require(name) });
    assert.equal(typeof output, "string");
    return output;
  }
  let old = source;
  for (const [before, after] of [...patch.REPLACEMENTS].reverse()) old = old.replace(after, before);
  assert.ok(!old.includes(patch.MARKER));
  assert.equal(run(old), source);
  assert.equal(run(source), source);
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stata-activation-isolation-"));
try {
  const explicit = path.join(temp, "explicit");
  const shared = path.join(temp, "shared", ".local/share/stata-workbench/mcp-stata-1.26.1");
  const moduleNames = ["server.py", "stata_client.py", "graph_detector.py", "sessions.py"];
  const sharedModules = path.join(shared, "lib/python3.14/site-packages/mcp_stata");
  fs.mkdirSync(sharedModules, { recursive: true });
  for (const name of moduleNames) fs.writeFileSync(path.join(sharedModules, name), "# untouched\n");
  let discoveryCalls = 0;
  const opts = { runtimeRoot: explicit, env: {}, homedir: path.join(temp, "shared"),
    uvCommand: "uvx", spawnSync: () => { discoveryCalls++; throw new Error("unexpected uv discovery"); } };
  check("explicit missing directory cannot discover or patch shared home", () => {
    const result = runtime.patchRuntime(opts);
    assert.equal(result.status, "not-found");
    assert.deepEqual(result.roots, [explicit]);
    assert.equal(discoveryCalls, 0);
  });
  check("explicit incomplete environment cannot fall back", () => {
    const modules = path.join(explicit, "Lib/site-packages/mcp_stata");
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(modules, "server.py"), "# incomplete\n");
    assert.equal(runtime.patchRuntime(opts).status, "not-found");
    assert.equal(discoveryCalls, 0);
  });
  check("invalid explicit roots fail without discovery", () => {
    for (const root of [null, undefined, "", "relative", 4, {}]) {
      assert.equal(runtime.patchRuntime({ ...opts, runtimeRoot: root }).status, "invalid-runtime-root");
      assert.equal(runtime.patchRuntime({ env: { MCP_STATA_RUNTIME_ROOT: root } }).status, "invalid-runtime-root");
    }
    assert.equal(discoveryCalls, 0);
  });
  check("config env overrides startup env; explicit root wins over command; uvx is not a venv", () => {
    const configOpts = runtime.runtimeOptionsFromConfig({ command: path.join(shared, "bin/mcp-stata"),
      env: { MCP_STATA_RUNTIME_ROOT: explicit, UV_CACHE_DIR: path.join(temp, "cache") } },
      { MCP_STATA_RUNTIME_ROOT: shared, PATH: "/test" });
    assert.deepEqual(runtime.candidateRuntimeRoots(configOpts), [explicit]);
    assert.equal(configOpts.env.PATH, "/test");
    assert.equal(configOpts.env.UV_CACHE_DIR, path.join(temp, "cache"));
    assert.equal(runtime.runtimeRootFromCommand("/opt/homebrew/bin/uvx"), null);
    assert.deepEqual(runtime.candidateRuntimeRoots({ ...opts, runtimeRoot: shared }), [shared]);
  });
  check("configured installed command remains isolated without uv discovery", () => {
    let probes = 0;
    assert.deepEqual(runtime.candidateRuntimeRoots({ command: path.join(explicit, "bin/python"),
      env: {}, homedir: path.join(temp, "shared"), uvCommand: "uvx",
      spawnSync: () => { probes++; throw Error("unexpected configured-command discovery"); } }), [explicit]);
    assert.equal(probes, 0);
  });
  check("default discovery orders fixed installations before uv caches and deduplicates", () => {
    const home = path.join(temp, "default-home");
    const local = path.join(temp, "local-app-data");
    const suppliedUv = path.join(temp, "supplied-uv");
    const discoveredUv = path.join(temp, "discovered-uv");
    const fixed = [path.join(home, ".local/share/stata-workbench/mcp-stata-1.26.1"),
      path.join(home, "AppData/Local/stata-workbench/mcp-stata-1.26.1"),
      path.join(local, "stata-workbench/mcp-stata-1.26.1")];
    let probes = 0;
    const defaults = { env: { LOCALAPPDATA: local }, homedir: home, uvCommand: "uvx",
      uvRuntimeRoot: suppliedUv, spawnSync: () => {
        probes++; return { status: 0, stdout: discoveredUv + "\n" };
      } };
    assert.deepEqual(runtime.candidateRuntimeRoots(defaults), [...fixed, suppliedUv, discoveredUv]);
    assert.equal(probes, 1);
    assert.deepEqual(runtime.candidateRuntimeRoots({ ...defaults, uvRuntimeRoot: fixed[0] }),
      [...fixed, discoveredUv]);
    assert.equal(probes, 2);
  });
  check("site-packages symlink cannot escape explicit runtime", () => {
    const escaped = path.join(temp, "escaped");
    fs.mkdirSync(path.join(escaped, "Lib"), { recursive: true });
    fs.symlinkSync(path.dirname(sharedModules), path.join(escaped, "Lib/site-packages"));
    assert.equal(runtime.patchRuntime({ ...opts, runtimeRoot: escaped }).status, "runtime-path-escape");
    for (const name of moduleNames) assert.equal(fs.readFileSync(path.join(sharedModules, name), "utf8"), "# untouched\n");
  });

  const loadMethod = between("_loadServerConfig({ignoreCommandArgs:A=!1,hostOnly:I=!1}={}){", "_captureMcpError(A){");
  const configPath = path.join(temp, "mcp.json");
  const entry = { command: path.join(explicit, "bin/python"), args: ["-m", "mcp_stata"],
    env: { MCP_STATA_RUNTIME_ROOT: explicit } };
  const env = { MCP_STATA_CONFIG_PATH: configPath };
  const loader = vm.runInNewContext("({" + loadMethod + "})", { MM: () => env, bA: path, Lt: fs, RF: "mcp_stata" });
  loader._safeParseJson = text => { try { return JSON.parse(text); } catch { return {}; } };
  loader._log = () => {};
  loader._hostMcpConfigPaths = loader._candidateMcpConfigPaths = () => { throw Error("shared config discovery"); };
  check("explicit config is used identically by activation and client, retaining command during forced refresh", () => {
    fs.writeFileSync(configPath, JSON.stringify({ servers: { mcp_stata: entry } }));
    for (const options of [{ hostOnly: true }, {}, { ignoreCommandArgs: true }]) {
      const value = loader._loadServerConfig(options);
      assert.equal(value.command, entry.command);
      assert.deepEqual(JSON.parse(JSON.stringify(value.args)), entry.args);
      assert.equal(value.env.MCP_STATA_RUNTIME_ROOT, explicit);
    }
  });
  check("explicit missing, invalid and unconfigured MCP JSON fail closed", () => {
    fs.unlinkSync(configPath);
    assert.throws(() => loader._loadServerConfig(), /ENOENT/);
    fs.writeFileSync(configPath, "{}");
    assert.throws(() => loader._loadServerConfig(), /requires/);
    fs.writeFileSync(configPath, "malformed");
    assert.throws(() => loader._loadServerConfig(), /requires/);
    env.MCP_STATA_CONFIG_PATH = "relative.json";
    assert.throws(() => loader._loadServerConfig(), /absolute/);
  });
  check("unset explicit config retains existing host and candidate lookup", () => {
    delete env.MCP_STATA_CONFIG_PATH;
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { mcp_stata: entry } }));
    const calls = [];
    loader._hostMcpConfigPaths = () => { calls.push("host"); return [configPath]; };
    loader._candidateMcpConfigPaths = () => { calls.push("candidate"); return [configPath]; };
    assert.equal(loader._loadServerConfig({ hostOnly: true }).command, entry.command);
    assert.equal(loader._loadServerConfig().command, entry.command);
    assert.deepEqual(calls, ["host", "candidate"]);
  });

  check("direct version and refresh entry points also skip uv package discovery for explicit runtime", () => {
    const functions = between("function __stataHasExplicitRuntime(){", "function RM(g){") +
      between("function $_(){", "function mF(g,A=!1){");
    const context = { require: () => runtime, zg: { getServerConfig: () => entry }, uM: () => ({}),
      RI: () => {}, JI: "uvx", mB: { spawnSync: () => { throw Error("unexpected package discovery"); } } };
    vm.runInNewContext(functions + ';if(qRA()!=="configured"||$_()!==null)throw Error("unexpected result")', context);
  });

  const activation = between("let E=zg.getServerConfig({hostOnly:!0});", 'if(HF(Io?"missing":"idle")');
  function activate(config, result, preflight = true) {
    const calls = [];
    const context = { zg: { getServerConfig: () => config }, uM: () => ({}), rg: path,
      yC: { extensionUri: { fsPath: temp } }, JI: "uvx", g: {}, Io: false, Kg: "unknown",
      RI: () => {}, GB: { setTag: () => {} }, AP: () => preflight,
      FF: () => calls.push("configure"), qRA: () => { calls.push("version-discovery"); return "1.26.1"; },
      TRA: () => { calls.push("uv-install"); return true; },
      setImmediate: fn => { calls.push("refresh-scheduled"); fn(); }, $_: () => { calls.push("refresh"); return null; },
      require: () => ({ ...runtime, patchRuntime: options => { calls.push(options); return result; } }),
    };
    vm.runInNewContext(activation, context);
    return calls;
  }
  check("activation passes config env and skips uv version and refresh for explicit runtime", () => {
    const calls = activate(entry, { ok: true });
    assert.equal(calls[0].env.MCP_STATA_RUNTIME_ROOT, explicit);
    assert.deepEqual(calls.slice(1), ["configure"]);
  });
  check("activation stops when explicit patch or command preflight fails", () => {
    assert.throws(() => activate(entry, { ok: false, status: "not-found" }), /unavailable/);
    assert.throws(() => activate(entry, { ok: true }, false), /refusing default/);
  });
  check("default activation retains version and deferred refresh behavior", () => {
    const calls = activate({ command: "uvx", env: {} }, { ok: false, status: "not-found" });
    assert.deepEqual(calls.slice(1), ["version-discovery", "configure", "refresh-scheduled", "refresh"]);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

async function clientChecks() {
  const clientMethod = between("async _createClient(){", "async _refreshToolList(A){");
  for (const explicit of [true, false]) {
    const commands = [];
    const config = { command: explicit ? "/isolated/bin/python" : "configured-launcher", args: ["-m", "mcp_stata"], env: {} };
    const context = { EE: { workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) }, commands: { getCommands: async () => [] } },
      MM: () => ({}), Ao: "mcp-stata", require: () => runtime, process: { platform: "darwin" },
      wHg: () => ({ spawnSync: command => { commands.push(command); return { status: command === config.command ? 1 : 0, stderr: "" }; } }),
      j_: class {}, Z_: class {}, uF: null, dF: null, globalThis: {},
    };
    const client = vm.runInNewContext("({" + clientMethod + "})", context);
    Object.assign(client, { _statusEmitter: { emit: () => {} }, _loadServerConfig: () => config,
      _log: () => {}, _resolveWorkspaceRoot: () => "/isolated", _clientVersion: "test" });
    if (explicit) {
      await assert.rejects(client._createClient(), /failed to execute/);
      assert.deepEqual(commands, [config.command]);
      cases.push("explicit client command failure cannot fall back to uvx");
    } else {
      await client._createClient();
      assert.deepEqual(commands, [config.command, "uvx"]);
      cases.push("default configured launcher failure retains previous fallback");
    }
  }
  const missingMethod = between("async _ensureLatestServerForMissingTool(A){", "_formatMissingToolError(A){");
  for (const explicit of [true, false]) {
    let closed = 0;
    const client = vm.runInNewContext("({" + missingMethod + "})", { require: () => runtime, MM: () => ({}), Ao: "mcp-stata" });
    Object.assign(client, { _loadServerConfig: () => ({ command: explicit ? "/isolated/bin/python" : "uvx", env: {} }),
      _requiredToolNames: () => new Set(["required"]), _log: () => {}, _resetClientState: () => {},
      _transport: { close: async () => { closed++; } } });
    await client._ensureLatestServerForMissingTool("required");
    assert.equal(closed, explicit ? 0 : 1);
    assert.equal(client._forceLatestServer, explicit ? undefined : true);
  }
  cases.push("missing required tool leaves explicit runtime fixed and preserves default refresh");
}
clientChecks().then(() => console.log(JSON.stringify({ ok: true, count: cases.length, cases, nativeVerified: false }, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
