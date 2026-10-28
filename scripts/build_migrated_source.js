"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const reference = require("./build_reference_source");
const migration = require("../src/migrations/terminal-preview");
const root = path.resolve(__dirname, "..");
const destination = path.join(root, "out/migrated-source");

async function main() {
  assert.equal(process.argv.length, 2, "Usage: node scripts/build_migrated_source.js");
  const upstream = reference.verifySource();
  const maintained = reference.snapshot(path.join(root, "dist"));
  const sourceFiles = ["src/shared-session/manual-graph-preview.js", "src/shared-session/platform-process.js",
    "src/shared-session/execution-lifecycle.js",
    "src/migrations/terminal-preview.js",
    "tests/source/terminal-preview-entry.js", "tests/source/test-terminal-preview.js",
    "tests/source/test-platform-command.js", "tests/source/test-execution-lifecycle.js",
    "scripts/build_migrated_source.js", "scripts/build_reference_source.js"];
  const sources = Object.fromEntries(sourceFiles.map(name => [name, reference.fingerprint(fs.readFileSync(path.join(root, name)))]));
  const options = { plugins: [migration.plugin()], contractEntry: "tests/source/terminal-preview-entry.js" };
  const first = await reference.compile(upstream, options);
  const second = await reference.compile(upstream, options);
  assert.deepEqual(reference.describe(first), reference.describe(second), "Repeated migration builds differed");
  const control = await reference.compile(upstream, { contractEntry: options.contractEntry });
  first.set("upstream-terminal-contract.cjs", control.get("terminal-contract.cjs"));
  reference.verifySource();
  assert.deepEqual(reference.snapshot(path.join(root, "dist")), maintained, "Maintained runtime changed");
  for (const [relative, identity] of Object.entries(sources)) {
    assert.deepEqual(reference.fingerprint(fs.readFileSync(path.join(root, relative))), identity, "Migration source changed during build");
  }
  const result = {
    schema: "source-migration-build/1", verdict: "PASS_BUILD_PENDING_BEHAVIOR",
    upstreamCommit: upstream.commit, sources,
    toolchain: { node: process.version, esbuild: esbuild.version,
      packageLockSha256: reference.sha256(fs.readFileSync(path.join(root, "package-lock.json"))) },
    repeatedBuildIdentical: true, maintainedRuntimeUnchanged: true,
    migratedBehavior: ["explicit Terminal-to-Graphs callback", "saved-image preview policy", "artifact container after clear/restore",
      "Windows MCP command probes use shell-free real executables and explicit cmd/bat shim fallback",
      "selection and .do-file execution publish source lifecycle state with run ownership and terminal release"],
    outputs: reference.describe(first),
    scope: "Source migration stage 2: Terminal preview, platform-process adapter, and execution lifecycle boundary; bridge HTTP routes, checkpoint/finalizer parity, and licensed/native acceptance remain pending; not the VSIX runtime",
  };
  for (const [relative, data] of first) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  fs.writeFileSync(path.join(destination, "BUILD-MANIFEST.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, sources: Object.keys(sources), outputs: Object.keys(result.outputs) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
