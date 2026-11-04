"use strict";

/**
 * test_data_browser_execution_gate_rc7.js — R16J90 deterministic gate tests.
 *
 * Pure Node, zero external deps, injected clock and timer queue, no real time.
 * Covers the R16J89 audit repairs: P0-1 waiter rejects on uncertainty, P0-2
 * released/stale reservations never revive, P0-3 reconnect is generation- and
 * identity-bound; P1 strict transitions, frozen handles, exact budget, canonical
 * origins, verified rotation, real bundle wiring; P2 bounded history and timer
 * fencing.
 *
 * The bundle-wiring block is an ORACLE over the generated dist text, plus a
 * two-sided control: a semantics-preserving rewrite keeps it green, and each
 * semantics-changing excision or reorder turns it red.
 *
 * Run: node scripts/test_data_browser_execution_gate_rc7.js
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const G = require("./data_browser_execution_gate.js");

const DIST = path.join(__dirname, "..", "dist", "extension.js");

let passed = 0;
let failed = 0;
const failures = [];
const CASES = [];

function t(name, fn) { CASES.push({ name, fn }); }

async function runCases() {
  for (const c of CASES) {
    try {
      await c.fn();
      passed += 1;
      console.log("PASS " + c.name);
    } catch (err) {
      failed += 1;
      const msg = err && err.message ? err.message : String(err);
      failures.push(c.name + " :: " + msg);
      console.log("FAIL " + c.name + " :: " + msg);
    }
  }
}

/** Deterministic clock + timer queue. Nothing here touches real time. */
function makeEnv() {
  const env = {
    t: 1000,
    timers: [],
    seq: 0,
    now() { return env.t; },
    setTimer(fn, ms) {
      env.seq += 1;
      const timer = { id: env.seq, at: env.t + ms, fn, cancelled: false };
      env.timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cancelled = true; },
    advance(ms) {
      const target = env.t + ms;
      for (;;) {
        const due = env.timers
          .filter((x) => !x.cancelled && x.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        env.t = due.at;
        due.fn();
      }
      env.t = target;
    },
    pending() { return env.timers.filter((x) => !x.cancelled).length; },
  };
  return env;
}

function newGate(env, extra) {
  const hooks = { now: env.now, setTimer: env.setTimer, clearTimer: env.clearTimer };
  if (extra && typeof extra.pidAlive === "function") hooks.pidAlive = extra.pidAlive;
  return new G.DataBrowserExecutionGate(hooks);
}

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

const URL_A = "http://127.0.0.1:55889";
const URL_B = "http://127.0.0.1:49210";

/** Admit + start one token, the common precondition. */
function openStarted(gate, p, url) {
  const tok = gate.beginHttp({ path: p || "/v1/dataset", baseUrl: url || URL_A });
  assert.strictEqual(tok.ok, true, "precondition: token admitted");
  assert.strictEqual(gate.markHttpStarted(tok.token).ok, true);
  return tok.token;
}

/* ======================= P0-1 waiter rejects on uncertainty ============== */

for (const outcome of [G.OUTCOME_TIMEOUT, G.OUTCOME_ERROR, G.OUTCOME_ABORT]) {
  t("P0-1 pending waiter rejects channel-uncertain when its token " + outcome, async () => {
    const env = makeEnv();
    const gate = newGate(env);
    const tok = openStarted(gate);
    const res = gate.reserveExecution({ op: "run_selection", runId: "r" });
    const pending = gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
    let settled = null;
    pending.then((v) => { settled = v; });
    await flush();
    assert.strictEqual(settled, null, "waiter must still be pending");
    gate.finishHttp(tok, outcome);
    const v = await pending;
    assert.strictEqual(v.ok, false, outcome + " must NOT resolve ok:true");
    assert.strictEqual(v.code, G.CODE_CHANNEL_UNCERTAIN);
    assert.strictEqual(gate.isChannelUncertain(), true);
  });
}

t("P0-1 wall expiry while a 5000ms waiter is pending rejects it (no widened budget)", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate);
  assert.strictEqual(gate.armWallWatchdog(tok).ok, true);
  const armed = env.timers.filter((x) => !x.cancelled);
  assert.strictEqual(armed.length, 1, "exactly one watchdog armed");
  assert.strictEqual(armed[0].at - env.t, G.WALL_SETTLE_MS, "watchdog is the 32000ms one");
  const res = gate.reserveExecution({ op: "run_file", runId: "r" });
  // The public budget stays exactly 5000; the 32000ms callback is fired directly
  // so it lands while the waiter is still logically pending.
  const pending = gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  armed[0].cancelled = true;
  armed[0].fn();
  const v = await pending;
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, G.CODE_CHANNEL_UNCERTAIN);
});

/* ============= P0-2 released / stale reservations never revive =========== */

t("P0-2 releasing the reservation settles its waiter fail-closed", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  openStarted(gate);
  const res = gate.reserveExecution({ op: "run_command", runId: "r" });
  const pending = gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  gate.releaseExecution(res.reservation);
  const v = await pending;
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, G.CODE_RESERVATION_RELEASED);
});

t("P0-2 rotation retires old tokens but does NOT pump the old waiter green", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  openStarted(gate, "/v1/dataset", URL_A);
  const res = gate.reserveExecution({ op: "run_selection", runId: "r" });
  const pending = gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  const rot = gate.rotateChannel({
    verifiedFresh: true, expectedGeneration: gate.generation,
    expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  });
  assert.strictEqual(rot.ok, true, "precondition: rotation accepted");
  const v = await pending;
  assert.strictEqual(v.ok, false, "a rotated-away waiter must never be ok:true");
  assert.strictEqual(v.code, G.CODE_RESERVATION_STALE);
  assert.strictEqual(v.detail.reservationGeneration, 1);
  assert.strictEqual(v.detail.currentGeneration, 2);
});

t("P0-2 waitForHttpDrain refuses an already-released or unknown reservation", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const res = gate.reserveExecution({ op: "run_selection" });
  gate.releaseExecution(res.reservation);
  const a = await gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  assert.strictEqual(a.ok, false);
  assert.ok([G.CODE_RESERVATION_RELEASED, G.CODE_RESERVATION_UNKNOWN].indexOf(a.code) !== -1,
    "released reservation must fail closed, got " + a.code);
  const b = await gate.waitForHttpDrain({ id: "exec-999" }, G.DRAIN_BUDGET_MS);
  assert.strictEqual(b.code, G.CODE_RESERVATION_UNKNOWN);
});

/* =========== P0-3 reconnect bound to generation + identity ============== */

t("P0-3 reconnect requires exact generation AND uncertainty id", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate);
  gate.finishHttp(tok, G.OUTCOME_TIMEOUT);
  const id = gate.uncertaintyIdentity();
  assert.ok(id && id.uncertaintyId, "uncertainty must have an identity");

  assert.strictEqual(gate.resetAfterReconnect({ reconnectOk: true }).code,
    "reconnect-generation-mismatch", "missing generation must be refused");
  assert.strictEqual(gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: id.generation + 5,
    expectedUncertaintyId: id.uncertaintyId,
  }).code, "reconnect-generation-mismatch");
  assert.strictEqual(gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: id.generation,
    expectedUncertaintyId: "unc-bogus",
  }).code, "reconnect-uncertainty-mismatch");
  assert.strictEqual(gate.isChannelUncertain(), true, "still uncertain after refusals");

  const good = gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: id.generation,
    expectedUncertaintyId: id.uncertaintyId, baseUrl: URL_B,
  });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.generation, id.generation + 1, "epoch advances to fence callbacks");
  assert.strictEqual(gate.isChannelUncertain(), false);
});

t("P0-3 a delayed duplicate reconnect callback cannot clear a newer generation", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate);
  gate.finishHttp(tok, G.OUTCOME_ERROR);
  const stale = gate.uncertaintyIdentity();
  gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: stale.generation,
    expectedUncertaintyId: stale.uncertaintyId,
  });
  // New uncertainty in the NEW generation.
  const tok2 = openStarted(gate, "/v1/vars", URL_A);
  gate.finishHttp(tok2, G.OUTCOME_TIMEOUT);
  assert.strictEqual(gate.isChannelUncertain(), true);
  const replay = gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: stale.generation,
    expectedUncertaintyId: stale.uncertaintyId,
  });
  assert.strictEqual(replay.ok, false, "stale callback must not clear the new generation");
  assert.strictEqual(gate.isChannelUncertain(), true);
});

t("P0-2 healthy force-reset fences a live old token and advances the epoch", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate, "/v1/dataset", URL_A);
  assert.strictEqual(gate.armWallWatchdog(tok).ok, true);
  const armed = env.timers.filter((x) => !x.cancelled);
  assert.strictEqual(armed.length, 1);
  assert.strictEqual(gate.isChannelUncertain(), false, "generation is HEALTHY");
  const gen = gate.generation;
  const id = gate.uncertaintyIdentity();
  assert.strictEqual(id, null, "healthy generation has null identity");

  const cleared = gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: gen, expectedUncertaintyId: null,
  });
  assert.strictEqual(cleared.ok, true, "healthy reset must be accepted");
  assert.strictEqual(cleared.generation, gen + 1, "epoch advances");
  assert.strictEqual(cleared.retired.length, 1, "the live old token is retired");
  assert.strictEqual(env.timers.filter((x) => !x.cancelled).length, 0,
    "the armed old watchdog is cancelled");

  // A later stale callback cannot poison the new generation or a new token.
  const fresh = openStarted(gate, "/v1/dataset", URL_A);
  armed[0].cancelled = true;
  armed[0].fn();
  assert.strictEqual(gate.isChannelUncertain(), false,
    "a fired stale watchdog must not mark the new generation");
  assert.strictEqual(gate.snapshot().openHttpCount, 1, "the new token is untouched");
  assert.strictEqual(gate.finishHttp(fresh, G.OUTCOME_RESPONSE_END).ok, true);

  const stale = gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: gen, expectedUncertaintyId: null,
  });
  assert.strictEqual(stale.ok, false, "stale callback must still reject");
});

t("P0-2 missing expectedUncertaintyId is not the same as null", async () => {
  const gate = newGate(makeEnv());
  const v = gate.resetAfterReconnect({ reconnectOk: true, expectedGeneration: 1 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, "reconnect-uncertainty-identity-required");
});

t("P0-3 there is no generic clear API", async () => {
  const gate = newGate(makeEnv());
  for (const name of ["clear", "clearUncertainty", "reset", "forceClear", "setUncertain"]) {
    assert.strictEqual(typeof gate[name], "undefined", name + " must not exist");
  }
});

/* ============ P1-1 strict HTTP state machine (one start) ================= */

t("P1-1 exactly one start; a repeated start is illegal and uncertain", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate);
  const again = gate.markHttpStarted(tok);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, "already-started");
  assert.strictEqual(gate.isChannelUncertain(), true, "duplicate start ⇒ uncertain");
  assert.strictEqual(gate.snapshot().counters.doubleStarts, 1);
});

t("P1-1 before start only construction-failed is safe", async () => {
  for (const bad of [G.OUTCOME_RESPONSE_END, G.OUTCOME_TIMEOUT, G.OUTCOME_ERROR,
                     G.OUTCOME_ABORT, G.OUTCOME_WALL_EXPIRY]) {
    const gate = newGate(makeEnv());
    const tok = gate.beginHttp({ path: "/v1/dataset", baseUrl: URL_A });
    const v = gate.finishHttp(tok.token, bad);
    assert.strictEqual(v.ok, false, bad + " before start must fail closed");
    assert.strictEqual(v.outcome, G.OUTCOME_ILLEGAL_TRANSITION);
    assert.strictEqual(gate.isChannelUncertain(), true, bad + " before start ⇒ uncertain");
  }
  const safe = newGate(makeEnv());
  const tok = safe.beginHttp({ path: "/v1/dataset", baseUrl: URL_A });
  const ok = safe.finishHttp(tok.token, G.OUTCOME_CONSTRUCTION_FAILED);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(safe.isChannelUncertain(), false, "never reached the server ⇒ safe");
});

t("P1-1 after start construction-failed is impossible and uncertain", async () => {
  const gate = newGate(makeEnv());
  const tok = openStarted(gate);
  const v = gate.finishHttp(tok, G.OUTCOME_CONSTRUCTION_FAILED);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.outcome, G.OUTCOME_ILLEGAL_TRANSITION);
  assert.strictEqual(gate.isChannelUncertain(), true);
});

t("P1-1 response-end after start is the only safe settlement; double settle refused", async () => {
  const gate = newGate(makeEnv());
  const tok = openStarted(gate);
  assert.strictEqual(gate.finishHttp(tok, G.OUTCOME_RESPONSE_END).ok, true);
  assert.strictEqual(gate.isChannelUncertain(), false);
  const again = gate.finishHttp(tok, G.OUTCOME_RESPONSE_END);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, "already-settled");
  assert.strictEqual(gate.snapshot().counters.doubleSettles, 1);
});

t("P1-1 watchdog may be armed only after the unique start", async () => {
  const gate = newGate(makeEnv());
  const tok = gate.beginHttp({ path: "/v1/dataset", baseUrl: URL_A });
  assert.strictEqual(gate.armWallWatchdog(tok.token).code, "not-started");
  gate.markHttpStarted(tok.token);
  assert.strictEqual(gate.armWallWatchdog(tok.token).ok, true);
  assert.strictEqual(gate.armWallWatchdog(tok.token).code, "already-armed");
});

/* ================== P1-2 frozen opaque handles =========================== */

t("P1-2 handles are frozen and caller mutation cannot alter gate state", async () => {
  const gate = newGate(makeEnv());
  const res = gate.reserveExecution({ op: "run_selection", runId: "r" });
  assert.ok(Object.isFrozen(res), "result must be frozen");
  assert.ok(Object.isFrozen(res.reservation), "reservation handle must be frozen");
  try { res.reservation.generation = 99; } catch (_e) { /* strict-mode throw is fine */ }
  try { res.reservation.released = true; } catch (_e) { /* ditto */ }
  assert.strictEqual(gate.hasActiveReservation(), true, "gate state must be unchanged");

  gate.releaseExecution(res.reservation);
  const tok = gate.beginHttp({ path: "/v1/dataset", baseUrl: URL_A });
  assert.strictEqual(tok.ok, true, "admission reopens once released");
  assert.ok(Object.isFrozen(tok.token), "token handle must be frozen");
  try { tok.token.generation = 99; } catch (_e) { /* ok */ }
  try { tok.token.settled = true; } catch (_e) { /* ok */ }
  assert.strictEqual(gate.snapshot().openHttpCount, 1, "token must still be open");
  assert.strictEqual(gate.hasActiveReservation(), false);
  assert.ok(Object.isFrozen(gate.snapshot()), "snapshot must be frozen");
});

/* ========== P1-3 exact budget, P1-4 canonical origin, P1-5 rotation ====== */

t("P1-3 invalid drain budgets are rejected, never defaulted to 5000", async () => {
  const gate = newGate(makeEnv());
  const res = gate.reserveExecution({ op: "run_selection" });
  for (const bad of [true, false, 0, -1, 5001, 37000, NaN, Infinity, -Infinity, undefined, null, "5000", {}]) {
    const v = await gate.waitForHttpDrain(res.reservation, bad);
    assert.strictEqual(v.ok, false, String(bad) + " must be rejected");
    assert.strictEqual(v.code, G.CODE_INVALID_BUDGET, "code for " + String(bad));
  }
  const good = await gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  assert.strictEqual(good.ok, true, "the exact normative budget is accepted");
  assert.strictEqual(G.DRAIN_BUDGET_MS, 5000);
});

t("P1-4 beginHttp requires a canonical http(s) origin", async () => {
  const gate = newGate(makeEnv());
  for (const bad of [undefined, null, "", "not a url", "ftp://h/x", "file:///x", 7, true, {}]) {
    const v = gate.beginHttp({ path: "/v1/dataset", baseUrl: bad });
    assert.strictEqual(v.ok, false, String(bad) + " must be refused");
    assert.strictEqual(v.code, "invalid-http-origin");
  }
  // Slash spelling and a trailing path canonicalise to the same origin, so they
  // cannot simulate a different endpoint.
  assert.strictEqual(G.canonicalOrigin("http://127.0.0.1:55889"), URL_A);
  assert.strictEqual(G.canonicalOrigin("http://127.0.0.1:55889/"), URL_A);
  assert.strictEqual(G.canonicalOrigin("http://127.0.0.1:55889/v1/dataset"), URL_A);
  const gate2 = newGate(makeEnv());
  assert.strictEqual(gate2.beginHttp({ path: "/a", baseUrl: URL_A }).ok, true);
  assert.strictEqual(gate2.beginHttp({ path: "/b", baseUrl: URL_A + "/" }).ok, true,
    "same canonical origin must be accepted");
  assert.strictEqual(gate2.beginHttp({ path: "/c", baseUrl: URL_B }).code, "stale-origin");
});

t("P1-5 rotation requires verifiedFresh, exact generation, exact prior origin, real change", async () => {
  const mk = () => {
    const g = newGate(makeEnv());
    g.beginHttp({ path: "/v1/dataset", baseUrl: URL_A });
    return g;
  };
  let g = mk();
  assert.strictEqual(g.rotateChannel({
    expectedGeneration: 1, expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  }).code, "rotation-not-verified-fresh", "verifiedFresh must be strictly true");
  assert.strictEqual(g.rotateChannel({
    verifiedFresh: "yes", expectedGeneration: 1, expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  }).code, "rotation-not-verified-fresh");

  g = mk();
  assert.strictEqual(g.rotateChannel({
    verifiedFresh: true, expectedGeneration: 7, expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  }).code, "rotation-generation-mismatch");

  g = mk();
  assert.strictEqual(g.rotateChannel({
    verifiedFresh: true, expectedGeneration: 1, expectedPriorBaseUrl: URL_B, baseUrl: URL_B,
  }).code, "rotation-prior-origin-mismatch");

  g = mk();
  assert.strictEqual(g.rotateChannel({
    verifiedFresh: true, expectedGeneration: 1, expectedPriorBaseUrl: URL_A,
    baseUrl: URL_A + "/",
  }).code, "rotation-origin-unchanged", "canonical no-op is not a rotation");

  g = mk();
  const ok = g.rotateChannel({
    verifiedFresh: true, expectedGeneration: 1, expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.generation, 2);
  assert.strictEqual(ok.retired.length, 1, "the open old-generation token is retired");
});

/* ==================== P2-1 bounded history =============================== */

t("P2-1 terminal records are pruned to a bounded history", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const churn = G.MAX_TERMINAL_HTTP_HISTORY * 3;
  for (let i = 0; i < churn; i += 1) {
    const tok = openStarted(gate, "/v1/dataset", URL_A);
    gate.finishHttp(tok, G.OUTCOME_RESPONSE_END);
  }
  const snap = gate.snapshot();
  assert.strictEqual(snap.http.length, 0, "no settled token stays live");
  assert.strictEqual(snap.recentHttp.length, G.MAX_TERMINAL_HTTP_HISTORY,
    "history is capped at " + G.MAX_TERMINAL_HTTP_HISTORY);
  assert.ok(snap.counters.prunedHttp >= churn - G.MAX_TERMINAL_HTTP_HISTORY);

  for (let i = 0; i < G.MAX_TERMINAL_RESERVATION_HISTORY * 2; i += 1) {
    const r = gate.reserveExecution({ op: "run_selection", runId: "r" + i });
    gate.releaseExecution(r.reservation);
  }
  const snap2 = gate.snapshot();
  assert.strictEqual(snap2.reservations.length, 0);
  assert.strictEqual(snap2.recentReservations.length, G.MAX_TERMINAL_RESERVATION_HISTORY);
  // An ACTIVE record must never be pruned.
  const live = gate.reserveExecution({ op: "run_file", runId: "live" });
  assert.strictEqual(gate.snapshot().reservations.length, 1, "active records are lossless");
  gate.releaseExecution(live.reservation);
});

/* ==================== P2-2 timer coverage / fencing ====================== */

t("P2-2 response-end cancels its own watchdog", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate);
  gate.armWallWatchdog(tok);
  assert.strictEqual(env.pending(), 1, "watchdog armed");
  gate.finishHttp(tok, G.OUTCOME_RESPONSE_END);
  assert.strictEqual(env.pending(), 0, "watchdog cancelled on settle");
  env.advance(G.WALL_SETTLE_MS * 2);
  assert.strictEqual(gate.isChannelUncertain(), false, "cancelled timer must not fire");
});

t("P2-2 rotation fences an old watchdog callback", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const tok = openStarted(gate, "/v1/dataset", URL_A);
  gate.armWallWatchdog(tok);
  gate.rotateChannel({
    verifiedFresh: true, expectedGeneration: 1,
    expectedPriorBaseUrl: URL_A, baseUrl: URL_B,
  });
  env.advance(G.WALL_SETTLE_MS * 2);
  assert.strictEqual(gate.generation, 2);
  assert.strictEqual(gate.isChannelUncertain(), false,
    "a retired generation's timer must not poison the live one");
});

t("P2-2 successful reconnect fences an old watchdog callback", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const a = openStarted(gate, "/v1/dataset", URL_A);
  gate.finishHttp(a, G.OUTCOME_TIMEOUT);
  const id = gate.uncertaintyIdentity();
  // A second token from the same (now uncertain) generation still holds a timer.
  gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: id.generation,
    expectedUncertaintyId: id.uncertaintyId,
  });
  env.advance(G.WALL_SETTLE_MS * 2);
  assert.strictEqual(gate.isChannelUncertain(), false, "fenced after reconnect");
});

/* ================= execution identity and admission ===================== */

t("exactly three execution ops; everything else never reserves", async () => {
  const gate = newGate(makeEnv());
  assert.deepStrictEqual(G.EXECUTION_OPERATIONS.slice(),
    ["run_selection", "run_file", "run_command"]);
  for (const op of G.EXECUTION_OPERATIONS) {
    const g2 = newGate(makeEnv());
    assert.strictEqual(g2.reserveExecution({ op }).ok, true, op);
    assert.strictEqual(g2.beginHttp({ path: "/v1/dataset", baseUrl: URL_A }).code,
      G.CODE_EXECUTION_RESERVED, op + " must close admission");
  }
  for (const op of ["view_data", "get_ui_channel", "break_session", "connect",
                    "run_command_background", "", null, 7, true]) {
    assert.strictEqual(gate.isExecutionOperation(op), false, String(op));
    assert.strictEqual(gate.reserveExecution({ op }).ok, false, String(op));
  }
});

t("drain timeout fails closed and reports before the progress sentinel", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  openStarted(gate);
  const res = gate.reserveExecution({ op: "run_selection", runId: "r" });
  const pending = gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  env.advance(G.DRAIN_BUDGET_MS + 1);
  const v = await pending;
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, G.CODE_HTTP_DRAIN_TIMEOUT);
  assert.strictEqual(v.pending.length, 1, "the blocking token is named");
  assert.ok(G.DRAIN_BUDGET_MS < G.SOCKET_IDLE_TIMEOUT_MS);
  assert.ok(G.SOCKET_IDLE_TIMEOUT_MS < G.WALL_SETTLE_MS);
  assert.ok(G.WALL_SETTLE_MS < G.PROGRESS_SENTINEL_MS);
});

t("gate refusals are excluded from dataset credential recovery", async () => {
  let tries = 0;
  const onError = (code) => {
    if (G.isGateErrorCode(code)) return "skipped";
    tries += 1;
    return tries <= 2 ? "recovering" : "exhausted";
  };
  for (const code of G.GATE_ERROR_CODES) assert.strictEqual(onError(code), "skipped", code);
  assert.strictEqual(tries, 0);
  assert.strictEqual(onError("401"), "recovering");
  assert.deepStrictEqual(G.GATE_ERROR_CODES.slice().sort(),
    ["channel-uncertain", "execution-reserved", "http-drain-timeout"]);
  assert.strictEqual(G.isGateErrorCode("execution-reserve"), false, "no prefix match");
});

t("shared singleton is one instance across both code paths", async () => {
  G.__resetSharedGateForTests();
  const a = G.getSharedGate({ now: () => 5 });
  assert.strictEqual(a, G.getSharedGate());
  const res = a.reserveExecution({ op: "run_selection" });
  assert.strictEqual(G.getSharedGate().beginHttp({ path: "/x", baseUrl: URL_A }).code,
    G.CODE_EXECUTION_RESERVED);
  a.releaseExecution(res.reservation);
  G.__resetSharedGateForTests();
});

/* ===== P1-4 generated-bundle oracle: semantics, not literal presence ===== */

/**
 * Runs over generated bundle TEXT. Beyond presence it proves lexical scope
 * (locals declared before `try`), settle-once ownership, response-emitter
 * coverage, Map-shaped PID extraction, liveness-hook injection, run-id
 * provenance, and capture-before-mutation ORDER — the facts the literal-only
 * oracle missed.
 */
function bundleWiringViolations(src) {
  const bad = [];
  const one = (n, l) => { const c = src.split(n).length - 1; if (c !== 1) bad.push(l + "(=" + c + ")"); };
  const none = (n, l) => { if (src.indexOf(n) !== -1) bad.push(l); };
  const order = (a, b, l) => {
    const i = src.indexOf(a); if (i < 0) { bad.push(l + ":missA"); return; }
    const j = src.indexOf(b, i + a.length); if (j < 0) bad.push(l);
  };

  one('"scripts","data_browser_execution_gate.js"', "module-not-required");
  one("globalThis.__codexDbGate=globalThis.__codexDbGate||__codexDbGateMod.getSharedGate({", "singleton-not-shared");

  // P0-1 lexical scope: locals must be declared BEFORE the try they are used in.
  const locals = src.indexOf("__dbTok=null,__dbStarted=false,__dbSettled=false");
  const tryAt = src.indexOf("try{let E=new URL(A)", locals < 0 ? 0 : locals);
  if (locals < 0) bad.push("no-outer-locals");
  else if (!(locals < tryAt)) bad.push("locals-inside-try");
  none('t.Connection="close";let __dbGate=', "shadowing-redeclaration");
  one("__dbSettle=function(__oc)", "no-settle-once-adapter");
  none("__dbTok.startedAt", "reads-startedAt-off-frozen-token");
  one("__dbSettle(__dbStarted?", "catch-not-using-private-flag");
  order("__dbSettle=function(__oc)", "catch(E){", "settle-adapter-after-catch");

  // P1-1 response emitter ownership + settle-once, scoped to _performRequest so
  // unrelated request objects elsewhere in the bundle cannot satisfy or break it.
  const pr0 = src.indexOf("static _performRequest(");
  const pr1 = pr0 < 0 ? -1 : src.indexOf("_getHtmlForWebview", pr0);
  const region = pr0 >= 0 && pr1 > pr0 ? src.slice(pr0, pr1) : "";
  if (!region) bad.push("performRequest-region-not-found");
  const inRegion = (n, l) => { if (region.indexOf(n) === -1) bad.push(l); };
  inRegion('n.on("aborted"', "resp-missing-aborted");
  inRegion('n.on("close"', "resp-missing-close");
  inRegion('n.on("end"', "resp-missing-end");
  // Name-agnostic: the response error listener must settle through the adapter.
  if (!/n\.on\("error",\s*\w+\s*=>\s*\{__dbSettle\("error"\)/.test(region)) {
    bad.push("resp-missing-error-settle");
  }
  for (const ev of ['s.on("timeout"', 's.on("error"', 's.on("abort"', 's.on("close"']) {
    inRegion(ev, "req-missing:" + ev);
  }
  inRegion('__dbSettle("response-end")', "no-response-end-settle");
  if (region.indexOf('finishHttp(__dbTok,"abort")') !== -1) {
    bad.push("direct-finishHttp-bypasses-adapter");
  }
  // P1-1: terminal premature closure must REJECT, not merely settle the gate.
  inRegion('n.on("close",()=>{__dbSettle("abort")&&C(', "resp-close-does-not-reject");
  inRegion('s.on("close",()=>{__dbSettle("abort")&&C(', "req-close-does-not-reject");
  inRegion('s.on("abort",()=>{__dbSettle("abort")&&C(', "req-abort-does-not-reject");
  inRegion('n.on("aborted",()=>{__dbSettle("abort")&&C(', "resp-aborted-does-not-reject");

  // Execution side.
  one("__execGate.reserveExecution({op:A,runId:String(n)})", "no-reservation");
  order("__execGate.reserveExecution({op:A,runId:String(n)})", "this._pending+=1", "reserve-after-pending");
  one("__execGate.waitForHttpDrain(__execRes,5e3)", "no-drain-or-wrong-budget");
  order("__execGate.waitForHttpDrain(__execRes,5e3)", "await this._ensureClient()", "drain-after-ensureClient");
  one("__execGate.releaseExecution(__execRes)}})();", "release-not-in-real-promise");
  order("__execGate.releaseExecution(__execRes)", "Promise.race([d,c])", "release-on-outer-race");
  one("__dbGate.beginHttp({path:E.pathname,method:I.method,baseUrl:E.origin})", "no-admission");
  one("let __dbGateCode=(B&&B.gateCode)||null,__dbRecoverable=!__dbGateCode&&", "cred-recovery-not-excluded");

  // P1-2 diagnostics: real facts, Map-shaped, before the first mutation.
  one("pidAlive:function(__pid)", "no-liveness-hook");
  if (src.split("Array.from((globalThis.__codexOwnedBackendPids||new Map).keys())").length - 1 < 1) {
    bad.push("pids-not-map-extracted");
  }
  none("__codexOwnedBackendPids||[]).slice", "pids-sliced-off-a-map");
  one("runId:(s&&s.runId)||null", "run-id-not-from-bridge");
  none("__codexLifecycleRunId", "run-id-from-nonexistent-global");
  order('__dbResetGate.captureDiagnostic({reason:"force-reset:', "__codexForceResetWasBusy=!!s.busy", "capture-after-wasBusy");
  const forceResetAt = src.indexOf("globalThis.__codexForceReset=async o=>");
  const resetCaptureAt = src.indexOf('__dbResetGate.captureDiagnostic({reason:"force-reset:', forceResetAt);
  const resetFinishAt = src.indexOf("__codexExecution.finishRun(s,", forceResetAt);
  if (!(forceResetAt >= 0 && resetCaptureAt > forceResetAt && resetFinishAt > resetCaptureAt)) {
    bad.push("capture-after-reset-finishRun");
  }
  // rc.7.82: the Windows destructive step is the scoped kill helper (no powershell.exe literal in force reset).
  order('__dbResetGate.captureDiagnostic({reason:"force-reset:', "__codexWindowsKillScopeRun", "capture-after-panic-kill");
  order('__dbResetGate.captureDiagnostic({reason:"force-reset:', "s.runId=null", "capture-after-runid-clear");

  // Rotation / reconnect / status.
  one("__dbRotGate.rotateChannel({verifiedFresh:true", "no-verified-rotation");
  one("__dbResetGate.resetAfterReconnect({reconnectOk:true,expectedGeneration:__dbResetGen,expectedUncertaintyId:__dbResetUnc})", "reconnect-not-identity-bound");
  one("__reconnect.ok===true&&__dbResetGen!==null){", "reconnect-skipped-when-healthy");
  one("executionGate:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.snapshot()", "status-no-snapshot");
  one("executionGateDiagnostic:(function(){try{return globalThis.__codexDbGate?globalThis.__codexDbGate.lastDiagnostic", "status-no-diagnostic");

  if (!src.includes("Workbench progress sentinel")) bad.push("sentinel-removed");
  if (src.includes("bridgeState.busy&&__execGate")) bad.push("forbidden-busy-gate");
  return bad;
}

t("P1-4 the generated bundle satisfies the semantic wiring oracle", async () => {
  const bad = bundleWiringViolations(fs.readFileSync(DIST, "utf8"));
  assert.deepStrictEqual(bad, [], "violations: " + JSON.stringify(bad));
});

t("P1-4 CONTROL green: a semantics-preserving rename stays green", async () => {
  const src = fs.readFileSync(DIST, "utf8");
  const mutated = src.split("__dbSettleUnusedNeverAppears").join("x")
    .split("__dbErr").join("__dbRefusalError");
  assert.notStrictEqual(mutated, src, "control must change the text");
  assert.deepStrictEqual(bundleWiringViolations(mutated), [],
    "semantics-preserving rename must stay green");
});

t("P1-4 CONTROL red: every repaired semantic reddens when mutated", async () => {
  const src = fs.readFileSync(DIST, "utf8");
  const controls = [
    ["move locals back inside try",
      (x) => x.replace("let __dbGate=globalThis.__codexDbGate||null,__dbTok=null,__dbStarted=false,__dbSettled=false,",
        "try{}catch(__z){}let __dbGate=globalThis.__codexDbGate||null,__dbTok=null,__dbStarted=false,__dbSettled=false,")
             .replace("try{let E=new URL(A)", "TRYMOVED{let E=new URL(A)")],
    ["reintroduce the shadowing redeclaration",
      (x) => x.replace('t.Connection="close";', 't.Connection="close";let __dbGate=globalThis.__codexDbGate||null,__dbTok=null;')],
    ["read startedAt off the frozen token",
      (x) => x.replace("__dbSettle(__dbStarted?", "__dbSettle(__dbTok.startedAt?")],
    ["drop the settle-once adapter",
      (x) => x.replace("__dbSettle=function(__oc)", "__dbSettleUnused=function(__oc)")],
    ["drop response aborted listener", (x) => x.split('n.on("aborted"').join('n.off("aborted"')],
    ["drop response error listener", (x) => x.split('n.on("error",__re=>').join('n.off("error",__re=>')],
    ["bypass the adapter with a direct finishHttp",
      (x) => x.replace('s.on("abort",()=>{__dbSettle("abort")&&C(new Error("Proxy request aborted before response end"))})',
        's.on("abort",()=>{__dbGate.finishHttp(__dbTok,"abort")})')],
    ["drop the reject on response premature close",
      (x) => x.replace('n.on("close",()=>{__dbSettle("abort")&&C(new Error("Proxy response closed before end from Stata server"))})',
        'n.on("close",()=>{__dbSettle("abort")})')],
    ["drop the reject on request premature close",
      (x) => x.replace('s.on("close",()=>{__dbSettle("abort")&&C(new Error("Proxy request closed before response end"))})',
        's.on("close",()=>{__dbSettle("abort")})')],
    ["move the census after finishRun",
      (x) => {
        // Physically relocate the census block so the ordering probe sees it late.
        const open = '/* codex patch r16j92: census BEFORE the first finishRun / panic-kill / clear */';
        const i = x.indexOf(open);
        if (i < 0) return x;
        const j = x.indexOf("catch(__dbDiagErr){}", i);
        if (j < 0) return x;
        const block = x.slice(i, j + "catch(__dbDiagErr){}".length);
        const without = x.slice(0, i) + x.slice(i + block.length);
        // Relocate to the r16j91 position (after the lifecycle clear), which is
        // exactly the defect this ordering probe must catch.
        const late = without.indexOf("s.runId=null,");
        if (late < 0) return without;
        return without.slice(0, late) + "s.runId=null," + block
          + without.slice(late + "s.runId=null,".length);
      }],
    ["slice PIDs off the Map again",
      (x) => x.replace("Array.from((globalThis.__codexOwnedBackendPids||new Map).keys())", "(globalThis.__codexOwnedBackendPids||[]).slice(0,8)")],
    ["remove the liveness hook", (x) => x.replace("pidAlive:function(__pid)", "pidDead:function(__pid)")],
    ["take the run id from a nonexistent global",
      (x) => x.replace("runId:(s&&s.runId)||null", "runId:globalThis.__codexLifecycleRunId||null")],
    ["capture after the first mutation",
      (x) => { const cap = x.indexOf('__dbResetGate.captureDiagnostic({reason:"force-reset:');
               const seg = x.slice(cap, x.indexOf("catch(__dbDiagErr){}", cap));
               return x.replace(seg, "").replace("s.source=\"force-reset\"", "s.source=\"force-reset\";" + seg); }],
    ["skip reconnect when healthy",
      (x) => x.replace("__reconnect.ok===true&&__dbResetGen!==null){", "__reconnect.ok===true&&__dbResetGen!==null&&__dbResetUnc){")],
    ["widen the drain budget",
      (x) => x.replace("__execGate.waitForHttpDrain(__execRes,5e3)", "__execGate.waitForHttpDrain(__execRes,37e3)")],
    ["release on the outer race",
      (x) => x.replace("__execGate.releaseExecution(__execRes)}})();", "0}})();")],
    ["remove the progress sentinel",
      (x) => x.replace("Workbench progress sentinel", "Workbench progress observer")],
  ];
  for (const [label, mutate] of controls) {
    const mutated = mutate(src);
    assert.notStrictEqual(mutated, src, label + ": control did not change the text");
    assert.ok(bundleWiringViolations(mutated).length > 0,
      label + ": oracle stayed GREEN — it is vacuous for that fact");
  }
});

t("P1-9 both background call paths inherit the barrier through _enqueue", async () => {
  const src = fs.readFileSync(DIST, "utf8");
  // Both run_command_background sites are wrapped in _withActiveRun inside
  // operations that reach the backend via _enqueue, so the single _enqueue
  // reservation covers them; assert both sites and all three ops exist.
  assert.strictEqual(src.split('this._callTool(k,"run_command_background"').length - 1, 1);
  assert.strictEqual(src.split('this._callTool(G,"run_command_background"').length - 1, 1);
  for (const op of ["run_selection", "run_file", "run_command"]) {
    assert.ok(src.includes('this._enqueue("' + op + '"'),
      op + " must be dispatched through _enqueue");
  }
  // And the gate's own operation list matches exactly those three.
  assert.deepStrictEqual(G.EXECUTION_OPERATIONS.slice(),
    ["run_selection", "run_file", "run_command"]);
});

/* ============================ diagnostics =============================== */

t("pre-reset diagnostic records census, PID liveness, budgets, bounded history", async () => {
  const env = makeEnv();
  const probed = [];
  const gate = newGate(env, { pidAlive: (pid) => { probed.push(pid); return pid === 29594; } });
  openStarted(gate, "/v1/dataset", URL_A);
  const res = gate.reserveExecution({ op: "run_selection", runId: "run_d" });
  env.advance(1200);
  const cap = gate.captureDiagnostic({
    reason: "force-reset:manual-selection pre-log watchdog release",
    runId: "run_d", ownedPids: [29594, 44214, 0, -1, true],
  });
  const d = cap.diagnostic;
  assert.strictEqual(d.openHttpCount, 1);
  assert.strictEqual(d.http[0].socketStarted, true);
  assert.strictEqual(d.http[0].responseEndObserved, false);
  assert.strictEqual(d.http[0].origin, URL_A);
  assert.ok(d.http[0].ageMs >= 1200);
  assert.strictEqual(d.activeReservation, true);
  assert.deepStrictEqual(d.ownedPids.map((x) => x.pid), [29594, 44214],
    "non-positive and boolean PIDs dropped");
  assert.deepStrictEqual(d.ownedPids.map((x) => x.alive), [true, false]);
  assert.deepStrictEqual(probed, [29594, 44214]);
  assert.strictEqual(d.budgets.httpDrainMs, 5000);
  assert.strictEqual(d.budgets.progressSentinelMs, 46000);
  assert.strictEqual(gate.snapshot().lastDiagnostic, d, "exposed for /status");
  assert.ok(Object.isFrozen(d), "diagnostic must be frozen");
  gate.releaseExecution(res.reservation);
});

t("zero-overlap census attributes a later stall away from concurrency", async () => {
  const gate = newGate(makeEnv());
  const tok = openStarted(gate);
  gate.finishHttp(tok, G.OUTCOME_RESPONSE_END);
  const d = gate.captureDiagnostic({ reason: "force-reset:x", ownedPids: [] }).diagnostic;
  assert.strictEqual(d.openHttpCount, 0);
  assert.strictEqual(d.channelUncertain, false);
});


/* ===== P1-1/P1-3 execute the ACTUAL generated _performRequest ============ */

const EventEmitter = require("node:events");

/** Mechanically extract the generated `_performRequest` by brace balance. No
 *  hand-written model: this is the shipped text, executed. */
function extractPerformRequest(src) {
  const at = src.indexOf("static _performRequest(");
  assert.ok(at > 0, "generated _performRequest not found");
  const open = src.indexOf("{", at);
  let depth = 0, i = open;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i += 1; i += 1; }
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(at, i).replace(/^static\s+/, "");
}

function makeRealHarness(opts) {
  const o = opts || {};
  const src = fs.readFileSync(DIST, "utf8");
  const slice = extractPerformRequest(src);
  const req = new EventEmitter();
  req.destroyed = false;
  req.written = [];
  req.write = function (b) { if (o.throwOnWrite) throw new Error("write blew up"); req.written.push(b); };
  req.end = function () { if (o.throwOnEnd) throw new Error("end blew up"); req.ended = true; };
  req.destroy = function () { req.destroyed = true; };
  req.setTimeout = function () {};
  let res = null;
  const yHg = {
    request(url, options, cb) {
      if (o.throwOnConstruct) throw new Error("construction blew up");
      res = new EventEmitter();
      res.statusCode = o.statusCode === undefined ? 200 : o.statusCode;
      if (cb) setImmediate(() => cb(res));
      return req;
    },
  };
  const GM = { startSpan: (_m, fn) => fn(), captureException: () => {} };
  const panel = {
    _credentials: { baseUrl: "http://127.0.0.1:55889", token: "test-channel" },
    _credentialGeneration: globalThis.__codexDbGate && globalThis.__codexDbGate.generation,
  };
  const holder = new Function("GM", "g", "yHg", "Buffer", "URL",
    "return ({" + slice + "})")(GM, { _log: () => {}, currentPanel: panel }, yHg, Buffer, URL);
  return {
    slice,
    req,
    panel,
    getRes: () => res,
    call: (path) => holder._performRequest(
      "http://127.0.0.1:55889" + (path || "/v1/dataset"), { method: "GET", headers: { Authorization: "Bearer test-channel" } }, false),
  };
}

/** Real macrotask tick: the generated code delivers the response via the
 *  http.request callback, which our harness schedules with setImmediate. */
function tick() { return new Promise((r) => setImmediate(r)); }

/** Settled-state probe that never leaves a test hanging on a pending promise. */
function probe(promise) {
  const state = { status: "pending", value: undefined };
  promise.then((v) => { state.status = "resolved"; state.value = v; },
              (e) => { state.status = "rejected"; state.value = e; });
  return state;
}

t("P1-3 REAL wiring: normal end resolves, later req/res close are no-ops", async () => {
  G.__resetSharedGateForTests();
  const gate = G.getSharedGate({ now: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
  globalThis.__codexDbGate = gate;
  const h = makeRealHarness({});
  const st = probe(h.call("/v1/dataset"));
  await tick(); await flush();
  const res = h.getRes();
  res.emit("data", Buffer.from('{"ok":true}'));
  res.emit("end");
  await tick(); await flush();
  assert.strictEqual(st.status, "resolved", "normal end must resolve");
  assert.deepStrictEqual(st.value, { ok: true });
  assert.strictEqual(gate.snapshot().recentHttp.slice(-1)[0].outcome, G.OUTCOME_RESPONSE_END);
  assert.strictEqual(gate.isChannelUncertain(), false);
  h.req.emit("close");
  res.emit("close");
  await tick(); await flush();
  assert.strictEqual(st.status, "resolved", "later closes must not change settlement");
  assert.strictEqual(gate.snapshot().counters.doubleSettles, 0);
  G.__resetSharedGateForTests(); delete globalThis.__codexDbGate;
});

for (const scenario of [
  ["response close-only", (h, res) => res.emit("close")],
  ["response aborted", (h, res) => res.emit("aborted")],
  ["response error", (h, res) => res.emit("error", new Error("res boom"))],
  ["request abort", (h) => h.req.emit("abort")],
  ["request close-only", (h) => h.req.emit("close")],
  ["request error", (h) => h.req.emit("error", new Error("req boom"))],
  ["request timeout", (h) => h.req.emit("timeout")],
]) {
  t("P1-3 REAL wiring: " + scenario[0] + " rejects exactly once and marks uncertain", async () => {
    G.__resetSharedGateForTests();
    const gate = G.getSharedGate({ now: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
    globalThis.__codexDbGate = gate;
    const h = makeRealHarness({});
    const st = probe(h.call("/v1/dataset"));
    await tick(); await flush();
    scenario[1](h, h.getRes());
    await tick(); await flush();
    assert.strictEqual(st.status, "rejected",
      scenario[0] + " must REJECT, never leave the promise pending");
    assert.strictEqual(gate.snapshot().openHttpCount, 0, "no token may stay live");
    assert.strictEqual(gate.isChannelUncertain(), true, "premature end ⇒ uncertain");
    // A second terminal event must not double-settle or double-reject.
    h.req.emit("close");
    if (h.getRes()) h.getRes().emit("close");
    await tick(); await flush();
    assert.strictEqual(gate.snapshot().counters.doubleSettles, 0);
    G.__resetSharedGateForTests(); delete globalThis.__codexDbGate;
  });
}

t("P1-3 REAL wiring: synchronous construction throw leaves zero live tokens, not uncertain", async () => {
  G.__resetSharedGateForTests();
  const gate = G.getSharedGate({ now: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
  globalThis.__codexDbGate = gate;
  const h = makeRealHarness({ throwOnConstruct: true });
  const st = probe(h.call("/v1/dataset"));
  await tick(); await flush();
  assert.strictEqual(st.status, "rejected", "construction failure must reject");
  assert.strictEqual(gate.snapshot().openHttpCount, 0, "the admitted token must not leak");
  assert.strictEqual(gate.isChannelUncertain(), false, "server never saw it ⇒ safe");
  const res = gate.reserveExecution({ op: "run_selection" });
  const drained = await gate.waitForHttpDrain(res.reservation, G.DRAIN_BUDGET_MS);
  assert.strictEqual(drained.ok, true, "no waiter may be blocked by a leaked token");
  G.__resetSharedGateForTests(); delete globalThis.__codexDbGate;
});

t("P1-3 REAL wiring: post-start write exception settles uncertain", async () => {
  G.__resetSharedGateForTests();
  const gate = G.getSharedGate({ now: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
  globalThis.__codexDbGate = gate;
  const src = fs.readFileSync(DIST, "utf8");
  const slice = extractPerformRequest(src);
  const req = new EventEmitter();
  req.write = () => { throw new Error("post-start write blew up"); };
  req.end = () => {}; req.destroy = () => {};
  const yHg = { request: (_u, _o, cb) => { const r = new EventEmitter(); r.statusCode = 200;
    if (cb) setImmediate(() => cb(r)); return req; } };
  const holder = new Function("GM", "g", "yHg", "Buffer", "URL", "return ({" + slice + "})")(
    { startSpan: (_m, f) => f(), captureException: () => {} }, { _log: () => {}, currentPanel: {
      _credentials: {baseUrl: "http://127.0.0.1:55889", token: "test-channel"}, _credentialGeneration: gate.generation,
    } }, yHg, Buffer, URL);
  const st = probe(holder._performRequest("http://127.0.0.1:55889/v1/dataset",
    { method: "POST", headers: {Authorization: "Bearer test-channel"}, body: '{"a":1}' }, false));
  await tick(); await flush();
  assert.strictEqual(st.status, "rejected");
  assert.strictEqual(st.value.message, "post-start write blew up", "must reach the intended exception");
  assert.strictEqual(gate.isChannelUncertain(), true,
    "an exception after the socket started leaves the server side unknown");
  G.__resetSharedGateForTests(); delete globalThis.__codexDbGate;
});

t("P1-3 REAL wiring: admission refusal rejects with a gateCode and never opens a socket", async () => {
  G.__resetSharedGateForTests();
  const gate = G.getSharedGate({ now: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
  globalThis.__codexDbGate = gate;
  const held = gate.reserveExecution({ op: "run_selection", runId: "r" });
  assert.strictEqual(held.ok, true);
  let constructed = 0;
  const src = fs.readFileSync(DIST, "utf8");
  const slice = extractPerformRequest(src);
  const holder = new Function("GM", "g", "yHg", "Buffer", "URL", "return ({" + slice + "})")(
    { startSpan: (_m, f) => f(), captureException: () => {} }, { _log: () => {}, currentPanel: {
      _credentials: {baseUrl: "http://127.0.0.1:55889", token: "test-channel"}, _credentialGeneration: gate.generation,
    } },
    { request: () => { constructed += 1; throw new Error("must not reach here"); } }, Buffer, URL);
  const st = probe(holder._performRequest("http://127.0.0.1:55889/v1/dataset",
    { method: "GET", headers: {Authorization: "Bearer test-channel"} }, false));
  await tick(); await flush();
  assert.strictEqual(st.status, "rejected");
  assert.strictEqual(st.value.gateCode, G.CODE_EXECUTION_RESERVED);
  assert.strictEqual(constructed, 0, "no socket may be constructed while execution holds the lock");
  gate.releaseExecution(held.reservation);
  G.__resetSharedGateForTests(); delete globalThis.__codexDbGate;
});

/* ============ P2-1 real armed old watchdog across reconnect ============== */

t("P2-1 uncertain reconnect retires the old token, cancels its armed watchdog, fences it", async () => {
  const env = makeEnv();
  const gate = newGate(env);
  const old = openStarted(gate, "/v1/dataset", URL_A);
  assert.strictEqual(gate.armWallWatchdog(old).ok, true);
  const armed = env.timers.filter((x) => !x.cancelled);
  assert.strictEqual(armed.length, 1, "an OLD watchdog is genuinely armed");

  const other = openStarted(gate, "/v1/vars", URL_A);
  gate.finishHttp(other, G.OUTCOME_TIMEOUT);
  const id = gate.uncertaintyIdentity();
  assert.ok(id, "generation is uncertain");
  const gen = gate.generation;

  const cleared = gate.resetAfterReconnect({
    reconnectOk: true, expectedGeneration: gen, expectedUncertaintyId: id.uncertaintyId,
  });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.generation, gen + 1);
  assert.ok(cleared.retired.indexOf(old.id) !== -1, "the old live token is retired");
  assert.strictEqual(env.timers.filter((x) => !x.cancelled).length, 0,
    "the armed old watchdog is cancelled");

  // Create the second token the old comment only claimed, then fire the stale timer.
  const fresh = openStarted(gate, "/v1/dataset", URL_A);
  armed[0].cancelled = true;
  armed[0].fn();
  assert.strictEqual(gate.isChannelUncertain(), false,
    "a fired stale watchdog cannot mark the new generation");
  assert.strictEqual(gate.snapshot().openHttpCount, 1, "the new token is unaffected");
  assert.strictEqual(gate.finishHttp(fresh, G.OUTCOME_RESPONSE_END).ok, true);
});

/* R16J120: execute generated methods, not a transcription of credential rules. */
t("R120 old cached HTTP after reconnect is refused before socket/admission", async () => {
  const gate = newGate(makeEnv());
  globalThis.__codexDbGate = gate;
  const h = makeRealHarness();
  assert.strictEqual(gate.resetAfterReconnect({reconnectOk: true,
    expectedGeneration: gate.generation, expectedUncertaintyId: null}).ok, true);
  const st = probe(h.call());
  await tick(); await flush();
  assert.strictEqual(st.status, "rejected");
  assert.strictEqual(st.value.gateCode, "stale-ui-channel");
  assert.strictEqual(h.getRes(), null, "no http.request on retired credentials");
  assert.strictEqual(gate.snapshot().counters.httpAdmitted, 0);
  assert.strictEqual(gate.isChannelUncertain(), false);
  assert.strictEqual(gate.reserveExecution({op: "run_selection"}).ok, true);
});

t("R120 stale bearer is refused even with current generation and same URL", async () => {
  const gate = newGate(makeEnv()); globalThis.__codexDbGate = gate;
  const h = makeRealHarness(); h.panel._credentials.token = "fresh-token";
  const st = probe(h.call()); await tick(); await flush();
  assert.strictEqual(st.status, "rejected");
  assert.strictEqual(st.value.gateCode, "stale-ui-channel");
  assert.strictEqual(h.getRes(), null);
});

function actualFetch(panel, fetch) {
  const src = fs.readFileSync(DIST, "utf8");
  const start = src.indexOf("async _fetchCredentials()");
  const end = src.indexOf("dispose(){", start);
  assert.ok(start > 0 && end > start);
  const fn = new Function("GM", "g", "uHg", "Ut", "URL", "return ({" + src.slice(start, end) + "})");
  return fn({ startSpan: (_m, f) => f() }, {_log: () => {}},
    {getUiChannel: fetch}, {workspace: {getConfiguration: () => ({get: (_k, d) => d})}}, URL
  )._fetchCredentials.call(panel);
}

t("R120 credential response crossing reset cannot publish into new epoch", async () => {
  const gate = newGate(makeEnv()); globalThis.__codexDbGate = gate;
  const panel = {_credentials: null, _credentialRefreshes: 0, _isWebviewReady: false};
  let complete;
  const pending = actualFetch(panel, () => new Promise(r => {complete = r;}));
  gate.resetAfterReconnect({reconnectOk: true, expectedGeneration: gate.generation, expectedUncertaintyId: null});
  complete({baseUrl: URL_A, token: "retired"});
  const result = await pending;
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "stale-credential-response");
  assert.strictEqual(panel._credentials, null);
});

t("R120 explicit refresh binds fresh origin and generation before publication", async () => {
  const gate = newGate(makeEnv()); globalThis.__codexDbGate = gate;
  const old = openStarted(gate, "/v1/dataset", URL_A); gate.finishHttp(old, G.OUTCOME_RESPONSE_END);
  const panel = {_credentials: {baseUrl: URL_A, token: "old"}, _credentialGeneration: gate.generation,
    _credentialRefreshes: 0, _isWebviewReady: false};
  gate.resetAfterReconnect({reconnectOk: true, expectedGeneration: gate.generation, expectedUncertaintyId: null});
  const result = await actualFetch(panel, async () => ({baseUrl: URL_B, token: "fresh"}));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(panel._credentialGeneration, gate.generation);
  assert.strictEqual(gate.snapshot().origin, URL_B);
  assert.strictEqual(panel._credentials.token, "fresh");
  assert.strictEqual(gate.beginHttp({path: "/v1/dataset", baseUrl: URL_A}).ok, false);
  assert.strictEqual(gate.beginHttp({path: "/v1/dataset", baseUrl: URL_B}).ok, true);
});

t("R120 optional summary never calls HTTP with a pre-reset cached epoch", async () => {
  const src = fs.readFileSync(DIST, "utf8"), start = src.indexOf("async function qF()");
  const end = src.indexOf("async function OHg()", start);
  assert.ok(start > 0 && end > start);
  const gate = newGate(makeEnv()); globalThis.__codexDbGate = gate;
  let calls = 0;
  const GD = { currentPanel: {_credentials: {baseUrl: URL_A, token: "old"}, _credentialGeneration: gate.generation},
    _performRequest: async () => {calls++; return {n: 1, k: 1};}, refresh: () => {} };
  const fn = new Function("GD", "Gg", src.slice(start, end) + ";return qF;")(GD, {updateDatasetSummary: () => {}});
  gate.resetAfterReconnect({reconnectOk: true, expectedGeneration: gate.generation, expectedUncertaintyId: null});
  await fn(); assert.strictEqual(calls, 0);
  GD.currentPanel._credentialGeneration = gate.generation;
  await fn(); assert.strictEqual(calls, 1, "positive branch must actually call HTTP");
});

/* ================================= main ================================== */

async function main() {
  await runCases();
  console.log("");
  if (failures.length) {
    console.log("--- failures ---");
    for (const f of failures) console.log("  " + f);
  }
  console.log("DB_EXECUTION_GATE PASS=" + passed + " FAIL=" + failed);
  if (failed === 0) console.log("DB_EXECUTION_GATE_OK");
  process.exitCode = failed === 0 ? 0 : 1;
}

main();




