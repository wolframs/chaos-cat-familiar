const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    ipcRenderer.send("ccf:renderer-log", {
      level: "error",
      category: "ipc",
      message: `IPC invoke failed: ${channel}`,
      context: {
        error: String(error?.message ?? error)
      }
    });
    throw error;
  });
}

window.addEventListener("error", (event) => {
  ipcRenderer.send("ccf:renderer-log", {
    level: "error",
    category: "renderer",
    message: event.message || "Unhandled renderer error",
    context: {
      fileName: event.filename ?? null,
      line: event.lineno ?? null,
      column: event.colno ?? null
    }
  });
});

window.addEventListener("unhandledrejection", (event) => {
  ipcRenderer.send("ccf:renderer-log", {
    level: "error",
    category: "renderer",
    message: "Unhandled renderer promise rejection",
    context: {
      reason: String(event.reason?.message ?? event.reason)
    }
  });
});

contextBridge.exposeInMainWorld("ccf", {
  getState: () => invoke("ccf:get-state"),
  getSettings: () => invoke("ccf:get-settings"),
  getCompanion: () => invoke("ccf:get-companion"),
  getCompanionStatus: () => invoke("ccf:get-companion-status"),
  companionAction: (payload) => invoke("ccf:companion-action", payload),
  getMascotLibrary: () => invoke("ccf:get-mascot-library"),
  getLogMetadata: () => invoke("ccf:get-log-metadata"),
  notificationAction: (payload) => invoke("ccf:notification-action", payload),
  updateSettings: (payload) => invoke("ccf:update-settings", payload),
  dispatchCommand: (command, payload = {}) => invoke("ccf:dispatch-command", { command, payload }),
  cleanupAction: (action) => invoke("ccf:cleanup-action", { action }),
  approvalAction: (payload) => invoke("ccf:approval-action", payload),
  activateEditor: (payload) => invoke("ccf:activate-editor", payload),
  activateTerminal: (payload) => invoke("ccf:activate-terminal", payload),
  detectClaudeRuntime: () => invoke("ccf:detect-claude-runtime"),
  diagnoseHooks: () => invoke("ccf:diagnose-hooks"),
  installHooks: () => invoke("ccf:install-hooks"),
  repairHooks: () => invoke("ccf:repair-hooks"),
  installMascot: (slug) => invoke("ccf:install-mascot", slug),
  importMascot: (payload) => invoke("ccf:import-mascot", payload),
  updateMascot: (payload) => invoke("ccf:update-mascot", payload),
  deleteMascot: (id) => invoke("ccf:delete-mascot", id),
  selectMascot: (id) => invoke("ccf:select-mascot", id),
  openDashboard: () => invoke("ccf:open-dashboard"),
  openDiagnostics: () => invoke("ccf:open-diagnostics"),
  openMascotManager: () => invoke("ccf:open-mascot-manager"),
  openMascotPreview: () => invoke("ccf:open-mascot-preview"),
  showOverlayContextMenu: () => invoke("ccf:show-overlay-context-menu"),
  getOverlayBounds: () => invoke("ccf:get-overlay-bounds"),
  setOverlayBounds: (payload) => ipcRenderer.send("ccf:set-overlay-bounds", payload),
  windowAction: (action) => invoke("ccf:window-action", action),
  log: (payload) => ipcRenderer.send("ccf:renderer-log", payload),
  onHookInstallResult: (handler) => ipcRenderer.on("hook-install-result", (_event, value) => handler(value)),
  onState: (handler) => ipcRenderer.on("ccf:state", (_event, value) => handler(value)),
  onCompanion: (handler) => ipcRenderer.on("ccf:companion", (_event, value) => handler(value)),
  onCompanionStatus: (handler) => ipcRenderer.on("ccf:companion-status", (_event, value) => handler(value)),
  onCompanionTextSize: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("ccf:companion-text-size", listener);
    return () => ipcRenderer.removeListener("ccf:companion-text-size", listener);
  },
  onDesignReload: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("ccf:design-reload", listener);
    return () => ipcRenderer.removeListener("ccf:design-reload", listener);
  },
  onMascotLibrary: (handler) => ipcRenderer.on("ccf:mascot-library", (_event, value) => handler(value)),
  onSettings: (handler) => ipcRenderer.on("ccf:settings", (_event, value) => handler(value)),
  onDashboardSection: (handler) => ipcRenderer.on("ccf:dashboard-section", (_event, value) => handler(value))
});
