"use strict";

// Next 阶段 D（0.2.0-next.4）：多会话。纯 Node，不依赖 VS Code，可单测。
//
// 一个 VS Code 窗口一个会话：每个会话有自己的配置目录（tools/stata_session.py 建）、端口和会话名。
// 扩展激活时：
//   1. 会话名取环境变量 STATA_WORKBENCH_NEXT_SESSION，没有再取 settings 的 stataMcp.nextSessionName，
//      再没有用 "default"。
//   2. 该会话的 temp/checkpoint 放到 <runs>/<sessionId>/tmp，并把本进程的 TMPDIR/TEMP/TMP 指过去
//      （bundle 里运行前快照、选区 do 文件等都用 os.tmpdir()，这样不再落到机器级临时目录）。
//   3. 注册表记录补齐 sessionName、backendPid、profilePath、workspacePath、tempDir、logDir、graphDir、
//      checkpointDir、generation、diskBundleSha256；generation 或 backendPid 变了就原子改写。
// 客户端提交前读 /status 核 sessionId、port、generation、bundle SHA，与注册表任一不符就不执行。
const fs = require("node:fs");
const path = require("node:path");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_SESSIONS = 5;
const PORT_MIN = 17601;
const PORT_MAX = 17620;

function sanitizeSessionName(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return NAME_RE.test(text) ? text : null;
}

// 环境变量优先（stata_session.py 启动时设），其次 settings，最后 default；不合法的值当没给。
function resolveSessionName(env, configured) {
  const e = env || {};
  return sanitizeSessionName(e.STATA_WORKBENCH_NEXT_SESSION) || sanitizeSessionName(configured) || "default";
}

function absoluteOrNull(value) {
  return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
}

// 该会话自己的目录。tmp 建成 0700；建不出来就抛错，调用方关掉 Next 多会话功能，不改 TMPDIR。
function sessionDirs(dataDir, env, options = {}) {
  const e = env || {};
  const mkdir = options.mkdirSync || fs.mkdirSync;
  const tempDir = path.join(dataDir, "tmp");
  mkdir(tempDir, { recursive: true, mode: 0o700 });
  // mcp-stata 的日志和图写在它自己的 MCP_STATA_TEMP 下（会话启动器每个配置目录各给一个）；没给就同 tempDir。
  const backendTemp = absoluteOrNull(e.MCP_STATA_TEMP) || tempDir;
  return { tempDir, checkpointDir: tempDir, logDir: backendTemp, graphDir: backendTemp };
}

// 把本进程的临时目录指到会话目录。返回原值供记录；Windows 同时改 TEMP、TMP。
function applyTempDir(env, tempDir, platform) {
  const before = { TMPDIR: env.TMPDIR, TEMP: env.TEMP, TMP: env.TMP };
  env.TMPDIR = tempDir;
  if ((platform || process.platform) === "win32") { env.TEMP = tempDir; env.TMP = tempDir; }
  return before;
}

// ownedBackendPids 是插入有序的 Map；取最后一个还活着的。
function latestBackendPid(owned, alive) {
  if (!owned || typeof owned.keys !== "function") return null;
  const pids = Array.from(owned.keys()).filter((p) => Number.isInteger(p) && p > 1);
  for (let i = pids.length - 1; i >= 0; i--) if (!alive || alive(pids[i]) !== false) return pids[i];
  return null;
}

// 注册表里 C 之外的字段。全部是可公开的值，不含 token。
function registryFields(input = {}) {
  return {
    sessionName: sanitizeSessionName(input.sessionName) || "default",
    profilePath: absoluteOrNull(input.profilePath),
    workspacePath: absoluteOrNull(input.workspacePath),
    tempDir: input.dirs ? input.dirs.tempDir : null,
    logDir: input.dirs ? input.dirs.logDir : null,
    graphDir: input.dirs ? input.dirs.graphDir : null,
    checkpointDir: input.dirs ? input.dirs.checkpointDir : null,
    generation: Number.isInteger(input.generation) && input.generation >= 0 ? input.generation : 0,
    backendPid: Number.isInteger(input.backendPid) && input.backendPid > 1 ? input.backendPid : null,
    diskBundleSha256: typeof input.diskBundleSha256 === "string" && /^[0-9a-f]{64}$/.test(input.diskBundleSha256)
      ? input.diskBundleSha256 : null,
  };
}

function publicMulti(state = {}) {
  return {
    sessionName: state.sessionName || null, profilePath: state.profilePath || null,
    tempDir: state.dirs ? state.dirs.tempDir : null, registryRefreshes: state.refreshes || 0,
    lastRefreshError: state.lastError || null,
  };
}

module.exports = {
  NAME_RE, MAX_SESSIONS, PORT_MIN, PORT_MAX,
  sanitizeSessionName, resolveSessionName, sessionDirs, applyTempDir, latestBackendPid, registryFields, publicMulti,
};
