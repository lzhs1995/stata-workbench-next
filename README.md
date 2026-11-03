# Stata Workbench Shared Session (Next)

[English](README.md) | [中文](README.zh-CN.md)

> **Development line.** This repository (`stata-workbench-next`) is where multi-session
> support, agent identity, bridge authentication and reviewed agent edits are built and
> tested. It does not replace the stable release,
> [stata-workbench-shared-session](https://github.com/lzhs1995/stata-workbench-shared-session).
> Keep using the stable release for research work until a Next build is promoted.

A VS Code extension that gives a person and AI agents one shared, visible Stata
session. Code from either side runs in the same Stata backend. Its progress
streams into the **Stata Terminal** panel while it runs, so the person can watch
an agent's run, interject, press **Stop**, fix the code and run it again. Data,
macros, scalars, estimates and graphs stay shared until someone clears them.

The Next line adds:

- **Several sessions at once.** Up to five named sessions, each with its own VS Code window, Stata backend, port and profile.
- **Authenticated bridge.** Every local bridge request needs the session's token. The agent client reads it from the session's private registry file, so nobody copies tokens by hand.
- **Reviewed agent edits.** An agent proposes a change to a `.do`, `.ado` or `.mata` file; it is written only after the person clicks **Accept** in a diff.
- **Truthful Stop and recovery.** Stop restores the pre-run checkpoint when one exists. When it cannot, the session locks instead of silently continuing on the wrong data.

Derived from [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)
(AGPL-3.0-or-later); see [License](#license).

## Contents

- [Relationship to the stable release](#relationship-to-the-stable-release)
- [Requirements](#requirements)
- [Install](#install) ([macOS](#macos), [Windows](#windows))
- [Quick start](#quick-start)
- [Features](#features)
- [Platform test results](#platform-test-results)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Configuration](#configuration)
- [Development](#development) and [License](#license)

## Relationship to the stable release

Next installs and runs side by side with the stable release. Nothing is shared
between the two, so a Next test window cannot disturb a research session.

| | Stable | Next |
| --- | --- | --- |
| Extension id | `lzhs1995.stata-workbench-shared-session` | `lzhs1995.stata-workbench-next` |
| Bridge port | `17485` | `17601` by default; the launcher picks a free port in `17601`–`17620` |
| State directory | `~/.stata-workbench-shared` (default profile) | `~/.stata-workbench-next` (`STATA_WORKBENCH_NEXT_HOME`) |
| Stata service runtime | Shared machine runtime | A private copy per session (APFS clone on macOS, full copy on Windows) |
| Sessions | One per profile and port | Up to 5 named sessions on one machine |
| Agent tools | `tools/` of the stable repository | `tools/` of this repository; they refuse a different bundle |

The Next launcher never picks ports `17485`, `17416`, `17497` or `17507`, so a
Next session cannot take a port used by stable-release tooling.

Current version: `0.2.0-next.5` (`package.json`). GitHub Releases is the only
distribution channel, and Next builds are published there as pre-releases; Next
is not published to Open VSX or the Visual Studio Marketplace.

## Requirements

| Item | Requirement |
| --- | --- |
| OS | macOS (Apple Silicon tested) or Windows 11 x64 |
| VS Code | 1.75 or later (tested: 1.139.1 on macOS, 1.144.0 on Windows) |
| Stata | A locally licensed installation (tested: StataNow on macOS, Stata 18 MP on Windows) |
| `uv` | Used once to create the Stata service runtime (`mcp-stata` 1.26.1 on Python 3.11) |
| Python 3 | For the launcher and agent tools in `tools/`. On Windows use the installed `python.exe`, not the Microsoft Store alias |
| Memory | Each open session runs its own VS Code and Stata; see [Known limitations](#known-limitations) |
| Disk | macOS: the launcher refuses to open a session below 20 GB free. Windows: 2 GB plus the size of the runtime copy |

## Install

The extension, the Stata service runtime and the agent tools are three separate
pieces. Install all three once per machine.

1. **Download the VSIX and check it, then get the tools at the same tag.**
   Download `stata-workbench-next-0.2.0-next.5.vsix` from the pre-release on
   [GitHub Releases](https://github.com/lzhs1995/stata-workbench-next/releases)
   (planned tag `v0.2.0-next.5`) and compare its SHA-256 with the value in the
   release notes: `shasum -a 256 <file>` on macOS,
   `(Get-FileHash <file> -Algorithm SHA256).Hash.ToLower()` on Windows. Then
   clone this repository and check out the same tag. The tools pin the bundle's
   SHA-256 and refuse to talk to any other build;
   `python3 -B tools/verify_release.py --vsix <file>` checks a VSIX against the
   clone's runtime manifest. To build the VSIX yourself, see [Development](#development).
2. **Install the VSIX into the shared Next extensions directory.** The launcher
   links every session's `extensions` folder to `~/.stata-workbench-next/extensions-shared`,
   so install there and not into your daily VS Code profile.
3. **Create the Stata service runtime** at the location the extension and the
   launcher look for first. If the stable release is already installed on the
   same machine, this runtime usually exists already; the launcher only reads
   it and gives each session its own copy.

### macOS

```sh
git clone https://github.com/lzhs1995/stata-workbench-next.git
cd stata-workbench-next
git checkout v0.2.0-next.5   # the tag of your VSIX

CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --user-data-dir ~/.stata-workbench-next/install-user-data \
  --extensions-dir ~/.stata-workbench-next/extensions-shared \
  --install-extension ./stata-workbench-next-0.2.0-next.5.vsix

RT=~/.local/share/stata-workbench/mcp-stata-1.26.1
uv venv --python 3.11 "$RT"
uv pip install --python "$RT/bin/python3" \
  -c examples/platform-acceptance/service-constraints.txt mcp-stata==1.26.1
```

### Windows

In PowerShell, from a clone of this repository:

```powershell
code --user-data-dir "$HOME\.stata-workbench-next\install-user-data" `
  --extensions-dir "$HOME\.stata-workbench-next\extensions-shared" `
  --install-extension .\stata-workbench-next-0.2.0-next.5.vsix

$rt = Join-Path $env:LOCALAPPDATA 'stata-workbench\mcp-stata-1.26.1'
uv venv --python 3.11 $rt
uv pip install --python "$rt\Scripts\python.exe" `
  -c examples\platform-acceptance\service-constraints.txt mcp-stata==1.26.1
```

`code` is VS Code's `bin\code.cmd`. If it is not on `PATH`, run
`Get-Command code` and fix `PATH`, or call `Code.exe` through its full path.
Use `python` instead of `python3` in all commands below.

The constraints file pins `mcp<2` (`mcp==1.28.1`). Without it, `uv` resolves
MCP 2.x and the service fails to import. A runtime elsewhere can be passed with
`--runtime-source` or `STATA_WORKBENCH_RUNTIME_SOURCE`.

## Quick start

All commands run from the repository root. Every tool prints one JSON object.

**1. Open a session.**

```sh
python3 -B tools/stata_session.py open s1 --workspace /absolute/path/to/project
```

This creates `~/.stata-workbench-next/profiles/s1/`, picks a free port, writes
the session's settings and starts one VS Code window. It returns `LAUNCHED`
right away; it does not wait for the bridge, activate the window or send any
Stata command. Without `--workspace` the session uses its own empty
`profiles/s1/workspace`.

Stata then loads in the background as the window opens
(`stataMcp.loadStataOnStartup: true`, written unless the profile already sets
it). On Windows 11 the connect took 54–66 s, and the Stata backend was up
97–108 s after `open`. `trueReady` does not wait for the load; a command sent
meanwhile waits for it inside its own 120 s pre-log budget. On Windows, send
the first command through the agent tools; see
[Known limitations](#known-limitations).

A new workspace opens in VS Code's Restricted Mode, and the extension starts
only after you click **Trust** once. Pass `--disable-workspace-trust` only for
a workspace you created yourself for this session. Set `stataMcp.stataPath` in
the window if Stata is not found.

**2. Check the session.**

```sh
python3 -B tools/verified_workbench.py --status --session s1
python3 -B tools/stata_session.py list
```

`--status` checks the installed bundle against the tools' pin and reads
`/status` through the authenticated bridge. `list` shows every profile, its
port, its VS Code processes and its live registry records (without tokens).

**3. Run code as the person.** In the window, run **Stata: Open Interactive
Terminal**, then type a command or use **Stata: Run Current File** on a `.do`
file. Each run's card is headed `You · <runId>`.

**4. Run code as an agent.**

```sh
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --code 'display c(N)' --cwd /absolute/path/to/project
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --file analysis.do --cwd /absolute/path/to/project --busy-policy wait --max-wait 60
```

The run appears live in the same Terminal, headed `claude · <runId>`. The person
can press **Stop** at any time. Exit code 0 means verdict
`PASS_VISIBLE_SHARED_RUN`; anything else exits 2. The client sends exactly one
request and never retries: a timeout or an unclear answer does not prove that
Stata did not run, so read the receipt in `.stata-receipts/` before submitting
again. The receipt contains your code and output; do not commit it.

`--session` takes a session name or id (or `STATA_WORKBENCH_SESSION`). With one
live session it may be omitted; with several it is required.

**5. Close the session.**

```sh
python3 -B tools/stata_session.py close s1
```

`close` asks only that session's VS Code window to quit (SIGTERM on macOS,
`taskkill` without `/F` on Windows) and never force-kills. If VS Code is waiting
on an unsaved-changes prompt, it returns `CLOSE_PENDING` (exit 2) and leaves the
window and files as they are. Other sessions keep running.

Other agent-client options: `--list-sessions` prints the registry; `--events 0`
prints the session's event stream (who ran what, Stop, refusals, edit
proposals) without running code.

## Features

### One visible session for a person and agents

- The editor commands are unchanged: **Run Current File** (`Ctrl+Shift+D`, macOS `Cmd+Shift+D`), **Run Selection/Current Line** (`Ctrl+Shift+Enter` / `Cmd+Shift+Enter`), **Open Interactive Terminal** (`Ctrl+Shift+C` / `Cmd+Shift+C`), **View Data**, the Stata Graphs panel and the Data Browser.
- Every run's card in the Terminal names its origin: `You · <runId>` for the person, `<agent name> · <runId>` for an agent. The runId matches the agent's receipt.
- One backend runs one request at a time. If the person presses Run while an agent is running, VS Code shows `<agent> is running Stata (<runId>). Wait for it to finish, or press Stop in the Stata Terminal.` and the refusal is logged in the event stream.
- Each session keeps an append-only event log (`~/.stata-workbench-next/runs/<sessionId>/events.jsonl`), readable with `shared_stata.py --events 0`.
- Shared memory is not durable storage. Save data and results to disk before a reset, a restart or closing VS Code.

### Several sessions

- `tools/stata_session.py` manages up to **5** live sessions. A sixth `open` returns `SESSION_LIMIT` and creates nothing.
- Each session has its own profile, port (`17601`–`17620`), Stata service runtime, temporary folders, pre-run snapshots and execution lock. Sessions run in parallel: two agents can submit to two sessions at the same moment and neither waits for the other.
- When several sessions are live, the agent client refuses a submission without `--session` (`MULTIPLE_SESSIONS`, exit 2) and runs nothing.
- Reopening a session name reuses its port. Settings that a profile already sets explicitly are kept.

### Bridge authentication

- Each session creates a random 32-byte token when its bridge starts and writes it only to its own registry file, `~/.stata-workbench-next/sessions/<sessionId>.json`. On macOS the file is mode `0600`; on Windows its access list is rebuilt to grant only the current user.
- Every bridge endpoint requires `Authorization: Bearer <token>` (missing or wrong: HTTP 401), `Host: 127.0.0.1:<port>` exactly, and no `Origin` header (otherwise HTTP 403). The token never appears in `/status` or the event stream.
- Before submitting, the agent client checks that the registry record, `/status` and the installed bundle agree on session id, port, reset generation and bundle SHA-256. Any mismatch is `SESSION_IDENTITY_MISMATCH` with nothing sent.
- The registry file is written only after the bridge has bound its port and is removed when that window closes. `close` also removes leftover temporary registry files whose writer has exited.

### Reviewed agent edits to Stata files

- An agent changes a `.do`, `.ado` or `.mata` file through `POST /propose-edit` with the file path, the new content (at most 2 MiB), the SHA-256 of the current file and a reason.
- VS Code opens a diff with **Accept** and **Reject**. The file is written only after **Accept**, and only if it is still unchanged; a timestamped copy of the old version goes to `~/.stata-workbench-next/edit-snapshots/`.
- A wrong SHA-256 (`SHA_MISMATCH`), a change by the person during review (`SHA_CHANGED_DURING_REVIEW`), a rejection or a timeout (default 120 s) never writes the file. Every outcome is recorded in the event stream.
- This gate is enforced by the extension. Agent hosts should also block direct writes: [docs/next/AGENT-EDIT-PERMISSIONS.md](docs/next/AGENT-EDIT-PERMISSIONS.md) gives the Claude Code deny rules. Codex has no equivalent per-file rule, so it must use the proposal flow.

### Stop, recovery and locking

- **Stop** in the Terminal (or `POST /soft-stop`) cancels the current run, drains its task and keeps the same Stata backend.
- Before an agent run, the session saves a pre-run checkpoint of the data. Stop puts it back, so the person sees their data as it was before the agent started. A person's own runs have no checkpoint; Stop then verifies that Stata is idle and keeps the data as it is.
- Every Stop adds 1 to `resetGeneration`. This is how agents detect that the session they used was interrupted.
- If a checkpoint was expected but could not be restored, the session **locks**: `/status` reports `trueReady: false`, further runs get HTTP 423, the status bar shows **Stata: STALE**, and the Terminal says the session did not restore the pre-run state and is locked.
- **Stata: KILL** in the status bar unlocks it: after one confirmation it force-resets the session's own backend and runs the verified recovery smoke (a fixed marker command that must return rc 0 with the marker in its log). Confirming accepts the loss of in-memory Stata data. On Windows, KILL also ends every Stata GUI process on the machine (`StataMP-64`, `StataSE-64`, `Stata-64`), not only this session's.
- The execution watchdog cancels an ordinary run that writes no log for 120 s before its first log line, or for 60 s after it (runs recognised as long tasks get 300 s and 30 min). The pre-run checkpoint is restored, but a watchdog cancel always locks the session until **Stata: KILL**. The lock reason names the stall, for example `EXEC_PRELOG_STALL (IDLE)`, and `/status.lastGuardFailure` records each cancel.
- A timeout after the code was sent is reported as `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun: true`, because the code may still run in Stata.

## Platform test results

All live tests used isolated Next profiles, synthetic `.do` files and ports
`17601`–`17620`; no research data was involved. Interface actions (Stop, Trust,
KILL) were driven through the VS Code DevTools protocol, not by a person at the
keyboard. Dates are 2026, Taipei time. Builds are `main` commits; `e7e54848`,
`579b0fe9` and `171138b6` are all version `0.2.0-next.5`, `8d63cb45` is
`0.2.0-next.4`.

### macOS (Apple Silicon, macOS 26.5, StataNow, VS Code 1.139.1)

| Check | Build, date | Result |
| --- | --- | --- |
| Person and agent share one session (globals, variables, estimates, graphs; Terminal card shows the agent name and receipt runId) | `8d63cb45`, 11-01 | Pass |
| Two, three and five sessions running at the same time | `8d63cb45`, 11-01 | Pass. Five sessions overlapped 28.57 s and each read back its own owner, N and coefficient; a sixth `open` returned `SESSION_LIMIT` |
| Registry and identity refusals (stale record, reused PID, wrong token, wrong generation, several live sessions without `--session`) | `8d63cb45`, 11-01 | Pass, 7/7 refused with nothing executed |
| Two agents submit to two sessions at the same moment (30 s commands, started 0.008 s apart) | `579b0fe9`, 11-02 | Pass. Both returned HTTP 200 in 34.41 s and 34.26 s |
| One session busy for 60 s while the other takes a short command | `579b0fe9`, 11-02 | Pass. The short command returned in 4.50 s while the long one was still running |
| Stop one of two busy sessions | `579b0fe9`, 11-02 | Pass. The stopped session returned to ready; the other finished normally with its reset generation unchanged |
| No `--session` with two live sessions | `579b0fe9`, 11-02 | Pass. `MULTIPLE_SESSIONS`, nothing executed |
| Close one of two sessions | `579b0fe9`, 11-02 | Pass. Its registry record was gone; the other session still ran code |
| Terminal Stop on the person's long command, twice | `579b0fe9`, 11-02 | Pass. Stopped on the first click each time, same Stata process, data kept |
| Stop on an agent run | `579b0fe9`, 11-02 | Pass. No force reset, pre-run state recovered (`RECOVERED_FULL`) |
| Stop after the pre-run checkpoint was removed | `579b0fe9`, 11-02 | Pass. Session locked (`trueReady: false`, next run 423, status bar STALE) |
| **Stata: KILL** unlock | `579b0fe9`, 11-02 | Pass. One confirmation, recovery smoke rc 0, next run succeeded |

### Windows (Windows 11 x64, Stata 18 MP, VS Code 1.144.0)

| Check | Build, date | Result |
| --- | --- | --- |
| New profiles turn off VS Code and extension auto-update | `171138b6`, 11-02 | Pass |
| Reviewed agent edits: accept, reject, change during review | `171138b6`, 11-02 | Pass |
| Refusals: reused PID, wrong token, port in use, stale record | `171138b6`, 11-02 | Pass, nothing sent |
| Two sessions: simultaneous agent submissions, one busy while the other submits, Stop one, no cross-talk, `MULTIPLE_SESSIONS` | `579b0fe9`, 11-02 | Pass. The two runs overlapped 40.5 s; read-backs `owner=w3a N=111` and `owner=w3b N=222` |
| Terminal Stop on the person's long command, twice | `579b0fe9`, 11-02 | Pass, 2/2: first click stopped it, same Stata process, data kept |
| Agent run stopped from the Terminal | `579b0fe9`, 11-02 | Pass. Pre-run checkpoint restored (`restored=true`); read-back N=77 |
| Stop after the pre-run checkpoint was moved away | `579b0fe9`, 11-02 | Pass. Session locked (`snapshot-expected-not-restored`) |
| Two sessions, 20 rounds of simultaneous agent submissions (40 runs, a Stop in 5 of them) | `e7e54848`, 11-03 | Pass, 20/20. The 35 runs that were not stopped all passed and no log line crossed sessions; the 5 stopped runs were restored without a force reset, and the other session's reset generation stayed unchanged (5/5). Stata PIDs unchanged for all 20 rounds |
| Terminal Stop on the person's long command, five times | `e7e54848`, 11-03 | Pass, 5/5. First click stopped it, same Stata process, data before Stop kept |
| Stop after the pre-run checkpoint was renamed | `e7e54848`, 11-03 | Pass. The notice says the session did not restore the pre-run state, is locked, and needs **Stata: KILL**; status fenced, next run 423. On `579b0fe9` the notice wrongly said the checkpoint was restored |
| Watchdog cancel of a silent agent command | `579b0fe9`, 11-02 | Partial. Pre-run checkpoint restored, but the cancel escalated to a force reset and the status reported the reason of an earlier failure |
| Watchdog cancel of a silent Terminal command | `e7e54848`, 11-03 | Pass. Quiescence probe saw its marker, no force reset; the lock reason was this cancel's own (`elapsedMs 63187`, `stallReason IDLE`) |
| First command after opening, `loadStataOnStartup=false` | `579b0fe9`, 11-02; `e7e54848`, 11-03 | Fails intermittently: stalled in 2 of 3 attempts (HTTP 504 after about 120 s, session locked); the third returned rc 0 in 42.2 s. On `e7e54848` the 504 reports `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun: true` |
| First command after opening, `loadStataOnStartup=true` | `579b0fe9`, 11-02 | Pass. Stata loaded in the background in 57.7 s while the window opened; the first command then took 6.1 s, rc 0 |
| Default `loadStataOnStartup` (key absent), first agent command after opening | `3765d82a`, 11-03 | Pass, 3/3. The launcher wrote `true`; Stata was up 106.6–107.7 s after `open`; the first agent command returned rc 0 in 23.1–25.2 s. A `false` set before `open` was kept |
| Watchdog cancel on the agent path and on the Terminal path | `3765d82a`, 11-03 | Pass. Each cancel recorded its own `runId` and `elapsedMs` (63 615 and 63 159 ms) in `/status.lastGuardFailure`; lock reason `EXEC_PRELOG_STALL (IDLE)`. Only the `IDLE` stall kind occurred |
| Late events of a cancelled cold-start command (`loadStataOnStartup=false`) | `3765d82a`, 11-03 | Pass. The command returned HTTP 504 after 167.1 s; its late `log_path` events were dropped as `not this client's run` instead of being given to the next run |
| Normal commands after such a cancel; first Terminal command after reopening | `3765d82a`, 11-03 | Partial. Same backend after unlock: 5/5 rc 0, about 3.1 s each, no foreign log lines. Reopened window with the default `true`: 0/2. The first Terminal command, sent right after `connect` completed (54.2 s), stalled before any log output and returned HTTP 504 after 163.9 s; the session locked and the second command got 423 |
| Two sessions, 8 rounds of simultaneous agent submissions with a Stop in 2; Terminal Stop 3 times | `3765d82a`, 11-03 | Pass. 14/14 runs that were not stopped passed; both stopped runs were restored without a force reset; no log line crossed sessions; 21.4–24.8 s per round. Terminal Stop 3/3 on the first click |
| `close` removes leftover temporary registry files | `171138b6`, 11-02; `e7e54848`, 11-03 | Partial on `171138b6` (one file left behind). Pass on `e7e54848`: a file whose writer had exited was removed and the registry was empty. The case of an exited process reporting error 5 did not occur (all three reported 87), so that branch has unit tests only |
| KILL notice when the recovery smoke is skipped; probe reading its own log after a late event | `e7e54848`, 11-03 | Partial. The first branch cannot be reached on Windows (KILL always runs the smoke there); the late-event shape did not reproduce in two lazy-load attempts. Both have unit tests only |

macOS Intel and Windows Server 2022 run the offline test suite and packaging in
CI on every pull request (no licensed Stata). Windows 10, Windows on ARM and
Linux are not verified.

PR #15 (Stop/KILL messages that match the actual outcome, Windows process
liveness, quiescence-probe fixes) was retested live on Windows on `e7e54848`
(rows dated 11-03). PR #17 (`e9b22430`: Stata loads at window open, a
watchdog cancel names its own stall, late events stay with their task) was
retested live on Windows on its head `3765d82a` (same bundle as `e9b22430`;
rows marked `3765d82a`). Its three fixes held, but a Terminal command sent right
after the load can still stall; see [Known limitations](#known-limitations).
macOS has not been retested live since `579b0fe9`.

## Known limitations

Fixed on `main` (`e9b22430`, PR #17) and confirmed live on Windows on `3765d82a`, 11-03, except where noted:

- **Windows: the first command after opening a window could lock the session (only partly fixed, see the first open problem below).** With `stataMcp.loadStataOnStartup: false`, Stata loads only when the first command arrives. On Windows that first command stalled in 2 of 3 attempts, returned HTTP 504 after about 120 s and locked the session. The launcher now writes `true` by default, so Stata loads while the window opens (57.7 s on Windows 11). The problem still occurs if a profile sets `false` explicitly; the launcher keeps that value and `open` says so in its `backendLoad` field. To unlock such a session, click **Stata: KILL**; to avoid it, remove the `false` entry from `profiles/<name>/user-data/User/settings.json` before `open`. macOS was not affected in the tests so far.
- **Late events from a cancelled command went to the wrong run.** On Windows a command whose cancel was reported as confirmed still ran about 2 s later, and its late log event was given to the run that came next (the quiescence probe). The session was locked, so nothing built on the wrong state, and since PR #15 such a response reports `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun: true` (confirmed live on Windows, `e7e54848`). PR #17 now keeps events with their task: after a run ends without its response, events with an unknown task id are no longer given to the active run but are held or dropped. The holding buffer keeps at most 256 events; if all of them are `log_path` or `task_done` events, a new `task_done` can be dropped.
- **A watchdog cancel could show an earlier failure's reason.** On the agent path the status after a watchdog cancel repeated the reason and timing of an earlier Terminal failure. Each cancel now writes its own `stallReason` and `elapsedMs`, and the lock reason reads for example `EXEC_PRELOG_STALL (IDLE)`. The `reasonCode` itself is still `EXEC_PRELOG_STALL` for every stall kind, because clients match on it.

Open problems on the current `main`:

- **Windows: a Terminal command sent right after Stata loads can still lock the session.** In the retest on `3765d82a` the first agent command after opening passed 3/3, but the first Terminal command, sent right after `connect` completed, stalled before any log output, returned HTTP 504 after 163.9 s and locked the session (the next command got 423). Offline analysis of the bundle shows that the agent path waits until the Stata worker is running before it dispatches, and the Terminal path does not; the Windows-side blocking point is not yet confirmed. A fix that makes Terminal commands wait for the same warm-up (FIX6) is in review and not merged. Until then, on Windows send the first command after `open` through the agent tools (the path that passed 3/3); if a session locks, click **Stata: KILL**.

- **A command sent while Stata is still loading** waits for the load inside its own 120 s pre-log budget, because `trueReady` does not wait for the background load. This case has not been tested live.
- **Stata: KILL on Windows ends every Stata GUI process on the machine**, not only this session's. Save work in other Stata windows before confirming it.
- **Silent long commands.** A command that writes no log output for 60 s (for example a `bootstrap … nodots`) is treated as stalled and cancelled. This rule is inherited from the stable release. Add progress output to long commands.
- **Windows dispatch overhead.** Each agent submission on Windows took about 15 s longer than the Stata work itself (pre-dispatch checks and receipt verification); a short command took 17.4 s end to end. In 20 rounds of an 8 s command the fixed cost was 12–18 s per submission.
- **Service start can wait for PyPI.** Before starting the Stata service, the extension checks PyPI for the `mcp-stata` version. On a machine where that request times out, the timeout adds to the first start.
- **Memory.** Each session is a full VS Code plus Stata. On macOS five sessions used 3852–4000 MB RSS in total (718–850 MB each). On a 16.8 GB Windows machine, two idle sessions had working sets of 1.93 and 2.16 GB, and 2.00–2.39 GB each under load. Check free memory before opening a third session on a machine of that size.
- **Workspace Trust.** A new workspace needs one **Trust** click before the extension starts.
- **Agent hosts.** Codex has no per-file deny rule for `.do` files; see [Reviewed agent edits](#reviewed-agent-edits-to-stata-files).
- **Inherited from the stable release:** a top-level `exit` inside a multi-line selection ends the whole selection and is reported as a failure; the Data Browser frame name updates only when the browser opens; `graph use` alone does not create a Terminal graph card; equality of the displayed source and the executed bytes is not certified.
- `dist/extension.js` is the maintained bundle. A reference source build exists, but feature parity with the bundle is not established.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `open` returned `LAUNCHED` but `--status` cannot connect | The window is in Restricted Mode. Click **Trust** in that window once |
| `SESSION_LIMIT` | Five sessions are live. `close` one first |
| `NO_FREE_PORT` | Every port in `17601`–`17620` is in use by another Next profile or another program |
| `DISK_RESERVE` | Free disk space is below the launcher's limit; nothing was created |
| `RUNTIME_SOURCE_MISSING` | Create the Stata service runtime ([Install](#install)) or pass `--runtime-source` |
| `EXTENSIONS_LINK_MISMATCH` | The profile's `extensions` link points to another directory. Pass the same `--extensions-dir` you used before |
| `SETTINGS_NOT_PLAIN_JSON` | The profile's `settings.json` has comments or is not a JSON object; the launcher changed nothing |
| `MULTIPLE_SESSIONS` | Several sessions are live. Pass `--session <name>` or set `STATA_WORKBENCH_SESSION` |
| `SESSION_IDENTITY_MISMATCH` | The registry and `/status` disagree (for example after a reload). Run `--status --session <name>` again; nothing was executed |
| `candidate identity mismatch` | The installed VSIX is not the build your clone pins. Check out the commit of the VSIX |
| HTTP 401 or 403 from the bridge | Requests need the session token, `Host: 127.0.0.1:<port>` and no `Origin`. Use the agent tools, which read the token from the registry |
| Status bar **Stata: STALE**; runs return HTTP 423 | Click **Stata: KILL** and confirm. It force-resets the session's backend and runs the recovery smoke itself; in-memory data is lost |
| Windows: first command after opening returns HTTP 504 (`EXEC_PRELOG_STALL` or `EXEC_OUTCOME_UNKNOWN`) and the session locks Not fully fixed: on `3765d82a` a Terminal command sent right after the load still stalled once (HTTP 504 after 163.9 s), and it also happens when the profile sets `loadStataOnStartup` to `false`. Send the first command through the agent tools. Click **Stata: KILL** to unlock; on Windows KILL also ends every other Stata GUI process on the machine. Check the receipt before resubmitting, because the command may still have run. Remove the `false` entry before the next `open` |
| `close` returned `CLOSE_PENDING` | VS Code is asking about unsaved changes in that window. Answer it, then run `close` again |
| `No module named 'mcp.server.fastmcp'` | The runtime was installed with MCP 2.x. Reinstall it with the constraints file |
| A timeout or unclear agent result | Do not resubmit blindly. Read the receipt and `--events` first; a timeout is not proof that Stata did not run |

## Configuration

The launcher writes these VS Code settings into each session's profile:

| Setting | Value | Meaning |
| --- | --- | --- |
| `stataMcp.visibleBridgePort` | Chosen port | Bridge port (package default `17601`) |
| `stataMcp.nextSessionName`, `stataMcp.nextProfilePath`, `stataMcp.nextMcpConfigPath` | Set by the launcher | Session identity; do not edit |
| `stataMcp.loadStataOnStartup` | `true` unless already set | Load Stata in the background when the window opens (on Windows 11 the connect took 54–66 s; the backend was up 97–108 s after `open`). `trueReady` does not wait for it |
| `update.mode`, `extensions.autoUpdate`, `extensions.autoCheckUpdates` | `none`, `false`, `false` unless already set | Keep test windows from updating VS Code or extensions |

All other `stataMcp.*` settings (`stataPath`, `runFileWorkingDirectory`,
`requestTimeoutMs`, `enableExecuteTimeout`, `maxOutputLines` and so on) work as
in the stable release.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATA_WORKBENCH_NEXT_HOME` | `~/.stata-workbench-next` | State directory: profiles, registry, runs, extensions |
| `STATA_WORKBENCH_SESSION` | — | Session name or id for the agent tools |
| `STATA_WORKBENCH_AGENT_NAME` | `agent` | Name shown on the agent's Terminal cards and in the event stream |
| `STATA_WORKBENCH_RUNTIME_SOURCE` | Machine runtime (see [Install](#install)) | Runtime that `open` copies into a new session |
| `STATA_WORKBENCH_CODE` | VS Code in its standard location | VS Code to launch |

## Development

```sh
npm ci --ignore-scripts
npm run check -- --keep-going
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run package` produces `stata-workbench-next-<version>.vsix`. CI runs these
steps on macOS 15 (Apple Silicon and Intel) and Windows Server 2022 without
Stata, a GUI or credentials, plus a separate reference source build. Locally,
`scripts/mac/test_png_compat_unit.js` (a private image corpus) and
`scripts/test_stata_preflight_timeout_patch.js` (an installed runtime) depend
on machine-specific files and are known to fail on the maintainer's Mac; they
pass in CI.

Bundle changes are readable patch scripts in `scripts/` applied to the
maintained `dist/extension.js`. Each later patch can be reverted and is
registered in `scripts/later_bundle_patches.js` and `scripts/patch_manager.js`.
After a bundle change, refresh `release/runtime-manifest.json` and the
`BUNDLE_SHA256` pin in `tools/verified_workbench.py`; replaying the patches
twice must give the same bytes.

More: [checks that need a licensed machine](docs/next/LIVE-CHECKS.md),
[cross-platform notes](docs/CROSS_PLATFORM.md),
[shared execution and concurrency](docs/shared-execution-and-concurrency.md),
[release maintenance](docs/RELEASE.md) and the [changelog](CHANGELOG.md).

## License

AGPL-3.0-or-later. Derived from
[tmonk/stata-workbench](https://github.com/tmonk/stata-workbench). Design
comparisons with [hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp)
are acknowledged in [NOTICE](NOTICE); they are not a claim that the runtimes are
interchangeable. See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).

Stata, Stata licenses, credentials and data are not included. The bridge
listens on `127.0.0.1` only; it is not a remote or multi-user service.
