// In a packaged CCF the app lives in resources/app.asar, which only Electron can read. Files that another program opens
// by path (PowerShell runs kill-on-close-job.ps1, node runs codex-hook-sender.mjs) are unpacked next to it
// (scripts/windows/stage-electron-app.mjs); this turns a path inside the archive into the unpacked copy's path.
// A dev run's paths have no app.asar segment and stay as they are.
export function unpackedPath(filePath) {
  return String(filePath).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}
