# Legacy command name delegates to the shared, single-dispatch client.
param(
  [string]$Code,
  [string]$DoFile,
  [string]$Cwd = "",
  [string]$Label = "Visible Stata Run",
  [int]$TimeoutSec = 300,
  [switch]$TailLog,
  [int]$TailLines = 80,
  [switch]$PlainTextTail,
  [switch]$NoSharedStateMutation,
  [switch]$AllowHttp500Retry,
  [switch]$UseRunFileHandler
)

& (Join-Path $PSScriptRoot "invoke_stata_visible_safe.ps1") @PSBoundParameters
exit $LASTEXITCODE
