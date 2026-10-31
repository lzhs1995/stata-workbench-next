#!/usr/bin/env node
"use strict";

// 回归：rc.7.45 运行前快照在「有观测、没有变量」（k=0、N>0）时执行 set obs 1，
// Stata 报 r(198)，快照失败，之后每次提交都 EXEC_REJECTED（A2 实测 2026-10-31）。
// 这里不跑 Stata：用一个只认数据集语句的小解释器，按 Stata 的规则（set obs 不能减少观测、
// save 至少要 1 个变量、出错跳出最近的 capture 块）走一遍生成的快照和恢复代码，
// 四种状态都要求快照成功、ready 文件可解析、恢复后 N 和 k 与原来相同。
// 实机核对见 docs/next/LIVE-CHECKS.md L14。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const checkpoint = require("./stop_checkpoint_core");

const CAPTURE_OPEN = /^(?:capture noisily(?: break)?|capture) \{$/;
const IGNORE = [/^tempname /, /^_return /, /^capture _return /, /^capture frame drop /,
  /^file (?:open|close) /, /^display /, /^exit /];

function tokenStata(line) {
  // 去掉宏引用，留下可判断的形状；只认本测试需要的几种语句。
  return line.trim();
}

// 执行快照代码。live 是 {N,k}，返回 {rc, saved, ready}。
function runSnapshot(code, live) {
  const locals = { _rc: "0" };
  let copy = null;
  let saved = null;
  let ready = "";
  const stack = []; // {kind: "capture"|"if"|"plain", active, failed}
  const active = () => stack.every((s) => s.active && !s.failed);
  const expand = (text) => text.replace(/`([A-Za-z_][A-Za-z0-9_]*)'/g, (_, name) =>
    name === "c(frame)" ? "default" : (locals[name] ?? ""));
  const cond = (text) => {
    let expr = expand(text).replace(/c\(k\)/g, String(live.k)).replace(/c\(N\)/g, String(live.N));
    expr = expr.replace(/"([^"]*)"\s*==\s*"([^"]*)"/g, (_, a, b) => String(a === b));
    expr = expr.replace(/(\d+)\s*==\s*(\d+)/g, (_, a, b) => String(Number(a) === Number(b)));
    expr = expr.replace(/(\d+)\s*!=\s*(\d+)/g, (_, a, b) => String(Number(a) !== Number(b)));
    expr = expr.replace(/(\d+)\s*>\s*(\d+)/g, (_, a, b) => String(Number(a) > Number(b)));
    expr = expr.replace(/\s*&\s*/g, "&&");
    assert.ok(/^(?:true|false|&&)+$/.test(expr.replace(/\s+/g, "")), "unmodelled condition: " + text);
    return expr.split("&&").every((part) => part.trim() === "true");
  };
  const fail = (rc) => {
    // 跳到最近的 capture 块：块里余下的语句不执行，块结束时 _rc = rc。
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === "capture") { stack[i].failed = rc; return; }
    }
    throw new Error("uncaught Stata error r(" + rc + ")");
  };
  for (const raw of code.split("\n")) {
    const line = tokenStata(raw);
    if (!line) continue;
    if (line === "}") {
      const top = stack.pop();
      assert.ok(top, "unbalanced block");
      if (top.kind === "capture" && top.active) locals._rc = String(top.failed || 0);
      continue;
    }
    if (line === "nobreak {") { stack.push({ kind: "plain", active: active() }); continue; }
    if (CAPTURE_OPEN.test(line)) { stack.push({ kind: "capture", active: active(), failed: 0 }); continue; }
    let m = /^if (.+) \{$/.exec(line);
    if (m) { stack.push({ kind: "if", active: active() && cond(m[1]) }); continue; }
    if (!active()) continue;
    m = /^if (.+?) (file write .+|exit .+)$/.exec(line);
    if (m && !/^if .+ \{$/.test(line)) {
      if (!cond(m[1])) continue;
      if (m[2].startsWith("exit ")) {
        const rc = Number(expand(m[2].slice(5)));
        return { rc, saved, ready };
      }
      ready += writeText(expand(m[2]));
      continue;
    }
    m = /^local (\S+) = (.+)$/.exec(line);
    if (m) {
      const value = m[2] === "_rc" ? locals._rc
        : /^strtrim\(string\(c\(N\), "%20\.0f"\)\)$/.test(m[2]) ? String(live.N)
          : /^\d+$/.test(m[2]) ? m[2] : null;
      assert.notStrictEqual(value, null, "unmodelled local: " + line);
      locals[m[1]] = value;
      continue;
    }
    m = /^local (\S+) "([^"]*)"$/.exec(line);
    if (m) { locals[m[1]] = m[2]; continue; }
    if (/^frame copy /.test(line)) { copy = { ...live }; continue; }
    m = /^frame `__codex_snap_frame': (.+)$/.exec(line);
    if (m) {
      const cmd = m[1];
      if (cmd === "quietly set obs 1") {
        if (copy.N > 1) { fail(198); continue; }
        copy.N = 1;
      } else if (cmd === "generate byte __codex_empty_state = .") {
        copy.k += 1;
      } else if (/^quietly save ".+", replace$/.test(cmd)) {
        if (copy.k === 0) { fail(111); continue; }
        saved = { ...copy };
      } else {
        throw new Error("unmodelled frame command: " + cmd);
      }
      continue;
    }
    if (/^file write /.test(line)) { ready += writeText(expand(line)); continue; }
    if (IGNORE.some((re) => re.test(line))) continue;
    throw new Error("unmodelled snapshot statement: " + line);
  }
  assert.deepStrictEqual(stack, [], "unclosed block");
  return { rc: 0, saved, ready };
}

// Stata 的 file write：字符串、_tab、_n。
function writeText(line) {
  const body = line.replace(/^file write \S+ /, "");
  let out = "";
  for (const token of body.match(/"[^"]*"|_tab|_n/g) || []) {
    out += token === "_tab" ? "\t" : token === "_n" ? "\n" : token.slice(1, -1);
  }
  return out;
}

// 只执行恢复代码里改数据集的语句；其他语句（全局、estimates、graph）不碰 N 和 k。
function runRestore(code, saved, start) {
  const state = { ...start };
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line === "clear") { state.N = 0; state.k = 0; continue; }
    if (/^use ".+", clear$/.test(line)) { Object.assign(state, saved); continue; }
    const m = /^set obs (\d+)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n < state.N) throw new Error("set obs cannot reduce observations: r(198)");
      state.N = n;
      continue;
    }
    assert.ok(!/^(?:quietly )?(?:drop|keep|generate|gen|set obs|frame|clear\b)/.test(line),
      "unmodelled dataset statement in restore: " + line);
  }
  return state;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-k0-"));
try {
  const cases = [
    { name: "k=0 N=0", live: { N: 0, k: 0 }, kind: "empty" },
    { name: "k=0 N>0", live: { N: 100000, k: 0 }, kind: "obs" },
    { name: "k=0 N=1", live: { N: 1, k: 0 }, kind: "obs" },
    { name: "k>0 N>0", live: { N: 5, k: 3 }, kind: "data" },
    { name: "k>0 N=0", live: { N: 0, k: 2 }, kind: "data" },
  ];
  for (const c of cases) {
    const snapshot = { path: path.join(root, c.kind + c.live.N + ".dta"), runId: "k0-" + c.name, checkpointNonce: "a".repeat(32) };
    checkpoint.initializeCheckpoint(snapshot, { checkpointNonce: snapshot.checkpointNonce });
    const result = runSnapshot(checkpoint.snapshotCode(snapshot), c.live);
    assert.strictEqual(result.rc, 0, `${c.name}: snapshot must succeed`);
    assert.ok(result.saved && result.saved.k > 0, `${c.name}: a file with at least one variable is saved`);
    const paths = checkpoint.checkpointPaths(snapshot);
    fs.writeFileSync(paths.snapshotReadyPath, result.ready, "utf8");
    fs.writeFileSync(snapshot.path, Buffer.alloc(1024, 7));
    const record = checkpoint.snapshotReadyRecord(snapshot);
    assert.ok(record, `${c.name}: ready file must parse: ${JSON.stringify(result.ready)}`);
    assert.strictEqual(record.kind, c.kind, c.name);
    if (c.kind === "obs") assert.strictEqual(record.obs, c.live.N, c.name);
    fs.writeFileSync(paths.globalsPath, "", "utf8");
    fs.writeFileSync(paths.estimatesPath, "", "utf8");
    fs.writeFileSync(paths.graphsPath, "", "utf8");
    fs.writeFileSync(paths.currentGraphPath, "", "utf8");
    fs.writeFileSync(paths.defaultGraphObjectPath, "1\n", "utf8");
    const code = checkpoint.restoreCode(snapshot);
    assert.ok(code && code !== checkpoint.REFUSED_RESTORE_CODE, `${c.name}: restore must be offered`);
    // 恢复前的会话处在被打断的运行之后：随便什么 N、k。
    for (const start of [{ N: 7, k: 3 }, { N: 0, k: 0 }, { N: 2000000, k: 0 }]) {
      const restored = runRestore(code, result.saved, start);
      assert.deepStrictEqual(restored, c.live, `${c.name}: restore from ${JSON.stringify(start)}`);
    }
  }

  // ready 文件的严格解析：obs 必须带正整数，其他种类不能带数。
  const s = { path: path.join(root, "p.dta"), runId: "parse", checkpointNonce: "b".repeat(32) };
  checkpoint.initializeCheckpoint(s, { checkpointNonce: s.checkpointNonce });
  const readyPath = checkpoint.checkpointPaths(s).snapshotReadyPath;
  const nonce = s.checkpointNonce;
  for (const [text, ok] of [
    [`ready\t${nonce}\tobs\t100000\n`, true], [`ready\t${nonce}\tobs\t1099511627775\n`, true],
    [`ready\t${nonce}\tobs\n`, false], [`ready\t${nonce}\tobs\t0\n`, false], [`ready\t${nonce}\tobs\t012\n`, false],
    [`ready\t${nonce}\tobs\t1e5\n`, false], [`ready\t${nonce}\tobs\t 5\n`, false], [`ready\t${nonce}\tdata\t5\n`, false],
    [`ready\t${nonce}\tempty\t5\n`, false], [`ready\t${nonce}\tdata\n`, true], [`ready\t${nonce}\tempty\n`, true],
  ]) {
    fs.writeFileSync(readyPath, text, "utf8");
    assert.strictEqual(checkpoint.snapshotReadyRecord(s) !== null, ok, JSON.stringify(text));
  }
  console.log("SNAPSHOT_K0_STATES_PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
