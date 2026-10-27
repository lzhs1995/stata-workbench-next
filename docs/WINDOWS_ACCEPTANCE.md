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

The following creates a new timestamped directory. Set `$Stata` to the existing
licensed executable if its installation differs. A missing prerequisite stops
preparation; do not launch a substitute profile to bypass the check.

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
$Acceptance = Join-Path $env:LOCALAPPDATA ('StataWorkbenchAcceptance\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$Repo = Join-Path $Acceptance 'source'
$Profile = Join-Path $Acceptance 'profile'
$Work = Join-Path $Acceptance "workspace\平台 测试 O'Brien"
$Evidence = Join-Path $Acceptance 'evidence'
$Packages = Join-Path $Acceptance 'packages'
New-Item -ItemType Directory -Path $Work, $Evidence, $Packages -Force | Out-Null
git clone --depth 1 --branch codex/cross-platform-client-20261027 https://github.com/lzhs1995/stata-workbench-shared-session.git $Repo
if ($LASTEXITCODE) { throw 'Source checkout failed' }
$Runs = @(gh run list --repo lzhs1995/stata-workbench-shared-session --branch codex/cross-platform-client-20261027 --workflow release-checks.yml --status success --limit 1 --json databaseId,headSha | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $Runs.Count -ne 1) { throw 'No successful candidate CI run; retain this directory and inspect CI' }
$Runs | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'ci-run.json')
git -C $Repo fetch --depth 1 origin $Runs[0].headSha
if ($LASTEXITCODE) { throw 'Could not fetch the exact CI source revision' }
git -C $Repo checkout --detach $Runs[0].headSha
if ($LASTEXITCODE) { throw 'Could not select the exact CI source revision' }
git -C $Repo rev-parse HEAD | Set-Content -LiteralPath (Join-Path $Evidence 'source-commit.txt')
gh run download $Runs[0].databaseId --repo lzhs1995/stata-workbench-shared-session --pattern '*windows-2022*' --dir $Packages
if ($LASTEXITCODE) { throw 'Candidate artifact download failed' }
$VsixFiles = @(Get-ChildItem -LiteralPath $Packages -Recurse -Filter '*.vsix')
if ($VsixFiles.Count -ne 1) { throw 'Expected exactly one Windows candidate VSIX' }
$Vsix = $VsixFiles[0].FullName
& $Py -B (Join-Path $Repo 'tools\verify_release.py') --vsix $Vsix
if ($LASTEXITCODE) { throw 'Source/VSIX identity mismatch; do not install' }
uv venv --python 3.11 (Join-Path $Profile 'runtime')
if ($LASTEXITCODE) { throw 'Private runtime creation failed' }
$RuntimePython = Join-Path $Profile 'runtime\Scripts\python.exe'
uv pip install --python $RuntimePython 'mcp-stata==1.26.1'
if ($LASTEXITCODE) { throw 'Private service installation failed' }
uv pip freeze --python $RuntimePython | Set-Content -LiteralPath (Join-Path $Evidence 'runtime-packages.txt')
Copy-Item -LiteralPath (Join-Path $Repo 'examples\platform-acceptance') -Destination (Join-Path $Acceptance 'fixture-original') -Recurse
Get-ChildItem -LiteralPath (Join-Path $Repo 'examples\platform-acceptance') -Filter '*.do' | Copy-Item -Destination $Work
$env:STATA_WORKBENCH_PROFILE = $Profile
$env:STATA_WORKBENCH_PORT = '17497'
$env:STATA_WORKBENCH_CODE = $Code
$env:STATA_WORKBENCH_PYTHON = $Py
$env:MCP_STATA_CONFIG_PATH = Join-Path $Profile 'mcp.json'
$env:MCP_STATA_RUNTIME_ROOT = Join-Path $Profile 'runtime'
$env:MCP_STATA_TEMP = Join-Path $Profile 'mcp-temp'
$env:UV_CACHE_DIR = Join-Path $Profile 'uv-cache'
$env:UV_TOOL_DIR = Join-Path $Profile 'uv-tools'
$env:TMP = Join-Path $Profile 'tmp'
$env:TEMP = $env:TMP
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
New-Item -ItemType Directory -Path $env:TMP, $env:MCP_STATA_TEMP, (Join-Path $Profile 'user-data\User'), (Join-Path $Profile 'extensions') -Force | Out-Null
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$ServiceEnv = @{}
foreach ($Name in @('MCP_STATA_CONFIG_PATH', 'MCP_STATA_RUNTIME_ROOT', 'MCP_STATA_TEMP', 'UV_CACHE_DIR', 'UV_TOOL_DIR', 'TMP', 'TEMP', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE')) {
    $ServiceEnv[$Name] = [Environment]::GetEnvironmentVariable($Name)
}
$Mcp = @{ servers = @{ mcp_stata = @{ type = 'stdio'; command = $RuntimePython; args = @('-m','mcp_stata'); env = $ServiceEnv } } }
[IO.File]::WriteAllText($env:MCP_STATA_CONFIG_PATH, ($Mcp | ConvertTo-Json -Depth 8), $Utf8)
$Settings = @{'stataMcp.visibleBridgePort'=17497; 'stataMcp.stataPath'=$Stata; 'stataMcp.autoConfigureMcp'=$false; 'stataMcp.configureClaudeCode'=$false; 'stataMcp.configureCodex'=$false; 'stataMcp.loadStataOnStartup'=$false; 'stataMcp.showAllLogsInOutput'=$true; 'stataMcp.runFileWorkingDirectory'='${fileDir}'; 'extensions.autoUpdate'=$false; 'extensions.autoCheckUpdates'=$false; 'update.mode'='none'; 'telemetry.telemetryLevel'='off'}
[IO.File]::WriteAllText((Join-Path $Profile 'user-data\User\settings.json'), ($Settings | ConvertTo-Json), $Utf8)
& $Code --user-data-dir (Join-Path $Profile 'user-data') --extensions-dir (Join-Path $Profile 'extensions') --install-extension $Vsix --force
if ($LASTEXITCODE) { throw 'VSIX installation failed' }
& $Py -B (Join-Path $Repo 'tools\verified_workbench.py') --doctor
& $Py -B (Join-Path $Repo 'tools\verified_workbench.py') --open --workspace $Work
if ($LASTEXITCODE) { throw 'Bound candidate did not open; preserve diagnostics' }
```

Doctor before launch can correctly report no running instance. After launch,
repeat `--doctor` and save its JSON. Verify one chosen profile, the loaded
version/bundle, the selected private configuration/runtime and the actual owner
PIDs. Workspace trust or licensing dialogs require the operator's real response.
Keep this PowerShell window open; its variables/environment are used below.

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

Client template (change only the numeric fixture and unique receipt directory):

```powershell
& $Py -B (Join-Path $Repo 'tools\shared_stata.py') --file (Join-Path $Work '02_agent_shared.do') --cwd $Work --receipt-dir (Join-Path $Evidence '02-agent') --busy-policy wait --max-wait 60
```

For the queue pair, use background jobs from this same PowerShell window so
both inherit the private environment. Argument arrays preserve the workspace's
spaces, Unicode and apostrophe. Start the first client:

```powershell
$QueueClient = {
    param($PythonExe, $SourceRoot, $WorkspaceRoot, $EvidenceRoot, $Fixture, $ReceiptName)
    & $PythonExe -B (Join-Path $SourceRoot 'tools\shared_stata.py') --file (Join-Path $WorkspaceRoot $Fixture) --cwd $WorkspaceRoot --receipt-dir (Join-Path $EvidenceRoot $ReceiptName) --busy-policy wait --max-wait 60
    if ($LASTEXITCODE) { throw "Client failed; inspect original receipt: $ReceiptName" }
}
$First = Start-Job -ScriptBlock $QueueClient -ArgumentList $Py, $Repo, $Work, $Evidence, '04_queue_first.do', '04-first'
```

When the original Terminal displays `PLATFORM_QUEUE_FIRST_START` and is still
busy, start the second client. The first fixture waits six seconds; if this
window was missed, preserve the result instead of claiming concurrent arrival.

```powershell
$Second = Start-Job -ScriptBlock $QueueClient -ArgumentList $Py, $Repo, $Work, $Evidence, '05_queue_second.do', '05-second'
Wait-Job -Job $First, $Second | Out-Null
Receive-Job -Job $First, $Second
if ($First.State -ne 'Completed' -or $Second.State -ne 'Completed') { throw 'Inspect original queue receipts; do not resubmit' }
```

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
