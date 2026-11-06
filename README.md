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

Current version: `0.2.0-next.6` (`package.json`); see the [changelog](CHANGELOG.md). GitHub Releases is the only
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
   Download `stata-workbench-next-0.2.0-next.6.vsix` from the pre-release
   [`v0.2.0-next.6`](https://github.com/lzhs1995/stata-workbench-next/releases/tag/v0.2.0-next.6)
   and compare its SHA-256 with the value in the release notes: `shasum -a 256 <file>` on macOS,
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
git checkout v0.2.0-next.6   # the tag of your VSIX

CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --user-data-dir ~/.stata-workbench-next/install-user-data \
  --extensions-dir ~/.stata-workbench-next/extensions-shared \
  --install-extension ./stata-workbench-next-0.2.0-next.6.vsix

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
  --install-extension .\stata-workbench-next-0.2.0-next.6.vsix

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
the session's settings and starts one VS Code window. It waits up to 60 s for
that window's VS Code process to appear and reports it in `launchState`
(`visible`, `accepted-not-visible` or `prepare-only`); it does not wait for the
bridge, activate the window or send any Stata command. `LAUNCHED` alone does not
mean the bridge is ready. Without `--workspace` the session uses its own empty
`profiles/s1/workspace`.

Stata then loads in the background as the window opens
(`stataMcp.loadStataOnStartup: true`, written unless the profile already sets
it). On Windows 11 the connect took 54–66 s, and the Stata backend was up
97–108 s after `open`. `trueReady` does not wait for the load. A Terminal
command or an agent submission sent meanwhile first waits until the Stata
worker is running; after 2 s the Terminal shows "Waiting for Stata to finish
loading…". See [Known limitations](#known-limitations).

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

`REFUSED_NOT_DISPATCHED` means the extension refused the run before sending it
(for example Stata did not finish loading, or the person pressed Stop during the
wait). The output carries `reasonCode`, `retryable` and `retryAfterMs`; a
refusal after Stop is not retryable.

A command that Stata ran and rejected with an error (for example `r(111)`)
exits 2 and is not retried. When the extension can confirm the error from this
run's own log and mcp-stata's return code, the verdict is
`STATA_ERROR_CONFIRMED` with `stataRc`; otherwise it stays
`EXECUTION_UNCONFIRMED_NO_RETRY`. Either way the receipt holds Stata's error
text, and the commands before the error may have changed the data. This path was
checked live on macOS on `b82203d` only; see [Known limitations](#known-limitations).

When a person stops the agent's run in VS Code with the Terminal Stop button or
**Stata: Cancel Current Request**, the verdict is `STOPPED_NO_RETRY` (exit 2, not
retried) if the same Stop restored this run's pre-run checkpoint and the session
is ready again. On an agent run only the Terminal Stop button has been checked
live (macOS).
Part of the code may have run before the Stop. A Stop through
`POST /soft-stop` or by the watchdog stays `EXECUTION_UNCONFIRMED_NO_RETRY`, with
the source in `stopReportedBy`. The **Cancel** of a Run File or Run Selection
notification belongs to that person's own run only: it cannot stop an agent run
that took over the session, and that person's run gives no agent-client verdict.

`--session` takes a session name or id (or `STATA_WORKBENCH_SESSION`). With one
live session it may be omitted; with several it is required.

**5. Close the session.**

```sh
python3 -B tools/stata_session.py close s1
```

`close` asks only that session's VS Code window to quit (SIGTERM on macOS,
`taskkill` without `/F` on Windows) and never force-kills. If VS Code is waiting
on an unsaved-changes prompt, it returns `CLOSE_PENDING` (exit 2) and leaves the
window and files as they are. If an `open` of the same session is still in
progress, it returns `OPENING` (exit 2) and signals nothing. Other sessions keep
running. On macOS the result also lists processes still holding the session's
files (`leftoverProcesses`) and Stata workers that may have outlived their
server (`orphanWorkers`). `close` only reports them (`orphanCleanup.mode`
`report-only`, `signalled: []`); `orphanCleanup.clean` is true only when every
read succeeded and nothing was left over. The scan looks at the session's
workspace folder and the files directly in it, not at deeper subfolders, and
process reads are not atomic, so `clean` means nothing was seen in that scope,
not that no process under the profile is alive.

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
- Reopening a session name reuses its port once that port is free. Right after `close` the old port can still be held by the operating system (TIME_WAIT); the launcher then picks the next free port. Tools find a session by name, so this does not affect them. Settings that a profile already sets explicitly are kept.
- Several `open` calls can run at the same time. Each reserves its name, port and session slot under a short lock and launches outside it; the runtime copies run one after another so each sees the disk space the previous one used. A second `open` of a name that is still opening is refused.

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
- **Stata: KILL** in the status bar unlocks it: after one confirmation it force-resets the session's own backend and runs the verified recovery smoke (a fixed marker command that must return rc 0 with the marker in its log). Confirming accepts the loss of in-memory Stata data. On Windows, KILL ends only this window's Stata Workbench backend (its python/mcp-stata process tree, matched by parent process and creation time); other VS Code windows and any Stata you opened yourself are not touched. Processes it cannot confirm as this window's are not targeted. When a termination was requested but its result, or the check for processes left behind, could not be confirmed, the session stays not ready: the notice lists those pids and start times with a PowerShell command to check them, and the way out is to close this VS Code window and open a new one. Closing the window does not prove those processes ended. On macOS KILL ends the registered backend pid, as before.
- The execution watchdog cancels an ordinary run that writes no log for 120 s before its first log line, or for 60 s after it (runs recognised as long tasks get 300 s and 30 min). After the first log line, CPU time used by this window's own Stata worker also counts as progress, so a quiet computation such as `bootstrap … nodots` is not cancelled at 60 s while the worker keeps computing. CPU activity is not proof of useful work: a run that loops without output can keep the session busy until its log has been silent for 30 min. Press Stop or **Stata: KILL** to end it earlier. If the worker's CPU time cannot be read and verified, the watchdog uses the log rule alone. The pre-run checkpoint is restored, but a watchdog cancel always locks the session until **Stata: KILL**. The lock reason names the stall, for example `EXEC_PRELOG_STALL (IDLE)`, and `/status.lastGuardFailure` records each cancel. `/status.watchdogCpu` shows the CPU counters, credits and failed samples by kind for the running guard and the last agent and Terminal guards.
- Stop pressed while the backend is still starting, before anything was sent, refuses the command (`PRE_RUN_BACKEND_START_CANCELLED`) and does not lock the session.
- A timeout after the code was sent is reported as `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun: true`, because the code may still run in Stata.

## Platform test results

All live tests used isolated Next profiles, synthetic `.do` files and ports
`17601`–`17620`; no research data was involved. Interface actions (Stop, Trust,
KILL) were driven through the VS Code DevTools protocol, not by a person at the
keyboard. Dates are 2026, Taipei time. Builds are `main` commits; `e7e54848`,
`579b0fe9` and `171138b6` are all version `0.2.0-next.5`, `8d63cb45` is
`0.2.0-next.4`.

Rows dated 11-04 come from two kinds of build. `aba81779` is the
`v0.2.0-next.5` release. `a1a2832b` (PR #21), `40abcbea` (PR #20) and
`2ec968a` (PR #24) are pull-request heads tested before their review rework
and before merging. macOS was later retested live on `main` `b0bc49d` and, for
Stata error return codes and the orphaned worker after KILL only, on `b82203d`.
PR #30 was checked live on its final head `8739778`, which has the same tree as
its merge `e0b4e11`. PR #31 was checked live on macOS on its heads `db105f28`
and `4a1ac2e`, before its last review rework; see
[Known limitations](#known-limitations).

<!-- FMAC-RESULT -->
On 11-06 the merged runtime was retested live: macOS on `d5b03df` (PR #31's merge candidate; the same extension bundle and cleanup core as `main` `d020b036`, only the Python `close` tool differs) and Windows on `main` `d020b036` (15 of 16 checks passed). These runs found the two macOS defects fixed by PR #32 and PR #33 and the Windows KILL recovery defect below. PR #33's last commit `32ff282` (the stop checks around its resume step) has offline tests only. A run of both platforms on the release commit is still to do.
<!-- /FMAC-RESULT -->

<!-- KW-RESULT -->
The Windows KILL recovery defect they found is fixed by PR #34 (rc.7.90). On 11-07 Windows was retested live on `main` `80e01c8` (the merge of #34): with two live sessions, a real **Stata: KILL** on one ended only that window's backend tree, the window recovered by itself (recovery smoke passed, next command rc 0) and the other window kept its processes and ran its next command with rc 0.
<!-- /KW-RESULT -->

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
| First command after opening, `loadStataOnStartup` `false` (5) and `true` (2) | `aba81779`, 11-04 | Pass, 7/7 HTTP 200 and rc 0, no stall before the first log line. The command waited for Stata to load (11–14 s with `false`, about 7 s with `true`, 61 s on the first cold start), and the Output log showed "Waiting for Stata to finish loading…" then "finished loading after N s" |
| Command sent while Stata is still loading: Stop, timeout, failed worker | `aba81779`, 11-04 | Pass. Stop during the wait: HTTP 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`, nothing sent, next command rc 0. Worker frozen: HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT` after 336.5 s, session not locked. Worker then killed: HTTP 500 `PRE_RUN_BACKEND_WARMUP_FAILED`; the next command waited 37 s for a new load and returned rc 0 |
| Stop pressed before the backend finished connecting | `aba81779`, 11-04 | Fail. Nothing had been sent, but soft Stop returned 500 after 35.6 s and the session locked (`soft-stop-did-not-restore-checkpoint`). Failed on this build. Fixed in rc.7.83 (PR #25); passed live on `main` `b0bc49d` (Stop before connect refused the command without locking, next command rc 0) |
| Terminal Stop button on a running command | `aba81779`, 11-04 | First run 0/2: the test driver clicked a point covered by the Welcome page's transparent overlay, so the click never reached the Terminal. With Welcome closed, the mouse click, a click inside the Terminal view and **Stata: Cancel Current Request** each stopped the run, without locking |
| Person and agent take turns; person submits during an agent run | `aba81779`, 11-04 | Pass. The person's submission got HTTP 409 `bridge busy` naming the agent; both read the same owner, N and coefficient afterwards |
| **Stata: KILL** with two live sessions | `aba81779`, 11-04 | Pass. Only the locked session's three processes were replaced; the other session's 40 s command finished with rc 0 |
| Five live sessions, three simultaneous submissions | `aba81779`, 11-04 | Partial. A sixth `open` got `SESSION_LIMIT`. Of three simultaneous submissions two passed; an agent submission sent about 20 s after its window reported ready was refused before dispatch (`BLOCKED_NO_DISPATCH`) because its backend had not started. Failed on this build. Fixed in rc.7.86 (PR #26); passed live on `main` `b0bc49d` (agent submission right after opening ran with rc 0 and matched `lastCold.runId`) |
| Quiet long command under heavy load (load average 120–140) | `aba81779`, 11-04 | Fail. A `bootstrap … dots(50)` run wrote no new log for 60 s, was cancelled at 63 s as `EXEC_PRELOG_STALL (IDLE)` and the session locked. rc.7.84 (PR #24) adds the worker CPU signal |
| Worker CPU signal: idle noise and a real hang | `2ec968a`, 11-04 | Pass. An idle worker's CPU time grew 10 ms per 12 s (threshold 200 ms). A worker frozen with SIGSTOP was still cancelled, 69.7 s after it froze; after KILL the next command returned rc 0. The quiet-command check finished inside its first-log budget, so the 60 s idle path with CPU credit was not exercised live |
| Stata error from an agent (`display nosuchvar`) | `b82203d`, 11-05 | Pass. `STATA_ERROR_CONFIRMED`, `stataRc` 111, all error checks true; the Terminal card showed RC 111. The next agent command returned rc 0 and the session stayed ready |
| Stata error typed by a person in the Terminal | `b82203d`, 11-05 | Pass. The run finished as failed with rc 111 and the panel showed `RC 111` and `r(111);`. The next typed command returned rc 0, then an agent command rc 0 |
| **Cancel** in a person's Run File notification ("Running long_dots.do [Cancel]") | `8739778` (PR #30), 11-05 | Pass. The click stopped the run through the same Stop as the Terminal button; the session was idle 5 s later with the pre-run state restored, and the next command typed into the panel returned rc 0 |
| A person's Terminal Stop on an agent run | `8739778` (PR #30), 11-05 | Pass. The agent got `STOPPED_NO_RETRY` with `stoppedBy` person and all stop checks true; one request sent, none retried. The next agent command passed |
| Package, `verify_release` and installed bundle | `d5b03df`, 11-06 | Pass. The VSIX bundle and the installed bundle equal the pinned SHA-256; `verify_release --vsix` 116/116; the 115 files of the runtime manifest match the installed copy |
| First command after opening, `true` and `false`, twice each; Stop while waiting | `d5b03df`, 11-06 | Pass, 4/4 with the wait message in the panel and the log. Stop while waiting (through `/soft-stop`) refused with `PRE_RUN_BACKEND_WARMUP_CANCELLED`, nothing sent, next command rc 0 |
| Run File notification **Cancel**; a person's Terminal Stop on an agent run | `d5b03df`, 11-06 | Pass. Cancel stopped the run with its pre-run state restored and the next typed command returned rc 0. The agent got `STOPPED_NO_RETRY` (one request, no retry, all 8 stop checks true) |
| An old notification's **Cancel** while a newer run is going | `d5b03df`, 11-06 | Not reached. In 3 attempts the old notification closed 4.7–10 s before the newer run's notification appeared; the newer run returned rc 0 each time. Offline tests only |
| Stata error from an agent and from a person | `d5b03df`, 11-06 | Pass. Agent: `STATA_ERROR_CONFIRMED`, `stataRc` 111, next agent command rc 0. Person: rc 111, next typed command rc 0 |
| Four live sessions: turns, a failing command, Stop, KILL on one | `d5b03df`, 11-06 | Pass. KILL on one session replaced only its own three processes; another session's 40 s loop finished with rc 0. A mouse click on the panel Stop during a person's Run File still lands on the notification; the notification's Cancel stops the run |
| KILL during a quiet command (orphaned worker) | `d5b03df`, 11-06 | Pass. The old worker and its resource tracker were ended; a test process in the same folder with a worker-like command line kept its pid and start time |
| Quiet `bootstrap … reps(400) nodots`; `/status.watchdogCpu` | `d5b03df`, 11-06 | Pass. Silent for 105 s, finished rc 0 in 108 s with CPU credit (7 of 8 samples, 0 errors); `watchdogCpu` present in all 22 polls |
| Force reset with this window's worker stopped (SIGSTOP) | `d5b03df`, `d020b036`, 11-06 | Fail, 4 of 4. About a second after the force reset ended the server, the extension host exited (code 0); only VS Code main was left and `close` returned `CLOSE_PENDING`. Not seen on `e0b4e11` (before #31). Fixed by PR #33 |
| The same control on PR #33's first head | `3c8e4f3`, 11-06 | Pass, 2/2. The worker was resumed before any terminating signal and the extension host survived; **Stata: KILL** unlocked the session, the next command returned rc 0 and `close` returned `CLOSED`. One run had one `host-group-unknown` row (nothing sent; cause not found) |
| `close` with a process still holding the workspace | `d5b03df`, `d020b036`, 11-06 | Fail on `d5b03df`: every `lsof +d` exited 1 with rows, and `close` reported `identity-unreadable` and `holders: unknown`. Pass with #32's `close` tool (`main` `d020b036`): a live test process holding the workspace was listed as unresolved (`holders: present:1`, `clean: false`, nothing signalled). A real Stata worker that outlives its window was not produced |

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
| First Terminal command right after `connect` completed, fresh window | `e5d2cda7`, 11-04 | Pass, 3/3. HTTP 200, rc 0 in 3.05–3.12 s; the second command also passed. Before dispatch the extension checked the worker state (`list_sessions` 4–6 ms; the worker was already running, so the wait message did not appear). The same check on `3765d82a` also passed 2/2, so this retest does not show that the earlier stall is gone |
| First agent command after opening; 4 agent runs with a soft Stop in the last; Terminal Stop | `e5d2cda7`, 11-04 | Pass. First agent command rc 0 in 11.5 s. Runs 1–3 passed in 14.4–15.7 s; the stopped run was restored (`restored=true`, no force reset) and the data from before the Stop was kept. Terminal Stop stopped the run on the first click, same Stata process |
| First Terminal command after opening, with per-step timing (`loadStataOnStartup` `true` and `false`, new and reused profiles) | `a1a2832b`, 11-04 | Pass, 24/24 HTTP 200 and rc 0, including 10 runs on fresh profiles. Each first command waited 16–60 s for Stata to load, then the run, its log path and the first output followed within 0.6 s. The older build `3765d82a` with the same timing lines stalled once in 17 runs (HTTP 504 after about 120 s); see [Known limitations](#known-limitations) |
| Four 8 s commands with a soft Stop in the second; one Stop from the Terminal button | `a1a2832b`, 11-04 | Pass. Stop returned in 1.65 s with the checkpoint restored and no force reset; the other three rounds each logged their start and end lines; the Stata process stayed the same. The Terminal Stop stopped the run on the first click. The first Run click right after the panel took focus did nothing, as in earlier Windows tests |
| Command sent while Stata is still loading (worker suspended): Stop, timeout, restart | `40abcbea`, 11-04 | Pass. Stop during the wait: refused with `PRE_RUN_BACKEND_WARMUP_CANCELLED`, nothing in the Stata log. Timeout: HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT` after 300.1 s, nothing sent. After resuming, the next command returned rc 0 in 46.1 s; its worker had failed while starting, was restarted once and loaded in 43 s, and the command ran once. A visible `PRE_RUN_BACKEND_WARMUP_FAILED` did not occur (a wrong `stataPath` still loaded Stata). The wait message appeared in the Output log; the test input path does not draw the Terminal panel, so the panel text is unverified on Windows |
| `/panic-kill?dryRun=1` with two live sessions | `d020b036`, 11-06 | Pass, 2/2. Each window selected only its own 4-process tree; the two sets were disjoint |
| **Stata: KILL** on one of two live sessions | `d020b036`, 11-06 | Scope pass, recovery fail. Only the killed window's tree ended; the other window kept its pids and its next command returned rc 0. The killed window's recovery smoke failed (`transport-failed`) and its next command got HTTP 423 `panic-kill-command-needs-smoke`; see the note at the top of this section |
| **Stata: KILL** on one of two live sessions, after PR #34 | `80e01c8`, 11-07 | Pass. Only the killed window's tree ended ("ended 3 of 4 … already exited 1"); 77 s after the click the killed window showed "the verified recovery smoke passed; the session is READY", had a new backend (`resetGeneration` 1) and ran its next command with rc 0 without being closed. The other window kept its pids and ran its next command with rc 0 |
| Stata error, then a person's Terminal Stop, after the KILL recovery | `80e01c8`, 11-07 | Pass. On the recovered window `display nosuchvar` gave `STATA_ERROR_CONFIRMED` with `stataRc` 111 and the next command rc 0. On the other window a person's Terminal Stop on an agent run gave `STOPPED_NO_RETRY` and the next command rc 0; both windows closed with `CLOSED` |
| Stata error from an agent (`display nosuchvar`) | `d020b036`, 11-06 | Pass. `STATA_ERROR_CONFIRMED`, `stataRc` 111, all 12 error checks true, next command rc 0. The Stata log has `r(111);`; the extension log has no error text |
| Quiet long command (`bootstrap … reps(400) nodots`, no log output) | `d020b036`, 11-06 | Pass. Ran 192.8 s with rc 0 and was not cancelled; CPU credit in 14 of 15 samples, 0 errors; `/status.watchdogCpu` present |
| Command sent while the backend is frozen: failure, Stop | `d020b036`, 11-06 | Pass. Failure: after 51 s the panel showed `PRE_RUN_BACKEND_WARMUP_FAILED`, nothing sent, the next command rc 0. Stop during the identity probe: HTTP 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`, nothing sent; the `/soft-stop` call itself took 58 s and the session stayed locked (Known limitations) |
| First commands; wait message in the real Terminal panel | `d020b036`, 11-06 | Pass. Agent submissions right after opening passed with `loadStataOnStartup` `true` and `false`; the first Terminal command with `false` returned rc 0 in 73.4 s. The panel showed "Waiting for Stata to finish loading" from 4.7 s to 42.7 s, then the output |
| A person's Terminal Stop on an agent run; `close` | `d020b036`, 11-06 | Pass. `STOPPED_NO_RETRY`, `stoppedBy` person, all stop checks true, next command rc 0. Six `close` calls returned `CLOSED` |

macOS Intel and Windows Server 2022 run the offline test suite and packaging in
CI on every pull request (no licensed Stata). Windows 10, Windows on ARM and
Linux are not verified.

PR #15 (Stop/KILL messages that match the actual outcome, Windows process
liveness, quiescence-probe fixes) was retested live on Windows on `e7e54848`
(rows dated 11-03). PR #17 (`e9b22430`: Stata loads at window open, a
watchdog cancel names its own stall, late events stay with their task) was
retested live on Windows on its head `3765d82a` (same bundle as `e9b22430`;
rows marked `3765d82a`). Its three fixes held, but a Terminal command sent right
after the load stalled once. PR #18 (`1bf02d02`: Terminal commands wait for
the Stata warm-up before dispatch) was retested live on Windows on its head
`e5d2cda7` (same source tree; rows dated 11-04); see
[Known limitations](#known-limitations). macOS was retested live on the
`v0.2.0-next.5` release (`aba81779`) on 11-04, and again on `main` `b0bc49d`
(after PRs #19–#21 and #23–#26, before #27, #28 and #22) on 11-04 to 11-05; the
failures found there are listed under [Known limitations](#known-limitations).
On 11-06 macOS was retested on `d5b03df` and Windows on `main` `d020b036`
(rows dated 11-06), and on 11-07 Windows on `main` `80e01c8` after PR #34
(rows dated 11-07).

## Known limitations

Fixed on `main` (`e9b22430`, PR #17) and confirmed live on Windows on `3765d82a`, 11-03, except where noted:

- **Windows: the first command after opening a window could lock the session (the remaining stall is covered by the warm-up fix below).** With `stataMcp.loadStataOnStartup: false`, Stata loads only when the first command arrives. On Windows that first command stalled in 2 of 3 attempts, returned HTTP 504 after about 120 s and locked the session. The launcher now writes `true` by default, so Stata loads while the window opens (57.7 s on Windows 11). The problem still occurs if a profile sets `false` explicitly (last checked on `3765d82a`); the launcher keeps that value and `open` says so in its `backendLoad` field. To unlock such a session, click **Stata: KILL**; to avoid it, remove the `false` entry from `profiles/<name>/user-data/User/settings.json` before `open`. macOS was not affected in the tests so far.
- **Late events from a cancelled command went to the wrong run.** On Windows a command whose cancel was reported as confirmed still ran about 2 s later, and its late log event was given to the run that came next (the quiescence probe). The session was locked, so nothing built on the wrong state, and since PR #15 such a response reports `EXEC_OUTCOME_UNKNOWN` with `payloadMayHaveRun: true` (confirmed live on Windows, `e7e54848`). PR #17 now keeps events with their task: after a run ends without its response, events with an unknown task id are no longer given to the active run but are held or dropped. The holding buffer keeps at most 256 events; if all of them are `log_path` or `task_done` events, a new `task_done` can be dropped.
- **A watchdog cancel could show an earlier failure's reason.** On the agent path the status after a watchdog cancel repeated the reason and timing of an earlier Terminal failure. Each cancel now writes its own `stallReason` and `elapsedMs`, and the lock reason reads for example `EXEC_PRELOG_STALL (IDLE)`. The `reasonCode` itself is still `EXEC_PRELOG_STALL` for every stall kind, because clients match on it.

Fixed on `main` after `0.2.0-next.5`, with offline tests and CI. macOS was retested live on `main` `b0bc49d` (before #27, #28, #22, #30 and #31), PR #30 on its final head `8739778`, and PR #31 on heads before its last review rework. On 11-06 macOS was retested on `d5b03df` (the merged bundle) and Windows on `main` `d020b036`; results are noted per item:

- **Windows: the first Terminal command after Stata loads stalled now and then (W-P1).** Per-step timing (PR #21) located the stall. In the one stalled run out of 33, Stata's own start-up inside the worker took 76.6 s between its pre-flight check and the end of `stata_setup.config` (3.4–8.6 s in the other 32 runs). The command was queued, not lost: the old build counted this wait against the command's 120 s first-log budget and cancelled it 1.7 s before Stata was ready. Since PR #18 a command first waits for Stata to load (up to 300 s by default) outside that budget. Builds with that wait had 0 stalls in 24 runs, 10 of them on fresh profiles. This is a statistical bound (true stall rate below about 12.5 % at 95 % confidence), not proof that the stall cannot occur. A Stata start-up longer than the limit is refused before dispatch (`PRE_RUN_BACKEND_WARMUP_TIMEOUT`) instead of locking the session.
- **Quiet long commands were cancelled after 60 s** (inherited from the stable release). The watchdog now also counts CPU time of this window's own Stata worker as progress (PR #24, rc.7.84). See the CPU-signal limits below; on the 11-04 macOS retest under heavy load such a command was still cancelled, after failed CPU samples; PR #31 changed that (below).
- **Stop before the backend finished connecting locked the session.** It now refuses the command without locking (PR #25, rc.7.83).
- **Concurrent `open` calls timed out after 10 s.** They now reserve inside a short lock and launch outside it (PR #23).
- **An agent submission right after a window opened was refused** (`BLOCKED_NO_DISPATCH`) while a Terminal command would have waited. It now waits for the same warm-up; refusals carry `retryable` and `retryAfterMs` (PR #26, rc.7.86).
- **The warm-up cache could trust a replaced worker.** It now records the worker's pid, start time and transport, checks them again before use, and treats a failed or timed-out check as not ready. A Terminal command whose worker died while starting restarts it once (PR #20, rc.7.81).
- **Stata errors were reported as an unknown outcome.** A confirmed error now returns `STATA_ERROR_CONFIRMED` with Stata's return code (`stataRc`) to an agent, and that return code instead of -1 on the Terminal path (PR #27, rc.7.85; PR #28 makes mcp-stata send the return code). Checked live on macOS on `b82203d` and `d5b03df`, and on Windows on `d020b036` (agent path); see the limits below.
- **Stata: KILL on Windows ended every Stata GUI process and every mcp-stata backend on the machine**, not only this session's; a busy force reset did the same. It now ends only this window's confirmed backend tree (PR #22, rc.7.82). One live run on `d020b036` with two sessions confirmed the scope: only the killed window's tree ended, and the other window kept its pids and ran its next command. Recovery after that KILL fails on Windows; see the note at the top of [Platform test results](#platform-test-results) and the limits below.
- **A person's Run File could not be stopped.** Its progress notification "Running <file> [Cancel]" covered the Terminal Stop button (macOS retest of `b0bc49d`), and the notification's **Cancel** was not connected, so the run went on until the watchdog cancelled it at 375 s and the session locked. The notification's **Cancel** on a Run File or Run Selection now calls the same Stop as the Terminal button, only while the run that opened the notification is still active (the same execution lifecycle and request id) (PR #30, rc.7.87). Checked live on macOS on `8739778` for Run File; Run Selection has unit tests only. That an old notification's Cancel does not stop a newer run, or an agent run that took over, has offline tests only; on 11-06 the live check could not set up that state (the old notification closed before the newer run's appeared).
- **A person's Stop on an agent's run reached the agent as `EXECUTION_UNCONFIRMED_NO_RETRY`.** The agent now gets `STOPPED_NO_RETRY` (exit 2, nothing retried) when a person stops its run in VS Code with the Terminal Stop button or **Stata: Cancel Current Request**. The Run File and Run Selection notifications belong to a person's own run and cannot stop an agent run. The client gives it only when the Stop belongs to this request and run, came after this submission, restored this run's pre-run checkpoint in the same Stop (same run id, `restored` true, same reset generation), and the session is ready again (PR #30). Checked live on macOS on `8739778` with the Terminal Stop button; **Stata: Cancel Current Request** was not tried live on an agent run. The HTTP 423 `checkpoint restore in progress` seen about 2 s after a Stop in the `b0bc49d` retest came from commands sent through the test endpoint `/debug-terminal-input`; the agent client waits for the session to be ready before it sends.
- **A person's failing command had the plain card title "Stata Output".** It is now "Stata Output (failed)", as for an agent (PR #30).
- **A quiet long command could be cancelled after one failed CPU sample under heavy load.** A failed, late or timed-out sample of the worker's CPU time reset the watchdog's CPU baseline, so two failed samples about 12 s apart could leave more than 60 s without credit while the worker was still computing. On the 11-04 macOS retest (load average about 200) `bootstrap _b, reps(400) nodots` was cancelled after 99 s. Such a sample now gives no credit but keeps the baseline and is counted by kind (`cpuErrorKinds`). Credit still needs two verified samples of the same process tree, and a changed tree or new log output still resets the baseline (PR #31, rc.7.88). `/status.watchdogCpu` shows these counters for the running guard and the last agent and Terminal guards. On the PR head `db105f28`, three quiet `bootstrap` runs at load average 61–76 finished with rc 0 and no sample errors. The heavy load that triggered the cancel was not reproduced, so the fix under that load rests on unit tests. On 11-06 a `bootstrap` silent for 105 s finished with CPU credit and no sample errors on macOS (`d5b03df`), as did a 192.8 s run without log output on Windows (`d020b036`).
- **macOS: a KILL or force reset during a running command could leave the old Stata worker running** with parent pid 1, while `/status` and `close` reported the session clean (`b82203d`, 11-05). KILL and force reset ended only the `mcp-stata` server, and its worker exits only when the server exits normally. A force reset now first takes one `ps` snapshot of the backend's tree. The root must be the registered pid, a direct child of this extension host, started no later than 5 s after it was registered. After the server is ended, it sends SIGTERM and then SIGKILL only to a recorded descendant that still has the same start time, a working directory inside this session's workspace or `mcp-temp`, and parent pid 1 or its recorded parent. Anything it cannot read or confirm, such as an unreadable registration, a presence check that fails, a second live backend or no live backend, is listed as unresolved in `/status.orphanWorkers`. It is not signalled and not reported as clean (PR #31, rc.7.89). `close` only reports and signals nothing beyond the VS Code window. Its result has `leftoverProcesses`, `orphanWorkers` and `orphanCleanup` (`mode: "report-only"`, `signalled: []`, `clean`, `unresolved`, `holders`). A process read that fails, times out, prints to stderr or returns partial output counts as unknown, not empty. `clean` is true only when nothing is unresolved and the final scan of the session's files read successfully and found no holder. Live on the PR head `4a1ac2e` (macOS, 11-05), before the last review rework: a KILL 20 s into a quiet command ended the old worker and its resource tracker. A test process in the same working directory with a `spawn_main` command line was not signalled, and a `close` listed it as unresolved. The review rework after that, closing the cases that could read as clean, has offline tests and mutants. The merged code was retested on `d5b03df` (11-06): a KILL during a quiet command again ended the old worker and its resource tracker and left the test process alone. That retest found the defects in the next two items.
- **macOS: `close` could not list a live worker or holder on a real workspace** (11-06 retest). `lsof +d <workspace>` exits 1 whenever the folder contains a file that no process has open, and it still prints the processes it found. #31 counted that as unknown, so `close` reported `identity-unreadable` and `holders: unknown` on any real workspace. Directory discovery now reads the rows when the exit status is 0 or 1 and stderr is empty; any other status, any stderr output (for example a folder that cannot be opened) or a timeout still counts as unknown (PR #32). Checked live with macOS lsof 4.91 only: a test process holding the workspace was listed as unresolved (`holders: present:1`, `clean: false`, nothing signalled). `close` stays report-only and best effort; see the limits below.
- **macOS: a force reset with a stopped backend process ended VS Code's extension host** (11-06 retest, 4 of 4 runs). With this window's Stata worker stopped by SIGSTOP, a watchdog cancel escalated to a force reset; about a second after the server ended, the extension host exited (code 0) and only VS Code's main process was left. The cause is strongly supported by the live runs but was not directly observed (no SIGHUP was captured). In the tested launch mode (macOS, a window started by `tools/stata_session.py` with an isolated profile), every process of the window, including the mcp-stata server, its resource tracker and its worker, is in VS Code main's process group. After the server exits, the tracker and worker are re-parented to launchd and stay in that group. When such a member exits while another member is stopped, the kernel treats the group as orphaned and sends SIGHUP and SIGCONT to all of it: the extension host and helpers end, VS Code main survives. The rc.7.89 cleanup triggered this by ending the re-parented tracker while the worker was stopped. Before each SIGTERM or SIGKILL the cleanup now reads the host's process group. Stopped members that match a recorded identity (pid and start time) get SIGCONT and the group is read again. A stopped member that is not ours (`host-group-stopped`) or a group that cannot be read (`host-group-unknown`) means no signal, and the row stays unresolved. The deadline, a cancel and a newer reset are checked after each group read and right before each SIGCONT (PR #33, rc.7.89-v4). Live on PR #33's first head `3c8e4f3`, 2 of 2: the host survived, **Stata: KILL** unlocked the session, the next command returned rc 0 and `close` returned `CLOSED`; one run had one `host-group-unknown` row whose cause was not found. The added stop checks have offline tests and mutants only.
- **Windows: after a successful KILL the window kept refusing runs** (11-06 retest). The command ran its recovery smoke on the connection to the backend it had just ended, so the smoke failed with `transport-failed` and the next command got HTTP 423 `panic-kill-command-needs-smoke` until the window was closed. A successful scoped kill now runs a force reset that reuses the kill's recorded result, opens a new connection and leaves the session needing a smoke; the smoke then runs on the new connection (PR #34, rc.7.90). The fail-closed path and a partial kill are unchanged. Live on `main` `80e01c8` (11-07), one run with two sessions: the killed window recovered by itself and ran its next command with rc 0; the other window was not affected.

Open problems on the current `main`:

- **A command sent while Stata is still loading.** `trueReady` does not wait for the background load. A Terminal command or an agent submission waits until the Stata worker is running. After 2 s the Terminal shows "Waiting for Stata to finish loading…"; the Terminal Stop button or `POST /soft-stop` cancels the wait. After 300 s, or if the warm-up fails, the command is refused before it is sent (`PRE_RUN_BACKEND_WARMUP_TIMEOUT` or `PRE_RUN_BACKEND_WARMUP_FAILED`, `payloadDispatched=false`). Only an older mcp-stata that does not provide `list_sessions` is let through without this check (a compatibility fallback, not proof that Stata is ready). When `list_sessions` exists but keeps failing or timing out, the warm-up ends as `FAILED` and the command is refused; when the worker changes or cannot be confirmed right after the warm-up, the command waits once more and is then refused. On 11-04 the wait message, Stop during the wait (through `/soft-stop`), the timeout and the failure refusal were confirmed live on macOS; on Windows all of them except the failure refusal, and the wait message only in the Output log; on 11-06 Windows (`d020b036`) also showed the failure refusal and the wait message in the real Terminal panel. On 11-05 a command typed into the Terminal panel on macOS (`b0bc49d`) showed Stop enabled during the wait; a click on it refused the command with `PRE_RUN_BACKEND_WARMUP_CANCELLED`, nothing was sent, and the next command returned rc 0. An earlier report that the button is disabled during the wait came from a test endpoint (`/debug-terminal-input`) that sends the command without going through the panel's Run handler, so the panel never showed the command as running; it was not a product defect.
- **Windows KILL scope rests on two live runs.** On `d020b036` and on `80e01c8`, with two sessions each, KILL on window A ended only A's backend tree, and window B kept its pids and ran its next command with rc 0. Two runs are not a statistical bound. The root is matched to its registration time within 1 s, not by a recorded creation time; identities are compared to the millisecond; the process listing is not atomic; and only direct children are rescanned after the kill. When cleanup fails or a process identity cannot be read, the session stays not ready and `/recovery-smoke` returns HTTP 423 `unresolved-cleanup`.
- **Windows: Stop on a fully frozen backend locks the session.** With every backend process of a session suspended, `/soft-stop` took 58 s and returned 500 (`RECOVERY_FAILED`: the quiescence probe timed out after 5 s) and force-reset the session's own tree. The session then refused commands with HTTP 423 (`soft-stop-needs-smoke`) until the window was closed. The log names **Stata: KILL** or `POST /force-reset`; neither was tried on a frozen session. Since PR #34 a successful KILL resets the connection before its smoke, but KILL after this Stop has not been tried live. A slow but alive backend was not tested.
- **Windows: a command typed into the panel and refused during the warm-up leaves `/status.lastTerminalGuardFailure` empty.** The refusal shows in the panel and the log only.
- **macOS KILL and force reset identify the backend by pid only** (PR #22 changed Windows only). The cleanup ends the registered pid when its command line contains `mcp-stata`; it does not check the process start time or parent. A pid reused by another session's `mcp-stata` within that window could be ended.
- **Limits of the macOS orphaned-worker cleanup.** Signals go to a bare pid: a process that exits after the last check and whose pid is reused before the signal is not ruled out, and start times have 1 s resolution. The root rule is one-sided: another child of this extension host that got the registered pid within 5 s of registration is not ruled out. `close`'s capture and report phases each have their own 8 s limit. These bound the cleanup's process reads, not the whole call: under heavy load `close` can still raise a `ps` timeout from its instance listing instead of returning a verdict. Rows that ran out of capture time stay unresolved even when the process later exited normally. `close` has been shown live listing a test process that held the workspace (11-06), not a real Stata worker that outlived its window: in the 11-05 tests the worker always ended with the VS Code quit, and on 11-06 a worker held with SIGSTOP outlived its window once, on a build whose `close` could not list it (fixed by PR #32), and ended during the quit in the other runs. `close` is report-only and best effort: its scan looks at the workspace folder and the files directly in it (`lsof +d` is not recursive), process reads are not atomic, and it was checked with macOS lsof 4.91 only, so `holders: none` and `clean: true` mean nothing was seen in that scope. Check an unresolved row with `ps -o pid,ppid,lstart,command -p <pid>` before you end anything yourself. Windows is unchanged (PR #22 ends this window's whole backend tree there), and this case was not tested on Windows.
- **macOS: KILL or cleanup while another process of the window is stopped is not supported.** PR #33 only makes sure the force reset does not end a member while one of our recorded processes is stopped. If a process of the window was stopped from outside (SIGSTOP, a debugger), a later **Stata: KILL** or cleanup can still end the extension host the same way (seen live). A stopped process of the window that is not a recorded identity blocks the cleanup (rows unresolved) and is not resumed. A pid reused, or a process stopped again, between the last group read and the signal is not ruled out.
- **The worker CPU signal is a heuristic.** CPU activity is not proof of useful work: a run that loops without output keeps the session until its log has been silent for 30 min. When the process tree cannot be verified (a pid exited during the sample, more than 4 levels or 16 processes, a parent mismatch), the sample gives no credit and the 60 s log rule applies. Same-second pid reuse is below the precision of the start time it checks. On the 11-04 macOS retest of `main` (`b0bc49d`), a run quiet for 57 s finished with rc 0 and a frozen worker was still cancelled; a longer quiet run under heavy load was cancelled (next item).
- **A quiet long command under the heaviest load has not been retested live since PR #31.** The 11-04 cancel (load average about 200, 99 s, `cpuErrors=2`) came from failed CPU samples resetting the baseline, which PR #31 changed (see the fixed list above). On 11-06 quiet runs finished with CPU credit on macOS (silent 105 s) and Windows (192.8 s), but that load and those sample failures were not reproduced, so the fix for them rests on unit tests. A watchdog cancel still locks the session (HTTP 423 `guard-cancel-needs-smoke`) until **Stata: KILL**; the lock is deliberate, because after a cancel the state inside Stata is unknown.
- **The progress notification of a person's Run File or Run Selection covers the Terminal Stop button.** Its **Cancel** now stops the run (see the fixed list above). Clicking the notification body does nothing; Cancel on Run Selection has unit tests only; and neither was checked on Windows. That an old notification's Cancel cannot stop a newer run has offline tests only: in three live attempts on 11-06 the old notification always closed 4.7–10 s before the new run's notification appeared.
- **A Stop through `POST /soft-stop` or by the watchdog reaches the agent as `EXECUTION_UNCONFIRMED_NO_RETRY`**, not as `STOPPED_NO_RETRY`; the receipt names the source in `stopReportedBy`. Check `resetGeneration` in `/status` and the receipt before submitting again. `STOPPED_NO_RETRY` was checked on Windows on `d020b036` (11-06) with the Terminal Stop button.
- **Stata error return codes are confirmed conservatively; on Windows only the agent path was tested live.** An error counts as confirmed only if the run was not cancelled (Stop, watchdog, Break, rc 1), the log is this run's own, the last `r(n)` line is followed only by echoed commands, the completion marker was not printed, and the code is a positive integer equal to mcp-stata's rc. mcp-stata sends that rc with `task_done` only through the runtime patch (PR #28), taken from the response this run already received; a runtime without the patch sends none, and every error stays unconfirmed. Anything else stays rc -1 on the Terminal path and `EXECUTION_UNCONFIRMED_NO_RETRY` to an agent; an error whose text mentions cancel, timeout or stall also stays unconfirmed. On macOS, build `b82203d` (11-05): an agent's `display nosuchvar` returned `STATA_ERROR_CONFIRMED` with `stataRc` 111 and the next command rc 0; the same error typed by a person finished with rc 111 and the next command rc 0; the session stayed usable. That build is not the current `main`; the same checks passed on `d5b03df` (11-06). On Windows (`d020b036`, 11-06) an agent's `display nosuchvar` returned `STATA_ERROR_CONFIRMED` with `stataRc` 111 and the next command rc 0; the Stata log shows `r(111);` and the extension log has no error text. A person's error on Windows was not tested. The offline cross-module test builds the `task_done` result by hand and stubs the UI, so it is not an MCP transport or end-to-end test.
- **The general log parser reads only the plain `r(n);` form**, not the SMCL form `{search r(111), local:r(111);}` that mcp-stata 1.26.1 writes. Only the new error check reads both. The rc inferred at release, the Run File finalizer and the watchdog's error check still see no rc in such logs when the error is not confirmed.
- **Wrapper lines are visible in the Terminal.** The RESULT tab shows lines added around each command, for example `display as text "___CODEX_RUN_DONE_…___"`, a second `r(111);` and `scalar _wb_rc_… = _rc`; an agent card's command line also shows the client's verification marker. They come from the command wrapping in the extension and the mcp-stata runtime. The completion check and the log evidence of a run depend on that wrapping, so the lines are not hidden yet.
- **A reopened session can get a new port.** Right after `close`, the old port can still be in TIME_WAIT; the launcher then picks the next free one. Tools look sessions up by name.
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
| Windows: first command after opening returns HTTP 504 (`EXEC_PRELOG_STALL` or `EXEC_OUTCOME_UNKNOWN`) and the session locks | Click **Stata: KILL** to unlock; it ends only this window's backend. Check the receipt before resubmitting, because the command may still have run. If the profile sets `loadStataOnStartup` to `false`, remove that entry before the next `open`. See [Known limitations](#known-limitations) |
| Windows: after **Stata: KILL** the session stays not ready; `/recovery-smoke` returns HTTP 423 `unresolved-cleanup` | KILL could not confirm the cleanup: some processes could not be confirmed as this window's (those were not targeted), or a requested termination or the check for processes left behind was not confirmed. The notice lists each pid with its start time and a PowerShell command to check it. Do not end a pid whose start time is unknown just to clear the lock; it may belong to another program. Close this VS Code window and open a new one; that does not prove the listed processes ended |
| Terminal shows "Waiting for Stata to finish loading…" | Stata is still starting. Wait, or cancel with the Terminal Stop button or `POST /soft-stop`; nothing has been sent yet. After 300 s the command is refused with `PRE_RUN_BACKEND_WARMUP_TIMEOUT`; it was not sent |
| Agent client returns `REFUSED_NOT_DISPATCHED` | The extension refused the run before sending it. Read `reasonCode`. If `retryable` is true, submit again after `retryAfterMs`; after a Stop it is false |
| Agent client returns `STATA_ERROR_CONFIRMED` | Stata ran the command and rejected it with `stataRc`. The receipt holds the error text. Fix the code; commands before the error may already have changed the data |
| Agent client returns `STOPPED_NO_RETRY` | A person stopped this run in VS Code and the pre-run checkpoint was restored. Part of the code may have run. Ask the person before submitting again |
| `close` returned `OPENING` | An `open` of that session is still running. Wait until it returns, then `close` again |
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
| `STATA_WORKBENCH_TIMING_FILE` | — | Diagnostics: a file to which the extension also appends its `[wb-timing]` lines |

The **Stata Workbench** output channel shows one `[wb-timing] {…}` line per
step of a Terminal command before its first output (entry, warm-up, tool calls,
log path, first output). The lines carry fixed fields only: times, ids, status
and error class or code, never code, output or error messages. Writing them is
synchronous, so they add a small I/O cost. Timing inside mcp-stata is not part
of the product: `scripts/stata_timing_patch.js` instruments only a new
disposable copy of a runtime, for manual diagnosis.

## Development

```sh
npm ci --ignore-scripts
npm run check -- --keep-going
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run package` runs the full check and produces
`stata-workbench-next-<version>.vsix` in one step. CI runs these steps on
macOS 15 (Apple Silicon and Intel) and Windows Server 2022 without Stata, a GUI
or credentials, plus a separate reference source build. The image-corpus test
skips when the private corpus has no `.do` files and also runs on a small
synthetic corpus in the repository; the pre-flight patch test accepts an
installed runtime only when it is unpatched or patched exactly once.

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
