# Windows visual assets

Placeholder art until the black-cat familiar art exists (see [STATUS](../../../docs/STATUS.md)).

- `pixel-art/` is the source: a stdlib-only pixel sprite plus `ChaosCatFamiliar.ico`, written by
  `python scripts/windows/generate-pixel-icon.py --output-dir packaging/windows/assets/pixel-art`.
- `generated/` holds the MSIX tiles (`Square44x44Logo.png` … `Wide310x150Logo.png`, `StoreLogo.png`),
  scaled from `pixel-art/pixel-ccf-310.png` by `scripts/windows/export-windows-assets.ps1`.

Regenerate; never hand-edit the exports. When the real art lands, point `-SourceIcon` at it.
