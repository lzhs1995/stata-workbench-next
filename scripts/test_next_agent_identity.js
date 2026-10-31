#!/usr/bin/env node
"use strict";

// 回归：Next 阶段 B（agent 身份、Terminal 抬头、/status 来源、事件流）。
// 第 1 部分直接跑 next_session_core；第 2 部分查补丁可逆与接线；第 3 部分在 vm 里跑
// bundle 里真实的 webview ensureRunGroup，看抬头是否出现且已转义。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const core = require("./next_session_core");
const patch = require("./apply_next_agent_identity_patch");
const fingerprint = require("./finalize_bundle_identity");
const { LATER, revertAfter } = require("./later_bundle_patches");
const execution = require("./execution_lifecycle_core");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-next-identity-"));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

try {
  // 1. 核心模块
  ok(core.sanitizeAgentName("  codex-astra  ") === "codex-astra", "trim");
  ok(core.sanitizeAgentName("<script>x</script>") === "scriptxscript", "strip markup characters");
  ok(core.sanitizeAgentName("a".repeat(99)).length === core.AGENT_NAME_MAX, "length cap");
  ok(core.sanitizeAgentName("") === null && core.sanitizeAgentName(null) === null, "empty -> null");
  ok(core.sanitizeAgentName("研究助手 1") === "研究助手 1", "CJK letters kept");
  ok(core.originOf("agent") === "agent" && core.originOf("human-file") === "human", "origin");
  ok(core.originOf("agent", "recovery-smoke") === "internal", "recovery smoke is internal");
  ok(core.originLabel({ source: "agent", agentName: "claude" }, "run_1") === "claude · run_1", "agent label");
  ok(core.originLabel({ source: "agent" }, "run_2") === "agent · run_2", "unnamed agent");
  ok(core.originLabel(null, "run_3") === "You · run_3", "human label");
  ok(/claude is running Stata \(run_9\).*Stop/.test(core.busyMessage({ busy: true, source: "agent", agentName: "claude", runId: "run_9" })), "busy message names the agent and Stop");
  ok(/Another run is running Stata/.test(core.busyMessage({ busy: true, source: "human-file", runId: "r" })), "busy message for a human run");

  let clock = Date.parse("2026-10-31T12:00:00Z");
  const session = core.createSession({ stateRoot: tmp, now: () => clock, randomBytes: () => Buffer.from("abcd") });
  ok(/^s20261031T120000Z-61626364$/.test(session.sessionId), "session id " + session.sessionId);
  ok(session.eventsPath === path.join(tmp, "runs", session.sessionId, "events.jsonl"), "events path under runs/<id>");
  ok(!fs.existsSync(session.dataDir), "no directory before the first event");
  session.runStart({ runId: "codex_1", source: "agent", agentName: "claude", code: "display 1", codePreview: "display 1" });
  clock += 1000;
  // 包过的 execution：finishRun 走原逻辑并记 run-end
  const bridge = { agentName: "claude", source: "agent" };
  const wrapped = core.wrapExecution(execution, session, () => bridge);
  ok(wrapped.beginRun === execution.beginRun, "other functions pass through");
  wrapped.beginRun(bridge, { runId: "codex_1", sourceMode: "agent" }, clock - 1000);
  wrapped.adoptRunId(bridge, "terminal_1");
  const completed = wrapped.finishRun(bridge, { rc: 0, completionMarkerVerified: true }, clock);
  ok(completed.runId === "terminal_1" && completed.phase === "completed", "finishRun result unchanged");
  // 同一运行再收一次（soft Stop 之后运行自己的释放）：记 run-end-update，不是第二条 run-end
  wrapped.finishRun(bridge, { rc: 1, error: new Error("late release") }, clock);
  session.runRefused({ runId: "human_2", source: "human-file", busyRunId: "terminal_1" }, { kind: "busy" });
  const lines = fs.readFileSync(session.eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(lines.map((e) => e.type).join(",") === "run-start,run-end,run-end-update,run-refused", "event types " + lines.map((e) => e.type));
  ok(lines.map((e) => e.seq).join(",") === "1,2,3,4", "monotonic seq");
  ok(lines[0].codeSha256 === require("node:crypto").createHash("sha256").update("display 1", "utf8").digest("hex"), "code sha recorded");
  ok(lines[1].agentName === "claude" && lines[1].origin === "agent" && lines[1].rc === 0 && lines[1].runId === "terminal_1", "run-end carries agent and terminal runId");
  ok(lines[2].rc === 1 && lines[2].failure === "late release", "repeat finish keeps its own fields");
  ok(lines[3].origin === "human" && lines[3].busyRunId === "terminal_1", "refusal names the busy run");
  if (process.platform !== "win32") ok((fs.statSync(session.eventsPath).mode & 0o777) === 0o600, "events file is 0600");
  const page = session.since(1);
  ok(page.events.length === 3 && page.events[0].seq === 2 && page.lastSeq === 4 && page.truncated === false, "since(1)");
  ok(session.since(4).events.length === 0 && session.since("x").events.length === 4, "since bounds");
  ok(session.since(0, 1).more === true, "pagination reports more");
  for (let i = 0; i < core.RING_MAX + 5; i++) session.record("noise", {});
  const old = session.since(1);
  ok(old.truncated === true && old.events[0].seq > 2, "evicted range is reported as truncated");
  ok(session.publicSession().writeError === null && session.publicSession().lastSeq === 4 + core.RING_MAX + 5, "public session");
  // 写不进去时不抛，记 writeError
  const blocked = path.join(tmp, "blocked");
  fs.writeFileSync(blocked, "x");
  const broken = core.createSession({ stateRoot: blocked });
  broken.runStart({ runId: "r", source: "agent" });
  ok(broken.publicSession().writeError !== null && broken.since(0).events.length === 1, "write failure stays in memory");

  // 2. 补丁：幂等、精确可逆、紧跟上一层
  assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
  assert.equal(fingerprint.verify(bundle).ok, true);
  const name = "./apply_next_agent_identity_patch";
  const sealed = revertAfter(bundle, name);
  const legacy = patch.revertBundle(sealed);
  assert.equal(legacy, revertAfter(bundle, LATER[LATER.indexOf(name) - 1]), "directly follows the previous later layer");
  assert.equal(patch.patchBundle(legacy), sealed, "replay reproduces the sealed layer");
  assert.throws(() => patch.patchBundle(legacy.replace(patch.EDITS[0][0], "")), /anchor/);
  assert.throws(() => patch.patchBundle(legacy + "__codexNextSessionRef"), /partial/);
  checks += 6;
  ok(!/[^\x00-\x7f]/.test(patch.EDITS.map((e) => e[1]).join("")), "patch strings are ASCII only");
  // 接线：一处建会话，/events 在 /status 之前，两处 runStarted 都带 origin，两处提示都换掉
  ok(bundle.split("__nextCore.createSession(").length === 2, "one session per activation");
  ok(bundle.split('__codexExecution=require(rg.join(((yC&&yC.extensionUri&&yC.extensionUri.fsPath)||process.cwd()),"scripts","execution_lifecycle_core.js"))').length === 2, "original lifecycle require kept byte-identical");
  ok(bundle.split("__codexExecution=__nextCore.wrapExecution(__codexExecution,").length === 2, "local adapter rebound to the wrapped one");
  ok(!bundle.includes("__codexExecutionAdapter.finishRun"), "global adapter never calls finishRun, so wrapping the local binding covers every exit path");
  ok(bundle.split("__codexExecution.finishRun(").length === 4, "three finishRun call sites, all on the local binding");
  ok(bundle.indexOf('__req.url==="/events"') < bundle.indexOf('__req.url==="/status"'), "/events route before /status");
  ok(bundle.split("origin:globalThis.__codexNextOriginLabel?").length === 3, "both runStarted posts carry origin");
  ok(bundle.split("__codexNextOriginLabel(B,true)").length === 2, "Terminal input is always labelled human");
  ok(bundle.split("globalThis.__codexNextBusyMessage?globalThis.__codexNextBusyMessage()").length === 3, "both human busy warnings");

  // 2b. 在 vm 里跑 bundle 里真实的激活语句：建会话、局部 __codexExecution 换成包过的版本；
  //     require 失败时只记 __codexNextSessionError，不抛。
  const actStart = bundle.indexOf("globalThis.__codexExecutionAdapter=__codexExecution;try{let __nextCore=");
  const actEnd = bundle.indexOf(patch.MARKER, actStart);
  ok(actStart > 0 && actEnd > actStart, "activation statement located");
  const activation = bundle.slice(actStart, actEnd);
  for (const broken of [false, true]) {
    const g = {};
    const box = {
      globalThis: g, process: { env: { STATA_WORKBENCH_NEXT_HOME: path.join(tmp, "act") }, cwd: () => __dirname },
      yC: { extensionUri: { fsPath: path.join(__dirname, "..") } }, rg: path,
      require: (p) => { if (broken) throw new Error("no core"); return require(p); },
      __codexExecution: execution, String,
    };
    vm.runInNewContext("var __codexExecution=__codexExecution;" + activation + ";globalThis.__local=__codexExecution;", box);
    if (broken) {
      ok(g.__codexNextSessionError === "no core" && g.__local === execution && !g.__codexNextSessionRef, "failed core leaves the original adapter");
    } else {
      ok(g.__codexExecutionAdapter === execution, "global adapter stays the original module");
      ok(g.__local !== execution && g.__local.beginRun === execution.beginRun, "local binding is the wrapped adapter");
      ok(g.__codexNextSessionRef && /^s\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(g.__codexNextSessionRef.sessionId), "session created");
      ok(g.__codexNextOriginLabel("t9", true) === "You · t9", "origin helper exported");
      ok(/already running|is running|busy/.test(g.__codexNextBusyMessage()), "busy helper exported");
    }
  }

  // 3. 在 vm 里跑 bundle 里真实的 ensureRunGroup：抬头出现、HTML 已转义、没有 origin 时不加
  const start = bundle.indexOf("function ensureRunGroup(runId, code, origin) {");
  const end = bundle.indexOf("\n    }\n", bundle.indexOf("runs[runId] = {", start)) + 6;
  ok(start > 0 && end > start, "webview ensureRunGroup located");
  const source = bundle.slice(start, end);
  const appended = [];
  const sandbox = {
    runs: {}, history: [], historyIndex: 0, autoScrollPinned: false, scrollToBottom() {}, updateLastCommand() {},
    chatStream: { lastElementChild: null, appendChild(div) { appended.push(div); } },
    document: { createElement: () => ({ dataset: {}, className: "", innerHTML: "" }), getElementById: () => null },
    window: { stataUI: { escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") } },
  };
  vm.runInNewContext(source + "\nensureRunGroup('r1', 'display 1', 'claude \\u00b7 r1');\nensureRunGroup('r2', 'display 2', '<b>x</b>');\nensureRunGroup('r3', 'display 3');", sandbox);
  ok(appended.length === 3, "three cards");
  ok(appended[0].innerHTML.startsWith('<div class="run-origin') && appended[0].innerHTML.includes("claude · r1"), "agent header rendered first");
  ok(appended[1].innerHTML.includes("&lt;b&gt;x&lt;/b&gt;") && !appended[1].innerHTML.includes("<b>x</b>"), "header is escaped");
  ok(!appended[2].innerHTML.includes("run-origin"), "no header without origin");
  console.log(`PASS next agent identity/events: ${checks} checks`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
