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
