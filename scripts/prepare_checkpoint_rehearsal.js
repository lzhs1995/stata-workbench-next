"use strict";

// Offline code generation only. This module has no Stata/HTTP/process launcher.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const checkpoint = require("./stop_checkpoint_core");

const CORE = path.join(__dirname, "stop_checkpoint_core.js");
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const LIMITATIONS = [
  "No native execution or complete-session backup/restore has been verified.",
  "Restore covers the current dataset, selected globals, registered estimates and named graphs only.",
  "Active unnamed e()/e(sample), r()/s(), other frames, Mata objects/functions/handles, preserve stack, RNG and settings are not a complete restore contract.",
  "Zero-variable data with observations or dataset metadata requires native regression before use.",
  "HTTP preprocessing, pagination, cancellation and backend reset require separate end-to-end validation.",
];

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileRecord(file, minBytes = 0) {
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size >= minBytes,
    `Missing, linked or invalid artifact: ${file}`);
  const bytes = fs.readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
}

function safeDirectory(directory) {
  requireValue(typeof directory === "string" && path.isAbsolute(directory), "Absolute directory required");
  const resolved = path.resolve(directory);
  requireValue(!/[\x00-\x1f\x7f"`$]/.test(resolved), "Directory cannot contain Stata source metacharacters");
  requireValue(!fs.existsSync(resolved), "Output already exists; preserve the original attempt");
  requireValue(fs.realpathSync(path.dirname(resolved)) === path.dirname(resolved),
    "Output parent must exist and use its canonical path");
  return resolved;
}

function writeNew(file, value) {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function prepare(directory) {
  const output = safeDirectory(directory);
  const snapshot = { path: path.join(output, "snapshot.dta"), sourceMode: "offline-rehearsal" };
  fs.mkdirSync(output);
  checkpoint.initializeCheckpoint(snapshot);
  const sources = {
    "snapshot-candidate.do": checkpoint.snapshotCode(snapshot),
    "checkpoint-candidate.do": checkpoint.checkpointCode(snapshot),
    "atomic-candidate.do": checkpoint.atomicCheckpointCode(snapshot),
  };
  const files = {};
  for (const [name, body] of Object.entries(sources)) {
    writeNew(path.join(output, name), body);
    files[name] = fileRecord(path.join(output, name));
  }
  const manifest = {
    schema: "checkpoint-rehearsal-v1",
    evidenceKind: "GENERATED_NOT_EXECUTED",
    nativeExecutionVerified: false,
    completeSessionRestoreVerified: false,
    generatedAt: new Date().toISOString(),
    core: fileRecord(CORE),
    generator: fileRecord(__filename),
    snapshot,
    files,
    limitations: LIMITATIONS,
    next: "Review the native regression plan. Execute only after the existing session has an independently verified backup and safe entry. Render restore only after real snapshot/checkpoint artifacts exist.",
  };
  writeNew(path.join(output, "PLAN.json"), manifest);
  return manifest;
}

function strictNames(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  requireValue(Buffer.from(text).equals(bytes), `Invalid UTF-8: ${file}`);
  const names = text.split(/\r?\n/);
  if (names[names.length - 1] === "") names.pop();
  requireValue(names.every((name) => NAME.test(name)) && new Set(names).size === names.length,
    `Invalid or duplicate artifact name: ${file}`);
  return names;
}

function renderRestore(planFile, directory) {
  const output = safeDirectory(directory);
  const planPath = fs.realpathSync(planFile);
  const base = path.dirname(planPath);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  requireValue(plan.schema === "checkpoint-rehearsal-v1" &&
    plan.core?.sha256 === fileRecord(CORE).sha256 && plan.generator?.sha256 === fileRecord(__filename).sha256,
  "Generator/core changed; create a new rehearsal instead of mixing generations");
  requireValue(plan.snapshot?.path === path.join(base, "snapshot.dta") &&
    plan.snapshot?.stateDir === path.join(base, "snapshot.dta.state"), "Snapshot path does not belong to this plan");
  for (const name of ["snapshot-candidate.do", "checkpoint-candidate.do", "atomic-candidate.do"]) {
    requireValue(plan.files?.[name]?.sha256 === fileRecord(path.join(base, name)).sha256,
      `Generated source changed: ${name}`);
  }
  const snapshot = plan.snapshot;
  const paths = checkpoint.checkpointPaths(snapshot);
  requireValue(fs.realpathSync(paths.stateDir) === paths.stateDir, "Checkpoint state directory is linked");
  const ready = checkpoint.snapshotReadyRecord(snapshot);
  requireValue(ready, "Real snapshot.ready with the original nonce is required; no placeholder is generated");
  const inputs = [fileRecord(snapshot.path, 512), fileRecord(paths.snapshotReadyPath, 1)];
  for (const key of ["globalsPath", "estimatesPath", "graphsPath", "currentGraphPath", "defaultGraphObjectPath"]) {
    inputs.push(fileRecord(paths[key]));
  }
  const estimates = strictNames(paths.estimatesPath);
  const graphs = strictNames(paths.graphsPath);
  const current = fs.readFileSync(paths.currentGraphPath, "utf8").trim();
  requireValue(current === "" || (NAME.test(current) && graphs.includes(current)), "Current graph is absent from the graph inventory");
  for (const name of estimates) inputs.push(fileRecord(path.join(paths.stateDir, `estimate_${name}.ster`), 1));
  for (const name of graphs) inputs.push(fileRecord(path.join(paths.stateDir, `graph_${name}.gph`), 1));
  const code = checkpoint.restoreCode(snapshot);
  requireValue(code && code !== "exit 459\n", "Checkpoint artifacts failed restore generation validation");
  // Detect changes during generation; native provenance still needs independent
  // receipts and the same owned backend's lock before any actual execution.
  for (const item of inputs) requireValue(fileRecord(item.path).sha256 === item.sha256,
    `Artifact changed during generation: ${item.path}`);
  fs.mkdirSync(output);
  writeNew(path.join(output, "restore-candidate.do"), code);
  const report = {
    schema: "checkpoint-restore-candidate-v1",
    evidenceKind: "GENERATED_FROM_PRESENT_FILES_NOT_EXECUTED",
    nativeExecutionVerified: false,
    nativeArtifactProvenanceVerified: false,
    completeSessionRestoreVerified: false,
    generatedAt: new Date().toISOString(),
    plan: fileRecord(planPath),
    core: fileRecord(CORE),
    snapshotKind: ready.kind,
    inputs,
    output: fileRecord(path.join(output, "restore-candidate.do")),
    limitations: LIMITATIONS,
  };
  writeNew(path.join(output, "RESTORE-CANDIDATE.json"), report);
  return report;
}

if (require.main === module) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2);
    requireValue(extra.length === 0, "Unexpected arguments");
    let result;
    if (command === "prepare" && first && !second) result = prepare(first);
    else if (command === "restore" && first && second) result = renderRestore(first, second);
    else throw new Error("Usage: node scripts/prepare_checkpoint_rehearsal.js prepare /new/absolute/directory | restore /absolute/PLAN.json /new/absolute/directory");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepare, renderRestore };
