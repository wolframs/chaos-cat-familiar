# Harmless stand-in for a stdio child of the companion (codex app-server, habitat bridge, watcher), tests only. Starts
# one hidden grandchild with a console of its own, records "<own pid> <grandchild pid>" in stdio-<own pid>.txt next to
# itself, then waits.
$ErrorActionPreference = 'Stop'
$grandchild = Start-Process -FilePath 'pwsh.exe' -ArgumentList '-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 600' `
  -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $PSScriptRoot "stdio-$PID.txt") -Value "$PID $($grandchild.Id)"
Start-Sleep -Seconds 600
