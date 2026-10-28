# Windows acceptance through UU remote terminal

The primary Windows control path is the UU CLI and its remote PowerShell
terminal. The UU desktop stream remains an observation and consent surface:
use it for source/Terminal layout, graphs, dialogs, and screenshots only. Do
not make routine development depend on Computer Use clicks inside the streamed
Windows desktop.

This follows the cross-platform split in the Tw93 reference: shared rules and
the client are developed and tested on the Mac/CI lane; Windows-only process,
filesystem, Stata, and desktop behavior is exercised by a short terminal
script; a physical desktop is reserved for final visual and consent checks.

## 1. Discover the device without changing it

On the Mac control host, keep UU Remote running and use the signed CLI shipped
with the app:

```zsh
UUCli="$(command -v uuyc-cli || printf '%s' /Applications/UURemote.app/Contents/Helpers/uuyc-cli)"
"$UUCli" --version
"$UUCli" device list
"$UUCli" device status
```

Select the online Windows device by its returned `deviceId`, then open the
remote terminal:

```zsh
"$UUCli" term <deviceId>
```

The command opens a native UU terminal window with a PowerShell prompt. A
short marker must be typed and verified in that window before sending a
longer script. A successful desktop stream does not prove that keyboard input
reaches Windows; the terminal marker does.

## 2. Transfer only a pinned, read-only script

Use a temporary authenticated/shared path that is reachable by the Windows
terminal, and record the SHA256 before execution. The maintained collector is
`scripts/collect_windows_baseline.ps1`. For Windows PowerShell 5.1, use the
ASCII-only companion `scripts/collect_windows_baseline_terminal.ps1`; it avoids
encoding-dependent parsing of non-ASCII legacy paths. The collector reads OS,
tool, path, and disk metadata, then writes one JSON file. It does not read
document contents, install software, start/stop Stata, or change settings.

Example remote command after the file is reachable:

```powershell
$Root = Join-Path $env:TEMP 'StataWorkbenchTerminalAcceptance'
New-Item -ItemType Directory -Force $Root | Out-Null
$Script = Join-Path $Root 'collect_windows_baseline_terminal.ps1'
$Out = Join-Path $Root 'windows-baseline-terminal.json'
& $Script -OutputPath $Out -Workspace (Get-Location).Path
Get-Content -Raw $Out
```

Keep the JSON and the exact script hash in the acceptance evidence. The
private setup requires at least 20.5 GB free on the target system (20 GB
reserve plus 500 MB setup budget). If the measured value is lower, record the
baseline and defer installation/launch; do not reclaim files or alter the
research machine through the remote channel.

## 3. Run the acceptance from the terminal

Once the baseline confirms the licensed Stata executable, the pinned VSIX,
the private profile, and the disk budget, run the existing `acceptance.py`
commands from the remote PowerShell terminal. Keep each command short and
record its JSON/log path. The fixture sequence and GUI evidence remain those in
`WINDOWS_ACCEPTANCE.md`; the difference is that `prepare`, `collect`, client
fixtures, queue jobs, and cleanup are submitted through the terminal instead
of typed into a streamed PowerShell window.

Use the desktop stream only for the steps that actually require a desktop:
source/Terminal placement, graph Open, Data Browser, Stop, and OS consent or
lock/unlock observations. A later screenshot cannot prove an earlier source
was visible, so archive the original file and any compatibility execution copy
separately.

## 4. Display and fallback policy

Keep the UU window on the Sculptor extended display while it is connected. If
Sculptor disconnects, move that UU window to the Mac primary display and
continue the same terminal session; do not stop the authorized remote input or
discard the session. The terminal session is the continuity boundary, not the
desktop window. If UU terminal is unavailable, use a pre-authorized SSH or VM
executor when one exists; do not silently fall back to blind Computer Use
clicks and do not claim Windows acceptance from the Mac lane.
