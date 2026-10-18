#!/usr/bin/env node
"use strict";
// Verify the real VSIX runtime entry without loading VS Code or starting Stata.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const yauzl = require("yauzl");
const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const vsix = process.argv[2] || path.join(root, `${pkg.name}-${pkg.version}.vsix`);
assert.ok(path.isAbsolute(vsix), "Pass one absolute VSIX path");
async function extractScripts(destination) {
  await new Promise((resolve, reject) => {
    yauzl.open(vsix, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on("error", reject);
      zip.on("entry", entry => {
        const name = entry.fileName;
        if (!name.startsWith("extension/scripts/") || name.endsWith("/")) return zip.readEntry();
        assert.ok(!name.includes("\\") && !name.split("/").includes(".."), "Invalid member path");
        const output = path.join(destination, name);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", chunk => chunks.push(chunk));
          stream.on("end", () => { fs.writeFileSync(output, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on("end", resolve);
      zip.readEntry();
    });
  });
}
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "stata-vsix-runtime-"));
  try {
    await extractScripts(temporary);
    const entry = path.join(temporary, "extension/scripts/mcp_stata_runtime_patch.js");
    const probe = "const p=require(" + JSON.stringify(entry) +
      ");if(typeof p.patchRuntime!=='function')throw Error('runtime entry missing');process.stdout.write('RUNTIME_REQUIRE_OK');";
    assert.equal(cp.execFileSync(process.execPath, ["-e", probe], {
      cwd: temporary, encoding: "utf8", stdio: "pipe", env: { ...process.env, NODE_PATH: "" },
    }), "RUNTIME_REQUIRE_OK");
    // Negative control: missing runtime data must make the exact entry fail.
    fs.unlinkSync(path.join(temporary, "extension/scripts/runtime/stata_bulk_cache.original.json"));
    assert.throws(() => cp.execFileSync(process.execPath, ["-e", probe], {
      cwd: temporary, encoding: "utf8", stdio: "pipe", env: { ...process.env, NODE_PATH: "" },
    }), error => /MODULE_NOT_FOUND/.test(String(error.stderr)));
    console.log(JSON.stringify({ verdict: "PASS", actualVsix: vsix,
      actualRuntimeRequire: true, missingResourceNegativeControl: true, nativeVerified: false }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
