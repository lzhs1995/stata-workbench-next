"use strict";

// A migration reference only. Never replaces the maintained dist/ runtime.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "upstream/stata-workbench");
const destination = path.join(root, "out/reference-source");
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const fingerprint = data => ({ bytes: data.length, sha256: sha256(data) });

function filesUnder(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error("Symlink not allowed: " + relative);
    if (entry.isDirectory()) return filesUnder(path.join(directory, entry.name), relative + "/");
    if (!entry.isFile()) throw new Error("Not a regular file: " + relative);
    return [relative];
  }).sort();
}

function snapshot(directory) {
  return Object.fromEntries(filesUnder(directory).map(relative =>
    [relative, fingerprint(fs.readFileSync(path.join(directory, relative)))]));
}

function verifySource() {
  const manifestPath = path.join(root, "upstream/SOURCE-MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, "upstream-source/1");
  assert.deepEqual(filesUnder(source), Object.keys(manifest.files).sort(), "Reference source inventory changed");
  for (const [relative, expected] of Object.entries(manifest.files)) {
    assert.deepEqual(fingerprint(fs.readFileSync(path.join(source, relative))), expected,
      "Reference source hash mismatch: " + relative);
  }
  return { ...manifest, manifestSha256: sha256(fs.readFileSync(manifestPath)) };
}

async function compile(manifest) {
  // No upload plugins, network calls, environment-selected release or watch mode.
  // Build to memory so verification cannot overwrite either source tree.
  const common = {
    absWorkingDir: root, bundle: true, minify: true, write: false,
    sourcemap: false, legalComments: "eof", logLevel: "silent", metafile: true,
    define: { "process.env.SENTRY_RELEASE": JSON.stringify("reference-" + manifest.commit) },
  };
  const builds = await Promise.all([
    esbuild.build({ ...common,
      entryPoints: ["upstream/stata-workbench/src/extension.js"],
      format: "cjs", platform: "node", target: "node22", external: ["vscode"],
      outfile: "out/reference-source/dist/extension.js", loader: { ".node": "file" },
      assetNames: "[name]",
    }),
    esbuild.build({ ...common, entryPoints: {
      main: "upstream/stata-workbench/src/ui-shared/main.js",
      "data-browser": "upstream/stata-workbench/src/ui-shared/data-browser.js",
    }, format: "iife", platform: "browser", target: "chrome128",
    outdir: "out/reference-source/dist/ui-shared",
    }),
  ]);
  const outputs = new Map();
  for (const build of builds) {
    for (const output of build.outputFiles) {
      const relative = path.relative(destination, output.path).split(path.sep).join("/");
      assert(relative && !relative.startsWith("../") && !path.isAbsolute(relative));
      assert(!outputs.has(relative), "Duplicate output " + relative);
      outputs.set(relative, Buffer.from(output.contents));
    }
    for (const input of Object.keys(build.metafile.inputs)) {
      assert(!input.startsWith("dist/"), "Reference build must not consume maintained dist");
    }
  }
  // Assets used by the original source, kept byte-for-byte. This is not a VSIX.
  for (const relative of Object.keys(manifest.files)) {
    if (relative.startsWith("src/ui-shared/") && !["src/ui-shared/main.js", "src/ui-shared/data-browser.js"].includes(relative)) {
      outputs.set(relative.replace(/^src\//, "dist/"), fs.readFileSync(path.join(source, relative)));
    } else if (relative.startsWith("src/grammars/") || relative === "src/language_config.json" || relative === "LICENSE") {
      outputs.set(relative, fs.readFileSync(path.join(source, relative)));
    }
  }
  return outputs;
}

const describe = outputs => Object.fromEntries([...outputs].sort(([a], [b]) => a.localeCompare(b))
  .map(([relative, data]) => [relative, fingerprint(data)]));

async function main() {
  assert(process.argv.length === 2, "Usage: node scripts/build_reference_source.js");
  const manifest = verifySource();
  const maintainedBefore = snapshot(path.join(root, "dist"));
  const first = await compile(manifest);
  const second = await compile(manifest);
  assert.deepEqual(describe(first), describe(second), "Two source builds differed");
  verifySource();
  assert.deepEqual(snapshot(path.join(root, "dist")), maintainedBefore, "Maintained runtime changed");
  const result = {
    schema: "reference-source-build/1", verdict: "PASS_REFERENCE_BUILD",
    upstream: { repository: manifest.repository, commit: manifest.commit, version: manifest.version,
      manifestSha256: manifest.manifestSha256, fileCount: Object.keys(manifest.files).length },
    toolchain: { node: process.version, esbuild: esbuild.version,
      packageLockSha256: sha256(fs.readFileSync(path.join(root, "package-lock.json"))),
      buildScriptSha256: sha256(fs.readFileSync(__filename)) },
    repeatedBuildIdentical: true, maintainedRuntimeUnchanged: true,
    outputs: describe(first),
    scope: "Pinned upstream reference only; local feature parity, runtime execution and release acceptance are not certified",
  };
  for (const [relative, data] of first) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  fs.writeFileSync(path.join(destination, "BUILD-MANIFEST.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, outputs: Object.keys(result.outputs), manifest: "out/reference-source/BUILD-MANIFEST.json" }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
