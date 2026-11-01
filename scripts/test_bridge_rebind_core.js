#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { createBridgeBinder } = require("./bridge_rebind_core");

class FakeServer extends EventEmitter {
  constructor(errors = []) {
    super();
    this.errors = errors.slice();
    this.listening = false;
    this.listenCalls = 0;
  }

  listen(_port, _host) {
    this.listenCalls += 1;
    const next = this.errors.shift();
    if (next) {
      this.emit("error", Object.assign(new Error(next), { code: next }));
      return;
    }
    this.listening = true;
    this.emit("listening");
  }
}

function timerHarness() {
  const queue = [];
  return {
    queue,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      queue.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = queue.shift();
      assert.ok(timer, "expected a scheduled retry");
      if (!timer.cleared) timer.callback();
    },
  };
}

function main() {
  const timers = timerHarness();
  const transient = new FakeServer(["EADDRINUSE", "EADDRINUSE"]);
  const states = [];
  const retryOrdinals = [];
  let boundCalls = 0;
  const binder = createBridgeBinder({
    server: transient,
    port: 17525,
    retryDelaysMs: [10, 20, 30],
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => 1000,
    onState: (state) => states.push(state),
    onRetry: ({ state }) => retryOrdinals.push(state.retriesScheduled),
    onBound: () => { boundCalls += 1; },
  });
  binder.start();
  assert.strictEqual(binder.state().attempts, 1);
  assert.strictEqual(binder.state().retriesScheduled, 1);
  timers.runNext();
  assert.strictEqual(binder.state().attempts, 2);
  timers.runNext();
  assert.strictEqual(binder.state().attempts, 3);
  assert.strictEqual(binder.state().bound, true);
  assert.strictEqual(transient.listenCalls, 3);
  assert.deepStrictEqual(retryOrdinals, [1, 2]);
  assert.strictEqual(boundCalls, 1, "failed listen callbacks must not accumulate");
  assert.ok(states.some((state) => state.lastErrorCode === "EADDRINUSE"));

  let terminal = null;
  const fatal = new FakeServer(["EACCES"]);
  const fatalBinder = createBridgeBinder({
    server: fatal,
    port: 17525,
    retryDelaysMs: [1, 1],
    onTerminalError: (error) => { terminal = error; },
  });
  fatalBinder.start();
  assert.strictEqual(fatalBinder.state().attempts, 1);
  assert.strictEqual(fatalBinder.state().retriesScheduled, 0);
  assert.strictEqual(fatalBinder.state().exhausted, true);
  assert.strictEqual(terminal.code, "EACCES");

  const disposeTimers = timerHarness();
  const disposing = new FakeServer(["EADDRINUSE"]);
  const disposingBinder = createBridgeBinder({
    server: disposing,
    port: 17525,
    retryDelaysMs: [5],
    setTimeoutFn: disposeTimers.setTimeoutFn,
    clearTimeoutFn: disposeTimers.clearTimeoutFn,
  });
  disposingBinder.start();
  disposingBinder.dispose();
  disposeTimers.runNext();
  assert.strictEqual(disposing.listenCalls, 1);

  const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
  assert.ok(bundle.includes("codex patch rc.7.10.31: bridge retries transient EADDRINUSE"));
  assert.ok(bundle.includes("bridge_rebind_core.js"));
  assert.ok(bundle.includes("bridgeBind:globalThis.__codexBridgeBindState||null"));
  assert.ok(bundle.includes("__codexBridgeBinder.start()"));
  assert.ok(bundle.includes("the agent cannot connect"), "busy explicit bridge port explains agent connectivity failure");
  console.log("BRIDGE_REBIND_CORE_PASS");
}

main();
