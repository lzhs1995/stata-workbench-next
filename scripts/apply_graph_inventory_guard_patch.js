#!/usr/bin/env node
"use strict";

// Offline maintained-bundle patch; never installs or connects to Stata.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const fingerprint = require("./finalize_bundle_identity");
const MARKER = "codex patch: graph inventory waits for guard and preserves local returns";
const START = "async function __codexCaptureGraphInventory(cwd) {";
const END = "async function __codexBeginGraphRun(";
// Includes both separator newlines before the following declaration.
const ORIGINAL_SHA = "5a41aa3d293525907ec87f284e4662fe0c9fc13e8665b852c6c946866df4ed68";
const BRIDGE_BEGIN = 'if(__run&&globalThis.__codexBeginGraphRun)await __codexBeginGraphRun(__run,"visible-bridge",__cwd,!!(__codexPreparedBridgeRun&&__codexPreparedBridgeRun.captureBaseline));';
const SNAPSHOT_START = "let __codexBridgePreRunSnapshot=null;try{";
const OLD_CATCH = `  } catch (error) {
    __codexGraphMark({
      lastClientError: "graph run begin failed: " + String(error?.message || error),
      lastBatchSource: "graph-run-begin-error"
    });
    __codexSetPostRunBusy(false, "graph-run-begin-error", runId);
    __codexGraphLog("graph run begin failed: " + String(error?.message || error));
    return [];
  }
}
globalThis.__codexBeginGraphRun = __codexBeginGraphRun;`;
const NEW_CATCH = `  } catch (error) {
    // Release only JS/UI bookkeeping; retain Stata and cancellation evidence.
    try { if (error?.__codexPreRunTimeout) error.__codexPreRunTimeout.payloadDispatched = false; } catch {}
    try { __codexGraphMark({lastClientError: "graph run begin failed: " + String(error?.message || error), lastBatchSource: "graph-run-begin-error"}); } catch {}
    try { __codexFinishGraphRunNoExport(runId, "graph-run-begin-error"); } catch {}
    try { __codexSetPostRunBusy(false, "graph-run-begin-error", runId); } catch {}
    try { __codexGraphLog("graph run begin failed: " + String(error?.message || error)); } catch {}
    throw error;
  }
}
globalThis.__codexBeginGraphRun = __codexBeginGraphRun;`;

function uniqueAt(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + needle.length) >= 0) {
    throw new Error("missing or ambiguous graph inventory anchor");
  }
  return at;
}

// Keep this function self-contained: the maintained bundle supplies its globals.
async function __codexCaptureGraphInventory(cwd) {
  /* codex patch: graph inventory waits for guard and preserves local returns */
  /* codex patch rc.7: graph inventory probes are quiet */
  const probeRunId = "graph-inventory-" + require("node:crypto").randomUUID();
  const inventoryRoot = rg.join(require("os").tmpdir(), "codex-" + probeRunId);
  JA.mkdirSync(inventoryRoot, { recursive: true });
  const manifestPath = rg.join(inventoryRoot, "inventory.tsv");
  const stataPath = manifestPath.replace(/\\/g, "/");
  if (/["\r\n`$]/.test(stataPath)) throw new Error("unsafe graph inventory path");
  const probeCode = [
    "nobreak {",
    "tempname __codex_gi_r __codex_gi_fh",
    "local __codex_gi_open = 0",
    "_return hold `__codex_gi_r'",
    "capture noisily break {",
    "    quietly graph dir, memory",
    "    local __codex_gi_list \"`r(list)'\"",
    '    file open `__codex_gi_fh\' using "' + stataPath + '", write text replace',
    "    local __codex_gi_open = 1",
    "    local __codex_gi_i = 0",
    "    foreach __codex_gi_name of local __codex_gi_list {",
    "        local ++__codex_gi_i",
    "        quietly graph describe `__codex_gi_name'",
    "        local __codex_gi_sig \"`r(command_date)' `r(command_time)' `r(name)'\"",
    "        file write `__codex_gi_fh' \"`__codex_gi_i'\" _tab \"`__codex_gi_name'\" _tab \"`__codex_gi_sig'\" _n",
    "    }",
    "}",
    "local __codex_gi_rc = _rc",
    "local __codex_gi_close_rc = 0",
    "if `__codex_gi_open' {",
    "    capture file close `__codex_gi_fh'",
    "    local __codex_gi_close_rc = _rc",
    "}",
    "capture _return restore `__codex_gi_r'",
    "local __codex_gi_restore_rc = _rc",
    "}",
    "if `__codex_gi_rc' | `__codex_gi_close_rc' | `__codex_gi_restore_rc' {",
    "    display as error \"graph inventory: body=`__codex_gi_rc' close=`__codex_gi_close_rc' restore=`__codex_gi_restore_rc'\"",
    "}",
    "if `__codex_gi_restore_rc' != 0 exit `__codex_gi_restore_rc'",
    "if `__codex_gi_rc' != 0 exit `__codex_gi_rc'",
    "if `__codex_gi_close_rc' != 0 exit `__codex_gi_close_rc'",
    "",
  ].join("\n");
  try {
    // Await the guard itself, including its cancellation and drain deadline.
    const result = await __codexGuardWrap(globalThis.__codexExecGuardRef.POLICY.SHORT_INTERNAL,probeRunId,()=>zg.runSelection(probeCode, {
      runId: probeRunId,
      normalizeResult: true,
      includeGraphs: false,
      cwd: cwd || undefined
    }),{sourceMode:"internal",timeoutMs:30000});
    if (!result || result.success === false || result.error || result.raw?.error || Number(result.rc || 0) !== 0) {
      throw Object.assign(new Error("graph inventory Stata execution failed"), { result });
    }
    // A missing/partial manifest is an error, not an empty graph baseline.
    const text = JA.readFileSync(manifestPath, "utf8");
    if (text && !text.endsWith("\n")) throw new Error("incomplete graph inventory manifest");
    const seen = new Set();
    return (text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : []).map((line, index) => {
      const parts = line.split("\t");
      const sequence = Number(parts[0]);
      const graphName = parts[1];
      if (parts.length < 3 || sequence !== index + 1 || !graphName || seen.has(graphName)) {
        throw new Error("invalid graph inventory manifest");
      }
      seen.add(graphName);
      return { sequence, graphName, signature: parts.slice(2).join("\t") };
    });
  } catch (error) {
    // Do not replace the guard's structured 503/504 envelope or its error.
    try { error.__codexGraphInventory = { runId: probeRunId, manifestPath }; } catch {}
    try { __codexGraphLog("graph inventory failed: " + String(error?.message || error)); } catch {}
    throw error;
  }
}
const REPLACEMENT = __codexCaptureGraphInventory.toString() + "\n\n";

function patchBundle(source, options = {}) {
  const start = uniqueAt(source, START);
  const end = uniqueAt(source, END);
  if (end <= start) throw new Error("invalid graph inventory anchor order");
  const block = source.slice(start, end);
  if (source.includes(MARKER)) {
    uniqueAt(source, MARKER);
    if (block !== REPLACEMENT) throw new Error("modified graph inventory patch");
    uniqueAt(source, NEW_CATCH);
    uniqueAt(source, SNAPSHOT_START + BRIDGE_BEGIN);
    uniqueAt(source, BRIDGE_BEGIN);
    if (source.includes(OLD_CATCH)) throw new Error("mixed graph inventory patch");
  } else {
    if (crypto.createHash("sha256").update(block).digest("hex") !== ORIGINAL_SHA) {
      throw new Error("unrecognized graph inventory source hash");
    }
    uniqueAt(source, OLD_CATCH);
    uniqueAt(source, BRIDGE_BEGIN + SNAPSHOT_START);
    source = source.slice(0, start) + REPLACEMENT + source.slice(end);
    source = source.replace(OLD_CATCH, NEW_CATCH)
      .replace(BRIDGE_BEGIN + SNAPSHOT_START, SNAPSHOT_START + BRIDGE_BEGIN);
  }
  return options.finalize === false ? source : fingerprint.finalize(source).text;
}

if (require.main === module) {
  const target = path.join(__dirname, "..", "dist", "extension.js");
  const before = fs.readFileSync(target, "utf8");
  const after = patchBundle(before);
  if (after !== before) fs.writeFileSync(target, after);
  console.log(JSON.stringify({ changed: before !== after, target, installed: false }));
}

module.exports = { patchBundle, MARKER, START, END };
