import path from "node:path";

// CCF's settings defaults. The core process owns settings.json and fills in these for missing keys.
export function settingsDefaults({ home, portOverride = null, appModeOverride = null }) {
  return {
    port: portOverride ?? 49152,
    editorPreference: "vscode",
    overlayVisible: true,
    // The companion cluster (cat, conversation, status, side panel, bubbles) above other windows; the cat's menu.
    clusterAlwaysOnTop: true,
    // The side panel left of the conversation, and the file it shows (null: <companion folder>/state/panel.json).
    sidePanelVisible: true,
    sidePanelFile: null,
    showOverlayOnStartup: true,
    openAtLogin: false,
    debugLogging: false,
    performanceProfiling: false,
    companionBackend: "claude",
    companionRepoPath: path.join(home, "repos", "work-companion"),
    codexModel: null,
    codexAuthenticationMode: null,
    codexAuthenticationHome: null,
    codexCompanionRepoPath: null,
    companionDataPath: null,
    companionCorePath: null,
    companionPythonExecutable: null,
    codexExecutable: null,
    companionSensorsEnabled: false,
    appShellMode: appModeOverride ?? "mascot",
    overlayDisplayMode: "remember",
    overlayDisplayId: null,
    overlayBounds: null,
    overlayOpacity: 1,
    permissionPanelScale: 1,
    snoozeUntil: null,
    onboardingCompletedAt: null,
    onboardingVersion: null,
    notifications: {
      enabled: true,
      minPriority: "high"
    },
    hotkeys: {
      toggleOverlay: "CommandOrControl+Shift+Space",
      openDashboard: "CommandOrControl+Shift+O",
      openDiagnostics: "CommandOrControl+Shift+D",
      approveTop: "CommandOrControl+Enter",
      denyTop: "CommandOrControl+Backspace",
      deferTop: "CommandOrControl+Shift+L",
      sessionSwitcherNext: "CommandOrControl+Tab",
      sessionSwitcherPrevious: "CommandOrControl+Shift+Tab",
      toggleExpandedApproval: "CommandOrControl+Shift+P"
    }
  };
}
