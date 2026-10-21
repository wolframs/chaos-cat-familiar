param(
  [string]$PackagePath = ".\packaging\windows\out\ChaosCatFamiliar-dev.msix",
  [switch]$ForceShutdown,
  [switch]$LaunchAfterInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$resolvedPackagePath = Join-Path $repoRoot $PackagePath
$metadataPath = Join-Path $repoRoot "packaging\windows\package-metadata.json"

if (-not (Test-Path $resolvedPackagePath)) {
  throw "MSIX package was not found at $resolvedPackagePath"
}

$metadata = Get-Content $metadataPath | ConvertFrom-Json
$existing = Get-AppxPackage -Name $metadata.identityName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[ccf-msix] existing package detected; removing before install"
  foreach ($pkg in $existing) {
    Remove-AppxPackage -Package $pkg.PackageFullName
  }
}

$installArgs = @{
  Path = $resolvedPackagePath
}

if ($ForceShutdown) {
  $installArgs["ForceApplicationShutdown"] = $true
}

Add-AppxPackage @installArgs
Write-Host "[ccf-msix] installed $resolvedPackagePath"

$installed = Get-AppxPackage -Name $metadata.identityName -ErrorAction Stop
Write-Host "[ccf-msix] installed package full name: $($installed.PackageFullName)"

if ($LaunchAfterInstall) {
  Start-Process "shell:AppsFolder\$($metadata.identityName)!$($metadata.applicationId)"
}
