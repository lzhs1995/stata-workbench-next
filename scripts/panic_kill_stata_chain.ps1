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
# -ScopedTargetCsv "pid:createdMs,...". Each pid is opened once; the creation
# time is read from that handle and the same handle is terminated, so a pid that
# was reused (or exits and is reused mid-call) is never ended. createdMs comes
# from GetProcessTimes in both modes. Processes started by an ended target are
# reported, never adopted. Name-based selection below is kept for manual
# emergency use only.
$swnHelper = @"
using System;
using System.Runtime.InteropServices;
public static class SwnProc {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  const uint QUERY = 0x1000, TERMINATE = 0x0001, SYNCHRONIZE = 0x00100000, STILL_ACTIVE = 259;
  static long ToMs(long ft) { return (ft - 116444736000000000L) / 10000L; }
  public static long CreatedMs(int pid) {
    IntPtr h = OpenProcess(QUERY, false, pid);
    if (h == IntPtr.Zero) return -1;
    try { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? ToMs(c) : -1; } finally { CloseHandle(h); }
  }
  // 0 ended, 1 already exited, 2 creation time differs (pid reused), 3 terminate failed, 4 cannot open
  public static int EndIfSame(int pid, long createdMs, out long seenMs) {
    seenMs = -1;
    IntPtr h = OpenProcess(QUERY | TERMINATE | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? 1 : 4;
    try {
      long c, e, k, u; uint code;
      if (!GetProcessTimes(h, out c, out e, out k, out u)) return 4;
      seenMs = ToMs(c);
      if (seenMs != createdMs) return 2;
      if (GetExitCodeProcess(h, out code) && code != STILL_ACTIVE) return 1;
      if (!TerminateProcess(h, 1)) return 3;
      WaitForSingleObject(h, 5000);
      return 0;
    } finally { CloseHandle(h); }
  }
}
"@
$swnProtected = @("Code.exe", "powershell.exe", "pwsh.exe", "explorer.exe", "copilot.exe", "cmd.exe", "WindowsTerminal.exe",
  "svchost.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "System", "Idle")

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

function Get-SwnCreated {
  param([int]$Id)
  $ms = [SwnProc]::CreatedMs($Id)
  if ($ms -lt 0) { return $null }
  return $ms
}

if ($ListProcesses -or $PSBoundParameters.ContainsKey('ScopedTargetCsv')) { Add-Type -TypeDefinition $swnHelper -ErrorAction Stop }

if ($ListProcesses) {
  $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      ppid = [int]$_.ParentProcessId
      name = [string]$_.Name
      createdMs = Get-SwnCreated ([int]$_.ProcessId)
      stataish = Test-Stataish $_
      spawnParent = Get-SpawnParent $_
    }
  })
  [pscustomobject]@{ ok = $true; mode = "list"; listedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $rows } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($PSBoundParameters.ContainsKey('ScopedTargetCsv')) {
  $wanted = @(); $malformed = @()
  foreach ($item in @($ScopedTargetCsv -split "," | Where-Object { $_ -ne "" })) {
    $p = 0; $c = [int64]0; $parts = $item -split ":"
    if ($parts.Count -eq 2 -and [int]::TryParse($parts[0], [ref]$p) -and [int64]::TryParse($parts[1], [ref]$c) -and $p -gt 4 -and $c -gt 0) {
      $wanted += [pscustomobject]@{ pid = $p; createdMs = $c }
    } else { $malformed += $item }
  }
  if ($malformed.Count -gt 0 -or $wanted.Count -eq 0) {
    [pscustomobject]@{ ok = $false; mode = "scoped"; error = "malformed or empty -ScopedTargetCsv; nothing was ended"; malformed = $malformed } | ConvertTo-Json -Depth 4 -Compress
    exit 2
  }
  if (-not $Force) {
    [pscustomobject]@{ ok = $true; mode = "scoped-dry-run"; requested = $wanted.Count; targets = $wanted } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  $killed = @(); $skipped = @(); $failed = @()
  foreach ($t in $wanted) {
    $name = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$($t.pid)" -ErrorAction SilentlyContinue).Name
    if ($swnProtected -contains $name) { $skipped += [pscustomobject]@{ pid = $t.pid; name = $name; reason = "protected process" }; continue }
    $seen = [int64]-1
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $code = [SwnProc]::EndIfSame($t.pid, $t.createdMs, [ref]$seen)
    switch ($code) {
      0 { $killed += [pscustomobject]@{ pid = $t.pid; name = $name; createdMs = $t.createdMs; endedAtMs = $at } }
      1 { $skipped += [pscustomobject]@{ pid = $t.pid; name = $name; reason = "already exited" } }
      2 { $skipped += [pscustomobject]@{ pid = $t.pid; name = $name; reason = "creation time changed (pid reused)"; seenMs = $seen } }
      default { $failed += [pscustomobject]@{ pid = $t.pid; name = $name; error = $(if ($code -eq 3) { "TerminateProcess failed" } else { "cannot open process" }) } }
    }
  }
  # Report (never end) processes started by an ended target before it was ended and not in the request.
  $requested = @{}; foreach ($t in $wanted) { $requested[[int]$t.pid] = $true }
  $endedAt = @{}; foreach ($k in $killed) { $endedAt[[int]$k.pid] = @([int64]$k.createdMs, [int64]$k.endedAtMs) }
  $unresolved = @()
  if ($endedAt.Count -gt 0) {
    Start-Sleep -Milliseconds 300
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $endedAt.ContainsKey([int]$_.ParentProcessId) -and -not $requested.ContainsKey([int]$_.ProcessId) } | ForEach-Object {
      $cm = Get-SwnCreated ([int]$_.ProcessId); $win = $endedAt[[int]$_.ParentProcessId]
      if ($null -ne $cm -and $cm -ge $win[0] -and $cm -le $win[1]) {
        $unresolved += [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; ppid = [int]$_.ParentProcessId; reason = "started by an ended backend process after the listing; not ended" }
      }
    }
  }
  [pscustomobject]@{ ok = ($failed.Count -eq 0); mode = "scoped"; requested = $wanted.Count; killedCount = $killed.Count; killed = $killed; skipped = $skipped; failed = $failed; unresolved = $unresolved } | ConvertTo-Json -Depth 5 -Compress
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
