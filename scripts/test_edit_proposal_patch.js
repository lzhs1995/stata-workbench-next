"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const patch = require("./apply_edit_proposal_patch");
const fingerprint = require("./finalize_bundle_identity");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");

const sealed = patch.patchBundle(bundle, { finalize: false });
assert.equal(patch.patchBundle(sealed, { finalize: false }), sealed, "patch is idempotent");
assert.ok(sealed.includes(patch.MARKER));
assert.ok(sealed.includes("/propose-edit"));
assert.ok(sealed.includes("edit_proposal_core.js"));
assert.ok(sealed.includes("__codexNextSessionRef"));
assert.equal(sealed.includes("eventLogPath"), false);
assert.equal(fingerprint.finalize(sealed).text.includes(patch.MARKER), true);
const sendAnchor = 'let __send=(o,s,n)=>{o.writeHead(s,{"content-type":"application/json"}),o.end(JSON.stringify(n))};';
if (!bundle.includes(patch.MARKER)) assert.throws(() => patch.patchBundle(bundle.replace(sendAnchor, "")), /anchor/);
console.log("PASS edit proposal patch: source anchors, route, marker, and fail-closed behavior");
