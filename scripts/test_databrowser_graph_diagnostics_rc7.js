#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
const sourceDataBrowser = fs.readFileSync(path.join(__dirname, "..", "src", "ui-shared", "data-browser.js"), "utf8");
const distDataBrowser = fs.readFileSync(path.join(__dirname, "..", "dist", "ui-shared", "data-browser.js"), "utf8");

assert.ok(extension.includes("codex patch rc.7: Data Browser observable readiness"));
assert.ok(extension.includes("codex patch rc.7: debug Data Browser readiness"));
assert.ok(extension.includes("codex patch rc.7: mcp-stata Data Browser listener-loop patch"));
// Activation now forwards the configured environment and explicit runtime root.
// Its execution and refusal behavior are covered by test_activation_isolation.js.
assert.ok(extension.includes("__runtimePatcher.runtimeOptionsFromConfig(E,uM())"));
assert.ok(extension.includes("__runtimePatcher.patchRuntime(__runtimeOptions)"));
assert.ok(extension.includes("codex patch rc.7.10.27: patch live uvx runtime"));
assert.ok(extension.includes("codex patch rc.7.10.11: Data Browser channel recovery"));
assert.ok(extension.includes("codex patch rc.7.10.12: exact Data Browser readiness"));
assert.ok(extension.includes("codex patch rc.7.10.13: fresh Data Browser command completion"));
assert.ok(extension.includes("codex patch rc.7.10.14: Data Browser variable integrity"));
assert.ok(extension.includes("codex patch rc.7.40: post-run summary uses cached Data Browser credentials"));
assert.ok(extension.includes("mcp_stata_runtime_patch.js"));
assert.ok(extension.includes("dataBrowser:globalThis.__codexDataBrowserStatus||null"));
assert.ok(extension.includes("lastArrowBytes"));
assert.ok(extension.includes("rowCount"));
assert.ok(extension.includes("datasetK"));
assert.ok(extension.includes("variableCount"));
assert.ok(extension.includes("selectedVariableCount"));
assert.ok(extension.includes("selectedVariables"));
assert.ok(extension.includes("await g.currentPanel._fetchCredentials()"));
assert.ok(extension.includes("this._credentialRecoveryAttempts<2"));
assert.ok(extension.includes('recoveryMaxAttempts:2'));
assert.ok(extension.includes('__sameCredentials?{type:"refresh"}:{type:"init"'));
assert.ok(extension.includes("this._credentialRecoveryAttempts=0"));
assert.ok(extension.includes("__dbStatus.rowCount!==null&&__dbStatus.rowCount!==undefined"));
assert.ok(extension.includes("__dbStatus.lastArrowBytes!==null&&__dbStatus.lastArrowBytes!==undefined"));
assert.ok(extension.includes("return await GD.createOrShow(Qn)"));
assert.ok(extension.includes("let __dbRefreshBefore=Number(globalThis.__codexDataBrowserStatus?.credentialRefreshes||0)"));
assert.ok(extension.includes("Number(__dbStatus.credentialRefreshes||0)>__dbRefreshBefore"));
assert.ok(extension.includes("Number(__dbStatus.variableCount)>0"));
assert.ok(extension.includes("Number(__dbStatus.selectedVariableCount)>0"));
const summaryStart = extension.indexOf("async function qF(){");
const summaryEnd = extension.indexOf("async function OHg(){", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
const summaryBody = extension.slice(summaryStart, summaryEnd);
assert.ok(summaryBody.includes("GD.currentPanel&&GD.currentPanel._credentials"));
assert.ok(summaryBody.includes("if(!g||!g.baseUrl||!g.token)return"));
assert.strictEqual(summaryBody.includes("zg.getUiChannel()"), false);
assert.strictEqual(
  extension.includes("credentialsReady&&Number.isFinite(Number(__dbStatus.rowCount))"),
  false,
  "null rowCount must not satisfy Data Browser readiness"
);
assert.ok(sourceDataBrowser.includes("getVariablesFromResponse(response)"));
assert.ok(distDataBrowser.includes("getVariablesFromResponse(response)"));
assert.strictEqual(sourceDataBrowser.includes("response.vars || []"), false);
assert.strictEqual(distDataBrowser.includes("response.vars || []"), false);
assert.ok(extension.includes("codex patch rc.7: routed and loaded graph paths are distinct"));
assert.ok(extension.includes("codex patch rc.7.10.29: internal graph probes are quiet"));
assert.strictEqual(extension.includes('"  capture graph describe",'), false);
assert.strictEqual(extension.includes('"  capture graph dir, memory",'), false);
assert.strictEqual(extension.includes("'  capture graph dir, memory',"), false);
assert.strictEqual(extension.includes('"    capture graph display `__codex_graph_name\'",'), false);
assert.strictEqual(extension.includes('"    capture graph export \\"`__codex_graph_export\'\\", as(svg) replace",'), false);
assert.strictEqual(extension.includes('match[1] + "capture graph display " + graphName'), false);
assert.strictEqual(extension.includes('exportLines.push(`  capture graph export "${exportPath}", as(svg) replace`)'), false);
assert.strictEqual(
  extension.includes("lastArtifactPath: message?.path || (globalThis.__codexGraphPanelDiag?.lastArtifactPath || null)"),
  false,
  "image load ACKs must not overwrite the last routed artifact path"
);

console.log("DATABROWSER_GRAPH_DIAGNOSTICS_RC7_PASS");
