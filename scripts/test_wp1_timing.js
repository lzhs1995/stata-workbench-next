#!/usr/bin/env node
"use strict";

// rc.7.80 W-P1 timing is log-only. Checks: the sealed layer replays and reverts
// byte-exactly; the warm-up wrappers return and throw exactly what they wrap;
// every inserted site is guarded, so a timing helper that throws changes
// nothing; the mcp-stata milestones are applied only with
// STATA_WORKBENCH_TIMING_FILE, compile, write JSON lines only while the variable
// is set, and skip (never fail) a missing anchor. Mutants of each guard must fail.
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
  ok(end.outcome === "THREW" && /refused/.test(end.error), "refusal is recorded, not swallowed");
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
    ["drop return", "      return result;\n", "      return undefined;\n"],
    ["unguarded channel", ["try { if (!quiet && typeof RI === \"function\") RI(\"[wb-timing] \" + line); } catch {}", "  } catch {}\n}\nglobalThis.__codexWbTiming ="],
      ["if (!quiet) RI(\"[wb-timing] \" + line);", "  } finally {}\n}\nglobalThis.__codexWbTiming ="]],
  ];
  for (const [label, from0, to0] of mutants) {
    const froms = Array.isArray(from0) ? from0 : [from0], tos = Array.isArray(to0) ? to0 : [to0];
    let text = patch.HELPER;
    froms.forEach((from, i) => { assert.equal(text.split(from).length - 1, 1, "mutant anchor " + label); text = text.replace(from, tos[i]); });
    let caught = false;
    try {
      const m = loadHelper(text, { warm: async () => state, terminal: async () => { throw new Error("refused: x"); } });
      if (label === "unguarded channel") m.ctx.RI = () => { throw new Error("channel gone"); };
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
  ok(timing.timingEnabled({}) === false && timing.timingEnabled({ STATA_WORKBENCH_TIMING_FILE: "x" }) === true, "gate follows env");

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
