## 0.2.0-next.6 — warm-up identity, quiet commands, Stop during start-up (unreleased)

Not released yet; `package.json` still says `0.2.0-next.5`. Entries are in merge
order. Each pull request was reviewed independently and passed CI on macOS 15
(Apple Silicon and Intel) and Windows Server 2022 before merging. The live
results below were taken on each pull request's own head before its review
rework; the merged `main` has not been retested live.

- **Packaging no longer depends on the maintainer's machine (PR #19).** `npm run package` now runs the full check and builds the VSIX in one step.
  - The image-corpus test skips when the corpus is missing, has no `.do` files or has no raster exports, and runs on five synthetic `.do` files in the repository with exact counts.
  - The pre-flight patch test accepts an installed runtime only when it is unpatched, or patched once with exactly one marker, idempotent and compilable. Seven mutated sources are refused.
- **Per-step timing for the first Terminal command (PR #21, rc.7.80).**
  - The **Stata Workbench** output channel gets one `[wb-timing] {…}` line per step: entry, warm-up start and end, default-session status changes, tool calls, the matched log path and the first output. With `STATA_WORKBENCH_TIMING_FILE` set, the same lines are appended to that file.
  - Fields come from a per-event allowlist; errors keep only their class and code. Every insertion is wrapped in `try`. The writes are synchronous, so the lines are a diagnostic with a small I/O cost.
  - Timing inside mcp-stata is not part of the runtime patch chain. `scripts/stata_timing_patch.js` reads a runtime and instruments only a new disposable copy, never an installed or linked runtime.
  - The timing located W-P1; see Known issues.
- **Concurrent `open` calls (PR #23).** `tools/stata_session.py open` used to hold its lock for the whole launch, so a second `open` failed after 10 s (M8).
  - Inside the lock it now only checks the name, the session limit, the disk space and the port, then takes a per-profile OS lock that it holds through preparation and launch. The global lock wait is 60 s.
  - Runtime copies run one at a time under their own lock, which re-checks the disk space.
  - `open` waits up to 60 s for the window's VS Code process and reports `launchState` (`visible`, `accepted-not-visible`, `prepare-only`). If the launch fails, `session.json` is restored.
  - `close` on a session that is still opening returns `OPENING` (exit 2) instead of `NOT_RUNNING`.
- **Stop during backend start-up (PR #25, rc.7.83).** Stop pressed while this run's backend was still starting (`WAITING` or `CANCELLED`) ran the quiescence probe, which timed out, escalated and locked the session (M3). The probe is now skipped in that state, because nothing has been sent. Every other case still probes.
- **Worker CPU time counts as watchdog progress (PR #24, rc.7.84).** Quiet commands such as `bootstrap … nodots` were cancelled 60 s after their last log line (M4, inherited from the stable release).
  - After the log has been silent for 10 s, the watchdog samples the CPU time of this window's own leaf processes (the Stata worker and its resource tracker). The sample is one `ps` call on macOS and one CIM query on Windows.
  - A sample counts only if its tree checks out. The root is the registered backend, started no more than 5 s after it was registered, and its parent is this extension host. Every other process links to the root, and none started before its parent. Samples are keyed by pid and start time.
  - CPU growth of at least max(200 ms, 2 % of one core over the interval) counts as progress, dated at the earlier sample. Long tasks are not sampled.
  - A failed, unverified or late sample gives no credit, so the guard falls back to the log rule. CPU credit stops once the log has been silent for 30 min. PRE_LOG and the hard budget are unchanged.
- **The warm-up cache follows the default worker (PR #20, rc.7.81).** mcp-stata 1.26.1 can replace the default worker inside one transport.
  - A cached run checks `list_sessions` again (5 s limit). A worker that is not `running`, a changed pid or start time, a changed transport, or a failed or timed-out check drops the cache and the run waits again.
  - After the warm-up reports ready, a second check records the worker. If it does not see the same running worker on the same transport, the run waits once more and is then refused (`PRE_RUN_BACKEND_WARMUP_FAILED`, `workerChanged`, `payloadDispatched=false`). The reset generation is checked after every wait.
  - A Terminal command whose worker failed while starting restarts it once instead of being refused. It does not use the force-reset path.
  - An mcp-stata without `list_sessions` is still let through. That is a compatibility fallback, not proof that the worker is ready.
- **Agent submissions right after a window opens (PR #26, rc.7.86).** The agent client refused before submitting while the backend had not started yet (`BLOCKED_NO_DISPATCH`), while a Terminal command would have waited (M2).
  - The client now submits once when only the lazy backend start is missing, and the extension runs the same warm-up wait.
  - The completion check requires that this run started the backend itself (`lastCold.runId`, `CONNECTED`, a registered pid).
  - Warm-up refusals carry `retryable` and `retryAfterMs`: TIMEOUT and FAILED are retryable after 5000 ms, CANCELLED (a Stop) is not. The client reports them as `REFUSED_NOT_DISPATCHED` and does not resend.
<!-- PENDING #22: Windows KILL ends only this window's backend tree (rc.7.82). Add the entry after PR #22 merges. -->
- **A conservative check for Stata errors (PR #27, rc.7.85).** A command that Stata ran and rejected was reported as an unknown outcome: rc -1 on the Terminal path, `EXECUTION_UNCONFIRMED_NO_RETRY` to an agent (M5). mcp-stata 1.26.1 writes the error as `{search r(111), local:r(111);}` and sends no return code with `task_done`.
  - `scripts/stata_error_outcome_core.js` confirms an error only if the mcp-stata result is a failure, the run was not cancelled (Stop, watchdog, Break text, rc 1), the run id and log path are bound to this run, the last `r(n)` line is followed only by echoed commands, the completion marker was not printed, and the code is a positive integer equal to mcp-stata's `rc`. Anything else keeps the previous response.
  - A confirmed agent run is released with that rc and answered `500 {outcome:"STATA_ERROR", executed:true, stataRc, payloadMayHaveRun:true}`. The client checks the request, the run, the log and the completed rc again and reports `STATA_ERROR_CONFIRMED` (exit 2, one POST, no retry). A confirmed Terminal run finishes with that rc. Pre-run refusals are never classified.
  - On its own this path is inactive: mcp-stata 1.26.1 sends no rc with `task_done`, so every real Stata error still reads as unconfirmed. PR #28 supplies the rc.
- **mcp-stata sends this run's return code (PR #28).** With #27 this makes the confirmed path reachable. A runtime patch makes both background `_run` paths keep the integer `rc` (0 or more) of the response they just validated and adds it to `task_done`.
  - The rc comes from the validated model, so Pydantic may have converted the raw value. A call that raises before it returns a response (cancelled, worker error) records nothing, and `task_done` carries no rc. An exception after that point (result formatting, UI notify) can still send the rc of the response this task already received. A runtime without the patch still reads as unconfirmed (`mcp-rc-missing`).
  - The patch accepts only an exactly unpatched or exactly patched runtime. In the patched state, no original anchor or marker may remain once the exact patched blocks are removed, so an extra unpatched `_run` or notify block is refused. Revert is byte-exact and must give a strictly unpatched source. For anything else `patchRuntime` returns `unsupported-source` and writes nothing.
  - An offline cross-module test runs the real catch edits, the bundle's `__release` and the lifecycle core, then the Python client checks. A real error log with rc 111 gives `STATA_ERROR_CONFIRMED`; a Stop, timeout text, or a runtime without rc gives the old response. The `task_done` result is built by hand and the UI, identity and window observation are stubs, so this is not an MCP transport or production end-to-end test.

Live results (isolated profiles, synthetic data, 11-04):

- macOS, `v0.2.0-next.5` (`aba81779`): first command after opening 7/7; Stop during the warm-up wait, timeout and failure refusals as specified; Stop before the backend connected locked the session (fixed by PR #25); an agent submission right after opening was refused (fixed by PR #26); a quiet `bootstrap` run under heavy load was cancelled at 63 s (addressed by PR #24). The Terminal Stop button misses were caused by the test driver clicking through the Welcome page's overlay.
- Windows, PR #21 head `a1a2832b`: 24/24 first commands, including 10 on fresh profiles; 0 stalls. The older build `3765d82a` with the same timing stalled once in 17 runs.
- Windows, PR #20 head `40abcbea`: Stop and timeout during the warm-up wait refused before dispatch; one worker restart during start-up, command ran once.
- macOS, PR #24 head `2ec968a`: idle worker CPU noise 10 ms per 12 s; a frozen worker was still cancelled.

Known issues:

- **W-P1 is bounded, not proven fixed.** In the stall, Stata's start-up inside the worker took 76.6 s (3.4–8.6 s in the other 32 runs), and the old build counted that wait against the command's 120 s first-log budget. With the warm-up wait outside that budget, 24 runs had 0 stalls: below about 12.5 % at 95 % confidence.
- **Stata: KILL on Windows ends every Stata GUI process on the machine.** <!-- PENDING #22 -->
- **macOS KILL and force reset identify the backend by pid and command line only**, not by start time or parent.
- **Stata error return codes have not been tested live.** #27 and #28 are covered by source review and offline tests only. The confirmed path was built on real macOS logs; no Windows log has been collected. The Mac/Windows live check (an error returns `STATA_ERROR_CONFIRMED` with `stataRc` 111, the next command returns rc 0, the session stays usable) is still to do. An error whose text mentions cancel, timeout or stall stays unconfirmed.
- **The general log parser still reads only `r(n);`**, not `{search r(n)…}`. The rc inferred at release, the Run File finalizer and the watchdog's error check are unchanged.
- **Backend start refusals (`PRE_RUN_BACKEND_START_*`) are not part of the `retryable` contract yet.**
- **The worker CPU signal is a heuristic.** A run that loops without output can hold the session for up to 30 min of log silence. Unverifiable process trees fall back to the 60 s log rule. A quiet command past 60 s has not yet been tested live.

## 0.2.0-next.5 — Stop, recovery and Windows fixes

The version has been `0.2.0-next.5` since PR #9. Entries are in merge order.
PR #6 (agent edit gate) and PR #7 (pre-run snapshot with no variables) merged
before 0.2.0-next.4; they are described in their own sections below.

- **Ready only after the checkpoint is back (PR #9).** Stop cleared the busy flags before the checkpoint restore had finished, so `/status` could briefly report `trueReady=true` and accept a submission on unrestored data. A run-bound restore state now keeps the bridge not-ready, and submissions get the existing 423, until the restore completes or fails.
- **Session trust, locks, cleanup and bridge errors (PR #10).**
  - `/propose-edit` used a VS Code binding without `Uri.file` and failed with HTTP 400 on real installs (P8). It now uses the bundle's real binding.
  - `tools/stata_session.py open --disable-workspace-trust` is an opt-in for workspaces you created yourself. The Trust prompt stays the default (P1).
  - Named sessions use only their private execution lock, so agents in two sessions can submit at the same time (P4).
  - `close` removes only the target session's registry file, and only when it is dead (P6).
  - When the bridge gives up on an explicit port, it shows the port and why agents cannot connect. It never switches ports (P7).
- **Windows probes, update policy and tmp cleanup (PR #11).**
  - Listener lookup uses `GetExtendedTcpTable` through ctypes, and the process query is filtered and shared. One pre-dispatch observation took 2.3–2.6 s on the test machine, well under the 20 s timeout that refused agents when several sessions were open (W-P4).
  - New session settings `setdefault` `update.mode: none`, `extensions.autoUpdate: false` and `extensions.autoCheckUpdates: false` (W-P3).
  - Leftover registry `.tmp` files are removed on every `close` path, and only when their writer pid is known dead.
- **Terminal Stop button (PR #12).** The webview always posts `cancelRun`, so a webview whose script stopped early cannot swallow the first click. The host cancels only when `__codexBridgeState.busy` is true; idle or missing state cancels nothing. This rescues the symptom; the webview script failure itself was not located.
- **Guard cancel restore and cold-start outcome (PR #13).**
  - A watchdog cancel of a dispatched payload goes through the same restore rule as Stop. With a checkpoint, the session restores it and becomes ready only after the recovery smoke. Without one, or when the restore fails, the session is fenced (`continuityLost`, `trueReady=false`) (W-P2).
  - A transport timeout after the payload may have reached mcp-stata is reported as `EXEC_OUTCOME_UNKNOWN` with `outcomeUnknown` and `payloadMayHaveRun` (W-P1).
  - A Stop that did not restore an expected checkpoint now locks the session. The automatic force reset inside a Stop escalation no longer counts as the explicit reset that unlocks it (P3).
  - Confirming **Stata: KILL** once runs the recovery smoke automatically. If the smoke fails or there is no bridge port, the session stays at 423.
  - The upstream Download handler had the same `Uri.file` defect as P8 and is fixed.
- **Terminal Stop no longer restarts a healthy Stata (PR #14, rc.7.76).** A person's run has no checkpoint, so Stop checks that Stata is idle with a one-line probe. mcp-stata replays the leftover `_rc` before single-line commands, so the probe read the break's rc 1 (rc 111 in a new session), and the session escalated to a force reset that lost all in-memory data. The probe is now `capture noisily display as text "<marker>"`.
- **Truthful Stop, KILL and guard-cancel feedback; Windows pid liveness (PR #15, rc.7.77).**
  - On Windows, OpenProcess error 5 is checked against `K32EnumProcesses`. A pid missing from the list is dead; a listed pid, or no list, stays unknown (W-P6b).
  - The Terminal Stop notice checks `fenced` and `continuityLost` first: "did not restore the pre-run state; the session is locked. Click Stata: KILL to unlock it." (P10).
  - The quiescence probe result is narrowed to whole marker lines before matching, so an echo of the command alone no longer counts (F-1).
  - A skipped recovery smoke is no longer reported as passed in either KILL notice (F-5).
  - A guard cancel confirmed before Stata wrote any log is reported as `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun`, and the session stays locked (W-P1b).
  - After a guard cancel, the probe checks the last 64 KiB of its own `logPath` when no result field has the exact marker line (W-P9m).
- **Load at window open, named stalls, events stay with their task (PR #17, rc.7.78).**
  - `tools/stata_session.py` now writes `stataMcp.loadStataOnStartup: true` by default, still via `setdefault`. `open` returns a `backendLoad` note: Stata loads in the background, `trueReady` does not wait for it, and a command sent meanwhile waits inside its own pre-log budget (W-P1).
  - A guard cancel attaches its `stallReason` and `elapsedMs`. Stop and recovery reasons read for example `EXEC_PRELOG_STALL (IDLE)`, and every cancel writes `/status.lastGuardFailure`. `reasonCode` is unchanged because clients match on it (W-P10).
  - A background run that ends without its response is recorded as an orphan. While an orphan is outstanding, events with an unknown task id are not given to the active run: they are dropped when the run already has its task id, or held until it learns it. The strict mode is tied to the MCP transport and ends when the backend is replaced; it no longer expires by time. The holding buffer keeps at most 256 events (root cause of W-P1b and W-P9m).
- **Terminal commands wait for the Stata warm-up (PR #18, rc.7.79).**
  - A Terminal command now runs the same backend warm-up as the agent path before its progress guard starts and before it is dispatched, so a slow Stata start no longer uses up the command's pre-log budget (W-P1).
  - After 2 s of waiting the Terminal shows "Waiting for Stata to finish loading…" and reports progress every second. Stop cancels the wait (`PRE_RUN_BACKEND_WARMUP_CANCELLED`); after 300 s, or when the worker reports an error, the command is refused with `PRE_RUN_BACKEND_WARMUP_TIMEOUT` or `PRE_RUN_BACKEND_WARMUP_FAILED`. All three are refused before dispatch (`payloadDispatched=false`).
  - If `list_sessions` is not available, the command is sent anyway and the Terminal says the load could not be confirmed.
  - The warm-up cache is bound to the transport and the reset generation, so a reset backend is checked again.
- Live results for this version are in the README's platform tables. PR #15 was retested on Windows on `e7e54848`; PR #17 was retested on Windows on its head `3765d82a` (same bundle as `e9b22430`); PR #18 was retested on Windows on its head `e5d2cda7` (same source tree as `1bf02d02`).
- Release: https://github.com/lzhs1995/stata-workbench-next/releases/tag/v0.2.0-next.5

Known issues:

- **Windows: the first Terminal command after Stata loads stalled once; the cause is not confirmed (W-P1).** On `3765d82a` the first Terminal command sent right after `connect` completed stalled before any log output, returned HTTP 504 after 163.9 s and locked the session. With PR #18 the same check passed 3/3 on `e5d2cda7`, but `3765d82a` also passed 2/2 on the same day, so the stall is intermittent and is not proven fixed. The wait message and the warm-up refusals have offline tests only. If a session locks, click **Stata: KILL** and read the receipt before resubmitting.
- **Stata: KILL on Windows ends every Stata GUI process on the machine**, not only this session's.

## Agent edit gate 2026-11-01 — accepted diff before agent Stata edits

- Merged as PR #6 (`3d169984`) before 0.2.0-next.4; not described here until now.
- `POST /propose-edit` takes a path, the new content, the expected SHA-256 of the current file and a reason. It refuses a wrong path, a stale SHA, oversized content and a missing file, opens a VS Code diff with **Accept** and **Reject**, and checks the SHA again after review.
- Accepted edits first save a timestamped copy of the old file (mode 0600), then write. Accept, reject and timeout outcomes go to the session event stream.
- `docs/next/AGENT-EDIT-PERMISSIONS.md` adds Claude Code deny rules for direct edits of Stata files and records that Codex 0.164.0 has no equivalent rule.
- On real installs the endpoint failed with HTTP 400 until PR #10 fixed its `Uri.file` binding.

## 0.2.0-next.4 — multi-session

- New `tools/stata_session.py open|list|close <name>`. One session is one private profile, one VS Code window, one port and one mcp-stata runtime.
  - `open` creates `~/.stata-workbench-next/profiles/<name>/` and writes `user-data/User/settings.json`: `stataMcp.visibleBridgePort` (a free port in 17601–17620, kept when the same profile is reopened), `stataMcp.nextSessionName`, `stataMcp.nextProfilePath`, `stataMcp.nextMcpConfigPath`.
  - It links `extensions` to a shared `extensions-shared` directory: a symlink on macOS, a directory junction on Windows, no elevation.
  - It gives the session its own runtime. On macOS this is an APFS clone (`cp -c -R`). On Windows it is a full copy, not yet verified on a licensed machine.
  - It writes `mcp.json` pointing at that runtime, so a session never patches or runs the machine-wide `~/.local/share/stata-workbench` runtime.
  - It refuses a sixth live session (`SESSION_LIMIT`), a second window for the same session (`SESSION_ALREADY_OPEN`), settings that are not plain JSON, and low disk (macOS keeps 20 GB free).
  - `open` launches VS Code once. It does not wait for the bridge, activate a window or send Stata code.
  - `close` asks only that profile's VS Code to quit (macOS SIGTERM, Windows `taskkill` without `/F`). It never force-kills and reports `CLOSE_PENDING` if a prompt is still open.
- The extension takes the session name from `STATA_WORKBENCH_NEXT_SESSION`, then `stataMcp.nextSessionName`, then `default`. It takes the runtime config from `MCP_STATA_CONFIG_PATH`, then `stataMcp.nextMcpConfigPath`.
- At activation the extension points this process's `TMPDIR` (Windows: also `TEMP`/`TMP`) at `~/.stata-workbench-next/runs/<sessionId>/tmp`. Pre-run checkpoints, selection do-files and other `os.tmpdir()` files then stay inside the session.
- The registry record now also has these fields. All are public; the token is unchanged.
  - sessionName, backendPid, profilePath, workspacePath
  - tempDir, logDir, graphDir, checkpointDir
  - generation, diskBundleSha256
- The record is rewritten atomically, with the same ACL, after the bridge binds and after any authorised request in which generation or the backend pid changed.
- `/status` adds `nextMulti` (session name, profile, runtime config, temp dir; no token).
- `tools/verified_workbench.py` and `tools/shared_stata.py` add `--session <name or id>` (env `STATA_WORKBENCH_SESSION`) and `--list-sessions`.
  - Records whose extension host pid is confirmed dead are skipped.
  - If no live record matches, the clients stop with `SESSION_REGISTRY_MISSING`. If more than one live record matches, they stop with `MULTIPLE_SESSIONS`. This includes two live records on one port, which replaces the old "newest record wins".
  - With exactly one live session, that session is used.
  - A client binds to one sessionId for the whole call. If the window reloads, the client refuses rather than switching sessions.
- Before every submission `shared_stata.py` compares the registry with `/status`: sessionId, port, generation and bundle SHA. Any difference is `SESSION_IDENTITY_MISMATCH` with zero POSTs.
- Logic lives in `scripts/next_multi_session_core.js` and `tools/stata_session.py`. `apply_next_multi_session_patch.js` wires D in after C without changing B's or C's text. If D cannot load, B and C work as before and `/status.nextMulti.error` says why.
- Not yet verified on a licensed machine; see `docs/next/LIVE-CHECKS.md` L15–L23.

## Pre-run snapshot fix 2026-11-01 — no variables, some observations

- A session with observations but no variables (`c(k)==0`, `c(N)>0`, for example after
  `set obs 100000` and a failing next line) could no longer run anything. The pre-run
  snapshot ran `set obs 1` on its copy, Stata refused with r(198) because `set obs` cannot
  reduce observations, and every later submission was refused with HTTP 500
  `EXEC_REJECTED` (`preRunStage:"snapshot"`, `payloadDispatched:false`) until
  `/force-reset`. Agent submissions (`visible-bridge`) and Run File (`human-file`) both
  use this snapshot.
- The snapshot now adds the placeholder variable without `set obs` when `c(N)>0`, and
  writes kind `obs` with the observation count to the ready file
  (`ready<TAB>nonce<TAB>obs<TAB>N`). Restore runs `clear` and `set obs N`, so the session
  returns to N observations and no variables. Before, a successful empty snapshot was
  always restored with `clear`, so a session with 1 observation and no variables came
  back with 0 observations.
- `c(k)==0 & c(N)==0` and sessions with variables are unchanged.
- Regression test `scripts/test_snapshot_k0_states.js` runs the generated snapshot and
  restore code through a small interpreter for five states. Against the previous
  `stop_checkpoint_core.js` it fails on both defects. Not yet run in Stata; see
  `docs/next/LIVE-CHECKS.md` L14.

## 0.2.0-next.3 — bridge bearer authentication

- Each window's bridge creates a random 32-byte token when it starts. After the bridge
  binds its port it writes `~/.stata-workbench-next/sessions/<sessionId>.json`
  (schema `stata-workbench-next-session/1`: sessionId, port, extension host pid, token,
  events path, bundle fingerprint). On macOS the file is 0600. On Windows PowerShell
  rebuilds the file's DACL by SID: inheritance off, every explicit entry removed (files
  can be created with explicit SYSTEM and Administrators entries, which
  `icacls /inheritance:r` keeps), one FullControl entry for the current user. The DACL is
  read back, and publishing fails unless exactly that entry remains. The empty file is
  restricted first; the token is written after. The record is deleted when the window
  closes. Records whose pid is confirmed dead are pruned; others are kept.
- Every bridge endpoint now requires `Authorization: Bearer <token>` and a `Host` of
  exactly `127.0.0.1:<port>`. Requests with any `Origin` header are refused. Missing or
  wrong token: 401; wrong Host or any Origin: 403; registry not written yet: 503. Refused
  requests never reach a route. They are recorded as rate-limited `auth-refused` events
  (reason, status, method, path), never with the token.
- `tools/verified_workbench.py` (and so `tools/shared_stata.py`) reads the newest record
  for the port from the registry and sends the token. `STATA_WORKBENCH_NEXT_HOME`
  overrides the state root. The extension's own recovery check sends the token too.
- `/status` adds `nextAuth` (required, published, registry path, port, ACL kind, publish
  error). It never contains the token.
- The older shell and PowerShell helpers (`scripts/mac/*.sh`, `scripts/*.ps1`) do not send
  a token yet, so they get 401 from a Next bridge. Use `tools/shared_stata.py`.
- Logic lives in `scripts/next_bridge_auth_core.js`; `apply_next_bridge_auth_patch.js`
  wires it in. If it or the B session module cannot load, the bridge fails closed: every
  request, `/status` included, gets 503 `AUTH_UNAVAILABLE` and `detail` says why. Runs
  started in the editor or Terminal are not affected.
- Not yet verified on a licensed machine; see `docs/next/LIVE-CHECKS.md` L9–L13.

## 0.2.0-next.2 — agent identity, Terminal origin header, session events

- Agent runs carry a name: `tools/shared_stata.py --agent-name NAME` (or env
  `STATA_WORKBENCH_AGENT_NAME`; default `agent`). The bridge also reads `agentId` from
  older clients and an `X-Agent-Name` header. Names keep letters, digits, space and
  `._-@`, at most 40 characters.
- The Stata Terminal shows a small header above each run card: `NAME · runId` for agent
  runs, `You · runId` for runs started in the editor or Terminal. The runId is the one
  in the agent receipt.
- `/status` `current` adds `origin` (`agent`, `human`, `internal`) and `agentName`;
  `/status` adds `nextSession` (sessionId, events file, last sequence number).
- Every run by the person or an agent is appended to one per-session event stream,
  `~/.stata-workbench-next/runs/<sessionId>/events.jsonl` (`run-start`, `run-end`,
  `run-end-update`, `run-refused`; code SHA-256, rc, duration, log path). New read-only
  `GET /events?since=N[&limit=M]`, and `tools/shared_stata.py --events N`.
- When you press Run while something else is running, the warning names who is running
  which run and points to Stop.
- Logic lives in `scripts/next_session_core.js`; `apply_next_agent_identity_patch.js`
  wires it in without changing the existing lifecycle require. If the module cannot load,
  the extension still activates and `/status.nextSession.error` says why.
- Not yet verified on a licensed machine; see `docs/next/LIVE-CHECKS.md` L4–L8.

## 0.2.0-next.1 — isolated development identity

Fork the rc.7.45 runtime into the Next development line. The extension is
`lzhs1995.stata-workbench-next` (display name ends in "(Next)"), version
`0.2.0-next.1`. The default bridge port is 17601 in `package.json`, in both bundle
fallbacks (new replay patch `apply_next_identity_patch.js`) and in the tools; the
default tool profile is `~/.stata-workbench-next/profiles/default`. Nothing in this
tree defaults to 17485, the stable release's port. No runtime behavior changes.
`scripts/refresh_runtime_manifest.js` recomputes the runtime manifest.

## Toolchain 2026-10-31

Pin `minimatch` to 11.0.3 through `overrides`. It is used only by the packaging
tool `@vscode/vsce` (a devDependency). Advisory GHSA-g3hv-75wg-m249 (minimatch
before 11.0.1, moderate) was published on 2026-10-30 and made `npm audit` fail in
CI. The VSIX does not contain minimatch. Packaging with the pin gives the same 319
files; only the `overrides` entry in `extension/package.json` differs.

## Recovery guide 2026-10-17

Document the cmux caller-signature, RTK terminal-descriptor and helper-permission
incident, including failed user attempts, the tested launcher repair and corrected
codesign syntax. Add original-session preservation, current-generation binding,
live desktop/profile/backend acceptance and no-duplicate research rules. Replace
the troubleshooting guide's unconditional reset/retry advice. Documentation only;
no extension installation, runtime reset or new Stata execution is implied.

## Toolchain guide 2026-10-01

Document explicit shared execution with user-permitted covering, hiding or minimization;
separate physical visibility from execution receipts. Clarify serial use of one backend,
offline parallel work and the unverified multi-instance isolation contract. Preserve
unknown outcomes and completed prefixes on resume. Documentation only: no runtime,
client, bundle or package version change, and no new live concurrency certification.

## Toolchain guide 2026-09-26

Document empirical handoff, archive root compatibility and source/installed/loaded runtime distinctions. No runtime source, bundled extension or package version changes in this guide revision.

# Public packaging revision 0.1.3-rc.7.39-public.1 (2026-09-08)

Preserves the Mac-accepted runtime; removes local maintenance credentials, adds portable tools, read-only CI, release manifests and bilingual usage guides. The public VSIX has a new hash and is not the private accepted archive. Historical failures and acceptance limitations are disclosed in docs/ACCEPTANCE.md. Development dependency security updates do not rebuild the embedded runtime.

# Changelog

## 0.1.3-rc.7.45 — cold start waits for Stata, Agent-path named graphs, soft Stop during the pre-run checkpoint

Integrates PR #11, #12, #13 and #14 on top of rc.7.44.

### Named graph exports on the Agent path (macOS and Windows)

- On macOS an Agent request `do "<file>"` reaches the visible bridge with
  `set more off` in front: the compatibility layer adds it (`ensurePaginationOff`).
  Both single-do checks in the bridge matched only the whole request, so the
  prefixed request was not treated as one do-file. The bridge skipped the human-file
  graph preparation and `__codexResolveSingleDoFilePath` returned null. Named graph
  exports were never activated, and `graph export …, name(g)` for a graph that was
  not the current one failed with r(693) "could not find Graph window". rc.7.44
  FULL45 hit this on taught_task5/7/8 over the Agent path (S8, S25, S28).
- rc.7.73 skips leading `set more off` / `capture set more off` lines before both
  checks and keeps them in front of the prepared code. Any other code before or
  after the `do` line still does not count as a single do-file.
- New test `scripts/test_single_do_pagination.js` runs the real bundle checks
  against the real compatibility layer. It fails on the rc.7.44 bundle.
- Windows (stage 211343, job 384): before the fix taught_task5 failed the same way (500,
  r(693)); after it, 200 rc 0 with the named exports activated.

### Wait for Stata itself on cold start

- Windows rc.7.44 refused the first run after opening or reloading in 4 of 10 cold
  starts (504 `PRE_RUN_SNAPSHOT_TIMEOUT`, or 500 after mcp-stata's pre-flight timed
  out). mcp-stata 1.26.1 answers the MCP handshake after waiting at most 30 s for its
  worker, while the worker still starts Stata twice: a pre-flight subprocess with a
  hard 60 s limit, then the in-process `stata_setup.config`. rc.7.67 waited only for
  the handshake, so the remaining start-up landed in the 60 s snapshot guard.
- rc.7.72 waits, before any pre-run stage, until `list_sessions` reports the default
  session as `running`, under its own bound (setup timeout + 120 s). A Stop during
  the wait returns 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`; a timeout returns 504; a
  failed session returns 500 and is stopped so the next run starts a fresh engine.
  All refusals carry `payloadDispatched: false`. `/status.backendWarmup` records the
  wait. Servers without `list_sessions` keep the rc.7.67 behaviour.
- A soft Stop during that wait no longer escalates to a force reset. With no
  dataset snapshot, soft Stop used to run a 5 s quiescence probe, which queued
  behind Stata start-up and timed out. The force reset then hit its own 30 s
  reconnect limit and left the instance recovery-required (Windows, 2026-10-30).
  The probe is now skipped only while this run's warm-up is waiting, or was
  cancelled before Stata reported `running`. In that window no payload has been
  dispatched.
- On Windows the force-reset reconnect now waits as long as a cold start may
  take: setup budget + 120 s, the same formula the warm-up uses (300 s by
  default; follows `STATA_SETUP_TIMEOUT`). After a force reset the reconnect is
  a fresh cold start, and Windows cold connects took 34.6–42.5 s, so the old
  30 s bound always ended in recovery-required. A successful reconnect is not
  slowed down. macOS and other platforms keep 30 s.
- On Windows the soft-Stop full restore of a large pre-run checkpoint gets more
  time. The budget is 30 s + 400 ms per saved estimate + 3 s per saved graph, up
  to 300 s. Before, every platform got 250 ms per item, capped at 45 s, and the
  recovery guard around the restore stopped it at 60 s whatever the budget. In the
  Windows integ smoke of 2026-10-31 (160 estimates, 80 graphs) the restore had
  finished all 160 estimates but only 16 of the 80 graphs when the 45 s timer fired.
  A complete restore needs about 190–225 s. The escalation then restored only the
  dataset and globals, so the instance ended continuity-lost and the next run was
  refused with 423. On win32 the recovery guard's default limit is now the same
  300 s. The escalation ladder scales with the new budget and stays monotonic. A
  restore that finishes is not slowed down, and a hung one still escalates when the
  budget runs out; a Stop of a large session can therefore take up to about 5
  minutes on Windows before it falls back. macOS and other platforms are unchanged.
- The force-reset process cleanup treats an empty owned-PID list as a no-op
  success. Before, the extension passed `-OwnedPidCsv ""` when no backend had
  been started, the script refused with exit 2, and the reset recorded cleanup
  `ok: false`. A non-empty list with no valid PID is still refused.
- The runtime patch reads the pre-flight limit from `MCP_STATA_PREFLIGHT_TIMEOUT`
  (seconds, default 180, clamped to 60–900) instead of the hard-coded 60 s.
- rc.7.74: a Stop during the pre-run checkpoint no longer leaves the instance
  continuity-lost. In FULL45 S40 (Mac, rc.7.44) the Stop broke the checkpoint's
  graph-save loop, `graphs.txt` ended in a half-written name, and the restore
  code refused with its `exit 459` sentinel. Soft Stop sent that sentinel to
  Stata, which answers a top-level exit with `--Break-- r(1)`; the Stop returned
  500 and only a force reset cleared the state, although the payload had never
  been dispatched. Each pre-run snapshot now records whether its run passed the
  last pre-run Stop fence. A refused restore is never sent to Stata: when the
  payload was not admitted, Stata still holds the pre-run state and the Stop
  completes; otherwise the restore fails as before, without dispatching.

### Successful prepared do-file runs no longer report a failure

- A prepared do-file run (human-file, and since #13 the Agent `do "<file>"` path)
  is driven by `scripts/runfile_finalizer_core.js`, which ended with
  `exit <rc>`. mcp-stata wraps multi-line code in `capture noisily { … }` and
  then reads `scalar <rc> = _rc`; pystata runs that bundle with `include`.
  `exit 0` ends the include before the scalar line, so mcp-stata found no return
  code and answered `success: false` for every run that returned 0. The error
  text was then taken from the last red line in the log. A nonzero exit is caught
  by the `capture`, so failures were reported correctly.
- The Workbench usually settled the run from its exact completion marker first,
  which hid the problem. In rc.7.45 FULL45 S20 (Mac) the `task_done` notice won
  twice: two Agent runs that had finished with RUN_RC 0 came back as HTTP 500,
  with "gopen: graph export failed …" (a user ado's `display as error` before
  `exit 0`) and "not found)" as the error.
- The driver now ends with `if <rc> != 0 exit <rc>`; rc 0 falls through.
  Measured in the mcp-stata bundle shape with pystata on StataNow MP: the old
  driver lost the rc for all three rc-0 bodies (plain, red line then `exit 0`,
  captured r(601)); the new driver returns 0, 0, 0, 603 and 111 for those three
  and two failing bodies. The failing bodies keep the author's own error text.

### Early Windows tooling accounted for, opt-in trust skip
- [docs/LEGACY_WINDOWS.md](docs/LEGACY_WINDOWS.md) records, per file, what became
  of the early Windows-only scripts and settings (about 60 files that were never
  under version control): merged, replaced, not needed, or open.
- `verified_workbench.py --open --disable-workspace-trust` (and
  `acceptance.py open --disable-workspace-trust`) opens a new window without the
  workspace trust prompt, as the early fast launcher always did. It is opt-in and
  applies to new launches only; the default still shows the prompt. With it, every
  extension in the private profile runs with full trust.
- The other early startup tips needed no code: the private extensions folder
  already loads only this extension, `--open` already reuses the running instance,
  and it runs no patch verifier or smoke command at startup.

## 0.1.3-rc.7.44 — Stop in the pre-run window, probe timeouts under load

- Windows Stop-cycle testing found that a soft Stop landing in the human-file
  pre-run enrich window did not stop the payload. The checkpoint task had already
  reported `task_done`, the enrich guard passed, and the `.do` file ran after the
  Stop. Soft Stop then waited on that uncancelled payload transport and escalated to
  force reset; one run ended in recovery-required. The gap is old (the same code
  from public rc.7.39 through dev.8), and the Agent bridge path had it too.
- rc.7.71 checks the reset generation before each pre-run dispatch (snapshot and the
  Run File checkpoint fallback) and again after the enrich guard, with no `await`
  between that check and the payload call. The Agent bridge takes its own generation
  right after acquiring the run. A Stop in that window now returns 409
  `PRE_RUN_CANCELLED_BY_STOP` with `payloadDispatched: false` and does not escalate.
  A Stop while the checkpoint is still incomplete keeps the existing 500
  `EXEC_REJECTED`.
- The agent client (`tools/shared_stata.py`) observes again, at most 3 times, when a
  read-only probe times out: `ps`/`lsof`, and on macOS the passive permission check
  or the window query. A timed-out permission probe is now `PERMISSION_CHECK_TIMEOUT`
  instead of `PERMISSION_CHECK_FAILED`, so it no longer gives permission advice.
  Real permission answers are not retried and the POST is never repeated. Found by
  the Mac stress run at load average about 200 (2 of 32 runs reported unconfirmed).
- `examples/platform-acceptance/stress.py`: bounded stress driver for one acceptance
  instance (sequential and concurrent agent runs; each must POST once, with unique
  run ids, an unchanged backend and reset generation, and no overlapping
  executions). Source-only; not packaged in the VSIX.
- `scripts/patch_manager.js verify` also checks the rc.7.70 Data Browser frame patch
  (source and packaged) and the rc.7.71 pre-run fence.
- README rewritten in English with a matching Chinese README (`README.zh-CN.md`).

## 0.1.3-rc.7.44-dev.8 — cancellation after connect, Stop wording, Data Browser frame

- Windows dev.5 step 9 diagnosis: a pre-run snapshot cancelled while the backend
  was still connecting ran once anyway, because `_enqueue` checked the token only
  before `_ensureClient()`. The operation body now rechecks the same token after
  connecting and rejects with `Request cancelled` through the existing cleanup.
- Human-file cancellation messages name the cause recorded in
  `__codexSupersedeHistory` (soft Stop, force reset, or soft Stop then force
  reset) instead of always saying force reset. `error.code`, `resetGeneration`
  and control flow are unchanged; `/status` adds `resetGenerationKind`.
- The Data Browser header shows the frame returned by `/v1/dataset` instead of the
  static `default` (`unknown` when the field is absent); source and packaged
  webview files are patched together.
- `firstLogAt` stays `null` when a run ends before its log is discovered; that is
  an absent observation, not a defect, and is unchanged.
- Verified on Windows x64 (stage 20261029-101315): cold first run 25.2 s, Data
  Browser shows `wb_platform`, soft Stop shows `human-file cancelled by soft Stop
  (generation 1)` with the backend unchanged. On Mac: cold first run 14.1 s, the Data
  Browser frame and the same soft Stop message. The `_enqueue` recheck is
  covered by the bundle-level test; the normal flow no longer reaches that timing.
- dev.7 default route on Windows from an empty cache: `--with mcp<2` resolved
  mcp 1.30.0 and imported the server; the same command without it resolved mcp 2.x
  and failed with `No module named 'mcp.server.fastmcp'`.

## 0.1.3-rc.7.44-dev.7 — default service stays on MCP 1.x

- The default uvx/uv route resolved mcp-stata 1.26.1 with the newest MCP; MCP 2.x
  removed the FastMCP module that mcp-stata imports. All 11 generated `--from`
  argument arrays (client default and fallback, version probes, refresh, Claude CLI /
  Codex TOML / VS Code-Cursor generators) and runtime discovery now add
  `--with "mcp<2"` after the package and before the executable.
- Behavior change: an explicitly configured command with no `args` now gets `[]`
  instead of inheriting the uvx arguments. Explicit `args` arrays, including `[]`,
  are unchanged. Generators still replace the whole target server entry.
- Acceptance constraints add the Windows-only packages installed by the tested
  service (colorama 0.4.6, pywin32 312, tzdata 2026.6) as `sys_platform == "win32"`
  constraints. Transformer and 58 behavior checks come from Codex's independent
  review; Mac cold install passed there, Windows default-route install is untested.

## 0.1.3-rc.7.44-dev.6 — backend cold start outside pre-run budgets

- Windows dev.5 acceptance step 9: after Reload Window the first Run Current File
  started mcp-stata lazily (about 62 s) inside the 60 s pre-run snapshot budget,
  so the run was refused before dispatch. `__codexBeginGraphRun` now waits for
  the backend first, under its own bound (setup timeout + 120 s), for all four
  execution entries. Timeout, failure and Stop during the wait refuse the run
  with `payloadDispatched:false`; `/status.backendStart` records the wait.
- `trueReady` is unchanged: it still means the extension accepts runs, and the
  backend still starts on the first run. dev.6 needs one Windows rerun of step 9.

## 0.1.3-rc.7.44-dev.5 — cross-platform candidate

- Share the Python receipt/client contract across Mac and Windows; native process,
  window and stable-lock adapters retain exact profile ownership. PowerShell
  wrappers delegate to the single-POST client and reject automatic reset/retry.
- Add Mac ARM, Mac Intel and Windows CI, including real Windows locks, CIM/TCP,
  argv and PowerShell tests; fix DOCX ZIP replacement while its input was open.
- Export the explicit Terminal → Graphs callback across bundle module scopes;
  retain the artifact container after output clear/restore. Native Mac failures
  and their regression controls are preserved; dev.5 passed the reloaded UI route.
- Provide a Windows physical-machine runbook and seven synthetic session fixtures.
  Evidence and remaining limits are in SYNC.md; no new universal/FULL45 acceptance.

## Unreleased

- Prepared `0.1.3-rc.7.39` with the rc.7.38 Stop/checkpoint repair using a Stata-safe 21-character local macro name and a generator-level regression gate that rejects every emitted `__codex_*` identifier longer than Stata's observed 31-character limit.

- Rejected the `0.1.3-rc.7.38` candidate during live S09 admission: the first checkpoint enrichment returned r(198) because its new 32-character local macro name exceeded Stata's identifier limit. The frozen failure stopped at step 2 before payload dispatch; no research buffer or disk drift occurred.

- The rc.7.38 repair candidate was created after FULL45 S09 proved that interrupting an unnamed graph could leave a non-graph top-level `.Graph` object behind while Stop falsely reported `RECOVERED_FULL`. The repair records whether `.Graph` preexisted, removes only a post-snapshot residue, clears same-name graph/class collisions before rebuilding saved graphs, and propagates every estimate/graph/display restore error as a nonzero restore result. Preexisting user objects remain untouched, and a malformed presence flag fails closed.

- Prepared `0.1.3-rc.7.37` to keep shared-session continuity fail-closed after Stop recovery. A dataset-only fallback is classified as `RECOVERED_DEGRADED` whenever any estimates or graphs were skipped, publishes exact loss counts through `/status.continuityLost`, and keeps `trueReady=false`; a merely reconnectable backend can no longer overrule an unrestored checkpoint. The Terminal Stop message now distinguishes complete, degraded, and failed recovery instead of claiming that partial dataset restoration preserved the full session.

- Prepared `0.1.3-rc.7.31` to make Stop reach the real StataNow interrupt path. The runtime patch now calls PyStata's supported `StataSO_SetBreak()` ABI instead of the nonexistent `sfi.breakIn`/`sfi.break_in` names, then keeps `task_done` blocked until the worker actually returns and the shared session is reusable.

- Prepared `0.1.3-rc.7.30` to make Stop wait for real worker and transport settlement before restoring a checkpoint. The pinned `mcp-stata` runtime now shields the worker result Future from server-task cancellation and publishes `task_done` only after the worker acknowledges the break; the extension independently requires the original payload/checkpoint Promise, server task, local active/pending state, active-run ownership, and cancellation source to settle. If that proof never arrives, restore occurs only after the existing owned hard-reset path replaces the backend.

- Raised the checkpoint-aware soft Stop restore floor from 15 to 30 seconds after a live small-checkpoint restore completed just beyond the old floor and unnecessarily entered hard recovery. The deadline remains complexity-aware and capped at 45 seconds; genuine timeout and restore errors still fail closed.

- Fixed soft Stop escalating a healthy full checkpoint restore after a fixed five-second deadline. The initial restore window is now bounded based on saved estimate and graph counts; the chosen timeout is exposed in `lastSoftStop.restore.timeoutMs`, while genuine timeout or restore errors still enter the owned hard-reset path.

- Fixed a completion race where the persistent Stata session SMCL contained the exact run marker but the per-run log closed before its final tail was copied. The runtime now performs a bounded post-`done` drain that rejects marker command echoes, and HTTP success remains blocked until the per-run log itself contains the standalone marker; session-only evidence fails closed as `PER_RUN_LOG_INCOMPLETE`.

- Fixed empty-session checkpoint admission rejecting a valid snapshot because Stata normalizes literal tab characters inside quoted strings to spaces. The ready marker now uses Stata's `_tab` file-write token, while the parser remains strict and fail-closed on non-tab delimiters.

- Fixed soft Stop making a recovered isolated runtime permanently not-ready after an injected dataset-restore timeout. A restore failure remains explicit in the HTTP 500 result, `lastSoftStop`, and `lastClientError`; readiness returns only when the final owned hard-reset result explicitly reports both `ok=true` and `trueReady=true`. Missing, failed, superseded, or unreadable reset evidence remains fail-closed.

- Fixed a soft-stop cancellation race during atomic Run File checkpoint enrichment. Once Stop claims a ready pre-run snapshot, the Run File failure path now leaves that snapshot and its registry entry intact for restore; unreadable ownership fails closed by retaining the checkpoint.

- Fixed visible Agent, Run Selection, Run File, and Terminal executions losing progress and exact completion after research code issued `capture log close _all`. The shared adapter now replaces only that exact transport-closing command in temporary execution code; named research logs and original `.do` bytes remain unchanged.
- Fixed internal `mcp-stata` no-capture graph fallbacks leaking stale `could not find Graph window` errors into otherwise successful visible logs. The runtime patch now preserves `_rc` while executing only Workbench-generated fallbacks with `capture quietly`; user-authored errors remain visible.
- Fixed the visible bridge remaining offline after a two-window activation race. A host that initially receives transient `EADDRINUSE` now retries the configured port on a bounded backoff, removes failed-attempt listening callbacks, cancels pending retries during disposal, and exposes bind attempts/state through `/status.bridgeBind`; non-address-in-use listen errors still fail immediately.
- Fixed the live `mcp-stata` graph detector and `list_graphs()` inventory probes leaking `could not find Graph window` before and after otherwise successful commands when graph memory was empty. The runtime patch now applies `capture quietly` only to its own inventory/metadata probes and rejects unknown upstream source shapes.
- Fixed internal graph snapshot, inventory, activation, and export probes leaking `could not find Graph window` into otherwise successful visible Terminal and Run Selection logs. Only Workbench-generated probes are quiet; user-authored graph errors remain observable.
- Fixed final `task_done` MCP notifications retaining the server transport after long Stata runs. The runtime adapter now bounds the notification to 250 ms and releases the completed background task even when the client-side notification pipe is backpressured.
- Fixed the runtime patch being applied to a configured fallback installation instead of the pinned `uvx` environment actually launched by the extension. Activation now resolves the live `uvx` `sys.prefix`, supports Python 3.12 and other `python*` site-package directories, and patches that runtime before connecting.
- Fixed the cumulative-notification template emitting literal line breaks inside a Python string and making the live `stata_client.py` fail to import. The runtime patch now preserves escaped newlines and migrates the rejected V19 template idempotently.
- Fixed the previous notification timeout remaining ineffective once Python was already blocked in a synchronous stdio write. Streamed progress now has one 4,000-character budget for the entire run, while the complete cleaned output continues to the authoritative `log_path` before optional notifications.
- Fixed long Darwin graph runs stalling after repeated PNG conversions filled an undrained Stata/PyStata shell pipe. Successful conversions are now silent and use the validated output plus `.__pngcompat_ok` marker as the only success evidence; conversion failures remain visible.
- Fixed accumulated SMCL notifications deadlocking the MCP stdio task group after Stata had already completed. The runtime adapter now writes the complete cleaned `log_path` first, caps each notification batch at 16,000 characters, bounds each 4,000-character notification to 250 ms, and falls back to the authoritative log file instead of blocking execution.
- Fixed Agent and manual-selection runs stalling on long tabulations after a fresh backend reset. The shared execution adapter now applies an idempotent `set more off` guard to every visible execution entry point while leaving research `.do` files unchanged.
- Fixed Force Reset returning READY while its disposed MCP transport was still disconnected. Client disposal now detaches the old transport atomically, and reset keeps `postRunBusy` until a bounded backend reconnect succeeds or recovery is required.

- Prepared `0.1.3-rc.6.4.4` to restore a template-safe SMCL fallback without weakening the packaged full parser. `/status.terminalWebview` now reports `fallbackActive` and `fallbackVersion`.
- Added repository and post-package VSIX integrity gates for all eight `src/ui-shared` and eight `dist/ui-shared` assets. The gates verify non-empty files, pass-through byte identity, bundled Data Browser output, and semantic Terminal CSS/SMCL anchors.
- Corrected the Terminal incident attribution: the main-profile `0.1.2` package lacked six UI assets, while missing CSP nonces and malformed generated inline JavaScript independently prevented shared-script and fallback initialization.
- Prepared `0.1.3-rc.6.4.3` after runtime inspection found that the restored Terminal's generated inline JavaScript contained an extra closing brace. The syntax error prevented all interaction and readiness messages even though external CSS rendered correctly.
- Added a permanent gate that extracts the JavaScript embedded inside the Terminal HTML template and parses it independently. External Terminal scripts now carry the current CSP nonce, and optional Sentry error reporting cannot mask fallback initialization failures.
- Prepared `0.1.3-rc.6.4.2` to fix restored Stata Terminal panels rendering as unstyled native HTML after a cold extension upgrade. The serializer now receives the current extension URI, resets scripts and local resource roots, and rebuilds HTML against the current bundle.
- Added Terminal webview readiness to `/status`: `panelExists`, `scriptReady`, `styleReady`, `bundleId`, and `readyAt`. The webview distinguishes the packaged shared script from its inline fallback and validates a concrete CSS computed-style probe.
- Added a deterministic rc.6.4.2 patch replay and wiring gate. Release progression now requires a preserved-tab cold-upgrade test and visual screenshot review before the same VSIX SHA can enter Windows acceptance.
- Prepared `0.1.3-rc.6.4.1` as a control-plane recovery candidate. It adds a dedicated internally generated `/recovery-smoke`, generation/token/runId/transport/rc/log-marker verification, structured 409/423 rejections, and recovery state in `/status`.
- Fixed `/run-command` returning HTTP 200 and releasing single-flight state before a quiet long-running Stata command completed. The visible bridge no longer treats a graph completion marker created during code preparation as executed completion evidence.
- Made the rc.6.4 route replay idempotent and added wiring checks for the visible-bridge completion policy and duplicate no-graph readiness markers.
- Made Stata Graphs `Clear All` and `POST /graph-clear` display-only. They no longer release `postRunBusy`, write graph readiness, or let empty-snapshot hydration release a stale execution state.
- Restricted force-reset cleanup to backend PIDs owned by the current extension host. Darwin no longer invokes PowerShell, and both Darwin/Windows cleanup scripts refuse force mode without explicit owned PIDs.
- Fixed Darwin exact-PID cleanup parsing for the leading whitespace emitted by `ps -Ao pid=,args=` and treat zombie state as terminated. Added a live Darwin unit that proves an explicitly owned `mcp-stata`-shaped process is selected and stopped.
- Added `scripts/control_plane_core.js`, rc.6.4 pure-logic/wiring tests, repo-target patch verification, and stronger Windows static guards. Static checks are not Windows runtime certification.
- Kept the release boundary explicit: this candidate requires isolated macOS cold-install/recovery regression and same-VSIX Windows acceptance before any dual-OS support claim.
- Added `docs/MAINTENANCE.md` documenting the workspace-first runtime patch workflow and repo-only release workflow.
- Added `scripts/export_to_repo.ps1` for previewing and applying a narrow workspace-to-repo runtime script export with SHA256 comparisons.

## 0.1.1

- Added nine public taught-task Stata examples under `examples/taught-tasks/`.
- Added dependency and packaging-boundary documentation.
- Updated README, installation, FAQ, limitations, publishing, and roadmap docs for Open VSX and GitHub Release installation.
- Normalized public taught-task examples so they write outputs relative to the current working directory instead of a local user path.

## 0.1.0

- Initial public staging release.
- Includes patched Stata Workbench bundle focused on visible shared-session execution.
- Adds helper scripts for visible bridge execution, safe execution, segmented runs, verification, and recovery.
- Adds public documentation, license/notice, packaging metadata, and CI skeleton.
- Adds Marketplace/Open VSX publishing notes, FAQ, limitations, roadmap, icon, and minimal smoke-test workspace.
# Public revision 2 — 2026-09-09

- Mac tool version 1.1.0; extension version remains 0.1.3-rc.7.39. Runtime and
  historical acceptance manifests unchanged; no research data or private receipts exported.
- Non-lossy window observations, passive consent check, explicit one-shot request,
  host/signature diagnosis and recent tccd database-error hints. Permission failure
  never becomes zero windows or automatic restart/retry; after-POST failure remains
  execution-unconfirmed rather than falsely zero-dispatch.
- Updated Chinese/English permission setup and empty Automation list guidance.
- Offline tests cover denied/required consent, inaccessible targets, timeouts,
  malformed output, genuine 0/1/multiple windows, pre- and post-POST revocation.
- Live boundary: one read-only permission request returned -1743; native check and
  correlated logs showed user permission-service database-open failure. The real
  shared client blocked with zero POST. No post-grant smoke or fresh FULL45 was
  performed; this release does not certify that blocked machine as recovered.
# 0.2.0-next.5

- F0: keep the visible bridge not-ready until checkpoint restore arbitration completes.
- D sync: retain the multi-session registry and per-session isolation from next.4.

