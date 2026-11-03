param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$IncludeStataGui,
  [switch]$ListProcesses,
  [string]$ScopedTargetCsv = ""
)

$ErrorActionPreference = "Stop"

# rc.7.82: the extension no longer asks this script to pick targets by name.
# -ListProcesses prints the process table; the extension chooses this window's
# backend tree (scripts/windows_kill_scope_core.js) and passes it back as
# -ScopedTargetCsv "pid:createdMs,...". Each pid is ended only if it still has
# that creation time, so a reused pid is skipped. Name-based selection below is
# kept for manual emergency use only.
function Get-CreatedMs {
  param($Proc)
  try {
    if ($Proc.CreationDate) { return [int64](([DateTimeOffset]$Proc.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) }
  } catch {}
  return $null
}

function Test-Stataish {
  param($Proc)
  $name = [string]$Proc.Name
  $cmd = if ($Proc.CommandLine) { [string]$Proc.CommandLine } else { "" }
  if ($name -match '^(StataMP|StataSE|StataBE|Stata)(-64)?\.exe$') { return $true }
  if ($name -ieq "mcp-stata.exe") { return $true }
  if (($name -ieq "python.exe" -or $name -ieq "pythonw.exe" -or $name -ieq "uv.exe" -or $name -ieq "uvx.exe") -and $cmd -match '(?i)mcp[-_]stata|stata_mcp|spawn_main') { return $true }
  return $false
}

function Get-SpawnParent {
  param($Proc)
  $cmd = if ($Proc.CommandLine) { [string]$Proc.CommandLine } else { "" }
  if ($cmd -match 'spawn_main\(\s*parent_pid\s*=\s*(\d+)') { return [int]$Matches[1] }
  return $null
}

if ($ListProcesses) {
  $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      ppid = [int]$_.ParentProcessId
      name = [string]$_.Name
      createdMs = Get-CreatedMs $_
      stataish = Test-Stataish $_
      spawnParent = Get-SpawnParent $_
    }
  })
  [pscustomobject]@{ ok = $true; mode = "list"; listedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $rows } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($ScopedTargetCsv)) {
  $protected = @("Code.exe", "powershell.exe", "pwsh.exe", "explorer.exe", "copilot.exe", "cmd.exe")
  $wanted = @($ScopedTargetCsv -split "," | ForEach-Object {
    $parts = $_ -split ":"
    $p = 0; $c = [int64]0
    if ($parts.Count -eq 2 -and [int]::TryParse($parts[0], [ref]$p) -and [int64]::TryParse($parts[1], [ref]$c) -and $p -gt 4) {
      [pscustomobject]@{ pid = $p; createdMs = $c }
    }
  })
  $killed = @(); $skipped = @(); $failed = @(); $late = @()
  if (-not $Force) {
    [pscustomobject]@{ ok = $true; mode = "scoped-dry-run"; requested = $wanted.Count; targets = $wanted } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  function Stop-Verified {
    param($Pid0, $CreatedMs, $Why)
    $now = Get-CimInstance Win32_Process -Filter "ProcessId=$Pid0" -ErrorAction SilentlyContinue
    if (-not $now) { $script:skipped += [pscustomobject]@{ pid = $Pid0; reason = "already exited" }; return }
    $nowMs = Get-CreatedMs $now
    if ($null -eq $nowMs -or [Math]::Abs($nowMs - $CreatedMs) -gt 2) { $script:skipped += [pscustomobject]@{ pid = $Pid0; name = [string]$now.Name; reason = "creation time changed (pid reused)" }; return }
    if ($protected -contains [string]$now.Name) { $script:skipped += [pscustomobject]@{ pid = $Pid0; name = [string]$now.Name; reason = "protected process" }; return }
    try {
      Stop-Process -Id $Pid0 -Force -ErrorAction Stop
      $script:killed += [pscustomobject]@{ pid = $Pid0; name = [string]$now.Name; createdMs = $nowMs; why = $Why }
    } catch {
      if (Get-Process -Id $Pid0 -ErrorAction SilentlyContinue) { $script:failed += [pscustomobject]@{ pid = $Pid0; name = [string]$now.Name; error = $_.Exception.Message } }
      else { $script:skipped += [pscustomobject]@{ pid = $Pid0; reason = "exited during kill" } }
    }
  }
  foreach ($t in $wanted) { Stop-Verified -Pid0 $t.pid -CreatedMs $t.createdMs -Why "this window's backend tree" }
  # A child started between the listing and the kill: same parent rule (not older than its parent).
  $ended = @{}; foreach ($k in $killed) { $ended[[int]$k.pid] = [int64]$k.createdMs }
  if ($ended.Count -gt 0) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $ended.ContainsKey([int]$_.ParentProcessId) } | ForEach-Object {
      $cm = Get-CreatedMs $_
      if ($null -ne $cm -and $cm -ge $ended[[int]$_.ParentProcessId] -and -not ($protected -contains [string]$_.Name)) {
        $late += [int]$_.ProcessId
        Stop-Verified -Pid0 ([int]$_.ProcessId) -CreatedMs $cm -Why "child started during kill"
      }
    }
  }
  [pscustomobject]@{ ok = ($failed.Count -eq 0); mode = "scoped"; requested = $wanted.Count; killedCount = $killed.Count; killed = $killed; skipped = $skipped; failed = $failed; lateChildren = $late } | ConvertTo-Json -Depth 5 -Compress
  if ($failed.Count -gt 0) { exit 1 }
  exit 0
}

if (-not $DryRun -and -not $Force) {
  $DryRun = $true
}

$currentPid = $PID
$protectedNames = @(
  "Code.exe",
  "copilot.exe",
  "pwsh.exe",
  "powershell.exe"
)

function Get-CimProcessMap {
  $map = @{}
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $map[[int]$_.ProcessId] = $_
  }
  return $map
}

function Get-Reason {
  param($Proc)

  $name = [string]$Proc.Name
  $cmd = if ($Proc.CommandLine) { [string]$Proc.CommandLine } else { "" }

  if ($name -ieq "mcp-stata.exe") { return "mcp-stata helper" }
  if (($name -ieq "uvx.exe" -or $name -ieq "uv.exe") -and $cmd -match "mcp-stata") { return "uv/uvx mcp-stata launcher" }
  if ($name -ieq "python.exe" -and $cmd -match "mcp-stata") { return "python mcp-stata process" }
  if ($name -ieq "python.exe" -and $cmd -match "stata_mcp_worker_entry\.py") { return "subprocess Stata MCP worker" }
  if ($name -ieq "python.exe" -and $cmd -match "stata_mcp_py311_server\.py") { return "subprocess Stata MCP server" }
  if ($IncludeStataGui -and ($name -ieq "StataMP-64.exe" -or $name -ieq "StataSE-64.exe" -or $name -ieq "Stata-64.exe")) { return "Stata GUI process included by panic mode" }

  return $null
}

function Add-With-Children {
  param(
    [hashtable]$Map,
    [hashtable]$Selected,
    [int]$TargetPid,
    [string]$Reason
  )

  if (-not $Map.ContainsKey($TargetPid)) { return }
  if ($Selected.ContainsKey($TargetPid)) { return }
  $Selected[$TargetPid] = [pscustomobject]@{
    pid = $TargetPid
    name = [string]$Map[$TargetPid].Name
    reason = $Reason
    parentPid = [int]$Map[$TargetPid].ParentProcessId
    commandLine = [string]$Map[$TargetPid].CommandLine
  }

  foreach ($child in $Map.Values | Where-Object { [int]$_.ParentProcessId -eq $TargetPid }) {
    Add-With-Children -Map $Map -Selected $Selected -TargetPid ([int]$child.ProcessId) -Reason "child of panic target $TargetPid"
  }
}

$processMap = Get-CimProcessMap
$selected = @{}
$skipped = @()

foreach ($proc in $processMap.Values) {
  $pidValue = [int]$proc.ProcessId
  $name = [string]$proc.Name
  if ($pidValue -eq $currentPid) {
    $skipped += [pscustomobject]@{ pid = $pidValue; name = $name; reason = "current panic script" }
    continue
  }
  if ($protectedNames -contains $name) {
    $skipped += [pscustomobject]@{ pid = $pidValue; name = $name; reason = "protected process" }
    continue
  }
  $reason = Get-Reason -Proc $proc
  if ($reason) {
    Add-With-Children -Map $processMap -Selected $selected -TargetPid $pidValue -Reason $reason
  }
}

$candidates = @($selected.Values | Sort-Object pid)
$killed = @()
$failed = @()

if ($Force) {
  foreach ($candidate in $candidates) {
    if ($protectedNames -contains $candidate.name) {
      $skipped += [pscustomobject]@{ pid = $candidate.pid; name = $candidate.name; reason = "protected process after child expansion" }
      continue
    }
    try {
      $existing = Get-Process -Id $candidate.pid -ErrorAction SilentlyContinue
      if (-not $existing) {
        $skipped += [pscustomobject]@{ pid = $candidate.pid; name = $candidate.name; reason = "already exited" }
        continue
      }
      Stop-Process -Id $candidate.pid -Force -ErrorAction Stop
      $killed += $candidate
    } catch {
      $afterError = Get-Process -Id $candidate.pid -ErrorAction SilentlyContinue
      if (-not $afterError) {
        $skipped += [pscustomobject]@{ pid = $candidate.pid; name = $candidate.name; reason = "already exited during panic kill" }
        continue
      }
      $failed += [pscustomobject]@{
        pid = $candidate.pid
        name = $candidate.name
        reason = $candidate.reason
        error = $_.Exception.Message
      }
    }
  }
}

$result = [pscustomobject]@{
  ok = ($failed.Count -eq 0)
  mode = if ($Force) { "force" } else { "dry-run" }
  includeStataGui = [bool]$IncludeStataGui
  candidateCount = $candidates.Count
  killedCount = $killed.Count
  failedCount = $failed.Count
  candidates = $candidates
  killed = $killed
  failed = $failed
  skipped = $skipped
}

$result | ConvertTo-Json -Depth 8

if ($failed.Count -gt 0) {
  exit 1
}
