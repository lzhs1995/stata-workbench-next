#!/usr/bin/env node
"use strict";

// rc.7.80 W-P1 timing is a diagnostic observation. Checks: the sealed layer
// replays and reverts byte-exactly; the warm-up wrappers return and throw exactly
// what they wrap; every inserted site is guarded, so a timing helper that throws
// changes nothing; each event keeps only its allowlisted scalar fields and an
// error only its class/code. The Python milestones are a manual tool for a
// disposable runtime copy: the product's runtime patch never loads it (the
// full-chain off/on check is in test_mcp_stata_runtime_patch_rc7.js); every
// inserted statement is try-guarded, it writes JSON lines only while
// STATA_WORKBENCH_TIMING_FILE is set and skips (never fails) a missing anchor.
// Mutants of each guard must fail.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const cp = require("node:child_process");
const patch = require("./apply_wp1_timing_patch");
const timing = require("./stata_timing_patch");
const fingerprint = require("./finalize_bundle_identity");
const { revertAfter } = require("./later_bundle_patches");

const NAME = "./apply_wp1_timing_patch";
const ROOT = path.join(__dirname, "..");
const bundle = revertAfter(fs.readFileSync(path.join(ROOT, "dist", "extension.js"), "utf8"), NAME);
const before = patch.revertBundle(bundle);
let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; };

// ---- layer identity ---------------------------------------------------------
ok(fingerprint.verify(bundle).ok === true, "bundle identity verifies");
ok(patch.patchBundle(before) === bundle, "replay reproduces the sealed layer");
ok(patch.patchBundle(bundle, { finalize: false }) === bundle, "patch is byte-idempotent");
ok(bundle.includes(patch.MARKER) && !before.includes(patch.MARKER), "marker only in the patched layer");
ok(!before.includes("__codexWbTiming"), "no timing text below the layer");
assert.throws(() => patch.patchBundle(before.replace("let e=Q??{},t=Date.now();try{let o=A;", "")), /W-P1 timing anchor/);
checks++;

// Every inserted byte is either the helper or a guarded site.
let stripped = bundle.replace(patch.HELPER, "");
for (const [b, a] of patch.SITES) stripped = stripped.split(a).join(b);
ok(fingerprint.finalize(stripped).text === before, "insertions are exactly the helper plus SITES");
for (const [, a] of patch.SITES) {
  const calls = a.match(/globalThis\.__codexWbTiming\(/g) || [];
  const guards = a.match(/try\{globalThis\.__codexWbTiming&&globalThis\.__codexWbTiming\(/g) || [];
  ok(calls.length === guards.length && calls.length >= 1, "every site call is try-guarded: " + a.slice(0, 40));
}

// ---- helper semantics in a VM ------------------------------------------------
function loadHelper(helperText, opts = {}) {
  const lines = [], appended = [];
  const ctx = {
    RI: (line) => lines.push(line), Date, performance: { now: () => 1234.5 }, JSON, Object, String, Array, Promise,
    process: { pid: 42, env: opts.env || {} },
    require: () => ({ appendFileSync: (file, text) => appended.push([file, text]) }),
    zg: { _parseToolJson: (x) => x },
  };
  ctx.globalThis = ctx;
  if (opts.warm) ctx.__codexEnsureBackendWarm = opts.warm;
  if (opts.terminal) ctx.__codexTerminalWarmup = opts.terminal;
  vm.runInNewContext(helperText, ctx);
  return { ctx, lines, appended };
}

(async () => {
  const state = { outcome: "READY" };
  const h = loadHelper(patch.HELPER, { warm: async () => state, terminal: async () => { throw new Error("refused: x"); },
    env: { STATA_WORKBENCH_TIMING_FILE: "/t/timing.jsonl" } });
  ok(await h.ctx.__codexEnsureBackendWarm("r1", "terminal-input") === state, "warm wrapper returns the wrapped value");
  await assert.rejects(() => h.ctx.__codexTerminalWarmup("r2", {}), /refused: x/); checks++;
  const events = h.lines.map((l) => JSON.parse(l.replace("[wb-timing] ", "")).event);
  ok(JSON.stringify(events) === JSON.stringify(["ext_backend_warm_start", "ext_backend_warm_end", "ext_terminal_enter",
    "ext_terminal_warmup_start", "ext_terminal_warmup_end"]), "warm-up events in order: " + events.join(","));
  ok(h.appended.length === 5 && h.appended.every(([f]) => f === "/t/timing.jsonl"), "file gets every line when the env var is set");
  const end = JSON.parse(h.lines[4].replace("[wb-timing] ", ""));
  ok(end.outcome === "THREW" && end.errorClass === "Error", "refusal is recorded, not swallowed");
  ok(!h.lines.join("\n").includes("refused") && !("error" in end), "error message text is not logged");
  const al = loadHelper(patch.HELPER, { env: { STATA_WORKBENCH_TIMING_FILE: "/t/a.jsonl" } });
  al.ctx.__codexWbTiming("ext_tool_done", { tool: "x".repeat(200), ms: 5, code: "display 1", path: "/Users/a/b.log", opts: { onProgress() {} } });
  al.ctx.__codexWbTiming("ext_unknown", { tool: "t", runId: "r" });
  al.ctx.__codexWbTiming("ext_terminal_warmup_start", { runId: { toString() { return "/secret"; } }, source: { cwd: "/w" } });
  const recs = al.lines.map((l) => JSON.parse(l.replace("[wb-timing] ", "")));
  const keys = (r) => Object.keys(r).filter((k) => !["event", "wall", "mono", "pid", "src"].includes(k)).sort().join(",");
  ok(keys(recs[0]) === "ms,tool" && recs[0].tool.length === 80, "allowlist keeps tool/ms only, strings cut to 80");
  ok(keys(recs[1]) === "" && keys(recs[2]) === "", "unknown events and object values carry no fields");
  const pathError = Object.assign(new TypeError("cannot open /Users/someone/private/file.log"), { code: "ENOENT" });
  const ew = loadHelper(patch.HELPER, { warm: async () => { throw pathError; } });
  await assert.rejects(() => ew.ctx.__codexEnsureBackendWarm("r9"), (e) => e === pathError); checks++;
  const ee = JSON.parse(ew.lines[1].replace("[wb-timing] ", ""));
  ok(ee.errorClass === "TypeError" && ee.errorCode === "ENOENT" && !ew.lines.join("").includes("/Users/"), "error keeps class/code, drops message and path");
  const quiet = loadHelper(patch.HELPER, {});
  quiet.ctx.__codexWbTiming("x", {}, true);
  quiet.ctx.__codexWbSessionStatus({ sessions: [{ id: "default", status: "starting" }] });
  quiet.ctx.__codexWbSessionStatus({ sessions: [{ id: "default", status: "starting" }] });
  quiet.ctx.__codexWbSessionStatus({ sessions: [{ id: "default", status: "running" }] });
  ok(quiet.lines.length === 2 && quiet.appended.length === 0, "quiet lines skip the channel; no file without env; status logged on change only");
  // A timing helper that throws must not change the wrapped result.
  const wrapped = loadHelper(patch.HELPER, { warm: async () => state });
  wrapped.ctx.RI = () => { throw new Error("channel gone"); };
  ok(await wrapped.ctx.__codexEnsureBackendWarm("r3") === state, "throwing channel does not change the result");

  // Mutants: each must make a check above fail.
  const mutants = [
    ["drop rethrow", "      throw error;\n", "      return null;\n"],
    ["drop return", "    return result;\n  };", "    return undefined;\n  };"],
    ["unguarded channel", ["try { if (!quiet && typeof RI === \"function\") RI(\"[wb-timing] \" + line); } catch {}", "  } catch {}\n}\nglobalThis.__codexWbTiming ="],
      ["if (!quiet) RI(\"[wb-timing] \" + line);", "  } finally {}\n}\nglobalThis.__codexWbTiming ="]],
    ["no allowlist", "    for (const key of __codexWbFields[event] || []) {", "    for (const key of Object.keys(fields || {})) {"],
    ["error message kept", ["  return out;\n}", '  ext_backend_warm_end: ["runId", "outcome", "ms", "errorClass", "errorCode"],'],
      ["  out.message = String(error && error.message);\n  return out;\n}", '  ext_backend_warm_end: ["runId", "outcome", "ms", "errorClass", "errorCode", "message"],']],
  ];
  for (const [label, from0, to0] of mutants) {
    const froms = Array.isArray(from0) ? from0 : [from0], tos = Array.isArray(to0) ? to0 : [to0];
    let text = patch.HELPER;
    froms.forEach((from, i) => { assert.equal(text.split(from).length - 1, 1, "mutant anchor " + label); text = text.replace(from, tos[i]); });
    let caught = false;
    try {
      const m = loadHelper(text, { warm: async () => state, terminal: async () => { throw new Error("refused: x"); } });
      if (label === "unguarded channel") { m.ctx.RI = () => { throw new Error("channel gone"); }; m.ctx.__codexWbTiming("ext_tool_send", { tool: "t" }); }
      if (label === "no allowlist") { m.ctx.__codexWbTiming("ext_tool_done", { tool: "t", code: "display 1" }); if (m.lines.join("").includes("display 1")) caught = true; }
      if (label === "error message kept") {
        const w = loadHelper(text, { warm: async () => { throw new Error("at /Users/x"); } });
        try { await w.ctx.__codexEnsureBackendWarm("e"); } catch {}
        if (w.lines.join("").includes("/Users/x")) caught = true;
      }
      const r = await m.ctx.__codexEnsureBackendWarm("m");
      if (r !== state) caught = true;
      try { await m.ctx.__codexTerminalWarmup("m2", {}); caught = true; } catch (e) { if (!/refused/.test(e.message)) caught = true; }
    } catch { caught = true; }
    ok(caught, "mutant caught: " + label);
  }
  // Site guard mutant: an unguarded site lets a throwing helper escape.
  const site = patch.SITES[3][1];
  const bare = site.replace("try{globalThis.__codexWbTiming&&globalThis.__codexWbTiming(", "(globalThis.__codexWbTiming(").replace(")}catch{}})()", "))})()");
  const run = (expr) => { const c = { globalThis: { __codexWbTiming: () => { throw new Error("boom"); } }, o: { _runId: "r" }, s: "/p", t: 0,
    _log: () => {}, _ensureLogTail: () => ({ catch: () => {} }) }; c.this = c;
    return vm.runInNewContext("(()=>{" + expr.replace(/this\./g, "self.") + "})()", Object.assign(c, { self: c })); };
  const body = (s) => s.slice(0, s.lastIndexOf(",")) + ";";
  assert.doesNotThrow(() => run(body(site))); checks++;
  assert.throws(() => run(body(bare)), /boom/); checks++;

  // ---- mcp-stata milestones ----------------------------------------------------
  const synthetic = {
    server: 'import os\nimport anyio\n\nlogger = logging.getLogger("mcp_stata")\n' +
      "def log_call(tool_name, request_id):\n    logger.info(\"MCP tool call: %s request_id=%s\", tool_name, request_id)\n    return 1\n\n" +
      timing.WAIT_ORIGINAL,
    session: 'import os\n\nlogger = logging.getLogger("mcp_stata.sessions")\n',
    client: 'import os\n\nlogger = logging.getLogger("mcp_stata")\n',
  };
  for (const [component, src] of Object.entries(synthetic)) {
    const r = timing.patchComponent(component, src);
    ok(r.status.helper === "applied", component + " helper applied");
    ok(timing.patchComponent(component, r.source).source === r.source, component + " idempotent");
    const missing = Object.entries(r.status).filter(([, v]) => v === "missing").length;
    ok(component !== "server" ? missing === timing.POINTS[component].points.length : missing === 0,
      component + " reports missing anchors instead of failing");
  }
  ok(timing.patchComponent("session", "no anchor here\n").status.helper === "missing", "no helper anchor: skipped");
  // Outside the product chain: the runtime patch must not load or mention it.
  const runtimeSource = fs.readFileSync(path.join(__dirname, "mcp_stata_runtime_patch.js"), "utf8");
  ok(!runtimeSource.includes("stata_timing_patch") && !runtimeSource.includes(timing.ENV) && !runtimeSource.includes("_wb_timing"),
    "mcp_stata_runtime_patch does not load the timing tool");
  ok(!fs.readFileSync(path.join(ROOT, "dist", "extension.js"), "utf8").includes("stata_timing_patch"), "bundle does not load the timing tool");
  // Every inserted Python statement is inside its own try/except.
  for (const component of Object.keys(timing.POINTS)) {
    const lines = timing.patchComponent(component, synthetic[component]).source.split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*_wb_timing\(|_WB_FIRST_LOG\.add/.test(line) || /def _wb_timing/.test(line)) return;
      const block = lines.slice(Math.max(0, i - 4), i).join("\n");
      ok(/try:/.test(block), component + " line guarded: " + line.trim().slice(0, 50));
    });
  }

  // Python: a broken task_info or a helper that raises never reaches the caller.
  const pyGuard = ["python3", "python"].find((exe) => cp.spawnSync(exe, ["-c", "import sys"], { stdio: "ignore" }).status === 0);
  if (pyGuard) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp1-guard-"));
    const server = timing.patchComponent("server", synthetic.server).source
      .replace("import anyio\n", "import types, asyncio, logging\nanyio = types.SimpleNamespace(sleep=asyncio.sleep)\nBackgroundTask = object\n");
    const prog = server + `
class Broken:
    log_path = "/p"
    done = True
    def __getattr__(self, name):
        raise RuntimeError("no " + name)
def boom(event, **fields):
    raise RuntimeError("helper failed")
r1 = asyncio.run(_wait_for_log_path(Broken()))
_wb_timing = boom
r2 = asyncio.run(_wait_for_log_path(Broken()))
print("GUARD_OK", r1, r2, log_call("t", 1))
`;
    fs.writeFileSync(path.join(dir, "g.py"), prog);
    const g = cp.spawnSync(pyGuard, [path.join(dir, "g.py")], { env: { ...process.env, STATA_WORKBENCH_TIMING_FILE: path.join(dir, "t.jsonl") }, encoding: "utf8" });
    ok(g.status === 0 && /GUARD_OK None None 1/.test(g.stdout), "python guards: " + (g.stderr || g.stdout).slice(-200));
    // The tool never writes the runtime it reads: direct target, directory alias
    // (symlink / junction) and linked .py files all stay byte-identical; only a
    // new plain copy is instrumented.
    const installed = path.join(dir, "installed");
    const pkg = path.join(installed, "Lib", "site-packages", "mcp_stata");
    fs.mkdirSync(pkg, { recursive: true });
    for (const [c, name] of [["server", "server.py"], ["session", "sessions.py"], ["client", "stata_client.py"]]) {
      fs.writeFileSync(path.join(pkg, name), synthetic[c].replace(/\n/g, "\r\n"));
    }
    fs.writeFileSync(path.join(pkg, "other.py"), "x = 1\n");
    const snap = (root) => {
      const out = {};
      const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f);
        if (st.isSymbolicLink()) out[path.relative(root, f)] = "link:" + fs.readlinkSync(f);
        else if (st.isDirectory()) walk(f); else out[path.relative(root, f)] = fs.readFileSync(f).toString("base64"); } };
      walk(root); return JSON.stringify(out);
    };
    const original = snap(installed);
    const plainCopy = (o, label) => {
      const d = timing.packageDir(o);
      for (const name of ["server.py", "sessions.py", "stata_client.py", "other.py"]) {
        const st = fs.lstatSync(path.join(d, name));
        ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, label + " " + name + " is a plain file");
      }
      const text = fs.readFileSync(path.join(d, "sessions.py"), "utf8");
      ok(text.includes(timing.MARKER) && !/[^\r]\n/.test(text), label + " copy instrumented, CRLF kept");
    };
    const a = timing.instrumentCopy(installed, { out: path.join(dir, "outA") });
    ok(a.ok && snap(installed) === original, "direct target: original unchanged");
    plainCopy(path.join(dir, "outA"), "direct");
    ok(timing.instrumentCopy(installed, { out: path.join(dir, "outA") }).status === "output-exists", "existing output refused");
    ok(timing.instrumentCopy(installed, { out: path.join(pkg, "nested") }).status === "output-overlaps-source" && snap(installed) === original,
      "output inside the source refused");
    const again = timing.instrumentCopy(path.join(dir, "outA"), { out: path.join(dir, "outA2") });
    ok(again.ok && Object.values(again.components).every((c) => !Object.values(c).includes("applied"))
      && snap(path.join(dir, "outA")) === snap(path.join(dir, "outA2")), "re-instrumenting a copy is a no-op");
    const alias = path.join(dir, "alias");
    fs.symlinkSync(installed, alias, process.platform === "win32" ? "junction" : "dir");
    const b = timing.instrumentCopy(alias, { out: path.join(dir, "outB") });
    ok(b.ok && snap(installed) === original, "directory alias: original unchanged");
    plainCopy(path.join(dir, "outB"), "alias");
    const linked = path.join(dir, "linked", "Lib", "site-packages", "mcp_stata");
    fs.mkdirSync(linked, { recursive: true });
    fs.linkSync(path.join(pkg, "server.py"), path.join(linked, "server.py"));
    let fileLink = true;
    try { fs.symlinkSync(path.join(pkg, "sessions.py"), path.join(linked, "sessions.py"), "file"); }
    catch { fileLink = false; fs.linkSync(path.join(pkg, "sessions.py"), path.join(linked, "sessions.py")); }
    fs.copyFileSync(path.join(pkg, "stata_client.py"), path.join(linked, "stata_client.py"));
    fs.copyFileSync(path.join(pkg, "other.py"), path.join(linked, "other.py"));
    const linkedSnap = snap(path.join(dir, "linked"));
    const c = timing.instrumentCopy(path.join(dir, "linked"), { out: path.join(dir, "outC") });
    ok(c.ok && snap(installed) === original && snap(path.join(dir, "linked")) === linkedSnap,
      "hardlinked" + (fileLink ? " and symlinked" : "") + " .py files: originals unchanged");
    plainCopy(path.join(dir, "outC"), "linked");
    const d = timing.instrumentCopy(installed);
    ok(d.ok && (d.out.startsWith(fs.realpathSync(os.tmpdir())) || d.out.startsWith(os.tmpdir())), "default output is a fresh temp dir");
    ok(snap(installed) === original, "default output: original unchanged");
    fs.rmSync(path.dirname(d.out), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  } else console.log("SKIP python guard checks: no python3 on PATH");

  // Python: the helper compiles, writes only while the variable is set.
  const py = ["python3", "python"].find((exe) => cp.spawnSync(exe, ["-c", "import sys"], { stdio: "ignore" }).status === 0);
  if (py) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp1-timing-"));
    const file = path.join(dir, "t.jsonl");
    const src = timing.patchComponent("session", synthetic.session).source.replace("logger = logging.getLogger", "import logging\nlogger = logging.getLogger");
    const mod = path.join(dir, "m.py");
    fs.writeFileSync(mod, src + "\n_wb_timing('probe', a=1)\n");
    const off = cp.spawnSync(py, [mod], { env: { ...process.env, STATA_WORKBENCH_TIMING_FILE: "" } });
    ok(off.status === 0 && !fs.existsSync(file), "python: no file without the variable");
    const on = cp.spawnSync(py, [mod], { env: { ...process.env, STATA_WORKBENCH_TIMING_FILE: file } });
    const rec = on.status === 0 && JSON.parse(fs.readFileSync(file, "utf8").trim());
    ok(rec && rec.event === "probe" && rec.a === 1 && typeof rec.wall === "number" && rec.src === "py", "python: one JSON line with the variable");
    fs.rmSync(dir, { recursive: true, force: true });
  } else console.log("SKIP python checks: no python3 on PATH");

  // Deployed runtime (optional): anchors resolve against the real 1.26.1 files.
  const deployed = path.join(os.homedir(), ".local/share/stata-workbench/mcp-stata-1.26.1/lib/python3.11/site-packages/mcp_stata");
  if (fs.existsSync(path.join(deployed, "sessions.py"))) {
    for (const [component, file] of [["server", "server.py"], ["session", "sessions.py"], ["client", "stata_client.py"]]) {
      const r = timing.patchComponent(component, fs.readFileSync(path.join(deployed, file), "utf8"));
      const bad = Object.entries(r.status).filter(([, v]) => v === "missing" || v === "ambiguous");
      ok(bad.length === 0, component + " deployed anchors: " + JSON.stringify(bad));
    }
  } else console.log("SKIP deployed anchors: no local mcp-stata 1.26.1");
  console.log(`WP1_TIMING_OK checks=${checks}`);
})().catch((error) => { console.error(error); process.exit(1); });
