"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEditGate, sha256 } = require("./edit_proposal_core");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stata-next-edit-gate-"));
const file = path.join(root, "analysis.do");
const snapshots = path.join(root, "snapshots");
const eventRecords = [];
fs.writeFileSync(file, "display \"before\"\n", "utf8");
const original = fs.readFileSync(file);
const gate = createEditGate({ snapshotRoot: snapshots, onEvent: event => eventRecords.push(event), now: () => new Date("2026-10-31T13:00:00.000Z") });

async function run() {
  const mismatch = await gate.propose({ path: file, content: "display \"bad\"\n", expectedSha256: "0".repeat(64) }, async () => ({ status: "accepted" }));
  assert.equal(mismatch.reasonCode, "SHA_MISMATCH");
  assert.deepEqual(fs.readFileSync(file), original);

  const rejected = await gate.propose({ path: file, content: "display \"rejected\"\n", expectedSha256: sha256(original) }, async () => ({ status: "rejected" }));
  assert.equal(rejected.reasonCode, "USER_REJECTED");
  assert.deepEqual(fs.readFileSync(file), original);

  const timedOut = await gate.propose({ path: file, content: "display \"timeout\"\n", expectedSha256: sha256(original), timeoutMs: 10 }, () => new Promise(() => {}));
  assert.equal(timedOut.reasonCode, "DECISION_TIMEOUT");
  assert.deepEqual(fs.readFileSync(file), original);

  const accepted = await gate.propose({ path: file, content: "display \"accepted\"\n", expectedSha256: sha256(original) }, async () => ({ status: "accepted" }));
  assert.equal(accepted.status, "accepted");
  assert.equal(fs.readFileSync(file, "utf8"), "display \"accepted\"\n");
  assert.deepEqual(fs.readFileSync(accepted.snapshotPath), original);

  fs.writeFileSync(file, "display \"changed\"\n", "utf8");
  const race = await gate.propose({ path: file, content: "display \"race\"\n", expectedSha256: sha256(Buffer.from("display \"changed\"\n")) }, async record => {
    fs.writeFileSync(file, "display \"human edit\"\n", "utf8");
    return { status: "accepted" };
  });
  assert.equal(race.reasonCode, "SHA_CHANGED_DURING_REVIEW");
  assert.equal(fs.readFileSync(file, "utf8"), "display \"human edit\"\n");
  const eventTypes = eventRecords.map(event => event.type);
  assert.deepEqual(eventTypes, [
    "edit_proposal_rejected", "edit_proposal_pending", "edit_proposal_rejected",
    "edit_proposal_pending", "edit_proposal_timeout", "edit_proposal_pending",
    "edit_proposal_accepted", "edit_proposal_pending", "edit_proposal_rejected",
  ]);
  console.log("PASS edit proposal core: mismatch, reject, timeout, accept+snapshot, and concurrent SHA change");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
