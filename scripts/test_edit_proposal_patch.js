"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const patch = require("./apply_edit_proposal_patch");
const authPatch = require("./apply_next_bridge_auth_patch");
const authCore = require("./next_bridge_auth_core");
const editCore = require("./edit_proposal_core");
const fingerprint = require("./finalize_bundle_identity");
const http = require("node:http");
const root = path.join(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");

const sealed = patch.patchBundle(bundle, { finalize: false });
assert.equal(patch.patchBundle(sealed, { finalize: false }), sealed, "patch is idempotent");
assert.ok(sealed.includes(patch.MARKER));
assert.ok(sealed.includes("/propose-edit"));
assert.ok(sealed.includes("edit_proposal_core.js"));
assert.ok(sealed.includes("__codexNextSessionRef"));
assert.ok(sealed.includes("FHg().Uri.file(__record.path)"), "review uses the unwrapped vscode Uri binding");
assert.equal(sealed.includes("iA.Uri.file(__record.path)"), false, "wrapped vscode module is not used for Uri construction");
assert.equal(sealed.includes("YQ.Uri.file(__record.path)"), false, "cross-module vscode binding is not used");

function extractReview(source) {
  const start = source.indexOf("globalThis.__codexReviewEdit=");
  const end = source.indexOf("};let __acquire", start) + 2;
  assert.ok(start >= 0 && end > start, "review function is present in the executable bundle");
  return source.slice(start, end);
}
async function executeReview(source, iAOverride = null) {
  const file = path.join(reviewTmp, "review.do");
  fs.writeFileSync(file, "display 1\n");
  const vscode = {
    Uri: { file: (value) => ({ fsPath: value }) },
    workspace: { openTextDocument: async (uri) => ({ uri }) },
    commands: { executeCommand: async () => {} },
    window: { showInformationMessage: async () => "Accept" },
  };
  const context = { globalThis: {}, FHg: () => vscode, iA: iAOverride || vscode, require };
  vm.runInNewContext(extractReview(source), context);
  return context.globalThis.__codexReviewEdit({ id: "exec", path: file, agentName: "test" }, "display 2\n");
}
const reviewTmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "wb-edit-review-"));
executeReview(sealed).then((result) => {
  assert.equal(result.status, "accepted", "the review function executes with the real vscode module shape");
  return executeReview(sealed.replaceAll("FHg().Uri.file", "YQ.Uri.file")).then(
    () => assert.fail("broken cross-module binding unexpectedly executed"),
    (error) => assert.match(String(error), /YQ is not defined/)
  ).then(() => executeReview(sealed.replaceAll("FHg().Uri.file", "iA.Uri.file"), {
    Uri: function Uri() {},
    workspace: { openTextDocument: async (uri) => ({ uri }) },
    commands: { executeCommand: async () => {} },
    window: { showInformationMessage: async () => "Accept" },
  })).then(
    () => assert.fail("wrapped Uri binding unexpectedly executed"),
    (error) => assert.match(String(error), /iA\.Uri\.file is not a function/)
  );
}).catch((error) => { console.error(error); process.exitCode = 1; });
assert.equal(sealed.includes("eventLogPath"), false);
assert.equal(fingerprint.finalize(sealed).text.includes(patch.MARKER), true);
const sendAnchor = 'let __send=(o,s,n)=>{o.writeHead(s,{"content-type":"application/json"}),o.end(JSON.stringify(n))};';
if (!bundle.includes(patch.MARKER)) assert.throws(() => patch.patchBundle(bundle.replace(sendAnchor, "")), /anchor/);

// The real C request gate must run before E's route: refused requests must not
// reach the diff callback or create a snapshot/write the .do file.
const gateText = authPatch.EDITS[2][1];
const gateOnly = gateText.slice(gateText.indexOf("let __nextAuth="));
const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "wb-edit-auth-"));
const sourcePath = path.join(tmp, "probe.do");
const original = "display \"before\"\n";
fs.writeFileSync(sourcePath, original);
const auth = authCore.createAuth({ stateRoot: tmp, sessionId: "edit-auth" });
globalThis.__codexNextAuthRef = auth;
let diffOpened = 0;
const editGate = editCore.createEditGate({ snapshotRoot: path.join(tmp, "snapshots") });
const server = http.createServer((req, res) => {
  const send = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const runGate = new Function("globalThis", "__req", "__res", "__send", "__routed", gateOnly + ";__routed()");
  runGate(globalThis, req, res, send, async () => {
    if (req.method !== "POST" || req.url !== "/propose-edit") return send(res, 404, {});
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      diffOpened++;
      const result = await editGate.propose(JSON.parse(body), async () => ({ status: "rejected", reasonCode: "USER_REJECTED" }));
      send(res, 200, { ok: false, proposal: result });
    });
  });
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  auth.publish({ port, extensionHostPid: process.pid });
  const token = JSON.parse(fs.readFileSync(auth.recordPath, "utf8")).token;
  const request = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/propose-edit", method: "POST", headers }, (response) => {
      let data = ""; response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(JSON.stringify({ path: sourcePath, content: "display \\\"after\\\"\\n", expectedSha256: editCore.sha256(Buffer.from(original)), timeoutMs: 1000 }));
    req.end();
  });
  const before = fs.readFileSync(sourcePath, "utf8");
  const noToken = await request({ host: `127.0.0.1:${port}`, "content-type": "application/json" });
  assert.equal(noToken.status, 401, "missing token -> 401");
  assert.equal(diffOpened, 0, "missing token does not open diff");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before, "missing token does not write file");
  const withOrigin = await request({ host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, origin: "https://evil", "content-type": "application/json" });
  assert.equal(withOrigin.status, 403, "Origin -> 403");
  assert.equal(diffOpened, 0, "Origin does not open diff");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before, "Origin does not write file");
  auth.remove();
  server.close();
  console.log("PASS edit proposal patch: source anchors, C auth gate, route, marker, and fail-closed behavior");
})().catch((error) => { try { auth.remove(); server.close(); } catch {} throw error; });
