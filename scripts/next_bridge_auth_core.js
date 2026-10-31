"use strict";

// Next 阶段 C（0.2.0-next.3）：bridge 鉴权与会话注册表文件。纯 Node，可单测。
//
// 每个会话启动时生成 32 字节随机 token，只写进该会话自己的注册表文件
// <stateRoot>/sessions/<sessionId>.json（macOS/Linux 0600；Windows 按 SID 重建 DACL、只给当前用户）。
// bridge 的每个端点都要：Host 恰好是 127.0.0.1:<端口>（否则 403）、请求不带 Origin（否则 403）、
// Authorization: Bearer <token>（缺或错 401）。token 只在闭包里，/status 和事件流里都不出现。
// 注册表文件在 bridge 真正绑定端口之后才写，窗口关闭时只删自己的那一个。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const TOKEN_BYTES = 32;
const RECORD_SCHEMA = "stata-workbench-next-session/1";
const REFUSAL_LOG_INTERVAL_MS = 10000;

function sessionsDir(stateRoot) { return path.join(stateRoot, "sessions"); }

// 三态：true 活着，false 确定已死，null 不知道（无权限等）。未知一律不当死。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return null;
  }
}

// Windows：按 SID 重建 DACL——关掉继承、删掉所有显式项（icacls /inheritance:r 只去继承项，
// 文件建出来时可能已有 SYSTEM/Administrators 显式项）、只加当前进程用户的 FullControl，再读回核对。
// 只写 Access 段，不动 owner，非管理员也能跑。目标路径经环境变量传入，不拼进脚本。
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:STATA_WORKBENCH_NEXT_ACL_TARGET",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$info = New-Object System.IO.FileInfo($target)",
  "$acl = $info.GetAccessControl('Access')",
  "$acl.SetAccessRuleProtection($true, $false)",
  "foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
  "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))",
  "$info.SetAccessControl($acl)",
  "$check = (New-Object System.IO.FileInfo($target)).GetAccessControl('Access')",
  "$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
  "'SID=' + $sid.Value",
  "'PROTECTED=' + $check.AreAccessRulesProtected",
  "'COUNT=' + $rules.Count",
  "foreach ($r in $rules) { 'RULE=' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.IsInherited + '|' + [int]$r.FileSystemRights }",
].join("\n");
const FULL_CONTROL = 2032127;

// 读回结果必须恰好一条：当前用户、Allow、非继承、FullControl，且 DACL 受保护。
function parseWindowsAclReport(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const value = (key) => { const l = lines.find((x) => x.startsWith(key + "=")); return l ? l.slice(key.length + 1) : null; };
  const sid = value("SID");
  const rules = lines.filter((l) => l.startsWith("RULE=")).map((l) => l.slice(5).split("|"));
  const good = sid && /^S-1-[0-9-]+$/.test(sid) && value("PROTECTED") === "True" && value("COUNT") === "1" && rules.length === 1
    && rules[0][0] === sid && rules[0][1] === "Allow" && rules[0][2] === "False" && Number(rules[0][3]) === FULL_CONTROL;
  if (!good) throw new Error("Windows ACL is not owner-only: " + lines.join("; ").slice(0, 300));
  return { sid };
}

// 把文件限制为只有当前用户可读写。返回 "posix-0600" 或 "windows-owner-only"；做不到就抛错。
function restrictToOwner(file, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return "posix-0600";
  }
  const run = options.execFileSync || cp.execFileSync;
  const env = options.env || process.env;
  const shell = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");
  const stdout = run(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, STATA_WORKBENCH_NEXT_ACL_TARGET: path.resolve(file) },
  });
  parseWindowsAclReport(stdout);
  return "windows-owner-only";
}

// 判定一次请求。headers 是 Node 的小写 header 对象。返回 {ok:true} 或 {ok:false,status,reason}。
function authorize(headers, expected) {
  const h = headers || {};
  if (h.origin !== undefined) return { ok: false, status: 403, reason: "ORIGIN_FORBIDDEN" };
  if (String(h.host || "") !== `127.0.0.1:${expected.port}`) return { ok: false, status: 403, reason: "HOST_MISMATCH" };
  const value = String(h.authorization || "");
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(value);
  if (!match) return { ok: false, status: 401, reason: value ? "AUTH_MALFORMED" : "AUTH_REQUIRED" };
  const given = Buffer.from(match[1]);
  const want = Buffer.from(expected.token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, status: 401, reason: "AUTH_INVALID" };
  }
  return { ok: true };
}

function createAuth(options = {}) {
  const stateRoot = path.resolve(options.stateRoot);
  const sessionId = String(options.sessionId || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid sessionId");
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || (() => Date.now());
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const recordPath = path.join(sessionsDir(stateRoot), sessionId + ".json");
  const lastRefusalLog = new Map();
  let published = null;
  let publishError = null;
  let acl = null;
  let port = null;

  function check(headers) {
    if (!port) return { ok: false, status: 503, reason: "SESSION_NOT_PUBLISHED" };
    return authorize(headers, { port, token });
  }

  // 同一原因 10 秒内只记一次，防止被刷满事件文件。
  function shouldRecordRefusal(reason) {
    const t = now();
    const last = lastRefusalLog.get(reason) || 0;
    if (t - last < REFUSAL_LOG_INTERVAL_MS) return false;
    lastRefusalLog.set(reason, t);
    return true;
  }

  function headers() { return port ? { authorization: "Bearer " + token, host: `127.0.0.1:${port}` } : {}; }

  // 已确定死掉的进程留下的记录才删；读不出、无权限、未知一律不动。
  function pruneDead() {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(sessionsDir(stateRoot)); } catch { return removed; }
    for (const name of names) {
      if (!name.endsWith(".json") || name === sessionId + ".json") continue;
      const file = path.join(sessionsDir(stateRoot), name);
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8"));
        if (rec.schema === RECORD_SCHEMA && pidAlive(rec.extensionHostPid) === false) { fs.unlinkSync(file); removed.push(name); }
      } catch {}
    }
    return removed;
  }

  // bridge 绑定端口之后调用。先写临时文件、限权，再改名；失败时 bridge 照常起，但所有请求 503。
  function publish(fields = {}) {
    port = Number(fields.port);
    if (!(port >= 1024 && port <= 65535)) { port = null; publishError = "invalid port"; return null; }
    const record = {
      schema: RECORD_SCHEMA, sessionId, port, token,
      extensionHostPid: fields.extensionHostPid || process.pid, startedAt: fields.startedAt || new Date(now()).toISOString(),
      dataDir: fields.dataDir || null, eventsPath: fields.eventsPath || null, bundleSha: fields.bundleSha || null,
    };
    const dir = sessionsDir(stateRoot);
    const tmp = path.join(dir, `.${sessionId}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const removed = pruneDead();
      // 先建空文件并限权，再写 token：token 落盘时文件已经只有当前用户能读。
      fs.writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
      acl = restrictToOwner(tmp, options);
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "r+" });
      fs.renameSync(tmp, recordPath);
      published = { recordPath, port, startedAt: record.startedAt, prunedDead: removed.length };
      publishError = null;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      port = null;
      published = null;
      publishError = String(error && (error.code || error.message) || error);
    }
    return published;
  }

  // 只删自己写的那一个：文件里的 sessionId 和 token 都得对得上。
  function remove() {
    try {
      const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (rec.sessionId === sessionId && rec.token === token) fs.unlinkSync(recordPath);
    } catch {}
    published = null;
    port = null;
  }

  function publicAuth() {
    return { required: true, scheme: "Bearer", registryPath: recordPath, published: !!published, port, acl, publishError };
  }

  return { sessionId, recordPath, check, headers, publish, remove, pruneDead, shouldRecordRefusal, publicAuth };
}

module.exports = { RECORD_SCHEMA, TOKEN_BYTES, WINDOWS_ACL_SCRIPT, authorize, createAuth, parseWindowsAclReport, pidAlive, restrictToOwner, sessionsDir };
