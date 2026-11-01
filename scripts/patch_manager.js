#!/usr/bin/env node
/**
 * Stata Workbench shared-session patch manager.
 *
 * This manager treats the current, verified extension.js as a full patch set:
 *   - visible HTTP bridge on 127.0.0.1:17601 (Next development line)
 *   - mcp-stata pinned to 1.26.1 with no --refresh/@latest
 *   - get_variable_list output noise filtered
 *   - terminal variable provider disabled
 *   - DataBrowser automatic refresh disabled
 *   - optional temp do-file selection patch for Stata /// continuation
 *   - Stata Terminal display-only clear before visible runs
 *   - Clear button no longer runs Stata "clear all"
 *   - visible bridge single-flight lock with GET /status and busy 409
 *   - force reset Stop button and HTTP /force-reset recovery path
 *   - V6 cleanup of orphan tmonk/mcp-stata helper processes
 *   - V7 separate Stata Graphs panel routing with Clear All
 *   - V7.1 graph panel feedback ACK layer with /graph-status
 *   - V8 bridge BUSY/IDLE status bar updater
 *   - V9 postRunBusy flag: IDLE = bridge free + no post-run cleanup + bridge healthy
 *
 * Commands:
 *   node patch_manager.js status
 *   node patch_manager.js verify
 *   node patch_manager.js apply
 *   node patch_manager.js revert
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const WORKSPACE = process.env.STATA_WORKBENCH_WORKSPACE || path.resolve(__dirname, "..");
const EXT_ROOT = path.join(os.homedir(), ".vscode", "extensions");
const EXTENSION_ID_PREFIX = "tmonk.stata-workbench-";
const MANIFEST = path.join(WORKSPACE, "stata_workbench_patch_manifest.json");
const PATCHED_BASELINE = path.join(WORKSPACE, "dist", "extension.js");
const BRIDGE_URL = { host: "127.0.0.1", port: 17601, path: "/status" };
const GRAPH_STATUS_URL = { host: "127.0.0.1", port: 17601, path: "/graph-status" };
const CLI_ARGS = process.argv.slice(2);
const TARGET_REPO = CLI_ARGS.includes("--target=repo") ||
  CLI_ARGS.some((arg, index) => arg === "--target" && CLI_ARGS[index + 1] === "repo");

const REQUIRED_MARKERS = [
  {
    key: "visibleBridge",
    label: "visible HTTP bridge",
    marker: "Codex visible bridge",
  },
  {
    key: "mcpPinned",
    label: "mcp-stata pinned to 1.26.1",
    marker: "mcp-stata==1.26.1",
  },
  {
    key: "variableProviderDisabled",
    label: "terminal variable provider disabled",
    marker: "lM=async()=>[]",
  },
  {
    key: "dataBrowserRefreshDisabled",
    label: "DataBrowser auto refresh disabled",
    marker: "disable automatic DataBrowser refresh",
  },
  {
    key: "getVariableListLogFiltered",
    label: "get_variable_list logs filtered",
    marker: 'o.includes("get_variable_list")?void 0',
  },
  {
    key: "displayOnlyClearBeforeRun",
    label: "display-only clear before visible runs",
    marker: "codex patch v3: display-only clear before visible run",
  },
  {
    key: "displayOnlyClearBeforeBridgeRun",
    label: "display-only clear before visible bridge runs",
    marker: "codex patch v4: display-only clear before visible bridge run",
  },
  {
    key: "clearButtonDisplayOnly",
    label: "Clear button is display-only",
    marker: "codex patch v3: Clear button is display-only; no Stata clear all",
  },
  {
    key: "visibleBridgePatchMarker",
    label: "visible bridge returns rc.7 shared-execution marker",
    marker: "codex-rc7-shared-execution",
  },
  {
    key: "editProposalDiffGate",
    label: "agent Stata edits require accepted diff proposals",
    marker: "next patch E1: agent .do edits require explicit diff acceptance",
  },
  {
    key: "visibleBridgeTransientPortRebind",
    label: "surviving extension host retries transient bridge-port ownership races",
    marker: "codex patch rc.7.10.31: bridge retries transient EADDRINUSE",
  },
  {
    key: "explicitBridgeBusyNotice",
    label: "explicit bridge busy port explains agent connectivity failure",
    marker: "next patch F1: explicit bridge busy notice names agent connectivity",
  },
  {
    key: "f0bStopButtonFallback",
    label: "Terminal Stop falls back to the registered cancel command",
    marker: "next F0b: Terminal Stop falls back to the registered cancel command",
  },
  {
    key: "sharedExecutionLifecycle",
    label: "all visible entry points share the rc.7 execution lifecycle",
    marker: "codex patch rc.7: shared execution lifecycle",
  },
  {
    key: "forceResetGenerationFence",
    label: "force reset fences cancelled handlers before post-run Stata work",
    marker: "codex patch rc.7.9: force-reset generation fences stale handlers",
  },
  {
    key: "forceResetLifecycleFinalization",
    label: "force reset finalizes the cancelled lifecycle before readiness",
    marker: "codex patch rc.7.9.1: force-reset finalizes cancelled lifecycle",
  },
  {
    key: "forceResetBackendReconnect",
    label: "force reset reconnects its owned MCP backend before exposing READY",
    marker: "codex patch rc.7.10.15: force reset reconnects before READY",
  },
  {
    key: "boundedMcpLogNotifications",
    label: "mcp-stata runtime writes full logs before timeout-bounded notifications",
    marker: "codex patch rc.7.10.18: timeout-bounded MCP log notifications",
  },
  {
    key: "softStopDatasetRollback",
    label: "UI Stop cancels without disposing the backend and restores the pre-run dataset",
    marker: "codex patch rc.7.10: soft Stop preserves the pre-run dataset",
  },
  {
    key: "softStopBoundedBreak",
    label: "UI Stop always sends a bounded Stata break instead of waiting for natural completion",
    marker: "codex patch rc.7.10.1: soft Stop always requests bounded break_session",
  },
  {
    key: "softStopServerTaskCancellation",
    label: "UI Stop cancels the actual mcp-stata background task before restoring state",
    marker: "codex patch rc.7.10.2: soft Stop cancels the server background task",
  },
  {
    key: "softStopOwnedBackendFallback",
    label: "UI Stop restores the dataset after a bounded owned-backend fallback",
    marker: "codex patch rc.7.10.3: soft Stop hard fallback restores the dataset",
  },
  {
    key: "softStopSnapshotlessQuiescence",
    label: "UI Stop proves backend quiescence even when no dataset snapshot exists",
    marker: "codex patch rc.7.10.4: snapshotless Stop proves backend quiescence",
  },
  {
    key: "softStopHardFallbackReconnect",
    label: "UI Stop reconnects its owned transport before hard-fallback dataset restore",
    marker: "codex patch rc.7.10.5: hard fallback reconnects before restore",
  },
  {
    key: "softStopStaleReconnectRetry",
    label: "UI Stop retries one owned reset after a stale reconnect",
    marker: "codex patch rc.7.10.6: stale reconnect gets one owned retry",
  },
  {
    key: "softStopBoundedCancellationLatency",
    label: "UI Stop bounds task cancellation and break opportunities to 2.5 seconds each",
    marker: "codex patch rc.7.10.7: bounded cancellation latency",
  },
  {
    key: "softStopBridgeEndpoint",
    label: "shared localhost bridge exposes the same soft Stop lifecycle",
    marker: "codex patch rc.7.10.34: shared bridge exposes soft Stop",
  },
  {
    key: "structuralLongSelectionWatchdog",
    label: "manual selections with structurally long work avoid the 120-second watchdog",
    marker: "codex patch rc.7.10.8: structural long-selection watchdog",
  },
  {
    key: "largeDocumentGraphPreLogWatchdog",
    label: "large document graph runs avoid the five-minute pre-log boundary on all visible entry points",
    marker: "codex patch rc.7.10.48: large document graph runs extend the pre-log watchdog",
  },
  {
    key: "manualSelectionPolicyScope",
    label: "manual-selection command handlers can access the long-run policy",
    marker: "codex patch rc.7.10.8.1: manual run policy is command-visible",
  },
  {
    key: "longManualSelectionExactMarker",
    label: "long source-preserving manual selections retain exact completion evidence",
    marker: "codex patch rc.7.10.9: long manual selections keep exact completion markers",
  },
  {
    key: "executionLifecycleStatus",
    label: "/status exposes canonical execution lifecycle diagnostics",
    marker: "__codexExecution.publicLifecycle(o)",
  },
  {
    key: "executionLifecycleReleaseProof",
    label: "visible Agent receipts expose verified lifecycle release evidence",
    marker: "codex patch rc.7: lifecycle release proof",
  },
  {
    key: "executionLifecycleManualEvidence",
    label: "Manual and Agent release share exact log-evidence inference",
    marker: "codex patch rc.7: release infers manual evidence",
  },
  {
    key: "executionLifecycleFinalLogDiscovery",
    label: "release binds the exact current-run Stata log",
    marker: "codex patch rc.7.5: exact-marker log overrides stale log",
  },
  {
    key: "executionLifecycleWatchdogLogOwnership",
    label: "watchdog rejects stale logs and stale end-of-do-file evidence",
    marker: "codex patch rc.7.6: watchdog log ownership is run-scoped",
  },
  {
    key: "agentBridgeExactCompletionMarker",
    label: "Agent bridge logs an exact current-run completion marker",
    marker: "codex patch rc.7.7: Agent bridge exact completion marker",
  },
  {
    key: "transportSuccessWaitsForExactMarker",
    label: "successful background transport settlement stays busy until exact completion",
    marker: "codex patch rc.7.10.21: transport success waits for exact marker",
  },
  {
    key: "authoritativeSessionLogMarkerFallback",
    label: "authoritative session-log completion starts bounded per-run convergence",
    marker: "codex patch rc.7.10.22: authoritative session log marker fallback",
  },
  {
    key: "unsettledTransportExactMarkerRelease",
    label: "authoritative exact marker is discovered while a transport callback is stalled",
    marker: "codex patch rc.7.10.23: authoritative exact marker releases unsettled transport",
  },
  {
    key: "exactMarkerTransportSettlement",
    label: "authoritative exact marker settles the matching missing task_done before READY",
    marker: "codex patch rc.7.10.24: exact marker settles missing task_done",
  },
  {
    key: "humanFileExactCompletionMarker",
    label: "Manual Run File logs an exact current-run completion marker",
    marker: "codex patch rc.7: human file exact completion marker",
  },
  {
    key: "terminalInputSharedLifecycle",
    label: "Terminal input owns the shared execution lifecycle",
    marker: "codex patch rc.7: Terminal input owns shared lifecycle",
  },
  {
    key: "terminalInputExactCompletionMarker",
    label: "Terminal input logs an exact current-run completion marker",
    marker: "codex patch rc.7: Terminal input exact completion marker",
  },
  {
    key: "terminalInputVerifiedLifecycleRelease",
    label: "Terminal input releases through exact lifecycle evidence",
    marker: "codex patch rc.7: Terminal input verified lifecycle release",
  },
  {
    key: "quietGraphInventoryProbes",
    label: "internal graph inventory probes suppress stale Graph-window noise",
    marker: "codex patch rc.7: graph inventory probes are quiet",
  },
  {
    key: "dataBrowserObservableReadiness",
    label: "Data Browser exposes dataset and Arrow readiness diagnostics",
    marker: "codex patch rc.7: Data Browser observable readiness",
  },
  {
    key: "graphRouteLoadDiagnosticsDistinct",
    label: "graph diagnostics distinguish routed and loaded artifact paths",
    marker: "codex patch rc.7: routed and loaded graph paths are distinct",
  },
  {
    key: "manifestCannotReleaseExecution",
    label: "inline graph manifests cannot release an executing Stata run",
    marker: "codex patch rc.7: manifest cannot release execution",
  },
  {
    key: "graphMarkerProgressOnly",
    label: "graph routing markers cannot release an executing Stata run",
    marker: "codex patch rc.7: graph marker is progress only",
  },
  {
    key: "manualSelectionRejectsGraphOnlyCompletion",
    label: "Manual Selection rejects graph-only completion evidence",
    marker: "codex patch rc.7: manual selection rejects graph-only completion",
  },
  {
    key: "humanFileRejectsGraphOnlyCompletion",
    label: "Manual Run File rejects graph-only completion evidence",
    marker: "codex patch rc.7: human file rejects graph-only completion",
  },
  {
    key: "debugSelectionRequiresLifecycle",
    label: "Manual Selection diagnostics require verified lifecycle completion",
    marker: "codex patch rc.7: debug selection requires lifecycle completion",
  },
  {
    key: "debugFileRequiresLifecycle",
    label: "Manual Run File diagnostics require verified lifecycle completion",
    marker: "codex patch rc.7: debug file requires lifecycle completion",
  },
  {
    key: "visibleBridgeExecutedCompletion",
    label: "visible bridge ignores prepared graph completion markers",
    marker: "codex patch rc.6.4.1: visible bridge waits for executed completion",
  },
  {
    key: "restoredTerminalRebasesResources",
    label: "restored terminal rebases current webview resources",
    marker: "codex patch rc.6.4.2: restored terminal rebases current webview resources",
  },
  {
    key: "terminalInlineScriptParseGate",
    label: "terminal inline script syntax and nonce repair",
    marker: "codex patch rc.6.4.3: terminal inline script parse gate",
  },
  {
    key: "terminalSmclFallbackV2",
    label: "terminal fallback preserves readable SMCL when shared UI fails",
    marker: "codex-smcl-fallback-v2-template-safe",
  },
  {
    key: "singleFlightState",
    label: "single-flight state",
    marker: "codex patch v4: single-flight state",
  },
  {
    key: "statusEndpoint",
    label: "GET /status endpoint",
    marker: "codex patch v4: status endpoint",
  },
  {
    key: "recoveryStatusPayload",
    label: "/status exposes public recovery and backend ownership state",
    marker: "recovery:__codexControl.publicRecovery(globalThis.__codexRecoveryState),backendOwnerId:",
  },
  {
    key: "dedicatedRecoveryEndpoint",
    label: "dedicated verified recovery endpoint",
    marker: "codex patch rc.6.4: dedicated verified recovery endpoint",
  },
  {
    key: "busy409",
    label: "busy requests use structured HTTP 409 rejection",
    marker: 'let __busy=o=>__reject(o,{kind:"busy",httpStatus:409',
  },
  {
    key: "forceResetStateCleanup",
    label: "force reset cleans bridge state",
    marker: "codex patch v5: force reset state cleanup",
  },
  {
    key: "forceResetEndpoint",
    label: "HTTP /force-reset endpoint",
    marker: "codex patch v5: force reset endpoint",
  },
  {
    key: "forceResetV6Cleanup",
    label: "force reset cleans only extension-owned backend PIDs",
    marker: "codex patch rc.6.4: cleanup only backend PIDs owned by this extension host",
  },
  {
    key: "separateGraphViewerPanel",
    label: "separate Stata Graphs panel routing",
    marker: "codex patch v7: separate graph viewer panel",
  },
  {
    key: "graphPanelFeedbackAckLayer",
    label: "graph panel feedback ack layer",
    marker: "codex patch v7.1: graph panel feedback ack layer",
  },
  {
    key: "graphPanelIncludedInStatus",
    label: "graph panel diagnostics included in /status",
    marker: 'graphPanel:globalThis.__codexGraphPanelStatus?globalThis.__codexGraphPanelStatus():null',
  },
  {
    key: "graphStatusEndpoint",
    label: "GET /graph-status endpoint",
    marker: "codex patch v7.1: graph status endpoint",
  },
  {
    key: "graphClearFunction",
    label: "graph panel clear diagnostics function",
    marker: "globalThis.__codexClearGraphPanel = __codexClearGraphPanel",
  },
  {
    key: "graphClearEndpoint",
    label: "POST /graph-clear endpoint",
    marker: "codex patch v7.2: graph clear endpoint",
  },
  {
    key: "graphClearUiOnly",
    label: "graph clear does not mutate execution readiness",
    marker: "codex patch rc.6.4: graph clear is UI-only",
  },
  {
    key: "graphClearHelperPreservesReadiness",
    label: "graph panel Clear All preserves execution readiness",
    marker: "codex patch rc.6.4: graph panel clear preserves execution readiness",
  },
  {
    key: "graphClearHydratePreservesReadiness",
    label: "clear-snapshot hydration cannot release execution readiness",
    marker: "codex patch rc.6.4: clear snapshot hydration cannot release readiness",
  },
  {
    key: "graphViewerPanelId",
    label: "dedicated graph webview panel",
    marker: "codexStataGraphs",
  },
  {
    key: "manualRunFinishedRouting",
    label: "manual runFinished image artifact routing",
    marker: "manual runFinished artifact routing failed",
  },
  {
    key: "safeGraphRouteScheduler",
    label: "safe graph route scheduler",
    marker: "globalThis.__codexRouteArtifactSafe = __codexRouteArtifactSafe",
  },
  {
    key: "manualPostRunGraphExport",
    label: "manual post-run graph export",
    marker: "globalThis.__codexExportCurrentGraphsForPanel = __codexExportCurrentGraphsForPanel",
  },
  {
    key: "inlineGraphSnapshotFastPath",
    label: "scoped manual-selection inline graph snapshot helper",
    marker: "codex patch v7.7: inline graph snapshot manifest fast path",
  },
  {
    key: "nativeFirstNoSourceRewriteGraphCapture",
    label: "native-first graph capture does not rewrite Stata source",
    marker: "codex patch v7.11: native-first no source rewrite graph capture",
  },
  {
    key: "sourceRewriteDisabledDiagnostic",
    label: "graph status reports source rewriting policy",
    marker: "sourceRewriteDisabled: true",
  },
  {
    key: "sharedSourceCompatibilityAdapter",
    label: "Manual, Agent, and Terminal share Darwin source-path compatibility",
    marker: "codex patch rc.7: shared source compatibility adapter",
  },
  {
    key: "sharedExecutionPaginationGuard",
    label: "Manual, Agent, and Terminal disable interactive Stata pagination",
    marker: "codex patch rc.7.10.16: shared adapter disables Stata pagination",
  },
  {
    key: "sharedTransportLogProtection",
    label: "all visible execution paths preserve the live Stata transport log",
    relativePath: path.join("scripts", "stata_source_compat_core.js"),
    marker: "codex patch rc.7.10.33: every visible entry point preserves the live transport log",
  },
  {
    key: "scopedManualSelectionSnapshot",
    label: "scoped manual-selection inline snapshot fast path",
    marker: "codex patch v7.12: scoped manual-selection inline snapshot fast path",
  },
  {
    key: "graphIncludeGate",
    label: "graph scanning is gated by Stata code content",
    marker: "globalThis.__codexShouldIncludeGraphs = __codexShouldIncludeGraphs",
  },
  {
    key: "doFileGraphScan",
    label: "visible bridge scans do-file content before graph inventory",
    marker: "__codexGraphScanTextForCode",
  },
  {
    key: "graphInventoryTimeout",
    label: "graph inventory awaits guard settlement and refuses failed probes",
    marker: "codex patch: graph inventory waits for guard and preserves local returns",
  },
  {
    key: "visibleBridgeIncludeGate",
    label: "visible bridge disables duplicate mcp graph_ready scans",
    marker: "normalizeResult:!0,includeGraphs:!1,cwd:__cwd",
  },
  {
    key: "manualSelectionIncludeGate",
    label: "manual selection disables duplicate mcp graph_ready scans",
    marker: "normalizeResult:!0,includeGraphs:!1,cwd:B",
  },
  {
    key: "mcpRunSelectionGraphReadyPropagation",
    label: "runSelection passes emit_graph_ready to mcp-stata",
    marker: "emit_graph_ready:B===!0",
  },
  {
    key: "mcpRunFileGraphReadyPropagation",
    label: "runFile passes emit_graph_ready to mcp-stata",
    marker: "path:A,cwd:a,emit_graph_ready:B===!0",
  },
  {
    key: "graphRunCodePreparation",
    label: "graph run code preparation",
    marker: "globalThis.__codexPrepareGraphRunCode = __codexPrepareGraphRunCode",
  },
  {
    key: "manifestFirstGraphRouting",
    label: "manifest-first graph routing",
    marker: "globalThis.__codexRouteGraphManifestOrExport = __codexRouteGraphManifestOrExport",
  },
  {
    key: "graphRunLifecycle",
    label: "execution-scoped graph lifecycle",
    marker: "globalThis.__codexBeginGraphRun = __codexBeginGraphRun",
  },
  {
    key: "manualGraphRunBeginHook",
    label: "manual graph run begin hook",
    marker: "__codexPreparedGraphRun",
  },
  {
    key: "manualSelectionTempInstrumentation",
    label: "manual selection instrumentation before temp do-file write",
    marker: "codex patch v7.8: instrument manual selection before temp do-file write",
  },
  {
    key: "manualSelectionPreparedBody",
    label: "manual selection prepared body is written to temp do-file",
    marker: "__codexSelectionBody",
  },
  {
    key: "manualSelectionStaleWatchdog",
    label: "manual selected-code stale UI watchdog",
    marker: "globalThis.__codexCreateManualSelectionWatchdog = __codexCreateManualSelectionWatchdog",
  },
  {
    key: "watchdogDiskLogTail",
    label: "watchdog reads mcp log tail for DONE marker",
    marker: "readLogTail",
  },
  {
    key: "manualSelectionWatchdogGuard",
    label: "manual selected-code watchdog guards runSelection",
    marker: "__codexManualSelectionWatchdog.guard",
  },
  {
    key: "manualSelectionPreLogWatchdog",
    label: "manual selected-code pre-log zombie watchdog",
    marker: "manual pre-log zombie watchdog release",
  },
  {
    key: "manualSelectionManifestWatchdog",
    label: "manual selected-code passes manifest path to watchdog",
    marker: "manifestPath:__codexPreparedGraphRun&&__codexPreparedGraphRun.manifestPath",
  },
  {
    key: "manualSelectionCompletedLogRoutesManifest",
    label: "manual selected-code completed-log watchdog routes inline manifest",
    marker: "manual-selection completed-log routes inline manifest",
  },
  {
    key: "manifestWatchdogWaitsForDocuments",
    label: "inline manifest watchdog does not pre-release document-output runs",
    marker: "manifest watchdog waits for document output",
  },
  {
    key: "manualSelectionHardStallBound",
    label: "manual selected-code hard-stall watchdog is bounded",
    marker: "hardStallAfterMs:(__codexManualSelectionLongRun?14400000:120000)",
  },
  {
    key: "visibleBridgeStructuralLongRunWatchdog",
    label: "visible bridge gives structurally long do-files a bounded extended watchdog",
    marker: "codex patch rc.7.10.35: structural long bridge watchdog",
  },
  {
    key: "visibleBridgePreRunDatasetSnapshot",
    label: "visible Agent bridge snapshots the shared dataset before interruptible execution",
    marker: "codex patch rc.7.10.36: visible bridge snapshots pre-run dataset",
  },
  {
    key: "visibleBridgeActiveSnapshotOwnership",
    label: "soft Stop resolves the canonical active Agent pre-run snapshot",
    marker: "codex patch rc.7.10.37: Stop resolves the active Agent snapshot",
  },
  {
    key: "visibleBridgeStopSnapshotCleanupOwnership",
    label: "cancelled Agent handlers preserve the snapshot until soft Stop restores it",
    marker: "codex patch rc.7.10.38: Stop owns Agent snapshot cleanup",
  },
  {
    key: "softStopServerTaskDrain",
    label: "soft Stop waits for server task cancellation before restoring shared state",
    marker: "codex patch rc.7.10.39: server task drain before snapshot restore",
  },
  {
    key: "softStopCancelledTaskDoneDrain",
    label: "cancelled Agent tasks retain task_done until Stop restores shared state",
    marker: "codex patch rc.7.10.40: cancelled task_done drains before restore",
  },
  {
    key: "softStopFullStateCheckpoint",
    label: "Stop checkpoints and restores dataset, globals, estimates, and named graphs",
    marker: "codex patch rc.7.10.41: full Stop checkpoint",
  },
  {
    key: "manualSelectionLongRunWatchdog",
    label: "MI/document/large manual selections use long-run watchdog",
    marker: "codex patch v7.40: MI/document/large manual selections use long-run watchdog",
  },
  {
    key: "manualSelectionGraphCompletionMarker",
    label: "manual-selection watchdog treats graph markers as progress only",
    marker: "codex patch rc.7: graph marker is progress only",
  },
  {
    key: "humanFileDocumentHardStallBound",
    label: "human-file document-output hard-stall watchdog is bounded",
    marker: "v7.24m: human-file document-output hard-stall bounded to 120s",
  },
  {
    key: "humanFilePreLogZombieBound",
    label: "human-file pre-log zombie watchdog is bounded",
    marker: "codex patch v7.41: human-file pre-log zombie watchdog is bounded",
  },
  {
    key: "humanFileDocumentLogIdleBound",
    label: "human-file document-output log-idle hard-stall watchdog is bounded",
    marker: "codex patch v7.42: human-file document-output hard-stall bounded after live log idle",
  },
  {
    key: "humanFileInlineSnapshotOptOut",
    label: "temporary human-file runners can opt out of inline snapshots",
    marker: "codex patch v7.43: temp runners can opt out of human-file inline snapshots",
  },
  {
    key: "hugeMiHumanFileInlineOptOut",
    label: "huge MI/document Run File uses post-do export instead of inline snapshots",
    marker: "codex patch v7.52: huge MI/document Run File opts out of inline snapshots",
  },
  {
    key: "hugeMiHumanFileExtendedWatchdog",
    label: "huge MI/document Run File gets extended no-log watchdog",
    marker: "codex patch v7.53: huge MI/document Run File gets extended no-log watchdog",
  },
  {
    key: "longHumanProgressSentinel",
    label: "long human-file/selection progress sentinel uses five-minute health windows",
    marker: "codex patch v7.54: long human-file/selection progress sentinel uses five-minute health windows",
  },
  {
    key: "hugeMiSelectionBoilerplateOptOut",
    label: "huge MI/document manual selection suppresses inline helper boilerplate",
    marker: "codex patch v7.54: huge MI/document manual selection suppresses inline helper boilerplate",
  },
  {
    key: "smallDocumentSelectionInlineSnapshots",
    label: "small document manual selections keep inline snapshot graph parity",
    marker: "codex patch v7.60: small document selections keep inline snapshots; huge MI/large selections opt out",
  },
  {
    key: "hugeMiSelectionLogCloseGuard",
    label: "huge MI/document manual selection guards log close _all",
    marker: "codex patch v7.59: huge MI/document manual selection guards log close _all",
  },
  {
    key: "hugeMiRunFileNoPassiveWait",
    label: "huge MI/document Run File uses progress sentinel instead of passive no-log waiting",
    marker: "codex patch v7.54: huge MI/document Run File uses progress sentinel instead of passive no-log waiting",
  },
  {
    key: "longHumanNoGraphMarkerRelease",
    label: "graph-only release branches are explicitly disabled",
    marker: "codex patch rc.7: graph-only release branches disabled",
  },
  {
    key: "longHumanIgnoreCodexMarkerEcho",
    label: "watchdog delegates completion parsing to the canonical run lifecycle",
    marker: "inspectLogText(text,runId)",
  },
  {
    key: "noGraphHumanIgnoreGraphMarker",
    label: "watchdog requires exact current-run completion evidence",
    marker: "__inspection.completionMarkerVerified",
  },
  {
    key: "longHumanStaleEvidenceWindows",
    label: "long human progress sentinel releases after stale-evidence windows",
    marker: "staleEvidenceWindows",
  },
  {
    key: "hugeMiRunFileSourceSelection",
    label: "huge MI/document Run File uses source-selection transport for visible progress",
    marker: "codex patch v7.56: huge MI/document Run File uses source-selection transport for visible progress",
  },
  {
    key: "hugeMiRunFileLogCloseGuard",
    label: "huge MI/document Run File guards log close _all to preserve Terminal progress",
    marker: "codex patch v7.56b: huge MI/document Run File guards log close _all to preserve Terminal progress",
  },
  {
    key: "hugeMiRunFileTempDoGuard",
    label: "huge MI/document Run File uses guarded temp do-file to preserve Stata continuations",
    marker: "codex patch v7.57: huge MI/document Run File uses guarded temp do-file to preserve Stata line continuations",
  },
  {
    key: "hugeMiRunFileCompletionGuard",
    label: "huge MI/document Run File temp do has terminal completion guard",
    marker: "codex patch v7.90: huge MI/document Run File appends and verifies terminal completion guard after temp do",
  },
  {
    key: "hugeMiRunFileTempDoRunFile",
    label: "huge MI/document Run File executes guarded temp do through runFile",
    marker: "codex patch v7.94: huge MI/document Run File executes guarded temp do via runFile",
  },
  {
    key: "hugeMiRunFileTempDoActivatesExports",
    label: "huge MI/document Run File temp do activates all named graph exports",
    marker: "codex patch v7.95: huge MI/document Run File temp do activates all named graph exports",
  },
  {
    key: "hugeMiRunFileSourceSelectionAfterTempDoStall",
    label: "huge MI/document Run File uses source-selection after temp-do graph stall",
    marker: "codex patch v7.96: huge MI/document Run File uses source-selection transport after temp-do graph stall",
  },
  {
    key: "progressSentinelExposesLogPath",
    label: "progress sentinel exposes discovered live logPath through bridge status",
    marker: "codex patch v7.58: progress sentinel exposes discovered logPath through bridge status",
  },
  {
    key: "manualSelectionHardStallReset",
    label: "manual selected-code hard-stall triggers reset",
    marker: "manual-selection-hard-stall-reset",
  },
  {
    key: "manualSelectionCompletionMarkerHardStallRelease",
    label: "manual selected-code hard-stall rejects graph-only completion",
    marker: "codex patch rc.7: graph marker cannot hard-stall release",
  },
  {
    key: "manualSelectionCompletionMarkerPreLogRelease",
    label: "manual selected-code pre-log watchdog rejects graph-only completion",
    marker: "codex patch rc.7: graph marker cannot pre-log release",
  },
  {
    key: "longGraphDocumentRunFileOptOut",
    label: "long graph/document Run File opts out of inline snapshots",
    marker: "codex patch v7.68: long graph/document Run File opts out of inline snapshots",
  },
  {
    key: "longGraphDocumentRunFileActivatesNamedExports",
    label: "long graph/document Run File activates named graph exports without inline snapshots",
    marker: "codex patch v7.69: long graph/document Run File activates all named graph exports while source rewrite stays disabled",
  },
  {
    key: "longGraphDocumentRunFileUsesActivatedTempCopy",
    label: "long graph/document Run File executes activated temp copy before post-run export",
    marker: "codex patch v7.70: long graph/document Run File executes activated temp copy before post-run export",
  },
  {
    key: "documentRunFileActivatesGraphExportName",
    label: "document Run File activates named graph exports whenever graph export name() is present",
    marker: "codex patch v7.97: document Run File activates named graph exports whenever graph export name() is present",
  },
  {
    key: "documentRunFileNamedExportBypassesNoGraphEarlyReturn",
    label: "document Run File named graph export bypasses no-graph early return",
    marker: "codex patch v7.98: document Run File named graph export bypasses no-graph early return",
  },
  {
    key: "runFileTrailingBlockCommentTrimKeepsBody",
    label: "Run File trailing block-comment trim keeps executable body",
    marker: "codex patch v7.99: Run File trailing block-comment trim keeps executable body",
  },
  {
    key: "humanFilePreAcquireInlineSnapshotSettle",
    label: "human Run File waits briefly after prior inline snapshot transport",
    marker: "codex patch v7.91: graph/document Run File pre-acquire waits briefly for prior inline snapshot transport to settle",
  },
  {
    key: "humanFileErrorReleasesPostRunBusy",
    label: "human Run File errors release postRunBusy",
    marker: "codex patch v7.91: human-file runSelection errors release postRunBusy",
  },
  {
    key: "smallDocumentRunFileUsesSelectionStyleSnapshots",
    label: "small document Run File uses selection-style named-loop snapshots",
    marker: "codex patch v7.93: small document Run File snapshots named loop graphs like manual selection",
  },
  {
    key: "smallDocumentRunFileSnapshotsNamedLoopGraphs",
    label: "small document Run File snapshots named loop graphs like manual selection",
    marker: "codex patch v7.93: small document Run File snapshots named loop graphs like manual selection",
  },
  {
    key: "inlineSnapshotReadinessRelease",
    label: "inline snapshot routing releases postRunBusy",
    marker: "inline-snapshot-route-complete",
  },
  {
    key: "trueReadyGate",
    label: "true READY gate includes graph readiness",
    marker: "codex patch v7.16: true READY gate includes graph readiness",
  },
  {
    key: "statusPayloadTrueReady",
    label: "/status exposes true READY result",
    marker: "trueReady:!!__codexReady.ready",
  },
  {
    key: "manualTrueReadyGuard",
    label: "manual selection refuses false READY",
    marker: "codex patch v7.16: manual true READY guard",
  },
  {
    key: "bridgeAcquireTrueReady",
    label: "bridge acquire checks true READY",
    marker: "codex patch v7.16: bridge acquire checks true READY",
  },
  {
    key: "bridgeAcquireRecoverySmoke",
    label: "bridge acquire permits only the current internal recovery generation",
    marker: "codex patch rc.6.4: only current internal recovery generation may bypass stale",
  },
  {
    key: "bridgeAcquireRecoverySmokeReason",
    label: "bridge recovery smoke acquire reads true READY reason",
    marker: "__codexAcquireStatus=s.busy",
  },
  {
    key: "terminalRecoveryGuard",
    label: "terminal execution rejects ordinary code during recovery",
    marker: 'controlPlaneRejected:true,httpStatus:423,reasonCode:"recovery-required"',
  },
  {
    key: "terminalNoGraphReadinessRefresh",
    label: "successful no-graph terminal runs refresh readiness runId",
    marker: "codex patch rc.6.4: successful no-graph terminal run refreshes readiness runId",
  },
  {
    key: "recoveryReadinessPrecedence",
    label: "recovery-required precedes graph readiness",
    marker: "codex patch rc.6.4: recovery gate precedes graph readiness",
  },
  {
    key: "platformPanicAdapter",
    label: "panic recovery uses a platform adapter",
    marker: "codex patch rc.6.4: platform panic adapter",
  },
  {
    key: "windowsPanicRecoveryState",
    label: "Windows panic command enters the shared recovery control plane",
    marker: "codex patch rc.6.4: Windows panic command enters recovery control plane",
  },
  {
    key: "statusBarTrueReady",
    label: "status bar uses true READY gate",
    marker: "codex patch v7.16: status bar uses true READY gate",
  },
  {
    key: "artifactRouteReadinessRunId",
    label: "artifact routing refreshes readiness runId",
    marker: 'readinessReason: String(source || "artifact-batch") + "-routed"',
  },
  {
    key: "noGraphFastPathReadinessRunId",
    label: "no-graph fast path refreshes readiness runId",
    marker: "no-graph fast path refreshes graph readiness for current run",
  },
  {
    key: "noGraphFastPathReadyMismatchTolerance",
    label: "no-graph terminal/debug runs tolerate graph readiness runId mismatch",
    marker: "no-graph terminal/debug runs do not fail true READY on graph run-id mismatch",
  },
  {
    key: "emptyExportRefreshesLastRunId",
    label: "empty graph export refreshes lastRunId",
    marker: "lastRunId: runId",
  },
  {
    key: "humanFileWatchdog",
    label: "human Run File has watchdog release",
    marker: "human-file completed-log watchdog preserves shared Stata memory",
  },
  {
    key: "humanFileCompletedLogPreservesMemory",
    label: "human Run File completed-log watchdog preserves Stata memory",
    marker: "completed-log watchdog preserved Stata session; no force-reset",
  },
  {
    key: "humanFileWatchdogGraphTimeout",
    label: "human Run File watchdog graph export is bounded",
    marker: '__codexHumanFileReason+"-graph-timeout"',
  },
  {
    key: "humanFilePostRunSettleReset",
    label: "human Run File keeps worker after normal completion",
    marker: "normal completion keeps worker alive",
  },
  {
    key: "humanFileReadyGuard",
    label: "human Run File relies on acquire true READY gate",
    marker: "acquire itself enforces true READY",
  },
  {
    key: "humanFilePreAcquireManualSelectionReset",
    label: "human Run File pre-acquire reset after prior manual-selection/no-graph",
    marker: "v7.24o-preacquire: human-file pre-acquire reset after prior manual-selection/no-graph fast path",
  },
  {
    key: "heavyDocumentGraphRunFileExtendedWatchdog",
    label: "heavy document graph Run File gets extended watchdog",
    marker: "v7.24p: heavy document graph Run File gets extended watchdog",
  },
  {
    key: "largeDocumentOutputRunFileExtendedWatchdog",
    label: "large document-output Run File extends watchdog by source size",
    marker: "v7.24q: large document-output Run File extends watchdog by source size",
  },
  {
    key: "humanFilePostDoGraphExport",
    label: "human Run File exports graphs inside same do execution",
    marker: "__codexPreparedHumanFileRun",
  },
  {
    key: "humanFilePostDoGraphExportMode",
    label: "human Run File graph export avoids source rewrite",
    marker: "human-file-post-do-export",
  },
  {
    key: "humanFileInlineSnapshotTempDo",
    label: "human Run File captures transient graphs with temp do inline snapshots",
    marker: "human-file-inline-snapshot",
  },
  {
    key: "humanFileDocumentInlineSnapshot",
    label: "human Run File document-output still captures transient graphs",
    marker: "human Run File document-output still captures inline snapshots",
  },
  {
    key: "humanFileInlineRetainedBeforeDocuments",
    label: "human Run File captures document graphs with loop-internal snapshots",
    marker: "codex patch v7.93: document Run File uses loop-internal snapshots for graph parity",
  },
  {
    key: "humanFilePreparedManifestRestored",
    label: "human Run File preserves prepared inline manifest through TerminalPanel dispatch",
    marker: "restore human-file prepared graph manifest after TerminalPanel dispatch",
  },
  {
    key: "debugRunFileEndpoint",
    label: "manual Run File diagnostic endpoint",
    marker: "activeBefore:__debugBefore",
  },
  {
    key: "debugRunFileHandlerExposed",
    label: "manual Run File handler exposed for diagnostics",
    marker: "__codexRunFileHandler=xHg",
  },
  {
    key: "humanFileLifecycleDebug",
    label: "human Run File lifecycle probes",
    marker: "__codexHumanFileDebug",
  },
  {
    key: "graphPanelTerminalColumn",
    label: "Stata Graphs follows Stata Terminal column",
    marker: "globalThis.__codexGraphTargetColumn = __codexGraphTargetColumn",
  },
  {
    key: "bridgeGraphRunBeginHook",
    label: "bridge graph run begin hook",
    marker: "__codexPreparedBridgeRun",
  },
  {
    key: "bridgeStaleWatchdogGuard",
    label: "visible bridge completed-log watchdog preserves shared memory",
    marker: "visible bridge completed-log watchdog preserves shared Stata memory",
  },
  {
    key: "bridgeCompletionSentinel",
    label: "completion marker helper available for watchdog diagnostics",
    marker: "___CODEX_RUN_DONE_",
  },
  {
    key: "visibleBridgeRefreshGuard",
    label: "visible bridge ignores post-run refresh errors",
    marker: "post-run refresh ignored after visible bridge run",
  },
  {
    key: "visibleBridgeErrorRelease",
    label: "visible bridge errors release postRunBusy",
    marker: "visible-bridge-error-release",
  },
  {
    key: "bridgePostRunGraphExportHook",
    label: "bridge post-run graph export hook",
    marker: "__codexBridgeGraphExportError",
  },
  {
    key: "bridgeWatchdogGraphExportBounded",
    label: "bridge watchdog release attempts bounded graph export",
    marker: "bridge watchdog release attempts bounded graph export",
  },
  {
    key: "visibleBridgeDocumentOutputNoInlineSnapshot",
    label: "visible bridge suppresses inline snapshot for document-output code",
    marker: "visible bridge suppresses inline snapshot for document-output code",
  },
  {
    key: "visibleBridgeDoFileDocumentOutputDetection",
    label: "visible bridge scans embedded do-file content for document-output suppression",
    marker: "codex patch v7.22a: visible bridge scans embedded do-file content for document-output suppression",
  },
  {
    key: "visibleBridgeDocumentOutputDetectsPtdocx",
    label: "visible bridge treats p_tdocx as document-output code",
    marker: "\\bp_tdocx\\b",
  },
  {
    key: "namedGraphExportActivation",
    label: "named graph export activates graph before export",
    marker: "codex patch v7.21: activate named graph before graph export",
  },
  {
    key: "selectiveNamedGraphExportActivation",
    label: "selective named graph activation skips immediately-created exports",
    marker: "codex patch v7.23: selective named graph activation skips immediately-created graph exports",
  },
  {
    key: "graphCombineExportActivation",
    label: "graph combine exports are activated even when immediately created",
    marker: "codex patch v7.61: graph combine exports are activated even when immediately created",
  },
  {
    key: "longDocumentSelectionCompletionWait",
    label: "long document manual selection waits for end-of-do-file before postprocessing",
    marker: "codex patch v7.62: long document manual selection waits for end-of-do-file before postprocessing",
  },
  {
    key: "longDocumentSelectionSkipsDatasetRefresh",
    label: "long document manual selection skips dataset refresh after completion",
    marker: "codex patch v7.62: long document manual selection skips dataset refresh after completion",
  },
  {
    key: "longDocumentSelectionActivatesAllNamedGraphExports",
    label: "long document manual selection activates all named graph exports",
    marker: "codex patch v7.63: long document manual selection activates all named graph exports",
  },
  {
    key: "hugeMiVisibleBridgeGuardedDoFile",
    label: "huge MI/document visible bridge do-files use guarded source-preserving temp copy",
    marker: "codex patch v7.64: huge MI/document visible bridge do-files use guarded source-preserving temp copy",
  },
  {
    key: "hugeMiVisibleBridgeGraphActivation",
    label: "huge MI/document visible bridge guarded temp copy activates all named graph exports",
    marker: "codex patch v7.65: huge MI/document visible bridge guarded temp copy activates all named graph exports",
  },
  {
    key: "documentDoFileSelectiveActivation",
    label: "document do-files use selective activation while suppressing inline snapshots",
    marker: "codex patch v7.23: document do-files use selective activation while suppressing inline snapshots",
  },
  {
    key: "visibleBridgeDoFileNoInlineSnapshot",
    label: "visible bridge direct do-files use delta graph routing, not inline snapshots",
    marker: "codex patch v7.23b: visible bridge direct do-files use delta graph routing, not inline snapshots",
  },
  {
    key: "namedGraphActivationIgnoresCrlfOnlyChanges",
    label: "named graph activation ignores CRLF-only differences",
    marker: "codex patch v7.30: named graph activation ignores CRLF-only differences",
  },
  {
    key: "singleDoFileNamedGraphExportActivation",
    label: "single do-file graph export uses activated temp copy",
    marker: "codex patch v7.21b: single do-file graph export uses activated temp copy",
  },
  {
    key: "inlineManifestGrowthCountsAsProgress",
    label: "inline manifest growth counts as watchdog progress",
    marker: "codex patch v7.21c: inline manifest growth counts as watchdog progress",
  },
  {
    key: "humanFilePreflightAfterNoGraphSelection",
    label: "human-file preflight after manual-selection/no-graph fast path",
    marker: "codex patch v7.24: human-file preflight after manual-selection/no-graph fast path",
  },
  {
    key: "humanFileSkipsSecondaryRunSelectionPreflight",
    label: "human-file skips secondary runSelection preflight after current-line",
    marker: "codex patch v7.25: human-file skips secondary runSelection preflight after current-line",
  },
  {
    key: "preAcquireUsesBoundedBarrier",
    label: "pre-acquire uses bounded barrier before dispatch",
    marker: "codex patch v7.25d: clear pre-acquire barrier immediately before selection acquire",
  },
  {
    key: "healthyNoGraphDoesNotForceHumanFilePreAcquire",
    label: "healthy no-graph fast path does not force human-file pre-acquire reset",
    marker: "codex patch v7.25b: healthy no-graph fast path does not force human-file pre-acquire reset",
  },
  {
    key: "preAcquireResetNoFalseReadySelection",
    label: "manual-selection pre-acquire reset cannot expose false READY",
    marker: "codex patch v7.25d: pre-acquire reset cannot expose false READY before selection dispatch",
  },
  {
    key: "preAcquireResetNoFalseReadyHumanFile",
    label: "human-file pre-acquire reset cannot expose false READY",
    marker: "codex patch v7.25d: pre-acquire reset cannot expose false READY before human-file dispatch",
  },
  {
    key: "preAcquireBarrierStatusGate",
    label: "true READY honors pre-acquire barrier without blocking acquire",
    marker: "codex patch v7.25d: /status trueReady honors pre-acquire barrier without blocking acquire",
  },
  {
    key: "runFileOverridePreventsStaleActiveEditor",
    label: "Run File path override prevents stale active-editor reuse",
    marker: "codex patch v7.25e: debug/manual Run File path override prevents stale active-editor reuse",
  },
  {
    key: "runFileActiveTabResync",
    label: "Run File resyncs stale activeTextEditor from active tab",
    marker: "codex patch v7.25g: Run Selection/File resync stale activeTextEditor from active tab",
  },
  {
    key: "debugActiveEditorEndpoint",
    label: "debug endpoint exposes active editor/tab state",
    marker: "codex patch v7.25h: debug active editor/tab state for stale Run File diagnosis",
  },
  {
    key: "graphDocumentRunFilePreAcquireReset",
    label: "graph/document Run File resets transport before acquire",
    marker: "codex patch v7.25i: graph/document Run File resets transport before acquire",
  },
  {
    key: "debugRunFilePinsRequestedPath",
    label: "debug-run-file pins requested path through Run File handler",
    marker: "codex patch v7.25e: debug-run-file pins requested path through Run File handler",
  },
  {
    key: "debugRunFileCanRevertFromDisk",
    label: "debug-run-file can discard dirty editor buffer before Run File",
    marker: "debug-run-file can refresh active buffer from disk",
  },
  {
    key: "documentOutputHumanFileLongHardStall",
    label: "all human-file document-output runs get long hard-stall watchdog",
    marker: "codex patch v7.25f: all human-file document-output runs get long hard-stall watchdog",
  },
  {
    key: "humanFileDebugStaleDetection",
    label: "debug-run-file reports any unverified human-file lifecycle as failure",
    marker: "human-file execution did not reach verified lifecycle completion",
  },
  {
    key: "forceResetNeedsSmokeAfterPrelog",
    label: "force reset marks pre-log/hard-stall recovery as needs-smoke",
    marker: "force-reset-needs-smoke",
  },
  {
    key: "humanFileGraphDocumentPostRunRecycle",
    label: "human-file graph/document runs preserve memory after completion",
    marker: "human-file graph/document runs do not force-reset after completion",
  },
  {
    key: "humanFileHybridTransientRetainedGraphs",
    label: "human-file inline snapshots exclude retained graph sweep from live do",
    marker: "codex patch v7.29d: human-file inline snapshot excludes retained graph sweep from live do to preserve worker",
  },
  {
    key: "humanFileRetainedGraphsBeforeDocuments",
    label: "human Run File retained graph export occurs before document output",
    marker: "bodyLines.splice(docIndex, 0, retainedGraphExport)",
  },
  {
    key: "humanFileInlineSnapshotMoreOff",
    label: "human Run File inline snapshot temp do disables Stata pagination",
    marker: 'const intended = "set more off\\n" + __codexBodyCode',
  },
  {
    key: "humanFileRecycleSettle",
    label: "human-file graph/document settles without clearing memory",
    marker: "human-file graph/document runs do not force-reset after completion",
  },
  {
    key: "humanFileInlineSnapshotGraphicsOff",
    label: "Darwin PNG compatibility rewrites only the temporary run copy",
    marker: "A3/rc.6.3.1 PNG_COMPAT: Darwin-only temp-copy rewrite of raster graph export",
  },
  {
    key: "darwinHugeHumanFilePngCompat",
    label: "huge human-file source-selection also uses Darwin PNG compatibility",
    marker: "codex patch rc.7: huge human file applies Darwin PNG compatibility",
  },
  {
    key: "humanFileDocumentHardStallWindow",
    label: "human Run File document-output does not use an unbounded hard-stall window",
    marker: "v7.24m: human-file document-output hard-stall bounded to 120s",
  },
  {
    key: "humanFileDocumentOutputInlineSnapshot",
    label: "human Run File document-output keeps inline snapshot rewriting",
    marker: "human Run File document-output still captures inline snapshots",
  },
  {
    key: "humanFileInlineTempRunSelectionTransport",
    label: "human Run File uses runSelection transport with streaming callbacks",
    marker: "human Run File uses runSelection transport to preserve live Stata memory while streaming",
  },
  {
    key: "humanFileTrimTrailingNonExecutable",
    label: "human Run File temp copy trims trailing non-executable comments",
    marker: "__codexTrimTrailingRunFileNonExecutable",
  },
  {
    key: "humanFileFinalDatasetSnapshotRestore",
    label: "human Run File snapshots/restores inside-do final dataset around graph routing",
    marker: "human Run File restores inside-do dataset snapshot after graph routing to preserve shared memory",
  },
  {
    key: "humanFileTerminalPanelWatchdogNoPrelogReset",
    label: "human Run File TerminalPanel watchdog does not false pre-log reset",
    marker: "TerminalPanel Run File watchdog must not pre-log reset while kM owns live Stata memory",
  },
  {
    key: "humanFilePostRecycleReadyReason",
    label: "successful human-file settle has memory-preserving READY reason",
    marker: "human-file-post-run-settle-preserve-session-complete",
  },
  {
    key: "humanFileGraphDocDefersDatasetRefresh",
    label: "human Run File graph/document completion defers dataset summary refresh to preserve live memory",
    marker: "human-file graph/document completion defers dataset summary refresh to preserve live Stata memory",
  },
  {
    key: "humanFileManifestNoPreRelease",
    label: "human Run File manifest progress does not pre-release full file",
    marker: "codex patch v7.24h: human-file manifest progress must not pre-release Run File",
  },
  {
    key: "humanFileExplicitGraphExportKeepsGraphicsOn",
    label: "human-file inline snapshots exclude retained graph sweep from live do",
    marker: "codex patch v7.29d: human-file inline snapshot excludes retained graph sweep from live do to preserve worker",
  },
  {
    key: "humanFilePreflightAfterInlineSnapshot",
    label: "human Run File pre-acquire resets after prior inline-snapshot graph batch",
    marker: "codex patch v7.24k-preacquire: human-file pre-acquire reset after prior inline-snapshot graph batch",
  },
  {
    key: "manualSelectionPreflightAfterInlineSnapshot",
    label: "manual selection pre-acquire resets after prior inline-snapshot graph batch",
    marker: "codex patch v7.24r-preacquire: manual-selection pre-acquire reset after prior inline-snapshot graph batch",
  },
  {
    key: "runningForceResetPanicEscalation",
    label: "running force-reset escalates to panic-kill before READY",
    marker: "codex patch v7.24l: running force-reset escalates to panic-kill before READY",
  },
  {
    key: "graphBeginFailureReleasesReady",
    label: "graph run begin failure releases postRunBusy",
    marker: "graph-run-begin-error",
  },
  {
    key: "manualSelectionExportHook",
    label: "manual selection manifest-first graph export hook",
    marker: "__codexRouteGraphManifestOrExport(e,B)",
  },
  {
    key: "batchedGraphUpdates",
    label: "batched graph updates",
    marker: "codex patch v7.3: batched graph updates",
  },
  {
    key: "postRunBusyFlag",
    label: "postRunBusy flag in bridge state",
    marker: "postRunBusy:false",
  },
  {
    key: "acquireChecksPostRunBusy",
    label: "acquire checks postRunBusy/trueReady before granting lock",
    marker: "codex patch v7.16: bridge acquire checks true READY",
  },
  {
    key: "forceResetSetsPostRunBusy",
    label: "forceReset sets postRunBusy during async cleanup",
    marker: "s.postRunBusy=true",
  },
  {
    key: "forceResetClearsPostRunBusy",
    label: "forceReset clears postRunBusy and readiness after cleanup completes",
    marker: "force-reset-complete",
  },
  {
    key: "graphMarkGlobalExport",
    label: "graph readiness marker is globally callable",
    marker: "globalThis.__codexGraphMark = __codexGraphMark",
  },
  {
    key: "statusBarChecksPostRunBusy",
    label: "status bar IDLE requires both busy and postRunBusy false",
    marker: "if(s.busy||s.postRunBusy)",
  },
  {
    key: "statusExposesPostRunBusy",
    label: "/status exposes postRunBusy to agents",
    marker: "postRunBusy:!!o.postRunBusy",
  },
  {
    key: "watchdogNoForceReset",
    label: "visible bridge completed-log watchdog preserves shared memory",
    marker: "visible bridge completed-log watchdog preserves shared Stata memory",
  },
  {
    key: "manualSelectionWatchdogPreservesMemory",
    label: "manual selection completed-log watchdog preserves shared memory",
    marker: "manual selection completed-log watchdog preserves shared Stata memory",
  },
  {
    key: "humanFilePostRunPreservesMemory",
    label: "human-file graph/document completion preserves shared memory",
    marker: "human-file graph/document completion preserves shared Stata memory",
  },
  {
    key: "humanFilePreAcquirePreservesMemory",
    label: "human-file graph/document pre-acquire preserves shared memory",
    marker: "graph/document pre-acquire preserves shared Stata memory",
  },
  {
    key: "panicKillEndpoint",
    label: "HTTP /panic-kill endpoint",
    marker: "codex patch v10: panic kill endpoint",
  },
  {
    key: "panicKillStatusButton",
    label: "status bar panic kill button",
    marker: "codex patch v10: panic kill status button",
  },
  {
    key: "panicKillCommand",
    label: "VS Code panic kill command",
    marker: 'registerCommand("stata-workbench.panicKill"',
  },
  {
    key: "panicKillAllStataDefault",
    label: "panic kill defaults to the full Stata execution chain",
    marker: "Kill all Stata processes",
  },
  {
    key: "panicKillTransportReset",
    label: "panic kill resets stale MCP transport before READY",
    marker: "panic-kill transport reset",
  },
  {
    key: "panicKillErrorCleanup",
    label: "panic kill cleans state but requires smoke after partial failure",
    marker: "panic-kill-error-needs-smoke",
  },
  {
    key: "panicKillRequiresSmoke",
    label: "panic kill leaves readiness stale until smoke test",
    marker: "panic-kill-command-needs-smoke",
  },
  {
    key: "debugTerminalInputEndpoint",
    label: "debug endpoint exercises TerminalPanel runCommand handler",
    marker: "terminal input diagnostic endpoint exercises runCommand handler",
  },
  {
    key: "debugRunSelectionEndpoint",
    label: "debug endpoint invokes real Run Selection/Current Line handler",
    marker: "debug current-line endpoint invokes real runSelection handler",
  },
  {
    key: "debugRunSelectionRangeEndpoint",
    label: "debug Run Selection endpoint supports range/all selection",
    marker: "codex patch v7.40: debug-run-selection supports range/all selection",
  },
  {
    key: "debugRunSelectionDiskRefresh",
    label: "debug Run Selection refreshes from disk and restores a clean editor buffer",
    marker: "codex patch rc.7: debug selection refreshes and restores disk buffer",
  },
  {
    key: "terminalInputStoppedSessionRetry",
    label: "terminal input recovers stopped default session once",
    marker: "terminal-input stopped-session auto-recovery",
  },
  {
    key: "terminalInputWorkerErrorRetry",
    label: "terminal input recovers worker error once",
    marker: "terminal-input worker-error auto-recovery",
  },
  {
    key: "terminalInputGraphRouting",
    label: "terminal input graph commands use graph lifecycle without clearing memory",
    marker: "terminal input graph routing uses graph lifecycle without clearing Stata memory",
  },
  {
    key: "terminalInputGraphRouteTimeout",
    label: "terminal input graph routing is bounded and releases postRunBusy",
    marker: "terminal-input-graph-route-timeout",
  },
  {
    key: "terminalInputRunSelectionTimeoutRecovery",
    label: "terminal input runSelection timeout is recovered after visible dispatch",
    marker: "runSelection timeout recovered after visible log dispatch",
  },
  {
    key: "terminalInputSkipsDatasetRefresh",
    label: "terminal input skips dataset refresh to preserve shared memory",
    marker: "terminal input skips dataset refresh to preserve shared memory",
  },
  {
    key: "terminalInputDataBrowserCommand",
    label: "bare Terminal browse/edit opens the Workbench Data Browser after lifecycle release",
    marker: "codex patch rc.7.10.10: Terminal browse opens Data Browser",
  },
  {
    key: "dataBrowserChannelRecovery",
    label: "reused Data Browser panels reacquire credentials and retry dataset initialization twice",
    marker: "codex patch rc.7.10.11: Data Browser channel recovery",
  },
  {
    key: "dataBrowserExactReadiness",
    label: "Data Browser readiness requires non-null dataset and completed Arrow evidence",
    marker: "codex patch rc.7.10.12: exact Data Browser readiness",
  },
  {
    key: "dataBrowserFreshCommandCompletion",
    label: "View Data awaits channel refresh and rejects stale readiness from a prior command",
    marker: "codex patch rc.7.10.13: fresh Data Browser command completion",
  },
  {
    key: "dataBrowserVariableIntegrity",
    label: "Data Browser requires real variables and records selected variable evidence",
    marker: "codex patch rc.7.10.14: Data Browser variable integrity",
  },
  {
    key: "graphPdfDownloadBaseDir",
    label: "graph PDF download preserves artifact baseDir",
    marker: "baseDir: activeModalArtifact.baseDir",
  },
];

const AUXILIARY_MARKERS = [
  {
    key: "stopCheckpointCore",
    label: "packaged Stop checkpoint module preserves full shared Stata state",
    relativePath: path.join("scripts", "stop_checkpoint_core.js"),
    marker: "function checkpointCode",
  },
  {
    key: "executionLifecycleCore",
    label: "shared execution lifecycle resolves authoritative log directories",
    relativePath: path.join("scripts", "execution_lifecycle_core.js"),
    marker: "function resolveLogDirectories",
  },
  {
    key: "executionLifecycleStableIdentity",
    label: "shared execution lifecycle preserves object identity through release",
    relativePath: path.join("scripts", "execution_lifecycle_core.js"),
    marker: "Object.assign(current",
  },
  {
    key: "terminalUiCommandAdapter",
    label: "packaged Terminal UI command adapter classifies only exact browse/edit commands",
    relativePath: path.join("scripts", "terminal_ui_command.js"),
    marker: "function classifyTerminalUiCommand",
  },
  {
    key: "controlPlaneCore",
    label: "shared control-plane core verifies recovery attempts",
    relativePath: path.join("scripts", "control_plane_core.js"),
    marker: "function verifyRecoveryAttempt",
  },
  {
    key: "darwinOwnedPidCleanup",
    label: "Darwin force cleanup requires explicit owned PIDs",
    relativePath: path.join("scripts", "mac", "cleanup.sh"),
    marker: "--force 必须至少提供一个由当前扩展宿主登记的 --pid",
  },
  {
    key: "windowsOwnedPidCleanup",
    label: "Windows force cleanup requires explicit owned PIDs",
    relativePath: path.join("scripts", "cleanup_mcp_stata_processes.ps1"),
    marker: "-Force requires -OwnedPidCsv",
  },
  {
    key: "autocompleteEmptyVarsNoRefreshLoop",
    label: "autocomplete empty-variable update does not requestVars loop",
    relativePath: path.join("src", "ui-shared", "autocomplete.js"),
    marker: "if (!vars.length) { close(); return; }",
  },
  {
    key: "terminalSharedUiLoadProbeSource",
    label: "source shared terminal UI exposes an external-script load probe",
    relativePath: path.join("src", "ui-shared", "main.js"),
    marker: "window.__stataWorkbenchSharedUiLoaded = true;",
  },
  {
    key: "terminalSharedUiLoadProbeDist",
    label: "packaged shared terminal UI exposes an external-script load probe",
    relativePath: path.join("dist", "ui-shared", "main.js"),
    marker: "window.__stataWorkbenchSharedUiLoaded = true;",
  },
  {
    key: "terminalBrowserSafeReleaseSource",
    label: "source terminal webview uses browser-safe release globals",
    relativePath: path.join("src", "ui-shared", "main.js"),
    marker: "globalThis.__SENTRY_RELEASE__",
  },
  {
    key: "terminalBrowserSafeReleaseDist",
    label: "packaged terminal webview uses browser-safe release globals",
    relativePath: path.join("dist", "ui-shared", "main.js"),
    marker: "globalThis.__SENTRY_RELEASE__",
  },
  {
    key: "dataBrowserBrowserSafeReleaseSource",
    label: "source Data Browser uses browser-safe release globals",
    relativePath: path.join("src", "ui-shared", "data-browser.js"),
    marker: "globalThis.__SENTRY_RELEASE__",
  },
  {
    key: "dataBrowserBrowserSafeReleaseDist",
    label: "packaged Data Browser uses browser-safe release globals",
    relativePath: path.join("dist", "ui-shared", "data-browser.js"),
    marker: "globalThis.__SENTRY_RELEASE__",
  },
  {
    key: "dataBrowserStataMissingValue",
    label: "Data Browser renders Stata numeric missing values as dot",
    relativePath: path.join("src", "ui-shared", "data-browser.js"),
    marker: "STATA_MISSING_VALUE = 8.98846567431158e+307",
    optional: true,
  },
  {
    key: "dataBrowserFrameLabelSource",
    label: "source Data Browser shows the current frame",
    relativePath: path.join("src", "ui-shared", "data-browser.js"),
    marker: "codex patch rc.7.70: Data Browser shows the current frame",
  },
  {
    key: "dataBrowserFrameLabelDist",
    label: "packaged Data Browser shows the current frame",
    relativePath: path.join("dist", "ui-shared", "data-browser.js"),
    marker: "codex patch rc.7.70: Data Browser shows the current frame",
  },
  {
    key: "preRunStopFenceRefusesPayload",
    label: "rc.7.71 refuses the payload when Stop lands in the pre-run window",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.71: Stop in the pre-run window refuses the payload",
  },
  {
    key: "backendWarmupWaitsForStata",
    label: "rc.7.72 waits for the default Stata session before any pre-run stage",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.72: backend warm-up waits for Stata, not just the MCP handshake",
  },
  {
    key: "runtimePatchPreflightTimeout",
    label: "packaged mcp-stata patch reads the pre-flight timeout from MCP_STATA_PREFLIGHT_TIMEOUT",
    relativePath: path.join("scripts", "stata_preflight_timeout_patch.js"),
    marker: "Workbench pre-flight timeout follows MCP_STATA_PREFLIGHT_TIMEOUT",
  },
  {
    key: "forceResetReconnectFollowsSetupBudget",
    label: "Windows force-reset reconnect bound follows the Stata setup budget",
    relativePath: path.join("scripts", "stop_checkpoint_core.js"),
    marker: "function setupBudgetMs(env = process.env)",
  },
  {
    key: "cleanupEmptyOwnedPidsIsNoop",
    label: "force-reset cleanup with no owned backend PIDs is a no-op success",
    relativePath: path.join("scripts", "cleanup_mcp_stata_processes.ps1"),
    marker: "IsNullOrWhiteSpace($OwnedPidCsv)",
  },
  {
    key: "singleDoMatchersSkipPaginationPrefix",
    label: "rc.7.73 single-do matchers skip the compat pagination prefix",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.73: single-do matchers skip the pagination prefix",
  },
  {
    key: "softStopNeverDispatchesRefusedRestore",
    label: "rc.7.74 soft Stop never dispatches a refused checkpoint restore",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.74: soft Stop never dispatches a refused checkpoint restore",
  },
  {
    key: "nextDefaultBridgePort",
    label: "next 0.2.0-next.1: Next default bridge port 17601",
    relativePath: path.join("dist", "extension.js"),
    marker: "next patch 0.2.0-next.1: Next default bridge port 17601",
  },
  {
    key: "nextAgentIdentityEvents",
    label: "next 0.2.0-next.2: agent identity, Terminal origin header, session events",
    relativePath: path.join("dist", "extension.js"),
    marker: "next patch 0.2.0-next.2: agent identity, Terminal origin header, session events",
  },
  {
    key: "nextBridgeBearerAuth",
    label: "next 0.2.0-next.3: bridge bearer authentication",
    relativePath: path.join("dist", "extension.js"),
    marker: "next patch 0.2.0-next.3: bridge bearer authentication",
  },
  {
    key: "nextMultiSession",
    label: "next 0.2.0-next.4: multi-session registry and per-session temp",
    relativePath: path.join("dist", "extension.js"),
    marker: "next patch 0.2.0-next.4: multi-session registry and per-session temp",
  },
  {
    key: "runtimePatchTargetsListenerLoop",
    label: "packaged mcp-stata patch targets the live listener loop",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "listener_task.get_loop()",
  },
  {
    key: "runtimePatchUsesRunCoroutineThreadsafe",
    label: "packaged Data Browser calls use run_coroutine_threadsafe",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "asyncio.run_coroutine_threadsafe(_run(), listener_loop)",
  },
  {
    key: "runtimePatchBoundsLogNotifications",
    label: "packaged mcp-stata patch writes full logs before timeout-bounded notifications",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench log_path must never wait indefinitely for MCP notifications",
  },
  {
    key: "runtimePatchCapsNotificationBatch",
    label: "packaged mcp-stata patch caps the cumulative run notification budget",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "notify_budget_remaining = 4000",
  },
  {
    key: "runtimePatchPreservesPythonStringEscapes",
    label: "packaged mcp-stata patch preserves valid Python notification strings",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench notification budget must preserve valid Python source",
  },
  {
    key: "runtimePatchTimesOutNotificationBackpressure",
    label: "packaged mcp-stata patch times out notification backpressure",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "timeout=0.25",
  },
  {
    key: "runtimePatchBoundsTaskDoneNotification",
    label: "packaged mcp-stata patch prevents task_done from retaining the transport",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench task_done notification must not retain the MCP transport",
  },
  {
    key: "runtimePatchDrainsWorkerFutureBeforeTaskDone",
    label: "packaged mcp-stata patch keeps cancellation non-terminal until the worker acknowledges",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench cancellation must drain the live worker future before task_done",
  },
  {
    key: "runtimePatchUsesSupportedStataBreakApi",
    label: "packaged mcp-stata patch interrupts Stata through the supported PyStata ABI",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench cancellation uses StataSO_SetBreak",
  },
  {
    key: "runtimePatchDrainsPerRunTail",
    label: "packaged mcp-stata patch drains the per-run log through its standalone completion marker",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench per-run log must contain its own completion marker before task_done.",
  },
  {
    key: "perRunCompletionFailsClosed",
    label: "rc.7.25 refuses session-only success when the per-run log never converges",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.25: per-run log completion is fail-closed",
  },
  {
    key: "dynamicProgressLongRunPolicy",
    label: "rc.7.26 uses scope-valid dynamic long-run classification at every visible PROGRESS wrapper",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.26: progress wrappers use dynamic long-run policy",
  },
  {
    key: "atomicPreRunDrainsOwningTransport",
    label: "rc.7.27 drains the original atomic runSelection transport before pre-run release",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.27: atomic stages drain the owning transport",
  },
  {
    key: "checkpointAwareSoftStopRestoreWindow",
    label: "rc.7.28 allows bounded full-checkpoint restore time before hard escalation",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.28: checkpoint-aware soft Stop restore window",
  },
  {
    key: "trueTransportSettlementBeforeStopRestore",
    label: "rc.7.30 requires server, promise, and local ownership settlement before Stop restore",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.30: Stop requires true transport settlement",
  },
  {
    key: "runtimePatchDrainsGraphCache",
    label: "packaged mcp-stata patch drains graph cache before task_done",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench graph cache must drain before task_done",
  },
  {
    key: "runtimePatchRespectsGraphReadyRequest",
    label: "packaged mcp-stata patch honors no-graph background requests",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench background tools must honor the client's graph-ready request",
  },
  {
    key: "runtimePatchQuietsGraphInventory",
    label: "packaged mcp-stata patch keeps internal no-graph inventory probes quiet",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench internal graph inventory probes must be quiet",
  },
  {
    key: "runtimePatchQuietsInternalGraphFallbacks",
    label: "packaged mcp-stata patch keeps internal graph fallbacks out of visible logs",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench internal no-capture commands must stay out of the visible log",
  },
  {
    key: "runtimePatchRejectsUnknownUpstream",
    label: "mcp-stata runtime patch rejects unsupported source shapes",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: 'status: "unsupported-source"',
  },
  {
    key: "runtimePatchResolvesPinnedUvxRoot",
    label: "packaged mcp-stata patch resolves the pinned uvx sys.prefix",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "runtimeRootFromUvCommand(options.uvCommand, options)",
  },
  {
    key: "runtimePatchSupportsDynamicPythonSitePackages",
    label: "packaged mcp-stata patch supports dynamic Python site-package versions",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: 'if (/^python\\d+(?:\\.\\d+)*$/i.test(name))',
  },
  {
    key: "runtimePatchPrefersConfiguredFixedRuntime",
    label: "configured and fixed mcp-stata runtimes precede disposable uv caches",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Workbench runtime precedence: configured/fixed installs before disposable uv caches.",
  },
  {
    key: "runtimePatchCompilesBeforeWrite",
    label: "all patched Python modules compile before any runtime write",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Compile every candidate module before any runtime byte is replaced.",
  },
  {
    key: "runtimePatchWritesTransactionally",
    label: "runtime patch failures restore every original Python byte",
    relativePath: path.join("scripts", "mcp_stata_runtime_patch.js"),
    marker: "Runtime patch writes are one transaction: any failure restores every original byte.",
  },
  {
    key: "configuredRuntimePatchFailClosedRelease",
    label: "rc.7.22 identifies configured-runtime fail-closed activation",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.22: configured runtime patch is fail-closed",
  },
  {
    key: "emptySessionCheckpointRelease",
    label: "rc.7.23 preserves an empty pre-run session with an exact checkpoint milestone",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.23: empty-session checkpoint is restore-capable",
  },
  {
    key: "byteStableCheckpointMarkerRelease",
    label: "rc.7.24 writes checkpoint delimiters with Stata byte-stable tab tokens",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.24: checkpoint marker uses byte-stable Stata tabs",
  },
  {
    key: "runtimePatchWiredBeforeConnect",
    label: "extension applies the Data Browser runtime patch before MCP connect",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7: mcp-stata Data Browser listener-loop patch",
  },
  {
    key: "runtimePatchWiredToLiveUvx",
    label: "extension patches the live uvx runtime before MCP connect",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.10.27: patch live uvx runtime",
  },
  {
    key: "internalGraphProbesAreQuiet",
    label: "internal graph inventory and snapshot probes do not leak no-graph errors",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.10.29: internal graph probes are quiet",
  },
  {
    key: "sharedDarwinDocumentCompatibility",
    label: "all visible execution paths share the Darwin document-image compatibility adapter",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.2: shared Darwin graph/document compatibility",
  },
  {
    key: "sharedDarwinReferencedDoCompatibility",
    label: "referenced do-file temporary copies use the shared Darwin compatibility adapter",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.3: referenced do-files use Darwin compatibility",
  },
  {
    key: "runScopedLifecycleCallbacks",
    label: "late callbacks are scoped to their owning execution run",
    relativePath: path.join("dist", "extension.js"),
    marker: "codex patch rc.7.4: lifecycle callbacks are run-scoped",
  },
  {
    key: "lifecycleCoreChecksCallbackOwnership",
    label: "shared lifecycle core rejects callbacks from previous runs",
    relativePath: path.join("scripts", "execution_lifecycle_core.js"),
    marker: "ownsLifecycle",
  },
  {
    key: "darwinCompatibilityAdapterModule",
    label: "packaged Darwin adapter transforms direct and referenced execution code",
    relativePath: path.join("scripts", "darwin_compat_adapter.js"),
    marker: "transformReferencedCode",
  },
  {
    key: "darwinPngOpaqueRgbHelper",
    label: "Darwin PNG compatibility includes lossless RGBA-to-RGB conversion",
    relativePath: path.join("scripts", "mac", "png_opaque_rgb.rb"),
    marker: 'rgb_ihdr = [width, height, 8, 2, 0, 0, 0]',
  },
  {
    key: "darwinPngRequiresRgb",
    label: "Darwin PNG helper rejects putdocx-unsafe alpha output",
    relativePath: path.join("scripts", "mac", "png_compat_sips.sh"),
    marker: 'fail "png_not_rgb:color_type=$COLOR_TYPE"',
  },
  {
    key: "darwinPngSilentSuccess",
    label: "Darwin PNG helper cannot fill Stata shell pipes with success output",
    relativePath: path.join("scripts", "mac", "png_compat_sips.sh"),
    marker: "codex patch rc.7.10.19: Stata/PyStata may not drain repeated shell output",
  },
  {
    key: "darwinDocxImageInjector",
    label: "Darwin document images are injected after save outside embedded PyStata",
    relativePath: path.join("scripts", "mac", "docx_image_inject.py"),
    marker: "DOCX_IMAGE_COMPAT_MARKER_REMAINED",
  },
  {
    key: "darwinDocxSilentSuccess",
    label: "Darwin DOCX helper cannot fill Stata shell pipes with success output",
    relativePath: path.join("scripts", "mac", "docx_image_inject.py"),
    marker: "codex patch rc.7.10.20: Stata/PyStata may not drain repeated shell",
  },
  {
    key: "darwinDocxTempCopyTransform",
    label: "Darwin temporary execution copies replace putdocx image with markers",
    relativePath: path.join("scripts", "mac", "png_compat_transform.js"),
    marker: "DOCX_IMAGE_COMPAT_DARWIN",
  },
];

const OPTIONAL_MARKERS = [
  {
    key: "tempDoSelectionPatch",
    label: "temp do-file selection patch",
    marker: "codex patch v2: temp do-file so Stata handles /// continuation natively",
  },
];

const FORBIDDEN_MARKERS = [
  { key: "noRefreshFlag", label: "no --refresh flag", marker: "--refresh" },
  { key: "noRefreshPackage", label: "no refresh-package flag", marker: "refresh-package" },
  { key: "noLatestSpec", label: "no mcp-stata@latest", marker: "mcp-stata@latest" },
  { key: "noLabelRecoveryBypass", label: "no label/code-regex recovery bypass", marker: "let __codexAllowRecoverySmoke=" },
  { key: "noGraphClearBusyRelease", label: "graph-clear cannot release postRunBusy", marker: '__codexSetPostRunBusy&&globalThis.__codexSetPostRunBusy(false,"graph-clear-complete"' },
  { key: "noGraphClearReadyWrite", label: "graph-clear cannot mark readiness ready", marker: 'readinessReason:"graph-clear-complete"' },
];

function findExtension() {
  if (TARGET_REPO) {
    const pkg = path.join(WORKSPACE, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(pkg, "utf8"));
    return {
      name: `${packageJson.publisher}.${packageJson.name}-repo`,
      full: WORKSPACE,
      js: PATCHED_BASELINE,
      pkg,
      version: packageJson.version,
      mtime: fs.statSync(PATCHED_BASELINE).mtimeMs,
      target: "repo",
    };
  }
  if (!fs.existsSync(EXT_ROOT)) {
    fail(`VS Code extension root not found: ${EXT_ROOT}`);
  }
  // codex patch v8.01: publisher-agnostic extension discovery (tmonk.* and lzhs1995.*)
  // Cross-platform shared-session packaging may ship as either publisher id.
  const candidates = fs.readdirSync(EXT_ROOT)
    .filter((name) => name.startsWith(EXTENSION_ID_PREFIX) || /^[^.]+\.stata-workbench-/.test(name))
    .map((name) => {
      const full = path.join(EXT_ROOT, name);
      const js = path.join(full, "dist", "extension.js");
      const pkg = path.join(full, "package.json");
      let version = name.startsWith(EXTENSION_ID_PREFIX)
        ? name.slice(EXTENSION_ID_PREFIX.length)
        : name.replace(/^[^.]+\./, "");
      try {
        version = JSON.parse(fs.readFileSync(pkg, "utf8")).version || version;
      } catch {}
      let mtime = 0;
      try {
        mtime = fs.statSync(js).mtimeMs;
      } catch {}
      return { name, full, js, pkg, version, mtime };
    })
    .filter((entry) => fs.existsSync(entry.js))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    fail("Stata Workbench extension.js not found under " + EXT_ROOT);
  }
  return candidates[0];
}

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, text) {
  fs.writeFileSync(file, text, "utf8");
}

function syntaxCheckFile(file) {
  const tmp = path.join(os.tmpdir(), `stata-workbench-check-${Date.now()}.js`);
  fs.copyFileSync(file, tmp);
  try {
    execFileSync("node", ["--check", tmp], { stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr && err.stderr.toString()) || err.message,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function syntaxCheckText(text) {
  const tmp = path.join(os.tmpdir(), `stata-workbench-check-${Date.now()}.js`);
  writeText(tmp, text);
  try {
    execFileSync("node", ["--check", tmp], { stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr && err.stderr.toString()) || err.message,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function inspectContent(content) {
  const required = {};
  const optional = {};
  const forbidden = {};
  for (const item of REQUIRED_MARKERS) {
    required[item.key] = content.includes(item.marker);
  }
  for (const item of OPTIONAL_MARKERS) {
    optional[item.key] = content.includes(item.marker);
  }
  for (const item of FORBIDDEN_MARKERS) {
    forbidden[item.key] = content.includes(item.marker);
  }
  const requiredOk = Object.values(required).every(Boolean);
  const forbiddenOk = Object.values(forbidden).every((present) => !present);
  return {
    required,
    optional,
    forbidden,
    requiredOk,
    forbiddenOk,
    fullyPatched: requiredOk && forbiddenOk,
  };
}

function inspectAuxiliary(extension) {
  const auxiliary = {};
  for (const item of AUXILIARY_MARKERS) {
    if (TARGET_REPO && item.base === "workspace") {
      auxiliary[item.key] = null;
      continue;
    }
    const file = path.join(item.base === "workspace" ? WORKSPACE : extension.full, item.relativePath);
    try {
      auxiliary[item.key] = fs.existsSync(file) && readText(file).includes(item.marker);
    } catch {
      auxiliary[item.key] = false;
    }
  }
  const auxiliaryOk = AUXILIARY_MARKERS.every((item) =>
    item.optional === true || auxiliary[item.key] !== false
  );
  return { auxiliary, auxiliaryOk };
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readText(MANIFEST));
  } catch {
    return null;
  }
}

function saveManifest(data) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  writeText(MANIFEST, JSON.stringify(data, null, 2));
}

function ensureBaseline(extension) {
  if (fs.existsSync(PATCHED_BASELINE)) return;
  const current = readText(extension.js);
  const check = inspectContent(current);
  if (!check.fullyPatched) {
    fail([
      "No patched baseline exists and current extension is not fully patched.",
      "A safe apply cannot be synthesized from this bundle.",
      "Restore a known-good patched extension.js first, then run status again.",
    ].join("\n"));
  }
  const syntax = syntaxCheckText(current);
  if (!syntax.ok) fail("Current patched extension.js fails node --check:\n" + syntax.error);
  writeText(PATCHED_BASELINE, current);
  console.log(`[baseline] Saved current verified patched baseline: ${PATCHED_BASELINE}`);
}

function makeBackup(extension, reason) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const dest = `${extension.js}.pm-backup-${stamp}-${reason}`;
  fs.copyFileSync(extension.js, dest);
  return dest;
}

function statusData() {
  const extension = findExtension();
  const content = readText(extension.js);
  const syntax = syntaxCheckFile(extension.js);
  const inspection = inspectContent(content);
  const auxiliaryInspection = inspectAuxiliary(extension);
  const manifest = loadManifest();
  return {
    extension,
    syntax,
    inspection,
    auxiliaryInspection,
    manifest,
    size: fs.statSync(extension.js).size,
    sha256: sha256(content),
    baselineExists: fs.existsSync(PATCHED_BASELINE),
  };
}

function printStatus() {
  const data = statusData();
  console.log("");
  console.log("=== Stata Workbench Shared Session Patch Manager ===");
  console.log(`Extension : ${data.extension.name} (v${data.extension.version})`);
  console.log(`File      : ${data.extension.js}`);
  console.log(`Size      : ${(data.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`SHA256    : ${data.sha256.slice(0, 16)}...`);
  console.log(`Baseline  : ${data.baselineExists ? PATCHED_BASELINE : "missing"}`);
  console.log(`Manifest  : ${data.manifest ? MANIFEST : "missing"}`);
  console.log(`Syntax    : ${data.syntax.ok ? "OK" : "FAIL"}`);
  if (!data.syntax.ok) console.log(indent(data.syntax.error));
  console.log("");
  console.log("Required patch checks:");
  for (const item of REQUIRED_MARKERS) {
    console.log(`  ${data.inspection.required[item.key] ? "OK  " : "MISS"} ${item.label}`);
  }
  console.log("");
  console.log("Forbidden drift checks:");
  for (const item of FORBIDDEN_MARKERS) {
    console.log(`  ${data.inspection.forbidden[item.key] ? "FAIL" : "OK  "} ${item.label}`);
  }
  console.log("");
  console.log("Auxiliary source checks:");
  for (const item of AUXILIARY_MARKERS) {
    const value = data.auxiliaryInspection.auxiliary[item.key];
    const status = value === null ? "SKIP" : value ? "OK  " : item.optional ? "INFO" : "MISS";
    console.log(`  ${status} ${item.label}`);
  }
  console.log("");
  console.log("Optional checks:");
  for (const item of OPTIONAL_MARKERS) {
    console.log(`  ${data.inspection.optional[item.key] ? "OK  " : "MISS"} ${item.label}`);
  }
  console.log("");
  console.log(`Overall   : ${data.syntax.ok && data.inspection.fullyPatched && data.auxiliaryInspection.auxiliaryOk ? "OK fully patched" : "NOT fully patched"}`);
  return data;
}

function httpGetJson(target) {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        path: target.path,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          let body = data;
          try { body = JSON.parse(data); } catch {}
          const ok = typeof res.statusCode === "number" ? res.statusCode >= 200 && res.statusCode < 300 : false;
          resolve({ online: ok, statusCode: res.statusCode, body });
        });
      },
    );
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ online: false, error: error.message });
    });
    req.setTimeout(2500, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ online: false, error: "timeout" });
    });
    req.end();
  });
}

function checkBridgeOnline() {
  return httpGetJson(BRIDGE_URL);
}

function checkGraphStatusOnline() {
  return httpGetJson(GRAPH_STATUS_URL);
}

async function cmdVerify() {
  const data = printStatus();
  if (TARGET_REPO) {
    console.log("");
    console.log("Bridge    : SKIP (--target repo is a static package check)");
    console.log("Graphs    : SKIP (--target repo is a static package check)");
    if (!data.syntax.ok || !data.inspection.fullyPatched || !data.auxiliaryInspection.auxiliaryOk) {
      process.exitCode = 1;
    }
    return;
  }
  console.log("");
  process.stdout.write("Bridge    : checking http://127.0.0.1:17601/status ... ");
  const bridge = await checkBridgeOnline();
  if (bridge.online) {
    console.log("OK online");
    console.log(`Response  : ${JSON.stringify(bridge.body)}`);
  } else {
    console.log("OFFLINE");
    console.log(`Reason    : ${bridge.error || "unknown"}`);
  }
  process.stdout.write("Graphs    : checking http://127.0.0.1:17601/graph-status ... ");
  const graphStatus = await checkGraphStatusOnline();
  if (graphStatus.online) {
    console.log("OK online");
    console.log(`Response  : ${JSON.stringify(graphStatus.body)}`);
  } else {
    console.log("OFFLINE");
    console.log(`Reason    : ${graphStatus.error || "unknown"}`);
  }
  if (!data.syntax.ok || !data.inspection.fullyPatched || !data.auxiliaryInspection.auxiliaryOk || !bridge.online || !graphStatus.online) {
    process.exitCode = 1;
  }
}

function cmdApply() {
  const extension = findExtension();
  const current = readText(extension.js);
  const currentInspection = inspectContent(current);
  if (currentInspection.fullyPatched) {
    ensureBaseline(extension);
    writeApplyManifest(extension, current, null, "already-patched");
    console.log("[apply] Extension is already fully patched. No write needed.");
    return;
  }

  if (!fs.existsSync(PATCHED_BASELINE)) {
    fail("Patched baseline missing. Cannot safely reconstruct full patch set.");
  }
  const manifest = loadManifest();
  if (manifest && manifest.extensionVersion && manifest.extensionVersion !== extension.version) {
    fail([
      `Extension version changed: manifest=${manifest.extensionVersion}, current=${extension.version}.`,
      "Refusing to overwrite a different Workbench version with an old patched baseline.",
      "Inspect the new extension.js and create a new baseline for this version.",
    ].join("\n"));
  }
  if (manifest && manifest.extensionName && manifest.extensionName !== extension.name) {
    fail([
      `Extension directory changed: manifest=${manifest.extensionName}, current=${extension.name}.`,
      "Refusing to apply baseline across extension directories.",
    ].join("\n"));
  }
  const baseline = readText(PATCHED_BASELINE);
  const baselineInspection = inspectContent(baseline);
  if (!baselineInspection.fullyPatched) {
    fail("Patched baseline is not fully patched. Refusing to apply.");
  }
  const syntax = syntaxCheckText(baseline);
  if (!syntax.ok) {
    fail("Patched baseline fails node --check:\n" + syntax.error);
  }

  const backupPath = makeBackup(extension, "pre-apply");
  writeText(extension.js, baseline);
  const afterSyntax = syntaxCheckFile(extension.js);
  if (!afterSyntax.ok) {
    fs.copyFileSync(backupPath, extension.js);
    fail("Patched file failed node --check; restored backup:\n" + afterSyntax.error);
  }
  writeApplyManifest(extension, baseline, backupPath, "applied-baseline");
  console.log(`[apply] Applied full patched baseline to ${extension.js}`);
  console.log(`[apply] Backup: ${backupPath}`);
  console.log("[apply] Reload VS Code window before verifying bridge online.");
}

function writeApplyManifest(extension, patchedContent, backupPath, action) {
  const existing = loadManifest() || {};
  saveManifest({
    schema: 1,
    patchSet: "stata-workbench-shared-session/full-v2",
    action,
    updatedAt: new Date().toISOString(),
    extensionName: extension.name,
    extensionVersion: extension.version,
    extensionFile: extension.js,
    backupPath: backupPath || existing.backupPath || null,
    patchedBaselinePath: PATCHED_BASELINE,
    patchedSha256: sha256(patchedContent),
  });
}

function cmdRevert() {
  const extension = findExtension();
  const manifest = loadManifest();
  if (!manifest || !manifest.backupPath) {
    fail("No manifest backupPath found. Refusing to guess a backup.");
  }
  if (!fs.existsSync(manifest.backupPath)) {
    fail(`Manifest backup missing: ${manifest.backupPath}`);
  }
  const safetyBackup = makeBackup(extension, "pre-revert");
  fs.copyFileSync(manifest.backupPath, extension.js);
  const syntax = syntaxCheckFile(extension.js);
  if (!syntax.ok) {
    fs.copyFileSync(safetyBackup, extension.js);
    fail("Reverted file failed node --check; restored pre-revert backup:\n" + syntax.error);
  }
  saveManifest({
    ...manifest,
    action: "reverted",
    updatedAt: new Date().toISOString(),
    revertedFromBackup: manifest.backupPath,
    preRevertBackup: safetyBackup,
  });
  console.log(`[revert] Restored extension.js from manifest backup: ${manifest.backupPath}`);
  console.log(`[revert] Pre-revert safety backup: ${safetyBackup}`);
  console.log("[revert] Reload VS Code window to unload patched extension code.");
}

function indent(text) {
  return String(text || "").split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function fail(message) {
  console.error("[ERROR] " + message);
  process.exit(1);
}

const command = CLI_ARGS.find((arg, index) =>
  !arg.startsWith("--") && CLI_ARGS[index - 1] !== "--target" && arg !== "repo"
) || "status";
if (command === "status") {
  printStatus();
} else if (command === "verify") {
  cmdVerify().catch((err) => fail(err.stack || err.message || String(err)));
} else if (command === "apply") {
  cmdApply();
} else if (command === "revert") {
  cmdRevert();
} else {
  fail(`Unknown command: ${command}\nUsage: node patch_manager.js [status|verify|apply|revert] [--target repo]`);
}
