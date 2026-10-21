param(
  [string]$SourceIcon = ".\packaging\windows\assets\pixel-art\pixel-ccf-310.png",
  [string]$OutputDir = ".\packaging\windows\assets\generated",
  [switch]$IncludePixelArtFallback
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$sourcePath = (Resolve-Path $SourceIcon).Path
$targetRoot = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$sizes = @(
  @{ Name = "Square44x44Logo.png"; Width = 44; Height = 44 },
  @{ Name = "Square50x50Logo.png"; Width = 50; Height = 50 },
  @{ Name = "Square150x150Logo.png"; Width = 150; Height = 150 },
  @{ Name = "Square310x310Logo.png"; Width = 310; Height = 310 },
  @{ Name = "Wide310x150Logo.png"; Width = 310; Height = 150 },
  @{ Name = "StoreLogo.png"; Width = 50; Height = 50 }
)

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size.Width, $size.Height
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        $scale = [Math]::Min($size.Width / $sourceImage.Width, $size.Height / $sourceImage.Height)
        $drawWidth = [int]([Math]::Round($sourceImage.Width * $scale))
        $drawHeight = [int]([Math]::Round($sourceImage.Height * $scale))
        $drawX = [int](($size.Width - $drawWidth) / 2)
        $drawY = [int](($size.Height - $drawHeight) / 2)

        $graphics.DrawImage($sourceImage, $drawX, $drawY, $drawWidth, $drawHeight)
      } finally {
        $graphics.Dispose()
      }

      $destination = Join-Path $targetRoot $size.Name
      $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host "[ccf-assets] wrote $destination"
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

Write-Host ""
Write-Host "[ccf-assets] completed"
Write-Host "Generated PNG assets under $targetRoot"

if ($IncludePixelArtFallback) {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
  }

  if (-not $python) {
    Write-Warning "[ccf-assets] Python was not found. Skipped pixel-art fallback asset generation."
  } else {
    $pixelOutput = Join-Path $repoRoot "packaging\windows\assets\pixel-art"
    & $python.Source (Join-Path $repoRoot "scripts\windows\generate-pixel-icon.py") --output-dir $pixelOutput
    Write-Host "[ccf-assets] generated pixel-art fallback assets under $pixelOutput"
  }
}
