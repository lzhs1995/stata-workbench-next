#!/usr/bin/env node
"use strict";

// 按当前文件重算 release/runtime-manifest.json 的 version、sha256、bytes。
// 只更新清单里已登记的文件；--add <相对路径> 可登记新文件（可重复）。
// 不改 acceptanceStatus、baselineManifest 等其他字段。默认只打印差异，--write 才写。
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "release", "runtime-manifest.json");

function main(argv) {
  const write = argv.includes("--write");
  const add = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--add") add.push(argv[++i]);
    else if (argv[i] !== "--write") throw new Error("unknown argument " + argv[i]);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const changes = [];
  if (manifest.version !== version) changes.push(`version ${manifest.version} -> ${version}`);
  manifest.version = version;
  for (const rel of add) {
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) throw new Error("bad --add path " + rel);
    if (!manifest.files[rel]) { manifest.files[rel] = { sha256: "", bytes: 0 }; changes.push("add " + rel); }
  }
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const data = fs.readFileSync(path.join(root, rel));
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    if (entry.sha256 !== sha256 || entry.bytes !== data.length) {
      changes.push(`${rel} ${entry.sha256.slice(0, 12) || "-"} -> ${sha256.slice(0, 12)}`);
      entry.sha256 = sha256; entry.bytes = data.length;
    }
  }
  for (const c of changes) console.log(c);
  if (write && changes.length) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ changes: changes.length, written: write && changes.length > 0 }));
}

main(process.argv.slice(2));
