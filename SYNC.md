# macOS / Windows capability and evidence ledger

Candidate: `0.1.3-rc.7.44-dev.8`, commit
`a7922dbd5933f2b83c79348b907f900920b3eb83`, bundle SHA256
`ada946f6ac1e1370333063033c7a60a56ee0e3b14b5fb0ac39ce3fea9f5a30b2`.
PR [#8](https://github.com/lzhs1995/stata-workbench-shared-session/pull/8) is
stacked on draft #7 (`d63b230`). The working research profile remains dev.1.
The evidence below separates versions and does not certify both desktops.

| Capability | Shared implementation | macOS | Windows | Evidence / remaining check |
| --- | --- | --- | --- | --- |
| Execution identity, receipts, single POST | Python client and existing bridge | dev.3 Run File → client → Selection shared state passed; dev.5 cleanup client passed | dev.5 native fixtures 01–08 passed: editor Run File, agent shared run, Selection, two competing submissions, cleanup | Physical x64 machine, stage `20261028-184807`; steps 1–8 were not rerun on dev.6/dev.7 |
| Backend cold start | `__codexEnsureBackendStarted` (rc.7.67) before every execution entry, outside pre-run stage budgets | dev.7 10.6 s and dev.8 14.1 s cold first runs after reload, rc 0 | dev.5 first run after reload failed (62 s cold start inside the 60 s snapshot budget, retained); dev.6 33.1 s, dev.7 25.4 s and dev.8 25.2 s passed | Wait limit is max(180, `STATA_SETUP_TIMEOUT`) + 120 s; a cold start over 60 s is covered by the time-scaled `test_backend_cold_start.js` cases, not by a physical run |
| Default service resolution | `--with mcp<2` on the default `uvx` route; kit constraints pin `colorama`, `pywin32`, `tzdata` on win32 | 58/58 offline behavior checks of the 11 rewritten argument arrays | Kit install with the constraints passed (mcp 1.28.1, mcp-stata 1.26.1, colorama 0.4.6, pywin32 312, tzdata 2026.6). Default-route cold install from an empty cache passed twice with the dev.7 arguments (mcp 1.30.0, server import ok) | Same-day control without the constraint resolved mcp 2.x and failed: `No module named 'mcp.server.fastmcp'`. Attempts 1–2 were cut off by a slow network and a network change; their logs are retained |
| Stable process lock | OS adapter | Actual dev.3 clients serialized on one backend | msvcrt byte-range lock | Windows CI child-process contention/crash tests passed |
| Code/profile/listener identity | OS adapter | ps/lsof, exact private profile and loaded runtime checked | CIM/TCP census, exact argv/profile, creation time | Actual Windows OS tests passed; desktop/Stata pending |
| Desktop/window observation | OS adapter | Existing passive permission protocol; dev.7 panel reported not visible while the window was in the background | Input desktop and EnumWindows; the user locked/unlocked the session and cancelled a UAC prompt on dev.6 | Top-level window count is not source/Terminal visibility. After the lock (Winlogon events 13:28:12Z/13:28:52Z) backend, extension host, reset generation and gate counters were unchanged; no live recording, and UAC cancel rests on the user's report |
| PowerShell dispatch | Shared Python client | Not applicable | 5.1/7 wrapper tests passed in CI | Automatic reset/retry modes rejected before dispatch |
| Terminal / Graphs / Data Browser | Shared webview resources | dev.3 data browser 6×4; dev.5 actual Graphs image loaded after Terminal reload; dev.7 graph preview Open after a cold run | dev.5 Graphs preview/Open and Data Browser 6×4 passed; dev.6–dev.8 graph click after a cold run passed with execution IDs unchanged; dev.8 Data Browser shows the active frame (`wb_platform`, Mac `wbxc_dev3`) instead of `default` | Clicks were CDP `element.click()`, not human input. Two native-discovered preview defects fixed, failed evidence retained. The frame label updates on browser init, not on a later `frame change` |
| Cancellation | Existing lifecycle and restore logic | dev.3 soft Stop, task/transport drain and scoped restoration passed on same backend; dev.8 message reads `cancelled by soft Stop (generation 1)` | dev.5 soft Stop (fixture 06) passed; dev.8 message reads `cancelled by soft Stop (generation 1)`, `resetGenerationKind` `soft-stop`, backend unchanged | Original HTTP 500 cancellation retained; no hard reset. dev.8 rechecks the token after connecting (a cancelled dev.5 snapshot had still run once); covered by a bundle-level test, not by a physical run. Mac dev.8 soft Stop gave the same message; with the window hidden the Terminal text appeared only after the run ended |
| Build / package / audit | Versioned maintained bundle | ARM and Intel CI passed | x64 CI passed | dev.8: 206 JS commands; 80 Python tests (4 Windows-only skips on Mac); 94 source/VSIX identity checks |
| Reference source build | Separate migration in PR #9 | Repeated builds passed, ARM/Intel output matches | Same 15 outputs in CI | 27 pinned upstream files; feature parity with maintained runtime remains unproved |
| Source Windows MCP probe boundary | `src/shared-session/platform-process.js` plus migrated `mcp-client.js` adapter | Source migration build and adapter tests pass | Source-built Windows probe path is covered in CI; physical Stata/MCP launch pending | Real `uv/uvx(.exe)` is shell-free; explicit `.cmd/.bat` shims retain shell compatibility; maintained VSIX entry remains unchanged |
| Source execution lifecycle boundary | `src/shared-session/execution-lifecycle.js` plus migrated `extension.js` selection/`.do`-file hooks | Stage 2 source build and lifecycle regression pass | Source candidate publishes run ownership and terminal release; bridge `/status`/dispatch and physical execution remain pending | `PASS_SOURCE_EXECUTION_LIFECYCLE`; maintained VSIX entry and installed research profile remain unchanged |
| Source localhost bridge boundary | `src/shared-session/bridge-http.js` plus migrated source activation/deactivation hooks | Stage 3 source build and HTTP contract regression pass | Source candidate binds loopback `/status` and `/run-command`; checkpoint/finalizer and licensed/native execution remain pending | `PASS_SOURCE_BRIDGE_HTTP`; port comes from `stataMcp.visibleBridgePort` (default 17485), and the maintained VSIX entry remains unchanged |
| Source run-file finalizer | `src/shared-session/runfile-finalizer.js` plus migrated `.do`-file call in `extension.js` | Stage 4 source build and 51 finalizer checks pass, with parity against the maintained log reader | Same driver code on Windows paths; no physical Stata run yet | `PASS_SOURCE_RUNFILE_FINALIZER`; pre-run snapshot, stop checkpoint and output bounds remain pending |
| Windows operator kit | Source-only `acceptance.py` | Portable setup/receipt/archive regressions | Private installation, one-shot fixture dispatch and bounded evidence ZIP | Windows CLI case runs in the OS matrix; licensed desktop remains operator-dependent |
| VS Code launcher resolution | `workbench_platform.code_launch_command` | App CLI launches directly | `Code.exe` and user-local `code.cmd`/`.bat` shims resolve to an existing `Code.exe` and launch without a shell | Python portability tests pass; Windows physical launch still pending disk/Stata/profile prerequisites |
| UU terminal control | `uuyc-cli` + remote PowerShell | CLI 1.0.0, online Windows device, terminal marker and read-only baseline verified on 2026-10-28 | Windows-side baseline JSON written without GUI clicks | Used for bootstrap only. Acceptance jobs now go through a signed LAN job agent kept in the handoff tooling, not shipped. C: had about 22 GB free on 2026-10-29; each stage installs its own profile, extension and service |

Three-platform dev.8 CI, commit `a7922dbd5933f2b83c79348b907f900920b3eb83`:
https://github.com/lzhs1995/stata-workbench-shared-session/actions/runs/40916018395
(earlier dev.5/operator-kit run: https://github.com/lzhs1995/stata-workbench-shared-session/actions/runs/40449906494)

Windows native cases ran on one physical x64 machine with licensed Stata, an
isolated stage profile and the synthetic fixtures. dev.5 passed steps 1–8. Its
step 9 reload kept bundle identity, but the first run after reload failed in the
pre-run snapshot stage; that evidence is retained. dev.6 (CI 40867644484) waits
for the backend outside the stage budgets and passed step 9 once on a new stage.
dev.7 passed the kit install with the new constraints and a cold first run with
a graph click. dev.8 passed a cold first run, the Data Browser frame label and
the soft Stop message on a new stage. The public projection below still covers only the Mac dev.3–dev.5
cases.

The native Mac cases used an isolated configuration/runtime and synthetic data.
dev.3 produced CSV/DTA, saved/reloaded GPH, and two fully decoded 800×480 PNGs
with identical pixels using **SVG+sips compatibility**. These are retained dev.3
results, not a new full-suite run on dev.5. dev.5 reused the saved GPH, proved the
restored artifact container is attached, and opened the actual Stata Graphs panel
from Terminal's modal **Open** button. Ten checks passed, including unchanged
execution IDs, backend and reservation count across the preview click.

The displayed author source and transformed execution copy are separately
archived. Source/Terminal layout was observed while a request was active; exact
displayed/executed byte equality and physical human viewing are not established.
The dev.4 saved-graph case lacked a live layout pass, and `graph use` alone does
not create a graph artifact card in the current scanner. These limits remain
visible in the [acceptance scope](docs/ACCEPTANCE.md).

Public projection and hashes of the private synthetic evidence:
[cross-platform acceptance](release/cross-platform-acceptance-20261027.json).
No dissertation data or licensed Stata is included.

Design source: the user's Tw93 clipping, https://x.com/HiTw93/status/2114702036264767748.
Apply its separation of common rules, native operations and UI, and its commit/evidence
tracking. VS Code remains the client; no Swift/WinUI rewrite or new VM dependency.

Windows sessions follow the [Windows runbook](docs/WINDOWS_ACCEPTANCE.md)
and [seven synthetic fixtures](examples/platform-acceptance/README.md). They cover
native execution, graph loading, shared memory, competing submissions, Stop,
cleanup, reload, and real desktop/consent transitions. Windows ARM, Windows 10,
other Stata editions and a new FULL45 run remain unverified. A source/reference
build or GitHub green check does not replace those cases.
