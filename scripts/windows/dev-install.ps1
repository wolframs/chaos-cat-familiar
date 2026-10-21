$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

Write-Host "[ccf-dev-install] repo: $repoRoot"

Write-Host "[ccf-dev-install] installing npm workspaces"
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

Write-Host "[ccf-dev-install] running tests"
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit code $LASTEXITCODE" }

Write-Host "[ccf-dev-install] checking the shell against a throwaway profile"
npm run smoke:windows-shell
if ($LASTEXITCODE -ne 0) { throw "Smoke run failed with exit code $LASTEXITCODE" }

Write-Host ""
Write-Host "[ccf-dev-install] completed"
Write-Host "Next steps:"
Write-Host "  1. Run 'npm --workspace @chaos-cat-familiar/windows-shell run start' for interactive use."
Write-Host "  2. Normal startup automatically installs or repairs Claude hooks in the current Windows profile."
Write-Host "  3. Use Diagnostics for hook status and repair; packaged ccf:// activation remains unverified."
