# Packaged App Input

Place the packaged Windows app layout for staging here.

Expected first use:

- run `npm run assets:windows:pixel`
- run `npm run packaging:windows:prepare-app -- -RunPackager`
- run `npm run assets:windows`
- run `npm run packaging:windows:manifest`
- run `npm run packaging:windows:stage-msix`

Notes:

- `prepare-app` without `-RunPackager` writes instructions only
- with `-RunPackager`, it uses the declared `@electron/packager` dependency, builds the Electron app
  and copies the result into `packaging/windows/input/app`
- for a manual/external build, copy the app layout into `input/app` yourself
- this folder exists so the MSIX staging script has a predictable input location
- the staged manifest rewrites `Executable="ChaosCatFamiliar.exe"` to `Executable="app\ChaosCatFamiliar.exe"` to match this layout

See the [packaging guide](../README.md) for signing, installation and remaining validation.
