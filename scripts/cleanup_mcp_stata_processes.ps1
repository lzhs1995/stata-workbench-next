# Clean orphan tmonk/mcp-stata helper processes for the Stata Workbench V6 force-reset path.

param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$OwnedPidCsv = ""
)

$ErrorActionPreference = "Stop"

if (-not $DryRun -and -not $Force) {
  $DryRun = $true
}

$currentPid = $PID
$ownedPids = @(
  $OwnedPidCsv -split "," |
    ForEach-Object {
      $parsed = 0
      if ([int]::TryParse($_, [ref]$parsed) -and $parsed -gt 1) { $parsed }
    }
)

# The force-reset caller passes the owned backend PIDs it knows about; an empty
# list (no backend was started yet) means there is nothing of ours to clean.
# That is a no-op success, never a global cleanup. A non-empty list without any
# valid PID is still refused.
if ($Force -and [string]::IsNullOrWhiteSpace($OwnedPidCsv)) {
  [pscustomobject]@{
    ok = $true
    mode = "owned-pids"
    noop = "no owned backend PIDs"
    candidateCount = 0
    killedCount = 0
    failedCount = 0
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($Force -and $ownedPids.Count -eq 0) {
  [pscustomobject]@{
    ok = $false
    mode = "owned-pids"
    error = "Refusing global cleanup: -Force requires -OwnedPidCsv."
  } | ConvertTo-Json -Depth 4
  exit 2
}
$protectedNames = @(
  "Code.exe",
  "copilot.exe",
  "StataMP-64.exe",
  "StataSE-64.exe",
  "Stata-64.exe",
  "pwsh.exe",
  "powershell.exe"
)

function Get-CleanupReason {
  param(
    [string]$Name,
    [string]$CommandLine
  )

  $cmd = if ($CommandLine) { $CommandLine } else { "" }

  if ($Name -ieq "mcp-stata.exe") {
    return "mcp-stata helper executable"
  }
  if ($Name -ieq "uvx.exe" -and $cmd -match "mcp-stata==1\.26\.1" -and $cmd -match "\bmcp-stata\b") {
    return "uvx launched mcp-stata==1.26.1"
  }
  if ($Name -ieq "uv.exe" -and $cmd -match "\btool\s+uvx\b" -and $cmd -match "mcp-stata==1\.26\.1" -and $cmd -match "\bmcp-stata\b") {
    return "uv tool uvx launched mcp-stata==1.26.1"
  }
  if ($Name -ieq "python.exe" -and $cmd -match "\\Scripts\\mcp-stata\.exe") {
    return "python running Scripts\\mcp-stata.exe"
  }

  return $null
}

function Get-ProcessStartTime {
  param($Process)
  try { return $Process.StartTime } catch { return $null }
}

function Test-NearAnyTime {
  param(
    [datetime]$Time,
    [datetime[]]$ReferenceTimes,
    [int]$WindowSeconds = 90
  )

  if (-not $Time -or -not $ReferenceTimes -or $ReferenceTimes.Count -eq 0) {
    return $false
  }
  foreach ($ref in $ReferenceTimes) {
    if ($ref -and [Math]::Abs(($Time - $ref).TotalSeconds) -le $WindowSeconds) {
      return $true
    }
  }
  return $false
}

$candidates = @()
$skipped = @()

$targetProcessNames = @("mcp-stata", "uvx", "uv", "python", "Code", "copilot", "StataMP-64", "StataSE-64", "Stata-64", "pwsh", "powershell")
$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $targetProcessNames -contains $_.ProcessName
}

$mcpStartTimes = @(
  $processes |
    Where-Object { $_.ProcessName -ieq "mcp-stata" -or ($_.Path -match "\\Scripts\\mcp-stata\.exe$") } |
    ForEach-Object { Get-ProcessStartTime $_ } |
    Where-Object { $_ }
)

foreach ($proc in $processes) {
  $name = "$($proc.ProcessName).exe"
  $cmd = ""
  $path = ""
  $startTime = $null
  try { $path = [string]$proc.Path } catch {}
  try { $startTime = $proc.StartTime } catch {}
  $pidValue = [int]$proc.Id

  if ($ownedPids.Count -gt 0 -and $pidValue -notin $ownedPids) {
    continue
  }

  if ($pidValue -eq $currentPid) {
    $skipped += [pscustomobject]@{
      pid = $pidValue
      name = $name
      reason = "current cleanup process"
      commandLine = $cmd
      path = $path
    }
    continue
  }

  if ($protectedNames -contains $name) {
    $skipped += [pscustomobject]@{
      pid = $pidValue
      name = $name
      reason = "protected process"
      commandLine = $cmd
      path = $path
    }
    continue
  }

  $reason = Get-CleanupReason -Name $name -CommandLine $cmd
  if (-not $reason) {
    if ($name -ieq "mcp-stata.exe" -or $path -match "\\Scripts\\mcp-stata\.exe$") {
      $reason = "mcp-stata helper executable"
    } elseif (($name -ieq "uvx.exe" -or $name -ieq "uv.exe") -and (Test-NearAnyTime -Time $startTime -ReferenceTimes $mcpStartTimes)) {
      $reason = "uv/uvx parent near mcp-stata helper start"
    } elseif ($name -ieq "python.exe" -and $path -match "\\uv\\cache\\archive-v0\\.+\\Scripts\\python\.exe$") {
      $reason = "python running uv archive mcp-stata environment"
    } elseif ($name -ieq "python.exe" -and $path -match "\\uv\\python\\cpython-" -and (Test-NearAnyTime -Time $startTime -ReferenceTimes $mcpStartTimes)) {
      $reason = "python child near mcp-stata helper start"
    }
  }
  if ($reason) {
    $candidates += [pscustomobject]@{
      pid = $pidValue
      name = $name
      reason = $reason
      commandLine = $cmd
      path = $path
      startTime = if ($startTime) { $startTime.ToString("o") } else { $null }
    }
  }
}

$killed = @()
$failed = @()

if ($Force) {
  foreach ($candidate in $candidates) {
    try {
      $existing = Get-Process -Id $candidate.pid -ErrorAction SilentlyContinue
      if (-not $existing) {
        $skipped += [pscustomobject]@{
          pid = $candidate.pid
          name = $candidate.name
          reason = "already exited before cleanup"
          commandLine = $candidate.commandLine
        }
        continue
      }
      Stop-Process -Id $candidate.pid -Force -ErrorAction Stop
      $killed += $candidate
    } catch {
      $stillExists = Get-Process -Id $candidate.pid -ErrorAction SilentlyContinue
      if ($stillExists) {
        $failed += [pscustomobject]@{
          pid = $candidate.pid
          name = $candidate.name
          reason = $candidate.reason
          error = $_.Exception.Message
          commandLine = $candidate.commandLine
        }
      } else {
        $skipped += [pscustomobject]@{
          pid = $candidate.pid
          name = $candidate.name
          reason = "exited during cleanup"
          commandLine = $candidate.commandLine
        }
      }
    }
  }
}

$result = [pscustomobject]@{
  ok = ($failed.Count -eq 0)
  mode = if ($Force) { "force" } else { "dry-run" }
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
