# Windows physical-machine acceptance

Target: Windows 11 x64 and licensed Stata 18 MP. Record actual versions; other
Windows/Stata combinations require their own results. Mac and Windows Server CI
have already checked the shared client, Windows locks/process matching,
PowerShell 5.1/7 entry points and VSIX resources. CI has no licensed Stata or
interactive Windows desktop. Budget about 45–60 minutes with the operator.

## Prepare the isolated installation

Use a normal PowerShell window. Prerequisites: Git, GitHub CLI (`gh`), `uv`, VS
Code and licensed Stata. For the documented user's machine the tools interpreter
is `C:\Users\LZHS\AppData\Local\Programs\Python\Python314\python.exe`; do not use
the Microsoft Store alias. The Stata service gets its own Python 3.11 environment,
matching the tested Mac service version. Nothing below edits the research profile.

The source-only operator tool prepares the private profile, pinned service and
seven fixtures, opens the chosen instance, runs client fixtures once, and collects
a bounded evidence ZIP. It is deliberately excluded from the VSIX because it
needs the matching source checkout and release identity manifest.

Use the following to select a **successful Windows CI artifact and its exact
source commit**. Set `$Stata` to the licensed executable if its location differs.
The staging directory and private run root are distinct: `prepare` refuses an
existing run root instead of overwriting an earlier acceptance.

```powershell
$ErrorActionPreference = 'Stop'
$Py = 'C:\Users\LZHS\AppData\Local\Programs\Python\Python314\python.exe'
$Stata = 'C:\Program Files\Stata18\StataMP-64.exe'
$Code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
if (!(Test-Path -LiteralPath $Code)) { $Code = 'C:\Program Files\Microsoft VS Code\Code.exe' }
foreach ($File in @($Py, $Stata, $Code)) {
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing executable: $File" }
}
foreach ($Command in @('git', 'gh', 'uv')) { Get-Command $Command -ErrorAction Stop | Out-Null }
$Stage = Join-Path $env:LOCALAPPDATA ('StataWorkbenchAcceptance\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$Repo = Join-Path $Stage 'source'
$Packages = Join-Path $Stage 'packages'
$Acceptance = Join-Path $Stage 'run'
New-Item -ItemType Directory -Path $Stage, $Packages | Out-Null
$Runs = @(gh run list --repo lzhs1995/stata-workbench-shared-session --branch codex/cross-platform-client-20261027 --workflow release-checks.yml --status success --limit 1 --json databaseId,headSha | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $Runs.Count -ne 1) { throw 'No successful candidate CI run' }
$Runs | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Stage 'ci-run.json')
git clone --depth 1 --branch codex/cross-platform-client-20261027 https://github.com/lzhs1995/stata-workbench-shared-session.git $Repo
if ($LASTEXITCODE) { throw 'Source checkout failed' }
git -C $Repo fetch --depth 1 origin $Runs[0].headSha
if ($LASTEXITCODE) { throw 'Could not fetch the exact CI source revision' }
git -C $Repo checkout --detach $Runs[0].headSha
if ($LASTEXITCODE) { throw 'Could not select the exact CI source revision' }
git -C $Repo rev-parse HEAD | Set-Content -LiteralPath (Join-Path $Stage 'source-commit.txt')
gh run download $Runs[0].databaseId --repo lzhs1995/stata-workbench-shared-session --pattern '*windows-2022*' --dir $Packages
if ($LASTEXITCODE) { throw 'Candidate artifact download failed' }
$VsixFiles = @(Get-ChildItem -LiteralPath $Packages -Recurse -Filter '*.vsix')
if ($VsixFiles.Count -ne 1) { throw 'Expected exactly one Windows candidate VSIX' }
$Kit = Join-Path $Repo 'examples\platform-acceptance\acceptance.py'
& $Py -B $Kit prepare --root $Acceptance --vsix $VsixFiles[0].FullName --stata $Stata --code $Code --port 17497
if ($LASTEXITCODE) { throw 'Preparation failed; preserve the original setup logs' }
Copy-Item -LiteralPath (Join-Path $Stage 'ci-run.json'), (Join-Path $Stage 'source-commit.txt') -Destination (Join-Path $Acceptance 'evidence')
& $Py -B $Kit collect --root $Acceptance
& $Py -B $Kit open --root $Acceptance
if ($LASTEXITCODE) { throw 'Bound candidate did not open; preserve diagnostics' }
$Work = Join-Path $Acceptance "workspace\平台 测试 O'Brien"
$Evidence = Join-Path $Acceptance 'evidence'
```

`prepare --configure-only` verifies source/VSIX and writes configuration without
installing or launching. It is a separate diagnostic mode; the existing-root
refusal still applies. For normal preparation the tool requires measured free
space of at least 20.5 GB (20 GB reserve plus 500 MB setup budget), checks the
private port, and uses Python 3.11 / `mcp-stata==1.26.1` for the service. Every
child command has an intent, log and outcome record. VSIX installation follows
VS Code's official `Code.exe resources/app/out/cli.js` invocation with
`ELECTRON_RUN_AS_NODE=1` scoped only to that command; opening uses normal GUI mode.

A successful install command is not proof of loaded runtime or licensed Stata.
`collect` runs the non-starting doctor; before opening, a missing instance is an
expected diagnosis. After opening, collect again and verify the chosen profile,
loaded version/bundle, selected service configuration and actual owner PIDs.
Workspace trust or licensing dialogs require the operator's real response. Each
command restores its persisted private environment, including in background jobs.
Keep the `$Py`, `$Kit`, `$Acceptance` and `$Work` variables for the steps below.

## Execute and retain evidence

Put the source on the left and the Stata Terminal on the right **before** each
manual run. In the current runtime, a newly opened file may follow the focused
Terminal group; the operator must check the layout. A later screenshot does not
prove the executable source was visible during an earlier run. Archive the
original file and any compatibility execution copy separately.

| Step | Action | Required result |
| --- | --- | --- |
| 1 | Open `01_graph_data.do`; Run Current File once | rc 0; 6 rows / 4 variables; CSV/DTA/GPH and two 800×480 PNGs; GPH reload succeeds |
| 2 | In Terminal, open a graph thumbnail and click **Open** | Stata Graphs exists, image actually loads; click changes no execution request/reservation counter |
| 3 | Click Data Browser | 6 rows / 4 variables, Unicode label preserved |
| 4 | Run client command below for `02_agent_shared.do` | one POST; zero retries; scalar 40 → 42; all receipt checks pass |
| 5 | Run Selection on the saved `03_selection.do` lines | verifies 42 on the same Stata backend |
| 6 | Start `04_queue_first.do`, then `05_queue_second.do` while the first is busy | second dispatch after first release; one POST each; final queue scalar 3 |
| 7 | Run Current File on `06_cancel.do`; press Stop after its start marker | original cancellation retained; task and transport drain; no hard reset; same backend |
| 8 | Run client on `07_cleanup.do` | cancellation probe absent; body and each cleanup rc 0; empty original `default` frame restored |
| 9 | After cleanup, reload only this candidate; use a fresh fixture workspace to test graphics again | loaded identity correct; Terminal artifact container still connected; graph click works after reload |
| 10 | Operator lock/unlock and UAC/input-desktop checks at an idle boundary | observe actual visibility/permission behavior; do not weaken OS consent or reset the backend |

Run the agent fixture through the operator tool:

```powershell
& $Py -B $Kit run --root $Acceptance --fixture 02_agent_shared.do
if ($LASTEXITCODE) { throw 'Inspect the original execution record before continuing' }
```

The tool validates the saved fixture hash and reserves one durable dispatch
record before invoking the existing single-POST client. It refuses a second
invocation even if the client failed before creating a receipt. Reconcile the
original request; do not delete records to retry. Manual fixtures 01/03/06 stay
in the editor/Stop route so their UI evidence is not silently replaced by a client.

For the queue pair, use two background jobs. Each invocation reconstructs the
same persisted private environment. Start the first client:

```powershell
$QueueClient = {
    param($PythonExe, $KitPath, $AcceptanceRoot, $Fixture)
    & $PythonExe -B $KitPath run --root $AcceptanceRoot --fixture $Fixture
    if ($LASTEXITCODE) { throw "Client failed; inspect the original record: $Fixture" }
}
$First = Start-Job -ScriptBlock $QueueClient -ArgumentList $Py, $Kit, $Acceptance, '04_queue_first.do'
```

When the original Terminal displays `PLATFORM_QUEUE_FIRST_START` and is still
busy, start the second client. The first fixture waits six seconds; if this
window was missed, preserve the result instead of claiming concurrent arrival.

```powershell
$Second = Start-Job -ScriptBlock $QueueClient -ArgumentList $Py, $Kit, $Acceptance, '05_queue_second.do'
Wait-Job -Job $First, $Second | Out-Null
Receive-Job -Job $First, $Second
if ($First.State -ne 'Completed' -or $Second.State -ne 'Completed') { throw 'Inspect original queue records; do not resubmit' }
```

After the manual cancellation test, run cleanup and collect the local evidence:

```powershell
& $Py -B $Kit run --root $Acceptance --fixture 07_cleanup.do
& $Py -B $Kit collect --root $Acceptance
```

`collect` prints absolute paths to its JSON report and ZIP. It snapshots the
private evidence, synthetic workspace, MCP temporary files and VS Code logs,
skipping symlinks/junctions and previous ZIPs. The per-file limit is 20 MB and the
total is 200 MB; the report lists omissions. Its hashes describe the exact bytes
in the ZIP, including logs that were growing when captured. If writing the ZIP
would violate the configured disk reserve, the JSON inventory is retained with
an explicit skipped-archive reason. Collection never labels native acceptance
passed and never uploads files. Review the report and keep any skipped material
locally until the relevant failure has been resolved.

Record actual start/dispatch/settlement timestamps from both receipt directories,
not just final exit codes. These two jobs do not certify mixed human/client
contention; record a separate GUI-originated overlap if that claim is needed.
If a second submit is refused before dispatch, retain that refusal; it is not a
successful queue test. Unknown submissions are reconciled by original request ID.

Compare PNG pixel arrays after full decoding; compare CSV and DTA values and
types. Do not require byte-identical DTA files across independent runs because
their metadata may differ. Preserve Stata/editor/Python versions, command
arguments, source hashes, original logs, receipt JSON, output hashes, actual
screenshots, and original research-instance before/after identities. Screen
observations and automated handlers are not human keypress evidence.

The initial acceptance does not certify long-path support beyond the tested
paths, Windows ARM, every Stata edition, remote desktops, native Mac bitmap
recovery, or public release readiness. Record a failure with its original request,
fix only the affected boundary, and rerun the relevant synthetic case once.
