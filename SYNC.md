# macOS / Windows capability and evidence ledger

Candidate: `0.1.3-rc.7.44-dev.5`, runtime commit
`78e0019cab6b81aaffd3ee40d24aef154e569754`, bundle SHA256
`bf3e938134855456475754ceeca00600c9a295a4f1bd530b811f90377dfc23ca`.
PR [#8](https://github.com/lzhs1995/stata-workbench-shared-session/pull/8) is
stacked on draft #7 (`d63b230`). The working research profile remains dev.1.
The evidence below separates versions and does not certify both desktops.

| Capability | Shared implementation | macOS | Windows | Evidence / remaining check |
| --- | --- | --- | --- | --- |
| Execution identity, receipts, single POST | Python client and existing bridge | dev.3 Run File → client → Selection shared state passed; dev.5 cleanup client passed | Same verifier; OS/fixture tests passed | Native Windows run pending |
| Stable process lock | OS adapter | Actual dev.3 clients serialized on one backend | msvcrt byte-range lock | Windows CI child-process contention/crash tests passed |
| Code/profile/listener identity | OS adapter | ps/lsof, exact private profile and loaded runtime checked | CIM/TCP census, exact argv/profile, creation time | Actual Windows OS tests passed; desktop/Stata pending |
| Desktop/window observation | OS adapter | Existing passive permission protocol | Input desktop and EnumWindows | Top-level window count is not source/Terminal visibility |
| PowerShell dispatch | Shared Python client | Not applicable | 5.1/7 wrapper tests passed in CI | Automatic reset/retry modes rejected before dispatch |
| Terminal / Graphs / Data Browser | Shared webview resources | dev.3 data browser 6×4; dev.5 actual Graphs image loaded after Terminal reload | Physical-machine GUI pending | Two native-discovered preview defects fixed, failed evidence retained |
| Cancellation | Existing lifecycle and restore logic | dev.3 soft Stop, task/transport drain and scoped restoration passed on same backend | Offline checks passed | Original HTTP 500 cancellation retained; no hard reset |
| Build / package / audit | Versioned maintained bundle | ARM and Intel CI passed | x64 CI passed | 193 JS commands; operator-kit revision has 65 Python tests (4 Windows-only skips on Mac); 90 source/VSIX identity checks |
| Reference source build | Separate migration in PR #9 | Repeated builds passed, ARM/Intel output matches | Same 15 outputs in CI | 27 pinned upstream files; feature parity with maintained runtime remains unproved |
| Source migration stage 1 | Readable preview module and upstream Terminal source integration | Compiled-handler/HTML regression with failing upstream control | Same build/regression in source CI | Preview callback and container retention only; bridge/state/native parity remains pending |
| Windows operator kit | Source-only `acceptance.py` | Portable setup/receipt/archive regressions | Private installation, one-shot fixture dispatch and bounded evidence ZIP | Windows CLI case runs in the OS matrix; licensed desktop remains operator-dependent |
| UU terminal control | `uuyc-cli` + remote PowerShell | CLI 1.0.0, online Windows device, terminal marker and read-only baseline verified on 2026-10-28 | Windows-side baseline JSON written without GUI clicks | C: free space 4.34 GB; Stata, private profile and Workbench extension absent, so setup/launch is deferred |

Three-platform dev.5/operator-kit CI, commit `66faf389a6da36c11e7b85fc2e9458eb7419d488`:
https://github.com/lzhs1995/stata-workbench-shared-session/actions/runs/40449906494

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

The next operator session uses the [Windows runbook](docs/WINDOWS_ACCEPTANCE.md)
and [seven synthetic fixtures](examples/platform-acceptance/README.md). It covers
native execution, graph loading, shared memory, competing submissions, Stop,
cleanup, reload, and real desktop/consent transitions. Windows ARM, Windows 10,
other Stata editions and a new FULL45 run remain unverified. A source/reference
build or GitHub green check does not replace those cases.
