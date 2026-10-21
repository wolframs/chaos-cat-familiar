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

$sourceDir = Join-Path $repoRoot $config.sourceDir
$outDir = Join-Path $repoRoot $config.outDir
$iconPath = Join-Path $repoRoot $config.icon
$instructionsPath = Join-Path $repoRoot "packaging\windows\input\package-electron-app.instructions.txt"

if (-not (Test-Path $sourceDir)) {
  throw "Electron app source directory was not found at $sourceDir"
}

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
  "--asar",
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
  & npm exec --workspace @chaos-cat-familiar/windows-shell electron-packager -- `
    $sourceDir `
    $config.productName `
    --platform=$($config.platform) `
    --arch=$($config.arch) `
    --out=$outDir `
    --overwrite `
    --asar `
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
