<#
.SYNOPSIS
    Build ccf-hook-relay.exe and (with -InstallTask) register the logon task that keeps it running.
.DESCRIPTION
    Output: %LOCALAPPDATA%\chaos-cat-familiar-relay\ccf-hook-relay.exe (built to a temp name, then swapped in, so a
    running relay does not block the build; the new binary is used from the next start).
    Task 'ccf-hook-relay': at logon, restart every minute on failure, no time limit, user scope, no admin.
    Built with -H windowsgui, so it never opens a console window.
    Revert: Unregister-ScheduledTask ccf-hook-relay -Confirm:$false; stop the process; set CCF's hookRelayPort to null.
#>
param([switch]$InstallTask, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'chaos-cat-familiar-relay'
[IO.Directory]::CreateDirectory($dir) | Out-Null
$exe = Join-Path $dir 'ccf-hook-relay.exe'
$tmp = "$exe.new"
Push-Location $PSScriptRoot
try {
    & go test ./... ; if ($LASTEXITCODE) { throw 'go test failed' }
    & go build -trimpath -ldflags '-s -w -H windowsgui' -o $tmp . ; if ($LASTEXITCODE) { throw 'go build failed' }
} finally { Pop-Location }
if (Test-Path $exe) { Move-Item $exe "$exe.old" -Force }
Move-Item $tmp $exe -Force
Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue   # fails while the old one still runs; harmless
Write-Host "built $exe"

if ($InstallTask) {
    $action = New-ScheduledTaskAction -Execute $exe
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'ccf-hook-relay' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
        -Description 'Chaos Cat Familiar hook relay: answers Claude Code routine http hooks when CCF is closed. chaos-cat-familiar/apps/hook-relay' | Out-Null
    Write-Host "task ccf-hook-relay registered"
}
if ($Restart -or $InstallTask) {
    Get-Process ccf-hook-relay -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-ScheduledTask -TaskName 'ccf-hook-relay'
    Write-Host "relay (re)started"
}
