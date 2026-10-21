# Windows packaging (end-to-end untested)

The assets, Electron packaging wrapper and MSIX staging/signing scripts exist. An installed build
has not been validated since the CCF rename. See [STATUS](../../docs/STATUS.md).

## Current contents

- `package-metadata.json`
  - stable Windows package identity and display metadata
- `msix-visual-assets.json`
  - explicit mapping from generated repo assets into MSIX logo fields
- `AppxManifest.template.xml`
  - manifest template with package identity, visual assets, and protocol declarations
- `AppxManifest.dev.xml`
  - rendered development manifest output generated from repo metadata
- `input/`
  - generated Electron output and the `input/app/` layout consumed by MSIX staging
- `electron-packager.config.json`
  - conservative packaging config for producing the Windows app folder that feeds MSIX staging

## Build sequence

Run from the repo root after `npm install`:

```powershell
npm run assets:windows:pixel
npm run assets:windows
npm run packaging:windows:prepare-app -- -RunPackager
npm run packaging:windows:manifest
npm run packaging:windows:stage-msix
```

`prepare-app` without `-RunPackager` writes instructions only. With it, the wrapper invokes the
workspace's declared `@electron/packager` dependency and copies its output into `input/app/`.
`stage-msix` copies the app and assets into `out/msix-stage/`; it does not create an MSIX by default.

To create and sign the development MSIX, install the Windows SDK and make `makeappx.exe` and
`signtool.exe` available on PATH, then supply your development certificate:

```powershell
npm run packaging:windows:stage-msix -- -RunPackagingTools -DevCertificatePath C:/path/to/dev-certificate.pfx
```

The certificate must match the manifest publisher (`CN=CCF-DEV`). Certificate creation and trust
setup are not automated. Never commit signing keys. Without `-DevCertificatePath`, the script can
create an unsigned package, which is not ready for installation.

After signing and configuring certificate trust on the test machine:

```powershell
npm run packaging:windows:install-msix
npm run packaging:windows:validate-msix -- -ExpectInstalled
npm run packaging:windows:uninstall-msix
```

`packaging:windows:loop-msix` repeats install/validation/uninstall against an existing package.
The validation script checks package presence and reports declared protocols; manually
exercise activation, launch at login, notifications and data retention before calling packaging done.

`assets/pixel-art/` and `assets/generated/` are checked-in placeholder art. Regenerate them through
the scripts; `input/` build output and `out/` staging files are ignored by Git.

## Rules

- keep package identity stable once external testing begins
- do not reuse the development publisher value for production signing
- validate protocol activation and startup-at-login only against packaged builds, not dev runs
- regenerate `AppxManifest.dev.xml` via `npm run packaging:windows:manifest` instead of hand-editing it
- prepare the packaged Electron app handoff via `npm run packaging:windows:prepare-app`
- stage a development MSIX layout via `npm run packaging:windows:stage-msix`
- install and uninstall the staged MSIX via the dedicated PowerShell loop scripts instead of ad hoc shell commands
