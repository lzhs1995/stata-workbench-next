#!/usr/bin/env node
"use strict";
// rc.7.89: orphan worker reap. Fake process table + fake kill; no real process is touched.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
let core = require("./orphan_worker_core");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const WS = "/h/ws/s1", TMP = "/h/profiles/s1/mcp-temp", DIRS = [WS, TMP];
const L = (n) => `Thu Nov  5 02:52:0${n} 2026`;
// table: pid -> {ppid, lstart, cwd}; kill() mutates it like the OS would
function world(table, opts = {}) {
  const sent = [];
  const execFile = (file, args, o, cb) => {
    if (file === "pgrep") {
      const parents = args[1].split(",").map(Number);
      const kids = Object.entries(table).filter(([, r]) => parents.includes(r.ppid)).map(([p]) => p);
      return kids.length ? cb(null, kids.join("\n") + "\n") : cb(Object.assign(new Error("none"), { code: 1 }), "");
    }
    if (file === "ps") {
      const want = args[args.length - 1].split(",").map(Number);
      return cb(null, want.filter((p) => table[p]).map((p) => `${p} ${table[p].ppid} ${table[p].lstart}`).join("\n") + "\n");
    }
    if (file === "lsof") {
      const want = args[2].split(",").map(Number);
      return cb(null, want.filter((p) => table[p] && table[p].cwd).map((p) => `p${p}\nfcwd\nn${table[p].cwd}`).join("\n") + "\n");
    }
    cb(new Error("unexpected " + file), "");
  };
  const kill = (pid, sig) => {
    sent.push([pid, sig]);
    if (!table[pid]) { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; }
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !opts.ignoreTerm)) delete table[pid];
  };
  return { execFile, kill, sent, sleep: async () => {}, termGraceMs: 0, killGraceMs: 0 };
}
const base = () => ({ 10: { ppid: 5, lstart: L(1), cwd: WS }, 11: { ppid: 10, lstart: L(2), cwd: WS }, 12: { ppid: 10, lstart: L(2), cwd: WS } });

async function cases() {
  // capture: descendants with identity, root lstart recorded
  let t = base(), w = world(t);
  const cap = await core.captureDescendants(10, w);
  ok(cap.length === 2 && cap.every((r) => r.rootPid === 10 && r.rootLstart === L(1).replace(/\s+/g, " ") && r.cwd === WS), "capture: worker + tracker with identity");
  // clean reset: server exited normally and took its children -> []
  delete t[10]; delete t[11]; delete t[12];
  ok((await core.reapOrphans(cap, DIRS, w)).length === 0 && w.sent.length === 0, "clean: nothing left, nothing signalled");
  // orphaned (ppid 1), exact identity, cwd in session -> TERM, ended
  t = base(); w = world(t); let c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 1; t[12].ppid = 1;
  let r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 2 && r.every((x) => x.ended === true && x.reason === "orphaned-sigterm"), "orphan: TERM ends it");
  ok(w.sent.every(([, s]) => s === "SIGTERM") && w.sent.length === 2, "orphan: only SIGTERM was needed");
  // TERM ignored -> KILL
  t = base(); w = world(t, { ignoreTerm: true }); c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 1; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].pid === 11 && r[0].ended === true && r[0].reason === "orphaned-sigkill", "orphan ignoring TERM: KILL after grace");
  ok(w.sent.map((x) => x.join(":")).join() === "11:SIGTERM,11:SIGKILL", "orphan ignoring TERM: TERM then KILL, nothing else");
  // pid reused (different start time) -> no signal
  t = base(); w = world(t); c = await core.captureDescendants(10, w);
  delete t[10]; t[11] = { ppid: 1, lstart: L(9), cwd: WS }; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "pid-reused" && !r[0].ended && w.sent.length === 0, "pid reused: reported, never signalled");
  // cwd outside the session -> no signal (even with matching pid + lstart)
  t = base(); t[11].cwd = "/Users/someone/other"; w = world(t); c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 1; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "cwd-outside-session" && w.sent.length === 0, "cwd outside session: no signal");
  // cwd changed since capture -> no signal
  t = base(); w = world(t); c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 1; t[11].cwd = TMP; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "cwd-changed" && w.sent.length === 0, "cwd changed: no signal");
  // identity unknown at capture (no cwd readable) -> no signal, reported
  t = base(); t[11].cwd = null; w = world(t); c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 1; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "identity-unknown" && w.sent.length === 0, "identity unknown: report only");
  // capture failed entirely -> one report row, no signal
  r = await core.reapOrphans(null, DIRS, world({}));
  ok(r.length === 1 && r[0].reason === "identity-unreadable" && r[0].ended === false, "capture unreadable: report only");
  // worker re-parented to someone else (not 1, not old server) -> no signal
  t = base(); t[20] = { ppid: 1, lstart: L(5), cwd: "/x" }; w = world(t); c = await core.captureDescendants(10, w);
  delete t[10]; t[11].ppid = 20; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "not-orphaned" && w.sent.length === 0, "foreign parent: no signal");
  // old server still alive (same lstart) while shutting down: its child may be ended
  t = base(); w = world(t); c = await core.captureDescendants(10, w);
  delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].pid === 11 && r[0].ended === true && w.sent.length === 1 && w.sent[0][0] === 11,
     "old server still shutting down: its own worker ended, the server itself is not signalled here");
  // old server pid reused by another process -> child not signalled
  t = base(); w = world(t); c = await core.captureDescendants(10, w);
  t[10] = { ppid: 5, lstart: L(8), cwd: "/x" }; delete t[12];
  r = await core.reapOrphans(c, DIRS, w);
  ok(r.length === 1 && r[0].reason === "not-orphaned" && w.sent.length === 0, "parent pid reused: no signal");
  const now = Date.now(), owned = new Map([[10, { pid: 10, startedAt: new Date(now - 9000).toISOString() }],
    [11, { pid: 11, startedAt: new Date(now - 1000).toISOString() }], [12, { pid: 12, startedAt: new Date(now).toISOString() }]]);
  ok(core.latestRoot(owned, (p) => p !== 12) === 11 && core.latestRoot(undefined, () => true) === null, "latestRoot: newest live registered pid");
  ok(core.inside(WS, WS + "/sub") && !core.inside(WS, "/h/ws/s10") && !core.inside(WS, "/h/ws"), "inside: path prefix is by segment");
}

const SRC = fs.readFileSync(path.join(__dirname, "orphan_worker_core.js"), "utf8");
const MUTANTS = [
  ["lstart not compared", '  if (now.lstart !== before.lstart) return { signal: false, reason: "pid-reused" };\n', ""],
  ["cwd scope not checked", '  if (!(dirs || []).some((d) => inside(d, now.cwd))) return { signal: false, reason: "cwd-outside-session" };\n', ""],
  ["cwd change not checked", '  if (!now.cwd || now.cwd !== before.cwd) return { signal: false, reason: "cwd-changed" };\n', ""],
  ["unknown identity signalled", '  if (!before || !before.lstart || !before.cwd) return { signal: false, reason: "identity-unknown" };\n', '  if (!before) return { signal: false, reason: "identity-unknown" };\n'],
  ["any parent accepted", '  return { signal: false, reason: "not-orphaned" };', '  return { signal: true, reason: "orphaned" };'],
  ["parent identity not checked", "      && parentNow.lstart === before.rootLstart) return", ") return"],
  ["no KILL escalation", '        try { kill(before.pid, "SIGKILL"); } catch { /* raced exit */ }\n', ""],
  ["segment prefix", "  return rel === \"\" || (!!rel && !rel.startsWith(\"..\") && !path.isAbsolute(rel));", "  return String(p).startsWith(String(dir));"],
];

(async () => {
  await cases();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w2-orph-"));
  const real = core, results = [];
  try {
    for (const [name, from, to] of MUTANTS) {
      assert.strictEqual(SRC.split(from).length, 2, "mutant anchor unique: " + name);
      const f = path.join(dir, name.replace(/\W+/g, "_") + ".js");
      fs.writeFileSync(f, SRC.replace(from, () => to));
      core = require(f);
      let killed = false;
      const saved = checks;
      try { await cases(); } catch { killed = true; }
      checks = saved;
      results.push([name, killed]);
    }
  } finally { core = real; fs.rmSync(dir, { recursive: true, force: true }); }
  for (const [n, k] of results) console.log((k ? "CAUGHT " : "SURVIVED ") + n);
  ok(results.every(([, k]) => k), "all mutants caught");
  console.log(`ORPHAN_WORKER_CORE_OK checks=${checks} mutants=${results.filter(([, k]) => k).length}/${results.length}`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
