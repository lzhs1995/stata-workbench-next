# Developing and verifying both desktop platforms

The editor, bridge protocol, request lifecycle and webview assets remain shared.
The Python entry points select `mac_workbench` or `windows_workbench` for process
and desktop observation. `workbench_platform` owns stable file locks, executable
selection and Stata path quoting. See [SYNC.md](../SYNC.md) for actual evidence.

## Entry points and configuration

`python -B tools/verified_workbench.py --doctor` returns JSON even when the
candidate is not installed. It reports OS/architecture, Python, Code, the chosen
profile/port, Stata candidates, installed/runtime identity and desktop observation.
It does not start Code/Stata, install anything or validate a Stata license.

Both platforms retain these environment variables:

- `STATA_WORKBENCH_PROFILE`: isolated profile root; default `~/.stata-workbench-shared`.
- `STATA_WORKBENCH_PORT`: must match `stataMcp.visibleBridgePort`; default 17485.
- `STATA_WORKBENCH_CODE`: Mac app CLI, Windows `Code.exe`, or its `bin/code.cmd`.
  Windows resolves the latter to `Code.exe`, avoiding shell interpolation.
- `STATA_WORKBENCH_PYTHON`: installed Python executable used by the PowerShell wrapper.

The pinned source bundle, installed extension and live bridge must match. A
missing/mismatched candidate is reported, never replaced by another running profile.

After installing/configuring the chosen isolated candidate profile:

```text
python -B tools/verified_workbench.py --open --workspace <existing-workspace>
python -B tools/shared_stata.py --file <saved-do-file> --cwd <working-directory> --busy-policy wait --max-wait 60
```

The client archives the exact submitted do-file bytes in its unique receipt
directory. Chinese/space/apostrophe paths are supported. Stata macro delimiters,
double quotes and control characters in do-file paths are rejected explicitly;
arbitrary Stata-language filename escaping is not claimed.

The Windows wrapper `scripts/invoke_stata_visible_safe.ps1` delegates to the same
Python verifier. Its former `AllowHttp500Retry`, `BusyPolicy reset` and
`SmokeAfterReset` modes now fail before dispatch. `NoSharedStateMutation` cannot
create a hidden session; `UseRunFileHandler` directs users to the editor command
instead of silently relabeling an agent request. The legacy wrapper name delegates
to this entry. `PollSec` is retained for argument compatibility; Python uses bounded
one-second pre-submit polls. `PlainTextTail` currently retains the original SMCL tail.

## Test layers

```text
npm ci --ignore-scripts
npm audit
npm run check
python -B -m unittest discover -s tools -p "test_*.py"
npm run package
python -B tools/verify_release.py --packaged
```

CI uses macOS 15 ARM, macOS 15 Intel, and Windows Server 2022 x64 with Node 22 and
Python 3.14. Windows tests use actual file locks, CIM, TCP ownership,
CommandLineToArgvW, PowerShell 5.1 and PowerShell 7. Stata is not installed in CI.
Platform-specific skips must be reported; mocked runs are not licensed execution.

Licensed desktop acceptance uses an isolated profile/config/runtime and synthetic
data. Check Run Selection, Run Current File, Graphs/PNG/GPH, data browsing,
cancellation, competing submissions, large output, source/Terminal visibility,
and preservation of the original research instance. Lock-screen or consent UI
that needs an operator remains a pending GUI case, never a fabricated pass.

The legacy `PASS_VISIBLE_SHARED_RUN` verdict retains API compatibility and proves
the execution checks only. Actual source/Terminal layout observation is separate.

## Source rebuild and release boundaries

`dist/extension.js` remains the maintained bundle until the independent source
migration proves feature parity. Keep byte-equality patch replay tests. Do not
replace the bundle with upstream HEAD to make a build pass. Preserve upstream
AGPL-3.0-or-later attribution and record the exact recovered source revision.

Candidate VSIXs and CI reports are review artifacts. A public release requires
licensed acceptance and release-specific scope notes; Windows CI alone does not
certify the Windows desktop or a Stata edition.
