# Stata Workbench Shared Session

[English](README.md) | [中文](README.zh-CN.md)

> **Development line, not for daily use.** This is `stata-workbench-next`, the isolated
> development repository for multi-session, agent identity, bridge authentication and
> diff-gated edits. It installs as a separate extension (`lzhs1995.stata-workbench-next`)
> with bridge port 17601. For research work use the stable release
> [stata-workbench-shared-session](https://github.com/lzhs1995/stata-workbench-shared-session).

A VS Code extension that lets a person and AI agents use one visible Stata
session in turn. Both send code to the same backend, so data, macros, scalars,
results and graphs are shared.

## What it is

- In the editor: **Run Current File**, **Run Selection/Current Line**, the
  Stata Terminal, the Stata Graphs panel and the Data Browser.
- For agents: `tools/shared_stata.py` sends one command or one saved `.do` file
  to the running session over a local HTTP bridge and writes a private receipt.
- Submissions to one backend run one at a time. The person and the agent take
  turns; do not type in the editor while an automated run is in progress.
- Shared memory is not durable storage. Save data and results to disk before a
  reset, a restart or closing VS Code.
- Not included: Stata, Stata licenses, credentials or data. The bridge listens
  on loopback only; it is not a remote or multi-user service.

Derived from [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)
(AGPL-3.0-or-later); see [License](#license).

### Versions

| Version | State | Platform evidence |
| --- | --- | --- |
| [`v0.1.3-rc.7.45`](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.45) | Latest pre-release (2026-10-31) | macOS and Windows, see [Platform status](#platform-status) |
| [`v0.1.3-rc.7.44`](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.44) | Earlier pre-release (2026-10-30) | macOS and Windows |
| [`v0.1.3-rc.7.39-public.2`](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.39-public.2) | Earlier pre-release (2026-09-09) | macOS only |

This README describes `v0.1.3-rc.7.45`. Each result names the version it was
measured on; rc.7.45 results are on the published VSIX (`b371bc61…`) unless a
line says otherwise.

### Documentation

- [Cross-platform development and configuration](docs/CROSS_PLATFORM.md)
- [Windows physical-machine runbook](docs/WINDOWS_ACCEPTANCE.md) and [early Windows tooling](docs/LEGACY_WINDOWS.md)
- [Capability and evidence ledger](SYNC.md) and [acceptance scope](docs/ACCEPTANCE.md)
- [macOS permissions](docs/MAC_PERMISSIONS.md) and [troubleshooting](docs/TROUBLESHOOTING.md)
- [Shared execution and concurrency](docs/shared-execution-and-concurrency.md)
- [Shared-session delivery lessons](docs/shared-session-delivery-lessons.md) and
  [research handoff and archive lessons](docs/empirical-review-and-archive.md)
- [Release maintenance](docs/RELEASE.md) and [changelog](CHANGELOG.md)
- [中文使用指南](docs/USAGE.zh-CN.md)

## Platform status

One VSIX serves macOS and Windows. The macOS and Windows CI builds of the
candidate contain byte-identical runtime files; they differ only in the line
endings of bundled documents.

| Platform | Tested environment | Result |
| --- | --- | --- |
| macOS, Apple Silicon | macOS 26.5 arm64, StataNow, VS Code 1.139.1, isolated profile | This release file installed (identity check passed); cold first run 200 rc 0. FULL45 scenarios rerun on this file with physical keys: S2, S6, S10, S12, S16, S20, S26 and S40 passed every step, and S43 ran 9/9 agent selections with 200 rc 0 (its one failure is the harness reading outputs from the wrong folder). On the build before the last fix, S2, S6, S10, S16, S20, S26 and S43 had failed because successful agent runs were answered as HTTP 500. S9, S11 and S33 ran every step and failed only harness evidence checks (transport receipts; restoring the previous app after a reopen). S41 failed as on rc.7.44 (see Known limitations); S34 could not send its first key (harness) |
| macOS, Intel | CI only (macOS 15 Intel) | Offline tests and packaging; no licensed Stata run |
| Windows 11 x64 | Windows 11 Home 24H2 (build 26100), Stata 18 MP, VS Code 1.121.0, Windows PowerShell 5.1, isolated profile | rc.7.45 (published VSIX): install and identity check, cold-start first run (backend 31.3 s), agent `do "<file>"` with a red line and `exit 0` 3/3 returned 200 rc 0 (500 on the earlier build), the same right after a force reset 3/3, a failing body returned its own rc 603 and error text, agent named graph exports (task5: 22 PNG, 28 SVG), Stop during the pre-run checkpoint recovered fully. On the build before the last fix, a soft Stop after the code had started restored 160 estimates and 80 graphs in 118 s without escalation. Runbook step 10 on the published VSIX, checked after the fact: after the user locked and unlocked the screen and declined a UAC prompt, the same backend and extension host were running (reset generation unchanged), and an agent run (200 rc 0), graph Open and Data Browser worked. The lock shows in Winlogon notifications; the UAC decline rests on the user's report. rc.7.44: stress run 32/32 and three Reload Window cold starts |
| Windows, default install route | Same machine, empty `uv` cache | With `mcp<2` the service installed and imported; without it `uv` resolved MCP 2.x and the server failed to import |
| Windows Server 2022 x64 | CI only | Offline tests, real file locks, process matching, PowerShell 5.1/7 entry points; no licensed Stata |
| Windows 10, Windows on ARM, Linux | — | Not verified |

### Windows runbook steps

From the [Windows runbook](docs/WINDOWS_ACCEPTANCE.md), synthetic data only.
Steps 1–8 passed on dev.5. Step 9 failed on dev.5 (the backend cold start
exceeded a 60 s pre-run budget) and passed on dev.6 after the fix. Step 10 was
run on dev.6 and again on rc.7.45 (checked after the fact on the published VSIX: same backend and extension host after lock, unlock and a declined UAC prompt; agent run, graph Open and Data Browser passed; the UAC decline rests on the user's report). Steps 1–8 were not
repeated on dev.6–dev.8; rc.7.45 covered the runs listed in Platform status.

| Step | Check |
| --- | --- |
| 1 | Run Current File: rc 0, 6 rows / 4 variables, CSV/DTA/GPH and two 800×480 PNGs, GPH reload |
| 2 | Terminal graph thumbnail → **Open**: Stata Graphs loads the image; no execution counter changes |
| 3 | Data Browser: 6 rows / 4 variables, Unicode label preserved |
| 4 | Agent client: one POST, zero retries, shared scalar 40 → 42 |
| 5 | Run Selection reads 42 on the same backend |
| 6 | Second client submitted while the first is busy: dispatched after release, one POST each |
| 7 | Stop during a run: task and transport drain, no hard reset, same backend |
| 8 | Cleanup client: each cleanup rc 0, the empty original `default` frame restored |
| 9 | Reload Window, then the first run with a cold backend start |
| 10 | Lock/unlock and a cancelled UAC prompt while idle: backend, extension host and counters unchanged |

## Requirements

| Item | Requirement |
| --- | --- |
| VS Code | 1.75 or later (tested: 1.139.1 on macOS, 1.121.0 on Windows) |
| Stata | A locally licensed installation (tested: StataNow on macOS, Stata 18 MP on Windows) |
| `uv` / `uvx` | Used to start the `mcp-stata` service (`mcp-stata` 1.26.1 with `mcp<2`) |
| Python 3 | Only for the agent and diagnostic tools in `tools/`. On Windows use the installed `python.exe`, not the Microsoft Store alias |
| macOS permissions | System Events Automation and Accessibility for the host that runs the agent tools; see [macOS permissions](docs/MAC_PERMISSIONS.md) |

## Install

Download `stata-workbench-shared-session-0.1.3-rc.7.45.vsix` and `SHA256SUMS`
from the [v0.1.3-rc.7.45 release](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.45)
into one folder. Check the VSIX against `SHA256SUMS` before installing (see
[Verifying a download](#verifying-a-download)); the release notes list the same hash.

The commands below install into a separate, identifiable profile. The agent
tools find the session by this profile and port. If you only use the editor,
**Extensions: Install from VSIX...** in your normal VS Code is enough.

### macOS

```sh
export STATA_WORKBENCH_PROFILE="$HOME/.stata-workbench-shared"
export STATA_WORKBENCH_PORT=17485
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir "$STATA_WORKBENCH_PROFILE/user-data" \
  --extensions-dir "$STATA_WORKBENCH_PROFILE/extensions" \
  --install-extension ./stata-workbench-shared-session-0.1.3-rc.7.45.vsix
```

In that profile set `stataMcp.stataPath` to your licensed Stata executable.

### Windows

In PowerShell:

```powershell
$env:STATA_WORKBENCH_PROFILE = Join-Path $HOME '.stata-workbench-shared'
$env:STATA_WORKBENCH_PORT = '17485'
code --user-data-dir "$env:STATA_WORKBENCH_PROFILE\user-data" `
  --extensions-dir "$env:STATA_WORKBENCH_PROFILE\extensions" `
  --install-extension .\stata-workbench-shared-session-0.1.3-rc.7.45.vsix
```

`code` is VS Code's `bin\code.cmd`. If it is not on `PATH`, see
[Troubleshooting](#troubleshooting). Set `stataMcp.stataPath` to the licensed
executable, for example `C:\Program Files\Stata18\StataMP-64.exe`. Variables set
with `$env:` apply to the current PowerShell window only.

The tested Windows runs used the private profile and port 17497 created by the
[operator kit](docs/WINDOWS_ACCEPTANCE.md), not the default profile above.

### Agent tools

The agent and diagnostic tools are in this repository, not in the VSIX. Clone it
at the release tag, so the tools pin the same version as the installed VSIX:

```sh
git clone https://github.com/lzhs1995/stata-workbench-shared-session.git
cd stata-workbench-shared-session
git checkout v0.1.3-rc.7.45
python3 -B tools/verified_workbench.py --doctor
```

On Windows use `python` instead of `python3`. `--doctor` prints JSON (OS and
architecture, Python, VS Code, profile and port, Stata candidates, installed
and running identity) and never starts VS Code or Stata.

## Quick start

With the same `STATA_WORKBENCH_PROFILE` and `STATA_WORKBENCH_PORT` set:

1. macOS only, once: `python3 -B tools/verified_workbench.py --request-permissions`
   in the host that will run the agent, and approve the system prompt.
2. Open the profile with the example workspace:
   `python3 tools/verified_workbench.py --open --workspace "$PWD/examples/minimal-workspace"`.
   `--open` reuses the exact profile or launches it once.
3. Set `stataMcp.stataPath` if you have not already.
4. Run **Stata: Open Interactive Terminal**, open `smoke.do` and run
   **Stata: Run Current File**. The Terminal prints `STATA_WORKBENCH_SMOKE_OK`.

The first run after opening or reloading also starts the Stata service. On the
dev.8 test machines this took 14.1 s (macOS) and 25.2 s (Windows). Wait for it;
do not submit the run again. The one exception is `PRE_RUN_SNAPSHOT_TIMEOUT`
(see [Troubleshooting](#troubleshooting)): that run was refused before your code
was sent, so running it again is safe.

### Share the session

In the Stata Terminal run `scalar public_shared_demo = 40` and wait until it is
ready. From a shell with the same profile and port:

```sh
python3 tools/shared_stata.py --code 'scalar public_shared_demo = public_shared_demo + 2' --cwd "$PWD"
```

Back in the Terminal, `display public_shared_demo` shows 42. Finish with
`scalar drop public_shared_demo`. Pick another name if that one is already in use.

## Using it

| Task | How |
| --- | --- |
| Run a whole `.do` file | **Stata: Run Current File** (`Ctrl+Shift+D`, macOS `Cmd+Shift+D`) |
| Run the selection or current line | **Stata: Run Selection/Current Line** (`Ctrl+Shift+Enter`, macOS `Cmd+Shift+Enter`) |
| Open the Terminal | **Stata: Open Interactive Terminal** (`Ctrl+Shift+C`, macOS `Cmd+Shift+C`) |
| Preview a saved graph | Click its thumbnail in the Terminal, then **Open**. Stata Graphs shows the file without running Stata again |
| Browse data | **Data Browser** button in the Terminal, or **Stata: View Data** |
| Stop a run | **Stop** in the Terminal |
| Run code from an agent | `tools/shared_stata.py`, described below |

The run shortcuts apply when a `.do`, `.ado` or `.mata` file (or a file in the
Stata language) has focus.

- **Graphs.** A clicked preview replaces the displayed batch with that one
  image. Other exported files stay available from their Terminal links and on
  disk. Automatic graph batches leave the Terminal visible when no Graphs panel
  is open.
- **Data Browser.** Shows rows, variables and the active frame (for example
  `wb_platform`). The frame name is read when the browser opens.
- **Stop.** A soft Stop cancels the current run, drains the task and keeps the
  same backend. The Terminal shows, for example,
  `human-file cancelled by soft Stop (generation 1)`, and `/status` reports
  `resetGenerationKind: "soft-stop"`. A Stop that lands while the run is still
  saving its pre-run checkpoint stops it before your code starts: the payload is
  not sent (`payloadDispatched: false`; HTTP 409 `PRE_RUN_CANCELLED_BY_STOP`, or
  500 `EXEC_REJECTED` if the checkpoint was still incomplete). Check that the
  session is ready again before the next run.

### Agent client

```sh
python3 tools/shared_stata.py --code 'display 1+1' --cwd /absolute/workspace
python3 tools/shared_stata.py --file analysis.do --cwd /absolute/workspace --busy-policy wait --max-wait 60
```

- One POST per call and no automatic retry. A timeout or unclear result is not
  proof that Stata did not run; inspect the receipt and the session before
  submitting again.
- It refuses a wrong bundle or listener owner, a duplicate launcher, a busy or
  recovering session, or a changed backend. `--busy-policy wait` only waits
  before submitting, up to `--max-wait` seconds.
- It never launches, activates, resets or retries Stata. It needs a running
  backend: after opening or reloading VS Code, start the service once from the
  editor or Terminal (any Run File, Run Selection or Terminal command).
- A read-only probe that times out on a heavily loaded machine (`ps`/`lsof`,
  and on macOS the passive permission check or the window query) is repeated, at
  most three times in all. A timed-out permission check is reported as
  `PERMISSION_CHECK_TIMEOUT`, not as a permission failure. The POST itself is
  never repeated.
- Exit code 0 means verdict `PASS_VISIBLE_SHARED_RUN`: the execution and
  identity checks passed. It does not prove that anyone watched the source and
  Terminal. Any other result exits 2.
- Each call writes a receipt with the request, response, the exact submitted
  `.do` bytes and the run log to `.stata-receipts/` (or `--receipt-dir`). It
  contains your code and output; do not commit it.
- `.do` paths may contain Chinese characters, spaces and apostrophes. Stata
  macro delimiters, double quotes and control characters in paths are rejected.
- On Windows, `scripts/invoke_stata_visible_safe.ps1` wraps the same client. Its
  former `AllowHttp500Retry`, `BusyPolicy reset` and `SmokeAfterReset` modes now
  fail before dispatch.

## Configuration

VS Code settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `stataMcp.stataPath` | empty | Path to the local Stata executable |
| `stataMcp.visibleBridgePort` | `17485` | Port of the local bridge (`/status`, `/run-command`, `/soft-stop`); must match `STATA_WORKBENCH_PORT` |
| `stataMcp.runFileWorkingDirectory` | empty | Working directory for Run File; accepts absolute paths, `~`, `${workspaceFolder}` and `${fileDir}` |
| `stataMcp.loadStataOnStartup` | `false` | Start Stata when VS Code starts |
| `stataMcp.requestTimeoutMs` | `100000` | Timeout for metadata and UI requests |
| `stataMcp.enableExecuteTimeout` | `false` | Time-limit execution commands; off for long research scripts |
| `stataMcp.maxOutputLines` | `2000` | Lines kept in the Terminal |
| `stataMcp.autoRevealOutput` | `false` | Show the output channel after runs |
| `stataMcp.showAllLogsInOutput` | `false` | Stream raw `mcp-stata` logs to the output channel |
| `stataMcp.logStataCode` | `false` | Log the Stata code sent to the backend |
| `stataMcp.autoConfigureMcp` | `false` | Add or update `mcp-stata` in the host MCP configuration |
| `stataMcp.restoreFinalSnapshotAfterGraphRouting` | `false` | Restore the final in-do dataset snapshot after Run File graph routing |

Environment variables for the tools:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATA_WORKBENCH_PROFILE` | `~/.stata-workbench-shared` | Isolated profile root |
| `STATA_WORKBENCH_PORT` | `17485` | Must match `stataMcp.visibleBridgePort` |
| `STATA_WORKBENCH_CODE` | VS Code in its standard location | macOS app CLI; on Windows `Code.exe`, or a `code.cmd`/`code.bat` shim that is resolved to `Code.exe` |
| `STATA_WORKBENCH_PYTHON` | — | Python used by the Windows PowerShell wrapper |

A port in use is a refusal, not a reason to stop another editor. Choose a free
`stataMcp.visibleBridgePort` and set the same `STATA_WORKBENCH_PORT`.

## Verifying a download

Check the file hash against `SHA256SUMS` from the same release.

macOS:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Windows PowerShell:

```powershell
$f = 'stata-workbench-shared-session-0.1.3-rc.7.45.vsix'
$expected = (Select-String -Path SHA256SUMS -SimpleMatch $f).Line.Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash.ToLower() -eq $expected
```

The last line must print `True`. Then check the VSIX contents against the
release identity manifest, from a clone at the release tag:

```sh
python3 tools/verify_release.py --vsix /path/to/stata-workbench-shared-session-0.1.3-rc.7.45.vsix
```

It prints JSON with `"verdict": "PASS"` when the package version and every
pinned runtime file match. This checks runtime identity only, not live acceptance.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The first run seems slow | The first run after opening or reloading also starts the Stata service. Wait; do not resubmit |
| The first run after opening or reloading fails with `PRE_RUN_SNAPSHOT_TIMEOUT` (HTTP 504) | Stata took longer than 60 s to start on a busy machine. The run was refused before dispatch (`payloadDispatched:false`), so your code did not run. Run it again |
| The Terminal looks busy for a long time | Check bridge status (`python3 tools/verified_workbench.py --status`) before running more code; do not queue another long run |
| A long script stalls or times out | Reconcile the original request, raw log and outputs first. A timeout is not proof that Stata did not run. See [storage and log recovery](docs/storage-and-log-recovery.md) |
| Port already in use | Another editor owns it. Choose a free `stataMcp.visibleBridgePort` and the same `STATA_WORKBENCH_PORT` |
| Status bar shows **Stata: STALE**; runs return HTTP 423 `recovery-required` | A force reset could not confirm the backend. Run the verified recovery once: `curl -X POST http://127.0.0.1:17485/recovery-smoke` (Windows: `Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:17485/recovery-smoke`; use your port). It runs a fixed marker command and unlocks only after rc 0 and the marker in the log. Do not kill Stata or delete the session |
| Graphs do not appear | Name graphs; several unnamed graphs can overwrite the single `Graph` window |
| Windows: `code` cannot install the VSIX | Run `Get-Command code` and `code --version`; fix `PATH` to VS Code's `bin\code.cmd`, or use **Extensions: Install from VSIX...** |
| macOS: error `-1743` or no windows found | Run `--doctor`, then `--request-permissions` once, in the same host as the agent. See [macOS permissions](docs/MAC_PERMISSIONS.md) |
| `No module named 'mcp.server.fastmcp'` | The service was installed with MCP 2.x. The default route adds `mcp<2`; a custom service command needs the same constraint |
| `Failed to connect to mcp-stata` with `No solution found when resolving tool dependencies` and "the network was disabled" | uv is in offline mode (for example `offline = true` in `~/.config/uv/uv.toml`, or `UV_OFFLINE`), so the default `uvx` route can only use packages already in its cache. Turn offline mode off for the first start so `uvx` can download the service once, then reload the window |

More cases: [Troubleshooting](docs/TROUBLESHOOTING.md) and the
[desktop recovery record](docs/desktop-auth-terminal-recovery.md).

## Known limitations

- Windows 10, Windows on ARM and Linux are not verified. macOS Intel has CI only.
- The licensed full suite (FULL45) was run on rc.7.45 before the last fix.
  26 of 45 scenarios passed there. On the published file 14 scenarios were rerun: 8
  passed every step, S9, S11, S33 and S43 failed only harness checks, S34 could not
  start (harness) and S41 failed (below). S4, S8, S13, S23, S29 and S44 have no complete
  run on rc.7.45.
- UI checks in the test runs used automated DevTools clicks, not human keypresses.
- The Windows lock/unlock and UAC step is supported by Winlogon events and
  unchanged session state. There was no live screen recording, and the UAC
  cancellation rests on the operator's report.
- On macOS, when the VS Code window is hidden, Terminal text can appear only
  after the run ends.
- Stata's own start-up still counts against the 60 s pre-run snapshot budget;
  only the service connection has its own budget. On a busy Windows machine the
  first run after opening or reloading was refused once in 6 cold starts
  (`PRE_RUN_SNAPSHOT_TIMEOUT`, code not sent); the next run passed.
- A top-level `exit` inside a multi-line selection (Run Selection, or an agent
  selection) ends the whole selection. The code before it has run, but the
  request is answered as a failure (HTTP 500), and the error text is the last
  red line. `exit` inside a do-file or a program is not affected. This already
  happened in rc.7.44.
- In FULL45 S41, a manual Run Selection that stopped at a Stata error (r(603), a path
  built from a global defined above the selection) was reported as failed, but without
  its return code ("execution released without verified completion evidence"). rc.7.44
  behaves the same. Not investigated further in this release.
- One backend runs one request at a time. Several instances need separate
  profiles and ports; there is no general multi-instance scheduler.
- The Data Browser frame name updates when the browser opens, not after a later
  `frame change`. At narrow panel widths its FILTER row text overlaps.
- `graph use` alone does not create a graph card in the Terminal.
- Exact equality of the displayed source and the executed bytes is not certified.
- `dist/extension.js` is the maintained bundle. A separate reference source
  build exists, but feature parity with the bundle is not established.
- Remote desktops, every Stata edition and long paths beyond the tested ones are
  not certified.

## Release history

Dates are UTC. Full details are in the [changelog](CHANGELOG.md).

| Tag | Date | Type | Scope |
| --- | --- | --- | --- |
| `v0.1.3-rc.7.45` | 2026-10-31 | Pre-release | macOS and Windows: the first run after a cold start waits until Stata itself is running; Stop during that wait stays a soft Stop; Windows force reset waits for a cold reconnect; named graph exports on the agent path (`set more off` prefix); Stop during the pre-run checkpoint never sends a refused restore; Windows soft-Stop restore of large sessions; successful do-file runs no longer reported as failures |
| `v0.1.3-rc.7.44` | 2026-10-30 | Pre-release | macOS and Windows: Windows adapters and operator kit, Stop in the pre-run window no longer runs the payload, read-only probe timeouts observed again, backend cold start outside pre-run budgets, default service kept on MCP 1.x, cancellation recheck after connect, Stop wording, Data Browser frame, saved-graph preview, recursive DO-reference scanner |
| `v0.1.3-rc.7.39-public.2` | 2026-09-09 | Pre-release | macOS permission diagnostics (Mac tools 1.1.0); runtime unchanged |
| `v0.1.3-rc.7.39-public.1` | 2026-09-07 | Pre-release | Public packaging of the Mac-accepted `0.1.3-rc.7.39`; local maintenance token removed |
| `docs-2026.09.26` | 2026-09-26 | Documentation | Documentation only; runtime unchanged |
| `v0.1.1` | 2026-05-19 | Release | Taught-task examples and install documentation |
| `v0.1.0` | 2026-05-19 | Release | Initial public staging release |

GitHub labels `v0.1.1` "Latest" because every later build is a pre-release.

## License

AGPL-3.0-or-later. Derived from
[tmonk/stata-workbench](https://github.com/tmonk/stata-workbench). Design
comparisons with [hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp)
are acknowledged in [NOTICE](NOTICE); they are not a claim that the runtimes are
interchangeable. See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).

GitHub Releases is the distribution channel. The older Open VSX listing is not
this runtime, and the extension is not on the Visual Studio Marketplace.

### Development

```sh
npm ci --ignore-scripts
npm run check
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run check` is read-only and guarded by a runtime digest. `check:legacy` is
the old mutating pipeline; never run it against a sealed candidate. Packaging
uses the versioned maintained bundle, readable patches and UI sources; it is not
a clean rebuild of upstream TypeScript. CI runs on macOS ARM, macOS Intel and
Windows Server 2022 without Stata, a GUI or private credentials. Runtime edits
need a new version and new licensed acceptance; see
[release maintenance](docs/RELEASE.md).
