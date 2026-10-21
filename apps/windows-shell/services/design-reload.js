import fs from "node:fs";
import path from "node:path";

// A renderer refresh never touches the main process or its companion PTY.
export function createDesignReload({
  rendererDir,
  getWindows = () => [],
  enabled = true,
  isPackaged = false,
  watch = fs.watch,
  debounceMs = 180,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {}
} = {}) {
  let watcher;
  let timer;
  let disposed = false;
  let revision = 0;
  const pending = new Set();

  function flush() {
    timer = undefined;
    if (disposed || !pending.size) return;
    const paths = [...pending].sort();
    pending.clear();
    const payload = {
      kind: paths.every((filename) => filename.toLowerCase().endsWith(".css")) ? "styles" : "reload",
      paths,
      revision: ++revision
    };
    for (const window of getWindows()) {
      if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) continue;
      try { window.webContents?.send("ccf:design-reload", payload); }
      catch (error) { onError(error); }
    }
  }

  function changed(_event, filename) {
    if (disposed || !filename) return;
    const relative = String(filename).replaceAll("\\", "/");
    if (path.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part.startsWith("."))) return;
    if (!/\.(?:css|html|js)$/i.test(relative)) return;
    pending.add(relative);
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(flush, debounceMs);
    timer?.unref?.();
  }

  if (enabled && !isPackaged && rendererDir) {
    try {
      watcher = watch(rendererDir, { recursive: true }, changed);
      watcher.on?.("error", onError);
      watcher.unref?.();
    } catch (error) { onError(error); }
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      pending.clear();
      watcher?.close();
    }
  };
}
