param(
  [string]$ExecutableDir = ".\packaging\windows\input\app",
  [string]$OutputDir = ".\packaging\windows\out",
  [string]$PackageBaseName = "ChaosCatFamiliar-dev",
  [string]$DevCertificatePath = "",
  [switch]$RunPackagingTools
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$metadataPath = Join-Path $repoRoot "packaging\windows\package-metadata.json"
$stageRoot = Join-Path $repoRoot "packaging\windows\out\msix-stage"
$manifestPath = Join-Path $repoRoot "packaging\windows\AppxManifest.dev.xml"
$generatedAssets = Join-Path $repoRoot "packaging\windows\assets\generated"
$pixelIcon = Join-Path $repoRoot "packaging\windows\assets\pixel-art\ChaosCatFamiliar.ico"
$exeSource = Join-Path $repoRoot $ExecutableDir
$outRoot = Join-Path $repoRoot $OutputDir

if (-not (Test-Path $metadataPath)) {
  throw "Missing package metadata at $metadataPath"
}

$metadata = Get-Content $metadataPath | ConvertFrom-Json

if (-not (Test-Path $generatedAssets)) {
  throw "Generated MSIX assets were not found at $generatedAssets. Run 'npm run assets:windows' first."
}

if (-not (Test-Path $manifestPath)) {
  throw "Rendered manifest was not found at $manifestPath. Run 'npm run packaging:windows:manifest' first."
}

if (-not (Test-Path $exeSource)) {
  throw "Packaged app input folder was not found at $exeSource. Place the packaged Windows app layout there or pass -ExecutableDir."
}

New-Item -ItemType Directory -Force -Path $stageRoot, $outRoot | Out-Null
Remove-Item -Recurse -Force $stageRoot\* -ErrorAction SilentlyContinue

$appStage = Join-Path $stageRoot "app"
$assetsStage = Join-Path $stageRoot "assets"
New-Item -ItemType Directory -Force -Path $appStage, $assetsStage | Out-Null

Copy-Item -Recurse -Force $exeSource\* $appStage
Copy-Item -Recurse -Force $generatedAssets (Join-Path $assetsStage "generated")

if (Test-Path $pixelIcon) {
  $pixelStage = Join-Path $assetsStage "pixel-art"
  New-Item -ItemType Directory -Force -Path $pixelStage | Out-Null
  Copy-Item -Force $pixelIcon $pixelStage
}

$manifestDestination = Join-Path $stageRoot "AppxManifest.xml"
$manifestContent = Get-Content $manifestPath -Raw
$manifestContent = $manifestContent.Replace(
  "Executable=`"$($metadata.executablePath)`"",
  "Executable=`"app\$($metadata.executablePath)`""
)
Set-Content -Path $manifestDestination -Value $manifestContent -NoNewline

$packagePath = Join-Path $outRoot "$PackageBaseName.msix"
$instructionsPath = Join-Path $outRoot "build-dev-msix.instructions.txt"

$instructionLines = New-Object System.Collections.Generic.List[string]
$instructionLines.Add("Chaos Cat Familiar dev MSIX staging complete.")
$instructionLines.Add("")
$instructionLines.Add("Stage root:")
$instructionLines.Add("  $stageRoot")
$instructionLines.Add("")
$instructionLines.Add("Manifest:")
$instructionLines.Add("  $manifestDestination")
$instructionLines.Add("")
$instructionLines.Add("Package output target:")
$instructionLines.Add("  $packagePath")
$instructionLines.Add("")
$instructionLines.Add("Recommended commands:")
$instructionLines.Add("  makeappx pack /d `"$stageRoot`" /p `"$packagePath`" /o")
if ($DevCertificatePath) {
  $instructionLines.Add("  signtool sign /fd SHA256 /a /f `"$DevCertificatePath`" `"$packagePath`"")
} else {
  $instructionLines.Add("  signtool sign /fd SHA256 /a /f <path-to-dev-certificate.pfx> `"$packagePath`"")
}
$instructionLines.Add("")
$instructionLines.Add("Notes:")
$instructionLines.Add("  - The packaged executable layout must already exist under '$exeSource'.")
$instructionLines.Add("  - This script does not build the Electron app itself.")
$instructionLines.Add("  - Validate protocol activation and startup-at-login against the installed MSIX, not this staging folder.")
Set-Content -Path $instructionsPath -Value ($instructionLines -join [Environment]::NewLine)

Write-Host "[ccf-msix] staged files under $stageRoot"
Write-Host "[ccf-msix] wrote instructions to $instructionsPath"

if (-not $RunPackagingTools) {
  Write-Host "[ccf-msix] RunPackagingTools was not requested. Staging only."
  exit 0
}

$makeAppx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue

if (-not $makeAppx) {
  throw "makeappx.exe was not found. Install the Windows SDK or run without -RunPackagingTools."
}

if (-not $signTool) {
  throw "signtool.exe was not found. Install the Windows SDK or run without -RunPackagingTools."
}

& $makeAppx.Source pack /d $stageRoot /p $packagePath /o

if ($LASTEXITCODE -ne 0) {
  throw "makeappx.exe failed with exit code $LASTEXITCODE"
}

if (-not $DevCertificatePath) {
  Write-Warning "[ccf-msix] Package created but not signed because -DevCertificatePath was not provided."
  exit 0
}

& $signTool.Source sign /fd SHA256 /a /f $DevCertificatePath $packagePath

if ($LASTEXITCODE -ne 0) {
  throw "signtool.exe failed with exit code $LASTEXITCODE"
}

Write-Host "[ccf-msix] created and signed $packagePath"
