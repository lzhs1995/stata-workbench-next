"use strict";
// task_done rc runtime patch: strict states, byte-exact revert, full patchRuntime
// chain repeated on temp copies (LF and CRLF), and the patched Python sends
// "rc" only when a validated response gave one. Never writes a live runtime.
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rc = require("./stata_task_done_rc_patch");
const runtimePatch = require("./mcp_stata_runtime_patch");

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log("ok", name); };
const server = ["# fixture", runtimePatch.PATCHED_TASK_DONE_NOTIFY, "x = 1", rc.RUN_ORIGINAL, "y = 2", rc.RUN_ORIGINAL, "# end", ""].join("\n");

ok("unpatched -> patched -> idempotent -> exact revert", () => {
  assert.equal(rc.state(server), "unpatched");
  const patched = rc.patchServer(server);
  assert.equal(rc.state(patched), "patched");
  assert.equal(rc.patchServer(patched), patched);
  assert.equal(rc.revertServer(patched), server);
  assert.equal(patched.split(rc.MARKER).length - 1, 3);
});
ok("partial, duplicated and unknown sources are refused", () => {
  const patched = rc.patchServer(server);
  const partial = [
    patched.replace(rc.NOTIFY_PATCHED, rc.NOTIFY_ORIGINAL),               // runs patched, payload not
    patched.replace(rc.RUN_PATCHED, rc.RUN_ORIGINAL),                     // one run reverted
    server.replace(rc.RUN_ORIGINAL, ""),                                  // only one run block
    server + rc.RUN_ORIGINAL,                                             // three run blocks
    server.replace(rc.NOTIFY_ORIGINAL, rc.NOTIFY_ORIGINAL.replace("error", "err")), // unknown payload
    server.replace(runtimePatch.PATCHED_TASK_DONE_NOTIFY, runtimePatch.ORIGINAL_TASK_DONE_NOTIFY), // before transport patch
    server + "# " + rc.MARKER + ".\n",                                    // stray marker
  ];
  for (const source of partial) {
    assert.equal(rc.state(source), "unsupported");
    assert.throws(() => rc.patchServer(source), /unsupported task_done rc source/);
  }
  assert.throws(() => rc.revertServer(server), /not a task_done rc patched source/);
});
ok("a complete patched source plus an extra original run or notify block is refused (codex R1)", () => {
  const patched = rc.patchServer(server);
  for (const extra of [rc.RUN_ORIGINAL, rc.NOTIFY_ORIGINAL]) {
    const bad = patched + "\n" + extra;
    assert.equal(rc.state(bad), "unsupported");
    assert.throws(() => rc.patchServer(bad), /unsupported task_done rc source/);
    assert.throws(() => rc.revertServer(bad), /not a task_done rc patched source/);
  }
});

// Real mcp-stata files, copied (never the live directory). CI has no live
// runtime; there the synthetic chain in test_mcp_stata_runtime_patch_rc7 runs.
const live = path.join(os.homedir(), ".local", "share", "stata-workbench", "mcp-stata-1.26.1");
const livePkg = fs.existsSync(live) && fs.readdirSync(path.join(live, "lib")).map((v) => path.join(live, "lib", v, "site-packages", "mcp_stata"))
  .find((p) => fs.existsSync(path.join(p, "server.py")));
if (livePkg) {
  const names = ["server.py", "stata_client.py", "graph_detector.py", "sessions.py"];
  const liveBefore = Object.fromEntries(names.map((f) => [f, fs.readFileSync(path.join(livePkg, f))]));
  for (const eol of ["lf", "crlf"]) {
    ok("full patchRuntime chain on a " + eol + " temp copy: off -> on -> on, revert exact", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "v3a-rc-chain-"));
      const pkg = path.join(root, "lib", "python3.11", "site-packages", "mcp_stata");
      fs.mkdirSync(pkg, { recursive: true });
      const original = rc.revertServer(rc.patchServer(liveBefore["server.py"].toString("utf8").replace(/\r\n/g, "\n")));
      for (const f of names) {
        let text = f === "server.py" ? original : liveBefore[f].toString("utf8");
        if (eol === "crlf") text = text.replace(/\r?\n/g, "\r\n");
        fs.writeFileSync(path.join(pkg, f), text);
      }
      const opts = { runtimeRoot: root, pythonCommand: process.execPath, compileSpawnSync: () => ({ status: 0, stdout: "", stderr: "" }) };
      const first = runtimePatch.patchRuntime(opts);
      assert.equal(first.ok, true, JSON.stringify(first).slice(0, 300));
      assert.equal(first.serverStatus, "applied");
      const once = Object.fromEntries(names.map((f) => [f, fs.readFileSync(path.join(pkg, f))]));
      for (let i = 0; i < 2; i++) {
        const again = runtimePatch.patchRuntime(opts);
        assert.equal(again.ok, true);
        assert.equal(again.status, "already-applied");
        for (const f of names) assert.deepEqual(fs.readFileSync(path.join(pkg, f)), once[f], f + " stable");
      }
      const text = once["server.py"].toString("utf8");
      assert.equal(/\r\n/.test(text), eol === "crlf", "EOL kept");
      assert.equal(rc.state(text.replace(/\r\n/g, "\n")), "patched");
      const back = rc.revertServer(text.replace(/\r\n/g, "\n"));
      assert.equal(back, liveBefore["server.py"].toString("utf8").replace(/\r\n/g, "\n"), "revert gives the pre-patch server");
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
  ok("full patchRuntime on a temp copy with an extra unpatched run block: unsupported-source, nothing written", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v3a-rc-bad-"));
    const pkg = path.join(root, "lib", "python3.11", "site-packages", "mcp_stata");
    fs.mkdirSync(pkg, { recursive: true });
    const patchedServer = rc.patchServer(liveBefore["server.py"].toString("utf8").replace(/\r\n/g, "\n"));
    for (const f of names) fs.writeFileSync(path.join(pkg, f), f === "server.py" ? patchedServer + "\n" + rc.RUN_ORIGINAL : liveBefore[f]);
    const before = Object.fromEntries(names.map((f) => [f, fs.readFileSync(path.join(pkg, f))]));
    const r = runtimePatch.patchRuntime({ runtimeRoot: root, pythonCommand: process.execPath,
      compileSpawnSync: () => ({ status: 0, stdout: "", stderr: "" }) });
    assert.equal(r.ok, false);
    assert.equal(r.status, "unsupported-source");
    assert.equal(r.anchor, "task-done-rc");
    for (const f of names) assert.deepEqual(fs.readFileSync(path.join(pkg, f)), before[f], f + " not written");
    fs.rmSync(root, { recursive: true, force: true });
  });
  ok("the live runtime was not written", () => {
    for (const f of names) assert.deepEqual(fs.readFileSync(path.join(livePkg, f)), liveBefore[f], f);
  });
}

// The patched notify and run code, executed by Python with stubs.
const py = ["python3", "python"].find((exe) => cp.spawnSync(exe, ["-c", "import sys"], { stdio: "ignore" }).status === 0);
if (py) ok("patched Python sends the validated model's integer rc; nothing when there is no response", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v3a-rc-py-"));
  const patched = rc.patchServer(server);
  const fn = patched.slice(patched.indexOf("async def _notify_task_done"), patched.indexOf("\nx = 1"));
  const run = rc.RUN_PATCHED.split("\n").map((l) => l.slice(12)).join("\n");
  const prog = `import asyncio, json, logging, types
logger = logging.getLogger("t")
${fn}
sent = []
class S:
    async def send_log_message(self, level, data, related_request_id=None):
        sent.append(json.loads(data))
def run_once(response):
    task_info = types.SimpleNamespace(task_id="t", done=True, log_path="/l", error=None)
    if response is not None:
        result_dict = response
        CommandResponse = types.SimpleNamespace(model_validate=lambda d: types.SimpleNamespace(**d))
        exec(${JSON.stringify(run)}, {"CommandResponse": CommandResponse, "result_dict": result_dict, "task_info": task_info})
    asyncio.run(_notify_task_done(S(), task_info, None))
err = types.SimpleNamespace(message="variable x not found")
run_once({"rc": 111, "log_path": "/l", "error": err})
run_once({"rc": 0, "log_path": "/l", "error": None})
run_once({"rc": "111", "log_path": "/l", "error": None})
run_once(None)
print(json.dumps([s.get("rc", "absent") for s in sent], separators=(",", ":")))
`;
  fs.writeFileSync(path.join(dir, "t.py"), prog);
  const r = cp.spawnSync(py, [path.join(dir, "t.py")], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), JSON.stringify([111, 0, "absent", "absent"]));
});
console.log("STATA_TASK_DONE_RC_PATCH_OK checks=" + n);
