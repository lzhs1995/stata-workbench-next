# Compatibility entry: both OS clients use the same receipt verifier and one POST.
# No automatic reset, retry, patch installation or hidden Stata instance.
param(
  [string]$Code, [string]$DoFile, [string]$Cwd = "",
  [string]$Label = "Visible Stata Safe Run", [int]$TimeoutSec = 900,
  [switch]$TailLog, [int]$TailLines = 80, [switch]$PlainTextTail,
  [switch]$NoSharedStateMutation, [switch]$AllowHttp500Retry,
  [switch]$UseRunFileHandler,
  [ValidateSet("fail", "wait", "reset")][string]$BusyPolicy = "wait",
  [int]$MaxWaitSec = 60, [int]$PollSec = 5,
  [switch]$VerifyPatch, [switch]$SmokeAfterReset, [string]$ReceiptDir
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$temporarySource = $null
try {
  if ($AllowHttp500Retry -or $BusyPolicy -eq "reset" -or $SmokeAfterReset) {
    throw "Automatic retry/reset is retired. Reconcile the original request; no request was sent."
  }
  if ($NoSharedStateMutation -or $env:STATA_VISIBLE_NO_MUTATION -eq "1") {
    throw "This entry executes in the existing shared session. No hidden replacement is created."
  }
  if ($UseRunFileHandler) {
    throw "Use VS Code Run Current File for human-file acceptance; this entry uses the verified agent protocol."
  }
  if (([string]::IsNullOrWhiteSpace($Code)) -eq ([string]::IsNullOrWhiteSpace($DoFile))) {
    throw "Provide exactly one of -Code or -DoFile."
  }
  if ($TimeoutSec -lt 1 -or $MaxWaitSec -lt 0 -or $TailLines -lt 1) {
    throw "Timeout/TailLines must be positive and MaxWaitSec nonnegative."
  }
  if ([string]::IsNullOrWhiteSpace($Cwd)) {
    $Cwd = if ($env:STATA_WORKBENCH_WORKSPACE) { $env:STATA_WORKBENCH_WORKSPACE } else { $repoRoot }
  }
  if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) { throw "Cwd must exist." }
  $workbenchPython = $env:STATA_WORKBENCH_PYTHON
  if (-not $workbenchPython) { $workbenchPython = (Get-Command python.exe -ErrorAction Stop).Source }
  if ($workbenchPython -match '[/\\]WindowsApps[/\\]') {
    throw "Select the installed Python with STATA_WORKBENCH_PYTHON; the Store alias is not an interpreter."
  }
  if (-not (Test-Path -LiteralPath $workbenchPython -PathType Leaf)) { throw "Python executable not found." }
  if ($VerifyPatch) {
    & $workbenchPython -X utf8 -B (Join-Path $repoRoot "tools/verified_workbench.py") --status
    if ($LASTEXITCODE -ne 0) { throw "Candidate identity/window check failed; no dispatch." }
  }
  if (-not [string]::IsNullOrWhiteSpace($Code)) {
    # Avoid PowerShell 5.1 native-argument quoting of arbitrary multiline Stata.
    $temporarySource = Join-Path ([IO.Path]::GetTempPath()) ("workbench-" + [guid]::NewGuid().ToString("N") + ".do")
    [IO.File]::WriteAllText($temporarySource, $Code, [Text.UTF8Encoding]::new($false))
    $DoFile = $temporarySource
  }
  $workbenchArgs = @("-X", "utf8", "-B", (Join-Path $repoRoot "tools/shared_stata.py"),
    "--file", $DoFile, "--cwd", $Cwd, "--timeout", "$TimeoutSec",
    "--busy-policy", $BusyPolicy, "--max-wait", "$MaxWaitSec", "--label", $Label)
  if ($ReceiptDir) { $workbenchArgs += @("--receipt-dir", $ReceiptDir) }
  $raw = & $workbenchPython @workbenchArgs
  $clientExit = $LASTEXITCODE
  $raw | Write-Output
  if ($TailLog -and $clientExit -eq 0) {
    $result = ($raw -join "`n") | ConvertFrom-Json
    $log = Join-Path $result.receipt "run.log"
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 -Tail $TailLines }
  }
  exit $clientExit
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 2
} finally {
  if ($temporarySource -and (Test-Path -LiteralPath $temporarySource)) {
    # Keep submitted source for uncertain/completed requests; its path may be in a live do-command.
    Write-Verbose "Preserved submitted source: $temporarySource"
  }
}
