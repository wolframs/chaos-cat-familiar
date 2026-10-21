export function normalizeShellMode(mode) {
  return mode === "mascot" ? "mascot" : "developer";
}

export function overlayWindowSizeForMode(mode) {
  return normalizeShellMode(mode) === "mascot"
    ? { width: 168, height: 144 }
    : { width: 420, height: 320 };
}
