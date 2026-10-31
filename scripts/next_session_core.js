"use strict";

// Next（0.2.0-next）会话身份与事件流。纯 Node，不依赖 VS Code，单测可直接调。
//
// 每次扩展激活建一个会话：sessionId、该会话的数据目录 <stateRoot>/runs/<sessionId>/。
// 人和 agent 的每次运行都记进同一份只追加的 events.jsonl（run-start / run-end / run-refused），
// 内存里留最近 RING_MAX 条供 /events?since=N 读；更早的去读文件。
// 写文件失败不影响运行：事件仍进内存，/status 报 writeError。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const RING_MAX = 2000;
const PAGE_MAX = 500;
const AGENT_NAME_MAX = 40;
const AGENT_SOURCES = new Set(["agent", "visible-bridge"]);

// agent 名只留字母、数字、空格和 ._-@，截到 40 字；空的返回 null。
function sanitizeAgentName(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).normalize("NFC").replace(/[^\p{L}\p{N} ._@-]+/gu, "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, AGENT_NAME_MAX) : null;
}

// 运行来源分三类：agent 发来的、人在编辑器/Terminal 里点的、扩展自己的恢复检查。
function originOf(source, kind) {
  if (kind === "recovery-smoke" || source === "internal-recovery") return "internal";
  return AGENT_SOURCES.has(String(source || "")) ? "agent" : "human";
}

// Terminal 每次运行的抬头：agent 写「agent名 · runId」，人写「You · runId」。
function originLabel(run, terminalRunId) {
  const id = terminalRunId || (run && run.runId) || "?";
  const origin = run ? originOf(run.source, run.kind) : "human";
  if (origin === "internal") return "Workbench check \u00b7 " + id;
  if (origin === "agent") return ((run && run.agentName) || "agent") + " \u00b7 " + id;
  return "You \u00b7 " + id;
}

// 人按 Run 被拒时的提示：说清是谁在跑、跑的哪一次、可以按 Stop。
function busyMessage(state) {
  const s = state || {};
  if (!s.busy) return "Stata Workbench is busy finishing the previous run. Try again in a moment.";
  const who = originOf(s.source, s.kind) === "agent" ? (s.agentName || "An agent") : "Another run";
  const id = s.runId ? " (" + s.runId + ")" : "";
  return who + " is running Stata" + id + ". Wait for it to finish, or press Stop in the Stata Terminal.";
}

function newSessionId(now, randomBytes) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return "s" + stamp + "-" + randomBytes(4).toString("hex");
}

function defaultStateRoot(env) {
  const e = env || process.env;
  return e.STATA_WORKBENCH_NEXT_HOME || path.join(os.homedir(), ".stata-workbench-next");
}

function createSession(options = {}) {
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot(options.env));
  const sessionId = options.sessionId || newSessionId(now(), randomBytes);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid sessionId");
  const dataDir = path.join(stateRoot, "runs", sessionId);
  const eventsPath = path.join(dataDir, "events.jsonl");
  const ring = [];
  let seq = 0;
  let writeError = null;
  const startedAt = new Date(now()).toISOString();

  function append(line) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(eventsPath, line + "\n", { encoding: "utf8", mode: 0o600 });
      writeError = null;
    } catch (error) {
      writeError = String(error && error.code || error && error.message || error);
    }
  }

  function record(type, fields = {}) {
    const event = { seq: ++seq, at: new Date(now()).toISOString(), sessionId, type, ...fields };
    ring.push(event);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    append(JSON.stringify(event));
    return event;
  }

  function runStart(run = {}) {
    return record("run-start", {
      runId: run.runId || null, requestId: run.requestId || run.runId || null,
      source: run.source || null, origin: originOf(run.source, run.kind),
      agentName: sanitizeAgentName(run.agentName), label: run.label || null,
      codePreview: typeof run.codePreview === "string" ? run.codePreview.slice(0, 300) : null,
      codeSha256: typeof run.code === "string" ? crypto.createHash("sha256").update(run.code, "utf8").digest("hex") : null,
    });
  }

  // 一次运行只记一条 run-end；同一运行之后再被 finishRun（例如 soft Stop 先收尾、运行自己的释放又收一次）
  // 记成 run-end-update，字段相同，配对 run-start/run-end 的读者不会数出两条。
  function runEnd(completed = {}, extra = {}) {
    return record(extra.repeat ? "run-end-update" : "run-end", {
      runId: completed.runId || null, requestId: completed.requestId || null,
      source: completed.sourceMode || extra.source || null, origin: originOf(completed.sourceMode || extra.source, extra.kind),
      agentName: sanitizeAgentName(extra.agentName), phase: completed.phase || null,
      rc: typeof completed.rc === "number" ? completed.rc : null, durationMs: completed.durationMs ?? null,
      logPath: completed.logPath || null, failure: completed.failure || null,
    });
  }

  function runRefused(request = {}, decision = {}) {
    return record("run-refused", {
      runId: request.runId || null, source: request.source || null, origin: originOf(request.source, request.kind),
      agentName: sanitizeAgentName(request.agentName), reason: decision.kind || "busy",
      busyRunId: request.busyRunId || null,
    });
  }

  // 只读分页。since 是上次读到的最后一个 seq；truncated=true 表示 since 之后有一段已不在内存里，
  // 去 eventsPath 读全量。
  function since(after, limit) {
    const from = Math.max(0, Number.parseInt(after, 10) || 0);
    const max = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(limit, 10) || PAGE_MAX));
    const oldest = ring.length ? ring[0].seq : seq + 1;
    const events = ring.filter((e) => e.seq > from).slice(0, max);
    return {
      sessionId, lastSeq: seq, since: from, truncated: from + 1 < oldest && seq > from,
      more: events.length === max && events[events.length - 1].seq < seq, events, eventsPath,
    };
  }

  function publicSession() {
    return { sessionId, startedAt, port: options.port || null, dataDir, eventsPath, lastSeq: seq, writeError };
  }

  return { sessionId, dataDir, eventsPath, record, runStart, runEnd, runRefused, since, publicSession };
}

// 包一层 execution_lifecycle_core：finishRun 在每条退出路径上都会被调（正常释放、soft Stop、
// force reset），在这里记 run-end，不用逐个改调用点。其余函数原样转发。
function wrapExecution(execution, session, lookupRun) {
  return {
    ...execution,
    finishRun(bridge, result, now) {
      let wasOpen = true;
      try { wasOpen = !execution.ensureLifecycle(bridge).releasedAt; } catch {}
      const completed = execution.finishRun(bridge, result, now);
      try {
        const run = (lookupRun && lookupRun()) || {};
        session.runEnd(completed || {}, { agentName: run.agentName, source: run.source, kind: run.kind, repeat: !wasOpen });
      } catch {}
      return completed;
    },
  };
}

module.exports = {
  RING_MAX, PAGE_MAX, AGENT_NAME_MAX,
  sanitizeAgentName, originOf, originLabel, busyMessage, createSession, wrapExecution, defaultStateRoot,
};
