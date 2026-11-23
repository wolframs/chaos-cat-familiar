# Harmless stand-in for work-companion's start-companion.ps1 (tests and smoke runs only; never Claude or Codex).
# The companion process runs it in its PTY like the real launcher. It starts one hidden grandchild with a console of its
# own (as Claude's MCP servers have), records "<own pid> <grandchild pid>" in pids-<own pid>.txt next to itself, then:
#   - with load.json next to it: prints prefillLines lines, then chunkLines coloured lines every chunkMs, forever;
#   - otherwise: prints "CCF fixture ready" and echoes every input line as "echo: <line>" ("size" prints the console
#     size the PTY reports, as "size: <cols>x<rows>").
param([switch]$Inner)
$ErrorActionPreference = 'Stop'
$grandchild = Start-Process -FilePath 'pwsh.exe' -ArgumentList '-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 600' `
  -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $PSScriptRoot "pids-$PID.txt") -Value "$PID $($grandchild.Id)"
$loadPath = Join-Path $PSScriptRoot 'load.json'
if (Test-Path -LiteralPath $loadPath) {
  $load = Get-Content -LiteralPath $loadPath -Raw | ConvertFrom-Json
  $filler = 'dolor sit amet ' * 5
  $builder = [System.Text.StringBuilder]::new()
  for ($line = 0; $line -lt $load.prefillLines; $line++) { [void]$builder.Append("prefill $line $filler`r`n") }
  [Console]::Out.Write($builder.ToString())
  $chunk = 0
  $esc = [char]27
  while ($true) {
    $chunk++
    $builder.Clear() | Out-Null
    for ($line = 0; $line -lt $load.chunkLines; $line++) {
      [void]$builder.Append("$esc[3$($line % 7 + 1)m${chunk}:$line $('lorem ipsum ' * 6)$esc[0m`r`n")
    }
    [Console]::Out.Write($builder.ToString())
    Start-Sleep -Milliseconds $load.chunkMs
  }
}
Write-Host 'CCF fixture ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'size') { Write-Host "size: $([Console]::WindowWidth)x$([Console]::WindowHeight)"; continue }
  Write-Host "echo: $line"
}
