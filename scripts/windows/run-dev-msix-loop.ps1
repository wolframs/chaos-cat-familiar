param(
  [string]$PackagePath = ".\packaging\windows\out\ChaosCatFamiliar-dev.msix",
  [int]$Iterations = 1,
  [int]$PauseSeconds = 2
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installScript = Join-Path $PSScriptRoot "install-dev-msix.ps1"
$uninstallScript = Join-Path $PSScriptRoot "uninstall-dev-msix.ps1"
$validateScript = Join-Path $PSScriptRoot "validate-dev-msix-install.ps1"

for ($i = 1; $i -le $Iterations; $i++) {
  Write-Host "[ccf-msix-loop] iteration $i/$Iterations"
  & $uninstallScript
  & $validateScript
  & $installScript -PackagePath $PackagePath -ForceShutdown
  & $validateScript -ExpectInstalled
  Start-Sleep -Seconds $PauseSeconds
  & $uninstallScript
  & $validateScript
}

Write-Host "[ccf-msix-loop] completed $Iterations iteration(s)"
