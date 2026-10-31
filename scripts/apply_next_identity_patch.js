#!/usr/bin/env node
"use strict";

// Next 开发线（0.2.0-next.1）：把 bundle 里 visibleBridgePort 的两处回退值从稳定版的
// 17485 改成 17601。稳定版和用户的研究实例占用 17485；Next 的测试会话只用 17601–17620，
// 未配置端口时也不能落到 17485 上。只改这两处字面量，不改端口校验和绑定逻辑。
// 离线改 bundle；不安装，不启动 Stata。
const fs = require("node:fs");
const path = require("node:path");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "/* next patch 0.2.0-next.1: Next default bridge port 17601 */";

// [before, after]；每个 before 在 rc.7.45 bundle 里唯一。
const ANCHORS = {
  configDefault: ['get("visibleBridgePort",17485)', 'get("visibleBridgePort",17601)'],
  catchDefault: ["catch(e){return 17485;}", "catch(e){return 17601;}" + MARKER],
};
const EDITS = Object.values(ANCHORS);

function uniqueAt(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous Next identity anchor");
  }
  return at;
}

function patchBundle(source, options = {}) {
  if (source.includes(MARKER)) {
    for (const [, after] of EDITS) uniqueAt(source, after);
  } else {
    if (source.includes('get("visibleBridgePort",17601)')) throw new Error("partial Next identity patch");
    for (const [before] of EDITS) uniqueAt(source, before);
    for (const [before, after] of EDITS) source = source.replace(before, () => after);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

// 精确逆操作，测试用来还原上一层封存字节。
function revertBundle(source) {
  for (const [, after] of EDITS) uniqueAt(source, after);
  for (const [before, after] of [...EDITS].reverse()) source = source.replace(after, () => before);
  return fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, revertBundle, MARKER, ANCHORS, EDITS };
