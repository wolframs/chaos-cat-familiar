# Windows packaging

The packaged Electron app (`prepare-app -RunPackager`) builds and passes the smoke run in test mode (process-split
plan, step 7, 2026-11-06). The MSIX staging/signing scripts exist; an installed MSIX has not been validated since the
CCF rename. See [STATUS](../../docs/STATUS.md).

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

`prepare-app` without `-RunPackager` writes instructions only. With it, the wrapper first stages the app
(`scripts/windows/stage-electron-app.mjs` into `input/stage/`), then invokes the workspace's declared
`@electron/packager` dependency on that stage and copies its output into `input/app/`.

The stage mirrors the repo's layout for what CCF runs: `apps/windows-shell` (without its tests), `packages/core`
(main, the core, the companion and the renderer pages import it by relative path), `scripts/windows/codex-hook-sender.mjs`,
and from the root `node_modules` only `node-pty` (lib and the win32-x64 prebuilds, without debug symbols) and
`@xterm/headless`. Its `package.json` names the installed Electron version (the packager takes that zip from
@electron/get's cache). `node:sqlite` ships with Electron. Inside `app.asar` everything resolves as in a dev run;
what programs outside Electron open by path is unpacked next to it (`app.asar.unpacked`: node-pty, `*.ps1` such as the
companion's kill-on-close job helper, the Codex hook sender), and `services/asar-paths.js` hands them those paths.
`stage-electron-app.test.mjs` checks that every module the app loads is staged.

To check a packaged build without installing it (test mode, temp folders, the PowerShell companion fixture):

```powershell
$env:CCF_SMOKE_APP = "packaging\windows\input\ChaosCatFamiliar-win32-x64\ChaosCatFamiliar.exe"
npm run smoke:windows-shell
```
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
