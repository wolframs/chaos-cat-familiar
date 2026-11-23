param(
  [switch]$RunPackager,
  [string]$ConfigPath = ".\packaging\windows\electron-packager.config.json"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$resolvedConfigPath = Join-Path $repoRoot $ConfigPath

if (-not (Test-Path $resolvedConfigPath)) {
  throw "Missing Electron packaging config at $resolvedConfigPath"
}

$config = Get-Content $resolvedConfigPath | ConvertFrom-Json
$appVersion = if ($null -ne $config.version) { $config.version } else { "0.1.0" }

$outDir = Join-Path $repoRoot $config.outDir
# The packaged app is a staged folder that mirrors the repo for what CCF runs (process-split plan, step 7): main, core,
# companion and renderer import packages/core by relative path, and node-pty/@xterm live in the root node_modules.
$sourceDir = Join-Path $outDir "stage"
# What stays outside app.asar (files other programs open by path) is defined once, in the stage script.
$patterns = & node (Join-Path $PSScriptRoot "stage-electron-app.mjs") --patterns | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $patterns.unpack) { throw "Reading the asar unpack patterns from stage-electron-app.mjs failed" }
$asarUnpack = $patterns.unpack
$asarUnpackDir = $patterns.unpackDir
$iconPath = Join-Path $repoRoot $config.icon
$instructionsPath = Join-Path $repoRoot "packaging\windows\input\package-electron-app.instructions.txt"

if (-not (Test-Path $iconPath)) {
  throw "Windows icon was not found at $iconPath. Run 'npm run assets:windows:pixel' first."
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$packagerCommand = @(
  "npm exec --workspace @chaos-cat-familiar/windows-shell electron-packager --",
  "`"$sourceDir`"",
  "`"$config.productName`"",
  "--platform=$($config.platform)",
  "--arch=$($config.arch)",
  "--out=`"$outDir`"",
  "--overwrite",
  "--asar.unpack=`"$asarUnpack`"",
  "--asar.unpackDir=`"$asarUnpackDir`"",
  "--prune=false",
  "--icon=`"$iconPath`"",
  "--executable-name=`"$($config.executableName)`"",
  "--app-version=`"$appVersion`""
) -join " "

$instructionLines = @(
  "Chaos Cat Familiar Electron packaging handoff",
  "",
  "Config:",
  "  $resolvedConfigPath",
  "",
  "Expected packaged output:",
  "  $(Join-Path $outDir "$($config.productName)-$($config.platform)-$($config.arch)")",
  "",
  "Recommended command:",
  "  $packagerCommand",
  "",
  "After packaging:",
  "  1. Verify the packaged app folder under packaging/windows/input",
  "  2. The wrapper will copy it to packaging/windows/input/app when RunPackager is used",
  "  3. If you package manually, copy or rename the folder to packaging/windows/input/app",
  "  4. Run npm run packaging:windows:manifest",
  "  5. Run npm run packaging:windows:stage-msix",
  "",
  "Notes:",
  "  - This wrapper expects @electron/packager to be installed in the workspace.",
  "  - For a first packaged build, validate the produced ChaosCatFamiliar.exe path before MSIX staging."
)
Set-Content -Path $instructionsPath -Value ($instructionLines -join [Environment]::NewLine)

Write-Host "[ccf-electron] wrote instructions to $instructionsPath"

if (-not $RunPackager) {
  Write-Host "[ccf-electron] RunPackager was not requested. Instructions only."
  exit 0
}

Push-Location $repoRoot
try {
  & node .\scripts\windows\stage-electron-app.mjs --out $sourceDir
  if ($LASTEXITCODE -ne 0) { throw "Staging the app failed with exit code $LASTEXITCODE" }
  & npm exec --workspace @chaos-cat-familiar/windows-shell electron-packager -- `
    $sourceDir `
    $config.productName `
    --platform=$($config.platform) `
    --arch=$($config.arch) `
    --out=$outDir `
    --overwrite `
    "--asar.unpack=$asarUnpack" `
    "--asar.unpackDir=$asarUnpackDir" `
    --prune=false `
    --icon=$iconPath `
    --executable-name=$($config.executableName) `
    --app-version=$appVersion
} finally {
  Pop-Location
}

if ($LASTEXITCODE -ne 0) {
  throw "electron-packager failed with exit code $LASTEXITCODE"
}

$producedFolder = Join-Path $outDir "$($config.productName)-$($config.platform)-$($config.arch)"
$inputAppDir = Join-Path $outDir "app"
if (Test-Path $inputAppDir) {
  Remove-Item -Recurse -Force $inputAppDir
}

if (Test-Path $producedFolder) {
  Copy-Item -Recurse -Force $producedFolder $inputAppDir
  Write-Host "[ccf-electron] copied packaged app to $inputAppDir"
} else {
  Write-Warning "[ccf-electron] Expected packaged folder $producedFolder was not found. Verify the packager output manually."
}
