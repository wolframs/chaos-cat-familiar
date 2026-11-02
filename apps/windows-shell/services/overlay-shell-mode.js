export function normalizeShellMode(mode) {
  return mode === "mascot" ? "mascot" : "developer";
}

const MASCOT_SIZE = { width: 168, height: 144 };
const DEVELOPER_SIZE = { width: 420, height: 320 };
const DEVELOPER_MIN = { width: 320, height: 220 };

// The mascot window has a fixed size; the developer overlay keeps a size the user
// gave it, but never inherits the mascot's (saved bounds are shared by both modes).
export function overlayWindowSizeForMode(mode, savedBounds = null) {
  if (normalizeShellMode(mode) === "mascot") return { ...MASCOT_SIZE };
  if (savedBounds?.width >= DEVELOPER_MIN.width && savedBounds?.height >= DEVELOPER_MIN.height) {
    return { width: savedBounds.width, height: savedBounds.height };
  }
  return { ...DEVELOPER_SIZE };
}
