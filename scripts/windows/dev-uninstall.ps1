param(
  [switch]$RemoveAppData,
  [switch]$RemoveClaudeHooks,
  [switch]$RemoveProtocolRegistration
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$profileHome = if ($env:CCF_HOME_OVERRIDE) { $env:CCF_HOME_OVERRIDE } else { $HOME }
$profileAppData = if ($env:CCF_APPDATA_OVERRIDE) { $env:CCF_APPDATA_OVERRIDE } else { $env:APPDATA }
$appDataRoot = [IO.Path]::GetFullPath((Join-Path $profileAppData "chaos-cat-familiar"))
$homeCcfRoot = [IO.Path]::GetFullPath((Join-Path $profileHome ".chaos-cat-familiar"))
$claudeSettingsPath = Join-Path $profileHome ".claude\settings.json"
$hookPath = Join-Path $homeCcfRoot "hooks\hook-sender.ps1"
$protocolKey = "HKCU:\Software\Classes\ccf"

Write-Host "[ccf-dev-uninstall] repo: $repoRoot"

Write-Host "[ccf-dev-uninstall] quit CCF before cleanup; other Electron apps are left running"

if ($RemoveClaudeHooks -and (Test-Path $claudeSettingsPath)) {
  Write-Host "[ccf-dev-uninstall] removing CCF Claude hook registrations"
  $nodeScript = @"
import fs from 'node:fs';
import { removeCcfHookRegistrations } from './apps/windows-shell/services/claude-hook-cleanup.js';
const settingsPath = process.argv[2];
const hookPath = process.argv[3];
const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const parsed = JSON.parse(raw);
const result = removeCcfHookRegistrations(parsed, hookPath);
fs.writeFileSync(settingsPath, JSON.stringify(result.updated, null, 2));
console.log(JSON.stringify({ changed: result.changed, removedEvents: result.removedEvents }));
"@
  Push-Location $repoRoot
  try {
    $nodeScript | & node --input-type=module - $claudeSettingsPath $hookPath
    if ($LASTEXITCODE -ne 0) {
      throw "Claude hook cleanup failed with exit code $LASTEXITCODE; sender and app data were kept."
    }
  } finally {
    Pop-Location
  }
}

if ($RemoveClaudeHooks -and (Test-Path -LiteralPath $hookPath)) {
  Write-Host "[ccf-dev-uninstall] removing hook script path $hookPath"
  Remove-Item -LiteralPath $hookPath -Force
}

if ($RemoveAppData) {
  foreach ($target in @(
    @{ Path = $appDataRoot; Parent = $profileAppData },
    @{ Path = $homeCcfRoot; Parent = $profileHome }
  )) {
    $parentPath = [IO.Path]::GetFullPath($target.Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.Path.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing cleanup outside profile directory: $($target.Path)"
    }
  }
  if (-not $RemoveClaudeHooks -and (Test-Path -LiteralPath $hookPath)) {
    throw "Use -RemoveClaudeHooks with -RemoveAppData while a hook sender is installed."
  }
  if (Test-Path -LiteralPath $appDataRoot) {
    Write-Host "[ccf-dev-uninstall] removing app data $appDataRoot"
    Remove-Item -LiteralPath $appDataRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $homeCcfRoot) {
    Write-Host "[ccf-dev-uninstall] removing home data $homeCcfRoot"
    Remove-Item -LiteralPath $homeCcfRoot -Recurse -Force
  }
}

if ($RemoveProtocolRegistration -and (Test-Path $protocolKey)) {
  Write-Host "[ccf-dev-uninstall] removing HKCU ccf protocol registration"
  Remove-Item $protocolKey -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[ccf-dev-uninstall] completed"
Write-Host "Options used:"
Write-Host "  RemoveAppData=$RemoveAppData"
Write-Host "  RemoveClaudeHooks=$RemoveClaudeHooks"
Write-Host "  RemoveProtocolRegistration=$RemoveProtocolRegistration"
