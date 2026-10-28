<#
Collect a read-only Windows baseline through the UU remote terminal.
This file is ASCII-only so Windows PowerShell 5.1 can parse it without an
encoding-dependent preamble. It does not inspect document contents or start
and stop application processes.
#>
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $env:TEMP 'StataWorkbenchTerminalAcceptance\windows-baseline.json'),
    [string]$Workspace = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

function Get-CommandInfo {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return [ordered]@{ name = $Name; found = $false }
    }
    $version = $null
    if ($Name -notmatch '^(stata|StataMP-64|StataSE-64)$') {
        try { $version = (& $command.Source --version 2>$null | Select-Object -First 1) } catch { $version = $null }
    }
    return [ordered]@{
        name = $Name
        found = $true
        path = $command.Source
        version = if ($null -eq $version) { $null } else { [string]$version }
    }
}

$resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace).Path
$os = Get-CimInstance Win32_OperatingSystem
$drive = Get-PSDrive -Name C
$payload = [ordered]@{
    schema = 'stata-workbench-windows-baseline-terminal-v1'
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    machine = [ordered]@{
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        osCaption = $os.Caption
        osVersion = $os.Version
        osBuild = $os.BuildNumber
        architecture = $env:PROCESSOR_ARCHITECTURE
        powershell = $PSVersionTable.PSVersion.ToString()
        cDriveFreeBytes = [int64]$drive.Free
        cDriveFreeGB = [math]::Round($drive.Free / 1GB, 2)
    }
    commands = @(
        (Get-CommandInfo 'code')
        (Get-CommandInfo 'code.cmd')
        (Get-CommandInfo 'node')
        (Get-CommandInfo 'npm')
        (Get-CommandInfo 'stata')
        (Get-CommandInfo 'StataMP-64')
        (Get-CommandInfo 'StataSE-64')
    )
    paths = [ordered]@{
        workspace = $resolvedWorkspace
        profile = (Join-Path $env:USERPROFILE '.stata-workbench-platform-20261027')
        extensionRoot = (Join-Path $env:USERPROFILE '.vscode\extensions')
    }
    bridgePorts = @(17485, 17495, 17525)
    notes = @(
        'Read-only metadata collection through UU remote terminal.'
        'No process, settings, or document contents were changed.'
    )
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output (Resolve-Path -LiteralPath $OutputPath).Path
