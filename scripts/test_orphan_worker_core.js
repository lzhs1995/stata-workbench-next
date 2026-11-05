#!/usr/bin/env node
"use strict";
// rc.7.89 (V3-W3 rework): orphan worker reap. Fake process table, fake kill and a fake
// clock; no real process is touched and nothing is signalled outside the table.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
let core = require("./orphan_worker_core");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const WS = "/h/ws/s1", TMP = "/h/profiles/s1/mcp-temp", DIRS = [WS, TMP];
const L = (n) => `Thu Nov  5 02:52:${String(n).padStart(2, "0")} 2026`;
const REG = Date.parse(L(1).replace(/\s+/g, " "));
const HOST = 5;
const ROOT = { pid: 10, registeredAtMs: REG, hostPid: HOST };
// table: pid -> {ppid, lstart, cwd}. f: failure switches. clock.t advances on sleep / slow reads.
function world(table, f = {}) {
  const sent = [], clock = { t: 1000000 };
  const fail = (cb) => cb(Object.assign(new Error("boom"), f.timeout ? { killed: true } : { code: 2 }), "");
  const execFile = (file, args, o, cb) => {
    if (f.slowMs) clock.t += f.slowMs;
    if (f.down && f.down[file] && f.down[file]()) return fail(cb);
    if (file === "pgrep") {
      const parents = args[1].split(",").map(Number);
      const kids = Object.entries(table).filter(([, r]) => parents.includes(r.ppid)).map(([p]) => p);
      if (f.afterPgrep) f.afterPgrep(table);
      return kids.length ? cb(null, kids.join("\n") + "\n") : cb(Object.assign(new Error("none"), { code: 1 }), "");
    }
    if (file === "ps") {
      const want = args[args.length - 1].split(",").map(Number);
      const rows = want.filter((p) => table[p]).map((p) => `${p} ${table[p].ppid} ${table[p].lstart}`);
      return rows.length ? cb(null, rows.join("\n") + "\n") : cb(Object.assign(new Error("none"), { code: 1 }), "");
    }
    if (file === "lsof") {
      const want = args[2].split(",").map(Number);
      return cb(null, want.filter((p) => table[p] && table[p].cwd).map((p) => `p${p}\nfcwd\nn${table[p].cwd}`).join("\n") + "\n");
    }
    cb(new Error("unexpected " + file), "");
  };
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (f.probeErr && f.probeErr(pid)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      if (!table[pid]) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }
    sent.push([pid, sig, clock.t]);
    if (!table[pid]) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (sig === "SIGKILL" ? !f.ignoreKill : !f.ignoreTerm) delete table[pid];
    if (f.afterSignal) f.afterSignal(table, pid, sig);
  };
  return { execFile, kill, sent, clock, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, termGraceMs: 3000, killGraceMs: 1500 };
}
// server 10 (child of host 5), worker 11 and tracker 12 in this session's ws
const base = () => ({ 10: { ppid: HOST, lstart: L(1), cwd: WS }, 11: { ppid: 10, lstart: L(2), cwd: WS }, 12: { ppid: 10, lstart: L(2), cwd: WS } });
const capOf = async (t, w) => core.captureDescendants(ROOT, { ctx: core.makeCtx(w, 5000) });
const reap = (c, w, extra = {}) => core.reapOrphans(c, DIRS, { ctx: core.makeCtx({ ...w, ...extra }, extra.budgetMs || 11000) });
async function cases() {
  // capture: verified tree
  let t = base(), w = world(t), c = await capOf(t, w);
  ok(c.state === "ok" && c.items.length === 2 && c.root.pid === 10 && c.items.every((i) => i.cwd === WS), "capture: verified worker + tracker");
  // R2: registered pid reused before capture (new process, later start, other parent) -> unknown, no signal ever
  t = base(); t[10] = { ppid: 999, lstart: L(40), cwd: "/elsewhere" }; t[11].ppid = 10; w = world(t); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "root-replaced", "R2: root pid reused before capture -> unknown");
  let r = await reap(c, w);
  ok(w.sent.length === 0 && r.length === 1 && r[0].unresolved && /^capture-unknown/.test(r[0].reason), "R2: no signal, unresolved row");
  // R2: same start time but not a child of this host -> unknown
  t = base(); t[10].ppid = 999; w = world(t); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "root-not-host-child", "R2: root parent is not this host -> unknown");
  // R2: discovery race (a child exits between pgrep and ps) -> unknown
  t = base(); w = world(t, { afterPgrep: (tb) => { delete tb[12]; } }); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "discovery-race", "R2: discovery race -> unknown");
  // R2: child older than its parent (stale ppid) -> unknown
  t = base(); t[11].lstart = "Thu Nov  5 01:00:00 2026"; w = world(t); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "child-older-than-parent", "R2: stale ppid -> unknown");
  // R2: truncated discovery -> unknown
  t = base(); for (let i = 20; i < 40; i++) t[i] = { ppid: 10, lstart: L(3), cwd: WS }; w = world(t); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "truncated", "R2: truncated -> unknown");
  // R3: capture command failures -> unknown
  for (const file of ["pgrep", "ps"]) {
    t = base(); w = world(t, { down: { [file]: () => true } }); c = await capOf(t, w);
    ok(c.state === "unknown" && c.why.startsWith(file + ":"), "R3: capture " + file + " failure -> unknown");
  }
  t = base(); w = world(t, { down: { ps: () => true }, timeout: true }); c = await capOf(t, w);
  ok(c.state === "unknown" && c.why === "ps:timeout", "R3: capture ps timeout -> unknown");
  // normal reap: server ended by dispose, worker + tracker orphaned (ppid 1) -> TERM ends both
  t = base(); w = world(t); c = await capOf(t, w);
  delete t[10]; t[11].ppid = 1; t[12].ppid = 1;
  r = await reap(c, w);
  ok(r.length === 2 && r.every((x) => x.ended && !x.unresolved && x.reason === "orphaned-sigterm"), "orphans ended by TERM");
  ok(w.sent.map((s) => s[1]).join() === "SIGTERM,SIGTERM", "only TERM was needed");
  // TERM ignored -> KILL; KILL ignored -> unresolved survived-sigkill
  t = base(); w = world(t, { ignoreTerm: true }); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
  r = await reap(c, w);
  ok(r.length === 1 && r[0].ended && r[0].reason === "orphaned-sigkill" && w.sent.map((s) => s[1]).join() === "SIGTERM,SIGKILL", "TERM ignored -> KILL");
  t = base(); w = world(t, { ignoreTerm: true, ignoreKill: true }); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
  r = await reap(c, w);
  ok(r.length === 1 && !r[0].ended && r[0].unresolved && r[0].reason === "survived-sigkill", "KILL ignored -> unresolved");
  // clean reset: everything already gone -> []
  t = base(); w = world(t); c = await capOf(t, w); delete t[10]; delete t[11]; delete t[12];
  r = await reap(c, w);
  ok(r.length === 0 && w.sent.length === 0, "clean reset -> [] and no signal");
  // R3: initial re-read fails (ps error / timeout / probe error) -> unresolved row, no signal
  for (const [label, sw] of [["ps exit", { down: { ps: () => true } }], ["ps timeout", { down: { ps: () => true }, timeout: true }],
    ["probe EINVAL", { probeErr: (p) => p === 11 }]]) {
    t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
    const w2 = world(t, sw); r = await reap(c, w2);
    ok(r.length === 1 && r[0].pid === 11 && r[0].unresolved && !r[0].ended && /^identity-unknown/.test(r[0].reason) && w2.sent.length === 0,
      "R3: initial read failure (" + label + ") -> unresolved, no signal");
  }
  // R3 (review repro): TERM sent, process still alive, the re-read times out -> NOT ended
  t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
  let psCalls = 0;
  w = world(t, { ignoreTerm: true, timeout: true, down: { ps: () => ++psCalls > 1 } });
  r = await reap(c, w);
  ok(r.length === 1 && !r[0].ended && r[0].unresolved && /orphaned-sigterm\+identity-unknown/.test(r[0].reason)
     && w.sent.map((s) => s[1]).join() === "SIGTERM", "R3: post-TERM read failure -> unresolved, no KILL, not ended");
  // pid now names another process (later start) -> original ended, omitted, never signalled
  t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11] = { ppid: 1, lstart: L(50), cwd: WS }; delete t[12];
  r = await reap(c, w);
  ok(r.length === 0 && w.sent.length === 0, "pid replaced before signal -> omitted, no signal");
  // cwd narrows only: changed / outside / unreadable -> unresolved, no signal
  for (const [label, cwd, why] of [["changed", WS + "/other", "cwd-changed"], ["outside", "/tmp/x", "cwd-changed"], ["unreadable", null, "cwd-unreadable"]]) {
    t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; t[11].cwd = cwd; delete t[12];
    r = await reap(c, w);
    ok(r.length === 1 && r[0].unresolved && r[0].reason === why && w.sent.length === 0, "cwd " + label + " -> unresolved, no signal");
  }
  t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
  r = await core.reapOrphans(c, ["/somewhere/else"], { ctx: core.makeCtx(w, 11000) });
  ok(r.length === 1 && r[0].reason === "cwd-outside-session" && w.sent.length === 0, "cwd outside this session's dirs -> no signal");
  // parent: old server still shutting down (same identity) -> signal; reparented elsewhere -> no signal
  t = base(); w = world(t); c = await capOf(t, w); delete t[12];
  r = await reap(c, w);
  ok(r.length === 1 && r[0].pid === 11 && r[0].ended && w.sent.length === 1 && w.sent[0][0] === 11, "child of the recorded old server -> TERM");
  t = base(); w = world(t); c = await capOf(t, w); delete t[10]; t[11].ppid = 777; t[777] = { ppid: 1, lstart: L(3), cwd: "/" }; delete t[12];
  r = await reap(c, w);
  ok(r.length === 1 && r[0].reason === "reparented-elsewhere" && w.sent.length === 0, "reparented to an unrecorded process -> no signal");
  t = base(); w = world(t); c = await capOf(t, w); t[10] = { ppid: 999, lstart: L(45), cwd: "/x" }; delete t[12];
  r = await reap(c, w);
  ok(r.length === 1 && r[0].reason === "parent-changed" && w.sent.length === 0, "recorded server pid reused -> no signal");
  // R4: timeout wins -> no signal after it, result keeps the unresolved identity
  t = base(); w = world(t, { ignoreTerm: true }); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; t[12].ppid = 1;
  const cancel = { stopped: false, why: null };
  const ctx = core.makeCtx({ ...w, cancel, sleep: async (ms) => { w.clock.t += ms; cancel.stopped = true; cancel.why = "reap-timeout"; } }, 11000);
  r = await core.reapOrphans(c, DIRS, { ctx });
  ok(w.sent.length === 1 && w.sent[0][1] === "SIGTERM" && r.length === 2 && r.every((x) => x.unresolved && !x.ended)
     && r[1].reason === "reap-timeout", "R4: after cancellation no further signal; both identities stay unresolved");
  // R4: superseded by a newer reset after the first TERM -> zero further signals
  t = base(); w = world(t, { ignoreTerm: true }); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; t[12].ppid = 1;
  let gen = 1;
  w = { ...w, sleep: async (ms) => { w.clock.t += ms; gen = 2; } };
  r = await core.reapOrphans(c, DIRS, { ctx: core.makeCtx({ ...w, isCurrent: () => gen === 1 }, 11000) });
  ok(w.sent.length === 1 && r.every((x) => x.unresolved) && r.some((x) => x.reason === "superseded"), "R4: superseded -> no further signal");
  // R4/R5: absolute deadline across slow reads -> stops, no signal after the deadline
  t = base(); w = world(t, { slowMs: 4000 }); c = await capOf(t, world(base()));
  delete t[10]; t[11].ppid = 1; t[12].ppid = 1;
  const t0 = w.clock.t;
  r = await reap(c, w, { budgetMs: 11000 });
  ok(w.sent.every((s) => s[2] < t0 + 11000) && w.clock.t - t0 <= 11000 + 4000 && r.some((x) => x.unresolved), "R4/R5: deadline bounds reads and signals");
  // R4/R5: the deadline passes during the identity reads -> the signal that would follow is not sent
  t = base(); w = world(t, { slowMs: 4000 }); c = await capOf(t, world(base())); delete t[10]; t[11].ppid = 1; delete t[12];
  r = await reap(c, w, { budgetMs: 6000 });
  ok(w.sent.length === 0 && r.length === 2 && r.every((x) => x.unresolved && /reap-timeout/.test(x.reason)), "R4/R5: past the deadline no signal is sent");
  // R4 (review repro): real timers; finishReap's 12 s race (shortened) wins -> no SIGKILL after it returns
  t = base(); w = world(t, { ignoreTerm: true }); c = await capOf(t, w); delete t[10]; t[11].ppid = 1; delete t[12];
  const store = {};
  const res = await core.finishReap(Promise.resolve(c), DIRS, { generation: 3 },
    { execFile: w.execFile, kill: w.kill, sleep: (ms) => new Promise((rr) => setTimeout(rr, 40)), raceMs: 10, store, isCurrent: () => true });
  await new Promise((rr) => setTimeout(rr, 150));
  ok(res.orphanWorkers.length === 2 && res.orphanWorkers.every((x) => x.unresolved && !x.ended) && res.orphanWorkers[1].reason === "reap-timeout"
     && !res.clean && res.unresolved === 2, "R4: timeout result keeps every identity not proven ended (incl. one never re-read)");
  ok(w.sent.map((s) => s[1]).join() === "SIGTERM", "R4: no SIGKILL after finishReap returned");
  // publish: an older reset finishing late never replaces a newer result; unresolved rows carried both ways
  const newer = { generation: 5, orphanWorkers: [], clean: true, unresolved: 0 };
  const st = { __codexOrphanReap: newer };
  const lateOld = core.publish({ generation: 4, orphanWorkers: [{ pid: 11, ended: false, unresolved: true, reason: "reap-timeout" }] }, st);
  ok(lateOld.generation === 5 && lateOld.orphanWorkers.length === 1 && lateOld.orphanWorkers[0].generation === 4 && lateOld.clean === false,
    "publish: late older result keeps the newer one, carries its unresolved row");
  const st2 = { __codexOrphanReap: { generation: 6, orphanWorkers: [{ pid: 12, ended: false, unresolved: true, reason: "x" }] } };
  const nw = core.publish({ generation: 7, orphanWorkers: [], clean: true, unresolved: 0 }, st2);
  ok(nw.generation === 7 && nw.orphanWorkers.length === 1 && nw.clean === false, "publish: newer result carries older unresolved rows");
  // finishReap on a clean capture / no root
  const empty = await core.finishReap(Promise.resolve({ state: "ok", root: null, items: [] }), DIRS, { generation: 1 }, { store: {} });
  ok(empty.clean === true && empty.unresolved === 0 && empty.orphanWorkers.length === 0, "finishReap: nothing to reap -> clean");
  const unk = await core.finishReap(Promise.resolve({ state: "unknown", why: "truncated" }), DIRS, { generation: 1 }, { store: {} });
  ok(unk.clean === false && unk.orphanWorkers[0].unresolved && /capture-unknown:truncated/.test(unk.orphanWorkers[0].reason), "finishReap: unknown capture -> not clean");
  const sc = await core.startCapture(new Map(), {});
  ok(sc.state === "ok" && sc.items.length === 0, "startCapture: no registered backend -> nothing to do");
  // helpers
  const now = Date.now(), owned = new Map([[10, { pid: 10, startedAt: new Date(now - 9000).toISOString() }],
    [11, { pid: 11, startedAt: new Date(now - 1000).toISOString() }], [12, { pid: 12, startedAt: new Date(now).toISOString() }]]);
  const lr = core.latestRoot(owned, (p) => p !== 12, 77);
  ok(lr && lr.pid === 11 && lr.hostPid === 77 && Number.isFinite(lr.registeredAtMs) && core.latestRoot(undefined, () => true) === null, "latestRoot: newest live registered pid + host");
  ok(core.inside(WS, WS + "/sub") && !core.inside(WS, "/h/ws/s10") && !core.inside(WS, "/h/ws"), "inside: path prefix is by segment");
  ok(core.parsePs("10 5 " + L(1) + "\ngarbage\n") === null && core.parsePs("") instanceof Map, "parsePs: a partial read is not a read");
  ok(core.probePresence(() => { throw Object.assign(new Error(), { code: "ESRCH" }); }, 1) === core.ABSENT
     && core.probePresence(() => { throw Object.assign(new Error(), { code: "EPERM" }); }, 1) === core.PRESENT
     && core.probePresence(() => { throw Object.assign(new Error(), { code: "EINVAL" }); }, 1) === core.UNKNOWN, "probe: three states");
}

const SRC = fs.readFileSync(path.join(__dirname, "orphan_worker_core.js"), "utf8");
const MUTANTS = [
  ["root start not checked", '  if (top.startMs > root.registeredAtMs + ROOT_START_TOLERANCE_MS) return { state: "unknown", why: "root-replaced" };\n', ""],
  ["root parent not checked", '  if (root.hostPid && top.ppid !== root.hostPid) return { state: "unknown", why: "root-not-host-child" };\n', ""],
  ["discovery race ignored", '  if (rows.size !== found.length + 1 || found.some((p) => !rows.has(p))) return { state: "unknown", why: "discovery-race" };\n', ""],
  ["creation order not checked", '      if (r.startMs < rows.get(r.ppid).startMs) return { state: "unknown", why: "child-older-than-parent" };\n', ""],
  ["read failure treated as absent", '  if (!ps.ok) return { state: UNKNOWN, why: "ps:" + ps.kind };', '  if (!ps.ok) return { state: ABSENT };'],
  ["probe error treated as absent", '  if (pres !== PRESENT) return { state: UNKNOWN, why: "probe" };', '  if (pres !== PRESENT) return { state: ABSENT };'],
  ["lstart not compared", '  if (now.lstart !== before.lstart) return { act: "ended", reason: "pid-replaced" };\n', ""],
  ["cwd change not checked", '  if (before.cwd && now.cwd !== before.cwd) return { act: "unresolved", reason: "cwd-changed" };\n', ""],
  ["cwd scope not checked", '  if (!(dirs || []).some((d) => inside(d, now.cwd))) return { act: "unresolved", reason: "cwd-outside-session" };\n', ""],
  ["any parent accepted", '  if (!ids.has(now.ppid)) return { act: "unresolved", reason: "reparented-elsewhere" };\n', ""],
  ["parent identity not checked", "parent.lstart === ids.get(now.ppid)) return", "true) return"],
  ["no stop check before kill", '      why = stopReason(ctx);\n      if (why) { rec.reason = rec.reason === "pending" ? why : rec.reason + "+" + why; break; }\n', ""],
  ["deadline ignored", '  if (ctx.now() >= ctx.deadline) return "reap-timeout";\n', ""],
  ["supersession ignored", '  if (!ctx.isCurrent()) return "superseded";\n', ""],
  ["timeout does not cancel", 'cancel.stopped = true; cancel.why = "reap-timeout"; r(null);', "r(null);"],
  ["late older result replaces newer", "  if (cur && Number.isFinite(cg) && Number.isFinite(g) && cg > g) {", "  if (false) {"],
  ["no KILL escalation", '["SIGKILL", "orphaned-sigkill", ctx.killGraceMs]', ""],
  ["unknown capture reported clean", "    state.recs = [{ pid: null, startedAt: null, ended: false, unresolved: true,", "    state.recs = []; [{ pid: null, startedAt: null, ended: false, unresolved: true,"],
];
(async () => {
  await cases();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w3-orph-"));
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
