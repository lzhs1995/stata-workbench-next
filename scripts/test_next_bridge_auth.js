#!/usr/bin/env node
"use strict";

// 回归：Next 阶段 C（bridge 鉴权）。
// 1. next_bridge_auth_core：判定矩阵、注册表写/删、只删自己、只清确定已死的记录、限权。
// 2. 补丁可逆、紧跟 B 层、接线位置。
// 3. 把 bundle 里真实的请求入口判定代码放进一个真 http server，用真 HTTP 请求打：
//    无 token 401、错 token 401、Host 不对 403、带 Origin 403、未发布 503、正确 200；拒绝时不进路由。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const auth = require("./next_bridge_auth_core");
const core = require("./next_session_core");
const patch = require("./apply_next_bridge_auth_patch");
const fingerprint = require("./finalize_bundle_identity");
const { LATER, revertAfter } = require("./later_bundle_patches");

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-next-auth-"));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/status", method: "GET", headers, setHost: !("host" in headers) },
      (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) })); });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  try {
    // 1. 判定矩阵
    const T = "A".repeat(43);
    const want = { port: 17601, token: T };
    const good = { host: "127.0.0.1:17601", authorization: "Bearer " + T };
    ok(auth.authorize(good, want).ok, "good request");
    ok(auth.authorize({ ...good, origin: "http://evil" }, want).status === 403, "Origin -> 403");
    ok(auth.authorize({ ...good, origin: "" }, want).reason === "ORIGIN_FORBIDDEN", "empty Origin still refused");
    ok(auth.authorize({ ...good, host: "localhost:17601" }, want).reason === "HOST_MISMATCH", "localhost Host -> 403");
    ok(auth.authorize({ ...good, host: "127.0.0.1:17602" }, want).status === 403, "other port Host -> 403");
    ok(auth.authorize({ host: good.host }, want).reason === "AUTH_REQUIRED", "no token -> 401 AUTH_REQUIRED");
    ok(auth.authorize({ ...good, authorization: "Basic xyz" }, want).reason === "AUTH_MALFORMED", "wrong scheme");
    ok(auth.authorize({ ...good, authorization: "Bearer " + "B".repeat(43) }, want).reason === "AUTH_INVALID", "wrong token");
    ok(auth.authorize({ ...good, authorization: "Bearer " + T + "x" }, want).status === 401, "longer token");

    // 注册表：发布前 503；发布写 0600 文件且含 token；/status 公开部分不含 token；只删自己
    let clock = Date.parse("2026-10-31T13:00:00Z");
    const a = auth.createAuth({ stateRoot: tmp, sessionId: "sA", now: () => clock });
    ok(a.check(good).status === 503 && a.check(good).reason === "SESSION_NOT_PUBLISHED", "unpublished -> 503");
    ok(Object.keys(a.headers()).length === 0, "no headers before publish");
    const pub = a.publish({ port: 17601, extensionHostPid: process.pid, eventsPath: "/x/events.jsonl" });
    ok(pub && fs.existsSync(a.recordPath), "record written");
    const rec = JSON.parse(fs.readFileSync(a.recordPath, "utf8"));
    ok(rec.schema === auth.RECORD_SCHEMA && rec.port === 17601 && /^[A-Za-z0-9_-]{43}$/.test(rec.token), "record fields");
    if (process.platform !== "win32") ok((fs.statSync(a.recordPath).mode & 0o777) === 0o600, "record is 0600");
    ok(a.check({ host: "127.0.0.1:17601", authorization: "Bearer " + rec.token }).ok, "published token accepted");
    ok(a.check(a.headers()).ok, "own headers accepted");
    ok(!JSON.stringify(a.publicAuth()).includes(rec.token) && a.publicAuth().published === true, "public view hides the token");
    ok(!fs.readdirSync(path.join(tmp, "sessions")).some((n) => n.endsWith(".tmp")), "no temp file left");
    ok(a.publish({ port: 80 }) === null && a.check(good).status === 503, "invalid port -> not published");
    a.publish({ port: 17601, extensionHostPid: process.pid });
    // 只删自己：别人的同名文件（token 不同）不删
    const b = auth.createAuth({ stateRoot: tmp, sessionId: "sB" });
    b.publish({ port: 17602, extensionHostPid: process.pid });
    const forged = JSON.parse(fs.readFileSync(b.recordPath, "utf8"));
    fs.writeFileSync(b.recordPath, JSON.stringify({ ...forged, token: "C".repeat(43) }));
    b.remove();
    ok(fs.existsSync(b.recordPath), "remove() leaves a record whose token is not ours");
    a.remove();
    ok(!fs.existsSync(a.recordPath) && a.check(good).status === 503, "remove() deletes own record and closes the gate");
    // 只清确定已死的：一个已退出子进程的记录被清，活着的（本进程）和读不出的留着
    const dead = cp.spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    const dir = auth.sessionsDir(tmp);
    fs.writeFileSync(path.join(dir, "sDead.json"), JSON.stringify({ schema: auth.RECORD_SCHEMA, sessionId: "sDead", extensionHostPid: deadPid }));
    fs.writeFileSync(path.join(dir, "sAlive.json"), JSON.stringify({ schema: auth.RECORD_SCHEMA, sessionId: "sAlive", extensionHostPid: process.pid }));
    fs.writeFileSync(path.join(dir, "garbage.json"), "{not json");
    ok(auth.pidAlive(deadPid) === false && auth.pidAlive(process.pid) === true && auth.pidAlive(0) === null, "three-state pid");
    const c = auth.createAuth({ stateRoot: tmp, sessionId: "sC" });
    c.publish({ port: 17603, extensionHostPid: process.pid });
    ok(!fs.existsSync(path.join(dir, "sDead.json")), "dead record pruned");
    ok(fs.existsSync(path.join(dir, "sAlive.json")) && fs.existsSync(path.join(dir, "garbage.json")), "live and unreadable records kept");
    c.remove();
    // 拒绝日志限流
    ok(c.shouldRecordRefusal("AUTH_REQUIRED") && !c.shouldRecordRefusal("AUTH_REQUIRED") && c.shouldRecordRefusal("HOST_MISMATCH"), "refusal logging is rate limited per reason");
    // 限权：Windows 上真跑，并用 icacls 独立读回，核只剩当前用户一条；其他平台核 0600
    const f = path.join(tmp, "acl-probe.json");
    fs.writeFileSync(f, "{}");
    const mode = auth.restrictToOwner(f);
    if (process.platform === "win32") {
      ok(mode === "windows-owner-only", "owner-only ACL applied");
      const out = cp.execFileSync("icacls", [f], { encoding: "utf8" });
      const aces = out.split(/\r?\n/).filter((l) => l.includes(":(")).map((l) => l.replace(f, "").trim());
      ok(aces.length === 1 && aces[0].toLowerCase().includes(String(process.env.USERNAME).toLowerCase()) && !aces[0].includes("(I)"),
        "only the current user: " + JSON.stringify(aces));
    } else {
      ok(mode === "posix-0600" && (fs.statSync(f).mode & 0o777) === 0o600, "chmod 0600");
    }
    // Windows 分支（在任何平台上用假 execFileSync 核命令行与读回判定）
    const SID = "S-1-5-21-1-2-3-1001";
    const report = (extra = {}) => [`SID=${extra.sid || SID}`, `PROTECTED=${extra.protectedValue || "True"}`, `COUNT=${extra.count || 1}`,
      ...(extra.rules || [`RULE=${SID}|Allow|False|2032127`])].join("\r\n") + "\r\n";
    const calls = [];
    const fakeRun = (stdout) => (...args) => { calls.push(args); return typeof stdout === "function" ? stdout(args) : stdout; };
    ok(auth.restrictToOwner("C:\\x.json", { platform: "win32", env: { SystemRoot: "C:\\Windows" }, execFileSync: fakeRun(report()) }) === "windows-owner-only",
      "good readback accepted");
    const [shell, args, runOptions] = calls[0];
    ok(shell === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell by absolute path: " + shell);
    ok(args.slice(0, 3).join(" ") === "-NoProfile -NonInteractive -EncodedCommand" && args.length === 4, "powershell arguments");
    const script = Buffer.from(args[3], "base64").toString("utf16le");
    ok(script === auth.WINDOWS_ACL_SCRIPT, "encoded script is the module script");
    ok(script.includes("SetAccessRuleProtection($true, $false)") && script.includes("RemoveAccessRuleSpecific")
      && script.includes("GetCurrent().User") && script.includes("GetAccessControl('Access')") && !/icacls|Set-Acl/i.test(script),
      "script drops inheritance and every explicit rule, grants the process SID, writes Access only");
    ok(runOptions.env.STATA_WORKBENCH_NEXT_ACL_TARGET === path.resolve("C:\\x.json") && !script.includes("x.json"), "target passed by environment, not in the script");
    for (const [label, bad] of [
      ["extra SYSTEM rule", report({ count: 2, rules: [`RULE=${SID}|Allow|False|2032127`, "RULE=S-1-5-18|Allow|False|2032127"] })],
      ["inheritance still on", report({ protectedValue: "False" })],
      ["inherited rule", report({ rules: [`RULE=${SID}|Allow|True|2032127`] })],
      ["another user's rule", report({ rules: ["RULE=S-1-5-21-9-9-9-500|Allow|False|2032127"] })],
      ["read-only rule", report({ rules: [`RULE=${SID}|Allow|False|1179785`] })],
      ["empty output", ""],
    ]) {
      assert.throws(() => auth.restrictToOwner("C:\\x.json", { platform: "win32", env: {}, execFileSync: fakeRun(bad) }), /not owner-only/, label);
      checks++;
    }
    // publish 在 Windows 上：限权时文件还是空的（token 之后才写）；读回不合格则不发布、不留文件、所有请求 503
    const winRoot = path.join(tmp, "win");
    let sizeWhenRestricted = null;
    const winOk = auth.createAuth({ stateRoot: winRoot, sessionId: "sWin", platform: "win32", env: {},
      execFileSync: fakeRun((a) => { sizeWhenRestricted = fs.statSync(a[2].env.STATA_WORKBENCH_NEXT_ACL_TARGET).size; return report(); }) });
    ok(winOk.publish({ port: 17605, extensionHostPid: process.pid }) && sizeWhenRestricted === 0, "ACL applied before the token is written");
    ok(JSON.parse(fs.readFileSync(path.join(winRoot, "sessions", "sWin.json"), "utf8")).port === 17605 && winOk.publicAuth().acl === "windows-owner-only",
      "record written after the ACL");
    winOk.remove();
    const winBad = auth.createAuth({ stateRoot: winRoot, sessionId: "sWinBad", platform: "win32", env: {}, execFileSync: fakeRun(report({ protectedValue: "False" })) });
    ok(winBad.publish({ port: 17606, extensionHostPid: process.pid }) === null && /not owner-only/.test(winBad.publicAuth().publishError), "bad ACL readback fails publish");
    ok(fs.readdirSync(path.join(winRoot, "sessions")).length === 0, "no record or temp file left after a failed ACL");
    ok(winBad.check({ host: "127.0.0.1:17606", authorization: "Bearer " + "a".repeat(43) }).status === 503, "unpublished session answers 503");

    // 2. 补丁
    assert.equal(patch.patchBundle(bundle), bundle, "byte idempotence");
    assert.equal(fingerprint.verify(bundle).ok, true);
    const name = "./apply_next_bridge_auth_patch";
    const sealed = revertAfter(bundle, name);
    const legacy = patch.revertBundle(sealed);
    assert.equal(legacy, revertAfter(bundle, LATER[LATER.indexOf(name) - 1]), "directly follows the previous later layer");
    assert.ok(LATER[LATER.indexOf(name) - 1] === "./apply_next_agent_identity_patch", "stacked on B");
    assert.equal(patch.patchBundle(legacy), sealed, "replay reproduces the sealed layer");
    assert.throws(() => patch.patchBundle(legacy.replace(patch.EDITS[2][0], "")), /anchor/);
    assert.throws(() => patch.patchBundle(legacy + "__codexNextAuthRef"), /partial/);
    checks += 7;
    ok(!/[^\x00-\x7f]/.test(patch.EDITS.map((e) => e[1]).join("")), "patch strings are ASCII only");
    const entry = bundle.indexOf("let __srv=__http.createServer((__req,__res)=>{(async()=>{try{let __nextAuth=");
    ok(entry > 0 && entry < bundle.indexOf('__req.url==="/events"') && entry < bundle.indexOf('__req.url==="/status"'), "gate runs before every route");
    ok(bundle.split("globalThis.__codexNextAuthRef.publish({port:__port,").length === 2, "registry written only from onBound");
    ok(bundle.includes('headers:{...(globalThis.__codexNextAuthRef?globalThis.__codexNextAuthRef.headers():{}),"content-type":"application/json","content-length":Buffer.byteLength(__payload),"x-codex-recovery-token"'), "internal recovery request carries the token");
    ok(!bundle.includes("__codexNextAuthRef.token"), "no code reads a raw token");

    // 3. 真 http server + bundle 里真实的入口判定
    const gate = patch.EDITS[2][1].slice(patch.EDITS[2][0].length);
    ok(bundle.includes(patch.EDITS[2][0] + gate), "gate text is in the bundle verbatim");
    const g = {};
    const events = [];
    g.__codexNextSessionRef = { record: (type, f) => events.push({ type, ...f }) };
    const run = new Function("globalThis", "__req", "__res", "__send", "__routed", gate + ";__routed()");
    let routed = 0;
    const server = http.createServer((req, res) => {
      const send = (r, status, body) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
      run(g, req, res, send, () => { routed++; send(res, 200, { ok: true, routed: true }); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      let r = await request(port, {});
      ok(r.status === 503 && r.body.error === "AUTH_UNAVAILABLE" && routed === 0, "no auth object -> 503, not routed");
      g.__codexNextAuthError = "boom";
      r = await request(port, {});
      ok(r.body.detail === "boom", "503 explains why");
      const live = auth.createAuth({ stateRoot: path.join(tmp, "live"), sessionId: "sLive" });
      g.__codexNextAuthRef = live;
      r = await request(port, {});
      ok(r.status === 503 && r.body.error === "SESSION_NOT_PUBLISHED", "unpublished -> 503");
      live.publish({ port, extensionHostPid: process.pid });
      const token = JSON.parse(fs.readFileSync(live.recordPath, "utf8")).token;
      r = await request(port, {});
      ok(r.status === 401 && r.body.error === "AUTH_REQUIRED", "real HTTP: no token -> 401");
      r = await request(port, { authorization: "Bearer " + "Z".repeat(43) });
      ok(r.status === 401 && r.body.error === "AUTH_INVALID", "real HTTP: wrong token -> 401");
      r = await request(port, { authorization: "Bearer " + token, host: "localhost:" + port });
      ok(r.status === 403 && r.body.error === "HOST_MISMATCH", "real HTTP: Host localhost -> 403");
      r = await request(port, { authorization: "Bearer " + token, origin: "https://example.org" });
      ok(r.status === 403 && r.body.error === "ORIGIN_FORBIDDEN", "real HTTP: Origin -> 403");
      ok(routed === 0, "no refused request reached a route");
      r = await request(port, { authorization: "Bearer " + token });
      ok(r.status === 200 && r.body.routed === true && routed === 1, "real HTTP: correct token -> routed");
      ok(!JSON.stringify(events).includes(token), "token never written to events");
      ok(events.filter((e) => e.type === "auth-refused").map((e) => e.reason).join(",") === "AUTH_UNAVAILABLE,AUTH_UNAVAILABLE,SESSION_NOT_PUBLISHED,AUTH_REQUIRED,AUTH_INVALID,HOST_MISMATCH,ORIGIN_FORBIDDEN",
        "each refusal recorded once: " + events.map((e) => e.reason));
      ok(events.every((e) => e.path === "/status" && e.method === "GET"), "refusal records path and method only");
    } finally { server.close(); }

    // 4. bundle 里真实的激活语句：建 auth；会话不可用时只记错误
    const actStart = bundle.indexOf("try{let __nextAuthCore=");
    const actEnd = bundle.indexOf(patch.MARKER, actStart);
    ok(actStart > 0 && actEnd > actStart, "activation statement located");
    const activation = bundle.slice(actStart, actEnd);
    for (const withSession of [true, false]) {
      const gg = {};
      if (withSession) gg.__codexNextSessionRef = core.createSession({ stateRoot: path.join(tmp, "act") });
      else gg.__codexNextSessionError = "core missing";
      const subs = [];
      const procOnce = [];
      const fn = new Function("globalThis", "rg", "yC", "process", "g", "require", activation);
      fn(gg, path, { extensionUri: { fsPath: path.join(__dirname, "..") } }, { cwd: () => __dirname, once: (e, f) => procOnce.push([e, f]) },
        { subscriptions: subs }, require);
      if (withSession) {
        ok(gg.__codexNextAuthRef && gg.__codexNextAuthRef.recordPath === path.join(tmp, "act", "sessions", gg.__codexNextSessionRef.sessionId + ".json"), "auth bound to the session id under the same state root");
        ok(subs.length === 1 && procOnce.length === 1 && procOnce[0][0] === "exit", "removal registered on dispose and process exit");
      } else {
        ok(!gg.__codexNextAuthRef && /session unavailable: core missing/.test(gg.__codexNextAuthError), "no session -> no auth, error recorded (gate then answers 503)");
      }
    }
    console.log(`PASS next bridge auth: ${checks} checks`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
