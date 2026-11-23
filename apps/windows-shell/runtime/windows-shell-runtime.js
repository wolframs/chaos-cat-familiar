import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CoreClient } from "../../../packages/core/src/core-client.js";
import { ServiceError } from "../../../packages/core/src/service-rpc.js";
import { livenessStats } from "../../../packages/core/src/process-ports.js";
import { SettingsMirror } from "../../../packages/core/src/settings-authority.js";
import {
  ElectronActivationService,
  ElectronNotificationService,
  ElectronOverlayService
} from "../services/platform-services.js";
import { createCoreHost } from "../core/core-host.js";
import { settingsDefaults } from "../core/settings-defaults.js";
import { deriveOverlayPlacement, clampBoundsToWorkArea } from "../services/display-placement.js";
import { MascotLibrary } from "../services/mascot-library.js";
import { findCcfProtocolArg, parseCcfProtocolUrl } from "../services/ccf-protocol.js";
import { detectRuntimeMode } from "../services/runtime-mode.js";
import { PerformanceSampler } from "../services/performance-sampler.js";
import { EventLoopMonitor } from "../services/event-loop-monitor.js";
import { MainLogger } from "../services/main-logger.js";
import { OverlayPlacementPersistence } from "../services/overlay-placement-persistence.js";
import { normalizeShellMode, overlayWindowSizeForMode } from "../services/overlay-shell-mode.js";
import { PANEL, placeCompanionCluster } from "../services/companion-cluster-layout.js";
import { companionMenuTemplate, flattenMenu } from "../services/companion-menu.js";
import { SidePanelFeed, sidePanelPath } from "../services/side-panel-feed.js";
import { isDoneKey } from "../renderer/companion-panel-model.js";
import { BUBBLE_SIZE, placeCompanionBubble } from "../services/companion-bubble-layout.js";
import { CompanionBubbles } from "../services/companion-bubbles.js";
import { CatLines, loadCatLinesCatalog } from "../services/cat-lines.js";
import { CompanionClient } from "../services/companion-client.js";
import { createCompanionHost } from "../companion/companion-host.js";
import { mergeHostedCompanion } from "../services/hosted-companion-state.js";
import { createDesignReload } from "../services/design-reload.js";
import { fontSizeShortcut } from "../renderer/companion-text-size.js";
import { ShellUiState } from "./shell-ui-state.js";
import { ViewSubscriptions } from "./view-subscriptions.js";
import {
  clearCcfCacheAndLogs,
  clearCcfLocalData,
  removeIdeIntegration
} from "../services/windows-cleanup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_ROOT = path.resolve(__dirname, "..");
const IPC_HANDLES = [
  "ccf:get-settings",
  "ccf:get-overlay-bounds",
  "ccf:show-overlay-context-menu",
  "ccf:get-mascot-library",
  "ccf:get-log-metadata",
  "ccf:get-companion",
  "ccf:get-companion-status",
  "ccf:get-companion-bubbles",
  "ccf:companion-action",
  "ccf:get-side-panel",
  "ccf:side-panel-action",
  "ccf:show-companion-menu",
  "ccf:notification-action",
  "ccf:dispatch-command",
  "ccf:cleanup-action",
  "ccf:window-action",
  "ccf:select-mascot",
  "ccf:install-mascot",
  "ccf:import-mascot",
  "ccf:update-mascot",
  "ccf:delete-mascot",
  "ccf:open-dashboard",
  "ccf:open-diagnostics",
  "ccf:open-mascot-manager",
  "ccf:open-mascot-preview",
  "ccf:update-settings",
  "ccf:approval-action",
  "ccf:activate-editor",
  "ccf:activate-terminal",
  "ccf:detect-claude-runtime",
  "ccf:diagnose-hooks",
  "ccf:install-hooks",
  "ccf:repair-hooks",
  "ccf:subscribe",
  "ccf:unsubscribe",
  "ccf:get-shell-state"
];
// How long an effect that targets a window waits for that window to report the revision it belongs to.
const VIEW_EFFECT_WAIT_MS = 300;
const IPC_EVENTS = [
  "ccf:renderer-log",
  "ccf:set-overlay-bounds",
  "ccf:companion-bubble-dismiss",
  "ccf:companion-bubble-pointer",
  "ccf:view-revision"
];
// The cat and its companion panels share one explicit always-on-top level.
// Electron's default level ("floating", also what `alwaysOnTop: true` uses)
// re-stacks a window directly below Shell_TrayWnd on creation and on every
// activation (MoveBehindTaskBarIfNeeded, electron v36 native_window_views.cc).
// SetWindowPos removes WS_EX_TOPMOST from a window inserted after a
// non-topmost window, so whenever the taskbar is not topmost at that moment
// (fullscreen or "rude" apps, shell glitches), clicking a panel demotes it into
// the normal band, where a maximized app covers it. Every level outside
// Electron's behind-taskbar set maps to a plain HWND_TOPMOST on Windows.
const CLUSTER_TOP_LEVEL = "pop-up-menu";
// isAlwaysOnTop() reads the real WS_EX_TOPMOST bit, so a cheap poll catches
// demotions from causes nobody has identified yet, and logs them.
const CLUSTER_TOPMOST_CHECK_MS = 2000;
// A Content-Security-Policy meta tag would silence this at the source, but in
// smoke runs it made Electron hang on exit intermittently (2026-10-22).
const ELECTRON_SECURITY_WARNING = /Electron Security Warning/;
// Every wait on another process during quit has a deadline, so a hung core or companion cannot keep quit from reaching
// the host's kill (review 2026-11-05, P1). Tests shorten them with services.quitDeadlinesMs.
const QUIT_DEADLINES_MS = { hooks: 5000, intake: 5000, companion: 5000, settings: 3000, core: 5000 };
const TIMED_OUT = Symbol("timed out");
// File links (OSC 8 in the conversation, rows in the side panel, which another program writes) open only folders and
// these document types: shell.openPath runs whatever the extension is associated with, and a list of refused types
// always misses one (.py and .pyw run through the Python launcher). Left out on purpose: macro-capable Office files
// (.docm .xlsm .pptm and the legacy .doc .xls .ppt), and anything else not named here.
export const OPENABLE_FILE_TYPES = new Set([
  ".md", ".markdown", ".txt", ".log", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".diff", ".patch",
  ".html", ".htm", ".pdf", ".rtf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"]);

// Why a path must not be opened, or null. A folder opens unless its name ends in ".{…}" (a shell namespace junction,
// e.g. "x.{21EC2020-…}" is Control Panel). Windows drops trailing dots and spaces ("x.ps1." runs x.ps1) and reads
// "x.txt:stream" as an alternate data stream, so both are refused too.
export function refusedFileReason(file, { directory = false } = {}) {
  const name = path.win32.basename(String(file));
  if (/[. ]$/.test(name) || name.includes(":")) return "Refused: unusual file name";
  const extension = path.win32.extname(name).toLowerCase();
  if (directory) return extension.startsWith(".{") ? `Refused to open a special folder: ${name}` : null;
  return OPENABLE_FILE_TYPES.has(extension) ? null : `Refused to open this file type: ${name}`;
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createTestControlServer({
  token,
  snapshot,
  stop,
  injectEvent,
  injectCompanionPreview,
  companionAction,
  dispatchCommand,
  diagnosticsSummary,
  captureOverlay,
  captureCompanion,
  captureCompanionStatus,
  captureCompanionBubble,
  captureCompanionPanel,
  menuClick,
  captureDashboard,
  closeDashboard,
  awaitState,
  logger
}) {
  if (!token) {
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (req.headers["x-ccf-test-token"] !== token) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    if (req.method === "GET" && req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && req.url === "/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await snapshot()));
      return;
    }

    if (req.method === "POST" && req.url === "/close-dashboard") {
      closeDashboard();
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/capture-dashboard") {
      const png = await captureDashboard();
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    if (req.method === "GET" && req.url === "/capture-overlay") {
      const png = await captureOverlay();
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    if (req.method === "GET" && req.url === "/capture-companion-bubble") {
      const png = await captureCompanionBubble();
      res.writeHead(png ? 200 : 404, { "content-type": "image/png" });
      res.end(png ?? undefined);
      return;
    }
    if (req.method === "GET" && req.url === "/capture-companion-panel") {
      const png = await captureCompanionPanel();
      res.writeHead(png ? 200 : 404, { "content-type": "image/png" });
      res.end(png ?? undefined);
      return;
    }
    // A click on an item of the tray's or the cat's menu, by id ({surface, id}).
    if (req.method === "POST" && req.url === "/menu-click") {
      try {
        const result = await menuClick(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
      return;
    }
    if (req.method === "GET" && (req.url === "/capture-companion" || req.url === "/capture-companion-status")) {
      const png = req.url === "/capture-companion" ? await captureCompanion() : await captureCompanionStatus();
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }

    if (req.method === "GET" && req.url === "/diagnostics-summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await diagnosticsSummary()));
      return;
    }

    if (req.method === "POST" && req.url === "/inject-event") {
      try {
        const payload = await readJsonBody(req);
        const result = await injectEvent(payload);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
      return;
    }
    if (req.method === "POST" && req.url === "/companion-preview") {
      const payload = await readJsonBody(req);
      injectCompanionPreview(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // The conversation window's companion actions, for smoke runs (start is the PowerShell fixture in test mode).
    if (req.method === "POST" && req.url === "/companion-action") {
      try {
        const result = await companionAction(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error), code: error?.code ?? null }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/dispatch-command") {
      try {
        const payload = await readJsonBody(req);
        const result = await dispatchCommand(payload.command, payload.payload ?? {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/await-state") {
      try {
        const payload = await readJsonBody(req);
        const result = await awaitState(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        const statusCode = error?.message === "await_state_timeout" ? 408 : 400;
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/shutdown") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => {
        stop("test-control").catch((error) => {
          logger?.error("test-control", "Graceful shutdown from control plane failed", {
            error: String(error?.stack ?? error?.message ?? error)
          });
        });
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return {
    server,
    port: null,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          this.port = address && typeof address === "object" ? address.port : null;
          resolve();
        });
      });
      return this.port;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export function createWindowsShellRuntime({
  electron,
  processLike = process,
  services = {},
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
} = {}) {
  const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    ipcMain,
    nativeImage,
    clipboard,
    dialog,
    shell,
    screen,
    globalShortcut,
    Notification
  } = electron;

  let tray = null;
  let overlayWindow = null;
  let dashboardWindow = null;
  let dashboardRequestedSection = null;
  let diagnosticsWindow = null;
  let mascotWindow = null;
  let mascotPreviewWindow = null;
  let companionConversationWindow = null;
  let companionStatusWindow = null;
  let companionBubbleWindow = null;
  let companionPanelWindow = null;
  // Main's reader of the side panel's file; it runs only while the panel window shows.
  let sidePanelFeed = null;
  let panelOmittedLogged = false;
  let lastTrayToolTip = null;
  let lastTrayWaiting = null;
  const companionBubbles = new CompanionBubbles({ random: services.random ?? Math.random });
  let catLines; // loaded with the first event bubble
  // The companion backend (PTY, Codex, watcher, habitat, delivery state, staged attachments) runs in its own utility
  // process, started when the companion is first needed and reached only through its client (process-split plan,
  // step 4). In-process for tests with fakes.
  let companion = null;
  let companionHost = null;
  let companionStatus = null;
  let companionStatusBackend = null;
  let lastHostedStateKey = null;
  let companionPreviewSnapshot = null;
  const layoutStats = { calls: 0, totalMs: 0, maxMs: 0, over4ms: 0 };
  let companionHudActive = false;
  let syncingCompanionCluster = false;
  let clusterTopmostTimer = null;
  let appliedClusterOnTop = null;
  // The core (settings, log file, state checkpoints, hook files, controller + HookServer) runs in its own process and
  // is reached only through its client: projections, effects and async requests (process-split plan, step 3). Main
  // reads settings from a mirror and writes them as patches; activation (focusing windows) stays main's.
  let core = null;
  let coreHost = null;
  let viewSubscriptions = null;
  let overlayService = null;
  let toastPresenter = null;
  let activation = null;
  let settingsStore = null;
  // The run marker lives in the core's storage worker (step 6); main names the run and keeps what the first boot
  // reported (a core restarted within the run reports the same run).
  const runId = randomUUID();
  let coreRecovery = null;
  let placementPersistence = null;
  let overlayDragSettings = null;
  let applyingOverlayBounds = false;
  let lastKnownSettings = {};
  let fatalErrorShown = false;
  let runtimePaths = null;
  let logger = null;
  let performanceSampler = null;
  let eventLoopMonitor = null;
  let mascotLibrary = null;
  let shellUiState = null;
  let smokeQuitTimer = null;
  let controlServer = null;
  let started = false;
  let stoppingPromise = null;
  let startedSnapshot = null;
  let mascotWarmupPromise = null;
  let hookOperations = Promise.resolve();
  const quitDeadlines = { ...QUIT_DEADLINES_MS, ...(services.quitDeadlinesMs ?? {}) };
  const utilityTimers = new Set();
  const securityWarningViews = new Set();
  const cleanupFns = [];

  function onWithCleanup(emitter, eventName, handler) {
    emitter.on(eventName, handler);
    cleanupFns.push(() => emitter.off(eventName, handler));
  }

  function currentSettings() {
    const settings = settingsStore?.load?.() ?? {};
    lastKnownSettings = {
      ...settings,
      appShellMode: normalizeShellMode(runtimePaths?.appModeOverride ?? settings.appShellMode)
    };
    return lastKnownSettings;
  }

  function companionSnapshot(changeSnapshot) {
    const live = changeSnapshot ?? companion?.snapshot() ?? null;
    const previewing = Boolean(runtimePaths?.testMode && companionPreviewSnapshot);
    const snapshot = previewing ? companionPreviewSnapshot : live;
    // Staged images come from the companion even under a test preview. A preview is marked: the conversation page shows
    // it instead of the frames on its port while it lasts (test mode only).
    return snapshot ? { ...snapshot, attachments: live?.attachments ?? snapshot.attachments ?? [], debugUi:processLike.env.CCF_DEBUG_UI==='1'||(processLike.argv??[]).includes('--debug-ui'),
      ...(previewing ? { preview: true } : {}) } : null;
  }

  // Starts the companion process when it is first needed. restart: only an explicit user action (Start, the
  // launcher's /companion/open) brings back a companion that crashed.
  function ensureCompanion({ restart = false } = {}) {
    if (!companionHost) return Promise.reject(new Error("Companion unavailable."));
    return companionHost.ensure({ restart });
  }

  // The companion's backend choice before its process ran: the setting.
  function companionBackend() {
    return companion?.snapshot()?.backend ?? (currentSettings().companionBackend === "codex" ? "codex" : "claude");
  }

  function injectCompanionPreview(payload) {
    if (!runtimePaths.testMode) throw new Error("Companion preview is only available in test mode.");
    companionPreviewSnapshot = payload;
    companionHudActive = true;
    syncOverlayHudWindows();
    pushCompanionToWindow();
  }

  function isWorkCompanionPath(value) {
    const settings=currentSettings();
    const activeClaudePath=companion?.activeClaudePath()??null;
    return typeof value==='string'&&[activeClaudePath,settings.companionRepoPath,settings.codexCompanionRepoPath,settings.companionDataPath,path.win32.resolve(runtimePaths.home,'repos','work-companion')]
      .filter(Boolean).some(candidate=>path.win32.resolve(value).toLowerCase()===path.win32.resolve(candidate).toLowerCase());
  }

  function shouldAutoOpenDashboardOnStartup() {
    return currentSettings().appShellMode === "developer";
  }

  function coreState() {
    return core?.state() ?? {
      approvals: [],
      sessions: [],
      notifications: [],
      events: [],
      logs: []
    };
  }

  // The full state (event history, log) for a reader that shows it: live in-process, otherwise asked of the core.
  async function fullCoreState() {
    if (!core) return coreState();
    if (core.peek) return core.state();
    return core.query({ timeoutMs: 5000 }).catch(() => coreState());
  }

  // The conversation window takes the companion's whole frames on its own port (process-split plan, steps 5 and 7);
  // main sends it only what main alone knows: the offline view after a crash (the port died with the process) and a
  // test preview, which the page shows instead of the port's frames while it lasts.
  function pushCompanionToWindow(snapshot) {
    companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot(snapshot));
  }

  function desktopFacts() {
    return {
      notificationsSupported: Boolean(Notification?.isSupported?.()),
      openAtLogin: Boolean(app.getLoginItemSettings?.()?.openAtLogin),
      runtimeMode: runtimeMode()
    };
  }

  // Claude and Codex hook files are the core's work; main serializes the operations (runHookOperation).
  function coreHooks(op, options) {
    return core.request("hooks", { op, options, desktop: desktopFacts() });
  }

  function mascotModeEnabled(settings = currentSettings()) {
    return settings.appShellMode === "mascot";
  }

  // Synchronous native calls on main's thread (bounds, displays, visibility; per state broadcast and per drag step), so
  // the whole pass is timed (diagnostics: mainLatency.layout; final review of the process split, item 5).
  function syncOverlayHudWindows(settings) {
    const started = performance.now();
    try { syncOverlayHudWindowsNow(settings ?? overlayDragSettings ?? currentSettings()); }
    finally {
      const ms = performance.now() - started;
      layoutStats.calls++;
      layoutStats.totalMs += ms;
      layoutStats.maxMs = Math.max(layoutStats.maxMs, ms);
      if (ms >= 4) layoutStats.over4ms++;
    }
  }

  // At a fractional display scale Windows hands bounds back rounded (at 110 % a window set to y 775, height 144 reads
  // y 774, height 146), so comparing with the target never matched: every layout pass moved the cat and both HUD
  // windows again and saved the cat's position, and the cat crept a pixel per pass (measured under real Electron, final
  // review, item 5). A window that reads back what it read right after its target was set stands at that target.
  const boundsTargets = new WeakMap();
  const sameBounds = (a, b) => ["x", "y", "width", "height"].every((key) => a?.[key] === b?.[key]);
  function intendedBounds(window) {
    const current = window.getBounds();
    const target = boundsTargets.get(window);
    return target && sameBounds(current, target.readBack) ? { ...target.bounds } : current;
  }
  // Moves the window unless it stands at `bounds` already; true when it moved.
  function placeWindow(window, bounds) {
    if (sameBounds(intendedBounds(window), bounds)) return false;
    window.setBounds(bounds);
    boundsTargets.set(window, { bounds: { ...bounds }, readBack: window.getBounds() });
    return true;
  }

  function syncOverlayHudWindowsNow(settings) {
    if (!overlayWindow) return;
    syncCompanionBubbleWindow();
    const canShow = overlayWindow.isVisible() && settings.overlayVisible !== false && mascotModeEnabled(settings);
    const bounds = intendedBounds(overlayWindow);
    const area = screen.getDisplayMatching(bounds).workArea;
    if (!canShow || !companionHudActive) {
      companionConversationWindow?.hide();
      companionStatusWindow?.hide();
      hideSidePanel();
      stopClusterTopmostWatch();
    } else if (!syncingCompanionCluster) {
      syncingCompanionCluster = true;
      try {
        const placement = clusterPlacement(bounds, area, settings);
        if (!sameBounds(placement.cat, bounds)) {
          placeWindow(overlayWindow, placement.cat);
          saveSettingsPatch({ overlayBounds: placement.cat, overlayDisplayId: screen.getDisplayMatching(placement.cat)?.id ?? null });
        }
        companionConversationWindow ??= createCompanionWindow("conversation");
        companionStatusWindow ??= createCompanionWindow("status");
        placeWindow(companionConversationWindow, placement.conversation);
        placeWindow(companionStatusWindow, placement.status);
        let revealing = !companionConversationWindow.isVisible() || !companionStatusWindow.isVisible();
        if (!companionConversationWindow.isVisible()) companionConversationWindow.showInactive();
        if (!companionStatusWindow.isVisible()) companionStatusWindow.showInactive();
        if (placement.panel) {
          companionPanelWindow ??= createCompanionWindow("panel");
          placeWindow(companionPanelWindow, placement.panel);
          if (!companionPanelWindow.isVisible()) { companionPanelWindow.showInactive(); revealing = true; }
          sidePanelFeed?.start();
        } else {
          if (settings.sidePanelVisible !== false && !panelOmittedLogged) {
            panelOmittedLogged = true;
            logger?.info?.("window", "No room for the side panel on this display", { workArea: area });
          }
          hideSidePanel();
        }
        if (revealing) raiseCompanionCluster("show");
        startClusterTopmostWatch();
      } finally {
        syncingCompanionCluster = false;
      }
    }
  }

  // The cluster's placement for the cat at `bounds`, with the side panel when it is on (sidePanelVisible).
  function clusterPlacement(bounds, workArea, settings = currentSettings()) {
    return placeCompanionCluster({ cat: bounds, workArea, ...(settings.sidePanelVisible !== false ? { panel: PANEL } : {}) });
  }

  // The side panel hides with the cluster, when it is turned off, and when its display has no room for it; its feed
  // runs only while it shows.
  function hideSidePanel() {
    companionPanelWindow?.hide();
    sidePanelFeed?.stop();
  }

  // Always on Top (setting clusterAlwaysOnTop, default on) covers the whole cluster: cat, conversation, status, side
  // panel and bubbles. Off, the windows are ordinary ones and nothing re-asserts topmost (watchdog, blur repair).
  function clusterOnTop() {
    return currentSettings().clusterAlwaysOnTop !== false;
  }

  function keepOnTop(window) {
    if (clusterOnTop()) window.setAlwaysOnTop(true, CLUSTER_TOP_LEVEL);
    else window.setAlwaysOnTop(false);
  }

  function clusterWindows() {
    return [companionStatusWindow, companionPanelWindow, companionConversationWindow, overlayWindow, companionBubbleWindow]
      .filter((window) => window && !window.isDestroyed?.());
  }

  function visibleClusterWindows() {
    // Cat last: each setAlwaysOnTop puts its window at the top of the topmost band.
    // The speech bubbles overlap the conversation, so they go above everything.
    return clusterWindows().filter((window) => window.isVisible());
  }

  // After the setting changed: every cluster window gets the new level, the watchdog follows, the cluster is raised.
  function applyClusterTopmost() {
    for (const window of clusterWindows()) keepOnTop(window);
    if (clusterOnTop()) {
      syncOverlayHudWindows();
      if (visibleClusterWindows().length) raiseCompanionCluster("always-on-top");
    } else {
      stopClusterTopmostWatch();
    }
  }

  // Every path that changes clusterAlwaysOnTop ends here: the menu toggle, ccf:update-settings and other callers of
  // broadcastSettings, and the core's settings push (an edit of settings.json outside CCF). Only a transition applies;
  // the first call records the level the windows were created with.
  function syncClusterTopmostSetting() {
    const on = clusterOnTop();
    if (appliedClusterOnTop === null) { appliedClusterOnTop = on; return; }
    if (on === appliedClusterOnTop) return;
    appliedClusterOnTop = on;
    applyClusterTopmost();
    refreshTrayMenu();
  }

  function lostTopmost(windows) {
    return windows.filter((window) => window.isAlwaysOnTop?.() === false);
  }

  function warnLostTopmost(windows, reason) {
    if (windows.length) logger?.warn("window", "Companion window lost always-on-top; restored", {
      reason, windows: windows.map((window) => window.getTitle?.() ?? "unknown")
    });
  }

  // Re-asserts the shared level for the whole cluster and stacks it together.
  function raiseCompanionCluster(reason, { focusComposer = false } = {}) {
    const windows = visibleClusterWindows();
    if (clusterOnTop()) {
      warnLostTopmost(lostTopmost(windows), reason);
      for (const window of windows) keepOnTop(window);
    } else {
      // Not on top: brought up together in stack order, so a click on the cat still raises the whole cluster.
      for (const window of windows) window.moveTop?.();
    }
    if (focusComposer && companionConversationWindow?.isVisible()) {
      companionConversationWindow.focus();
      companionConversationWindow.webContents.executeJavaScript?.("document.getElementById('draft')?.focus()")
        ?.catch?.(() => {});
    }
  }

  // Restores only demoted windows. Restacking on every blur would push the
  // cluster above windows the user has just raised on purpose.
  function repairClusterTopmost(reason) {
    if (!clusterOnTop()) return;
    const lost = lostTopmost(visibleClusterWindows());
    if (!lost.length) return;
    warnLostTopmost(lost, reason);
    for (const window of lost) keepOnTop(window);
  }

  function startClusterTopmostWatch() {
    if (clusterTopmostTimer !== null || !clusterOnTop()) return;
    clusterTopmostTimer = timers.setInterval(() => repairClusterTopmost("watchdog"), CLUSTER_TOPMOST_CHECK_MS);
  }

  function stopClusterTopmostWatch() {
    if (clusterTopmostTimer === null) return;
    timers.clearInterval(clusterTopmostTimer);
    clusterTopmostTimer = null;
  }

  function clusterHasFocus() {
    return [overlayWindow, companionConversationWindow].some((window) => window?.isFocused?.());
  }

  function wireClusterWindow(window, onFocus) {
    window.on("focus", onFocus);
    window.on("blur", () => repairClusterTopmost("blur"));
  }

  // The cluster's windows next to the cat. The side panel is not focusable: a click on it must not take keyboard focus
  // from his editor or the composer (its actions go through main).
  const COMPANION_WINDOW_KINDS = {
    conversation: { width: 700, height: 500, title: "Conversation" },
    status: { width: 520, height: 144, title: "Status", clickThrough: true },
    panel: { width: PANEL.width, height: 500, title: "Panel", options: { focusable: false, hasShadow: false } }
  };

  function createCompanionWindow(kind) {
    const isConversation = kind === "conversation";
    const spec = COMPANION_WINDOW_KINDS[kind];
    const window = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true,
      ...(spec.options ?? {}),
      title: `Chaos Cat Familiar Companion ${spec.title}`,
      webPreferences: { preload: path.join(SHELL_ROOT, "preload.js") }
    });
    keepOnTop(window);
    wireClusterWindow(window, () => raiseCompanionCluster("panel-focus"));
    if (spec.clickThrough) window.setIgnoreMouseEvents?.(true, { forward: true });
    window.webContents.on("did-finish-load", () => syncOverlayHudWindows());
    if (isConversation) window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const direction = fontSizeShortcut({ ctrlKey: input.control, altKey: input.alt, metaKey: input.meta,
        code: input.code, key: input.key, isComposing: input.isComposing });
      if (direction === null) return;
      event.preventDefault();
      window.webContents.send("ccf:companion-text-size", direction);
    });
    window.loadFile(path.join(SHELL_ROOT, "renderer", `companion-${kind}.html`));
    wireWindowLogging(window, `companion-${kind}`, true);
    window.on("close", () => {
      if (kind === "conversation" && companionConversationWindow === window) companionConversationWindow = null;
      if (kind === "status" && companionStatusWindow === window) companionStatusWindow = null;
      if (kind === "panel" && companionPanelWindow === window) { companionPanelWindow = null; sidePanelFeed?.stop(); }
      window.destroy();
    });
    return window;
  }

  // The cat's speech bubbles (POST /companion/bubble from the work companion's
  // watcher). They stack until each is clicked away; the window exists only
  // while there is a bubble, and follows the cat's visibility and position.
  // An event ({event, placeholders}) gets its line from the cat's catalog (services/cat-lines.js);
  // free text is shown as sent. Text sent with an event is the fallback for an event the catalog lacks.
  async function addCompanionBubble({ text = null, event = null, placeholders = null, style = null, special = null }) {
    let line = null;
    if (event) {
      line = (await companionCatLines())?.pick(event, placeholders ?? {}) ?? null;
      if (!line && !text) {
        logger?.warn("companion-bubble", "Bubble event has no usable line", { event });
        return { shown: false, rejected: "unknown_bubble_event" };
      }
    }
    const bubble = companionBubbles.add({ text: line?.text ?? text, style,
      special: special ?? (line?.special ? true : null) });
    logger?.info("companion-bubble", "Bubble added", { id: bubble.id, style: bubble.style, special: bubble.special,
      event, tier: line?.tier ?? null, kind: line?.kind ?? null, stack: companionBubbles.size });
    broadcastCompanionBubbles();
    syncCompanionBubbleWindow();
    // Not on top: a new bubble brings the cat and its bubbles up once (the watcher's meow plays either way).
    if (!clusterOnTop() && overlayWindow?.isVisible() && companionBubbleWindow) {
      overlayWindow.moveTop?.();
      companionBubbleWindow.moveTop?.();
    }
    refreshTrayToolTip();
    // The cat's visibility, not the bubble window's: a just-created window can report
    // isVisible() false right after showInactive() (2026-10-30: a bubble on screen came back shown: false).
    return { shown: Boolean(companionBubbleWindow && overlayWindow?.isVisible()),
      ...(line ? { tier: line.tier, kind: line.kind, text: line.text } : {}) };
  }

  // Loaded once, with the first event bubble, without blocking main.
  function companionCatLines() {
    if (catLines !== undefined) return catLines;
    catLines = services.catLines ? Promise.resolve(services.catLines)
      : loadCatLinesCatalog(path.join(SHELL_ROOT, "assets", "cat-lines.json"))
        .then((catalog) => new CatLines({ catalog, random: services.random ?? Math.random, now: services.now ?? Date.now }))
        .catch((error) => {
          // A broken catalog must not cost the bubble: events then fall back to the text sent along.
          logger?.error("companion-bubble", "Cat line catalog failed to load", { error: String(error?.message ?? error) });
          return null;
        });
    return catLines;
  }

  function dismissCompanionBubble(id) {
    if (!companionBubbles.dismiss(id)) return;
    broadcastCompanionBubbles();
    syncCompanionBubbleWindow();
    refreshTrayToolTip();
  }

  function broadcastCompanionBubbles() {
    if (companionBubbleWindow && !companionBubbleWindow.isDestroyed?.()) {
      companionBubbleWindow.webContents.send("ccf:companion-bubbles", companionBubbles.list());
    }
  }

  function syncCompanionBubbleWindow() {
    if (!companionBubbles.size) {
      const window = companionBubbleWindow;
      companionBubbleWindow = null;
      window?.destroy?.();
      return;
    }
    if (!overlayWindow?.isVisible()) {
      companionBubbleWindow?.hide();
      return;
    }
    companionBubbleWindow ??= createCompanionBubbleWindow();
    const catBounds = intendedBounds(overlayWindow);
    placeWindow(companionBubbleWindow, placeCompanionBubble({ cat: catBounds, workArea: screen.getDisplayMatching(catBounds).workArea }));
    if (!companionBubbleWindow.isVisible()) {
      companionBubbleWindow.showInactive();
      keepOnTop(companionBubbleWindow);
    }
  }

  function createCompanionBubbleWindow() {
    const window = new BrowserWindow({
      ...BUBBLE_SIZE,
      show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, focusable: false, hasShadow: false,
      title: "Chaos Cat Familiar Speech Bubbles",
      webPreferences: { preload: path.join(SHELL_ROOT, "preload.js") }
    });
    keepOnTop(window);
    // Click-through except over a bubble; the renderer reports the pointer.
    window.setIgnoreMouseEvents?.(true, { forward: true });
    window.loadFile(path.join(SHELL_ROOT, "renderer", "companion-bubble.html"));
    wireWindowLogging(window, "companion-bubble", true);
    window.on("close", () => {
      if (companionBubbleWindow === window) companionBubbleWindow = null;
      window.destroy();
    });
    return window;
  }

  function snapshotRuntime(changeSnapshot, baseState = coreState()) {
    const state = mergeHostedCompanion(baseState,changeSnapshot??companion?.snapshot(),currentSettings().companionDataPath??currentSettings().companionRepoPath);
    shellUiState?.sync?.(state);
    const settings = currentSettings();
    return {
      state: {
        ...state,
        meta: {
          unreadNotificationCount: (state.notifications ?? []).filter((item) => !item.isRead).length,
          approvalHistoryCount: (state.notifications ?? []).filter((item) =>
            item.category === "permission_request" && item.resolutionOutcome !== "pending"
          ).length,
          overlayMode: settings.appShellMode,
          overlayVisible: settings.overlayVisible !== false,
          overlayOpacity: settings.overlayOpacity ?? 1,
          permissionPanelScale: settings.permissionPanelScale ?? 1,
          autoHideEnabled: Boolean(settings.autoHideEnabled),
          autoHideDelay: settings.autoHideDelay ?? null,
          onboardingVersion: settings.onboardingVersion ?? null,
          onboardingCompletedAt: settings.onboardingCompletedAt ?? null,
          coreStatus: core?.status ?? null,
          // The core state this payload holds; a window reports it back once drawn (ccf:view-revision).
          revision: core?.revision ?? 0,
          epoch: core?.epoch ?? null
        },
        ui: shellUiState?.snapshot?.() ?? null
      },
      settings,
      runtime: {
        hookPort: core?.hookPort ?? null,
        controlPort: controlServer?.port ?? null,
        metadataPath: runtimePaths?.runtimeMetadataPath ?? null,
        logPath: logger?.filePath ?? null,
        pid: processLike.pid ?? null,
        core: { mode: coreHost?.mode ?? null, pid: coreHost?.pid ?? null, status: core?.status ?? null },
        companion: companionHost ? { mode: companionHost.mode, pid: companionHost.pid, status: companion?.status ?? null } : null
      }
    };
  }

  // runtime.json (scripts and the smoke read it; storage-export refuses while it exists): written and removed without
  // blocking main, one write after another, each with the content of its moment, so the newest lands last.
  let runtimeMetadataWrites = Promise.resolve();
  function runtimeMetadataWrite(work) {
    const file = runtimePaths?.runtimeMetadataPath;
    if (!file) return runtimeMetadataWrites;
    runtimeMetadataWrites = runtimeMetadataWrites.then(() => work(file)).catch((error) => {
      logger?.warn("runtime", "runtime.json could not be updated", { error: String(error?.message ?? error) });
    });
    return runtimeMetadataWrites;
  }

  function writeRuntimeMetadata() {
    if (stoppingPromise) return runtimeMetadataWrites;   // quitting: the file goes, nothing writes it again
    const text = JSON.stringify({
      pid: processLike.pid ?? null,
      hookPort: core?.hookPort ?? null,
      controlPort: controlServer?.port ?? null,
      logPath: logger?.filePath ?? null
    }, null, 2);
    return runtimeMetadataWrite(async (file) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    });
  }

  function removeRuntimeMetadata() {
    return runtimeMetadataWrite((file) => fs.rm(file, { force: true }));
  }

  function runtimeMode() {
    return detectRuntimeMode({ app, processLike });
  }

  function resolveRuntimePaths() {
    const home = processLike.env.CCF_HOME_OVERRIDE || app.getPath("home");
    const appData = processLike.env.CCF_APPDATA_OVERRIDE || app.getPath("appData");
    const portOverride = Number.parseInt(processLike.env.CCF_PORT_OVERRIDE ?? "", 10);
    const appModeOverride = processLike.env.CCF_APP_MODE_OVERRIDE || null;
    const root = path.join(appData, "chaos-cat-familiar");
    return {
      home,
      appData,
      root,
      portOverride: Number.isFinite(portOverride) ? portOverride : null,
      appModeOverride: appModeOverride ? normalizeShellMode(appModeOverride) : null,
      settingsPath: path.join(root, "settings.json"),
      statePath: path.join(root, "state.json"),
      dbPath: path.join(root, "ccf.sqlite"),
      logPath: path.join(root, "logs", "chaos-cat-familiar.log"),
      mascotsPath: path.join(root, "mascots.json"),
      mascotCacheDir: path.join(root, "mascot-assets"),
      runtimeMetadataPath: path.join(root, "runtime.json"),
      testMode: processLike.env.CCF_TEST_MODE === "1",
      testToken: processLike.env.CCF_TEST_TOKEN || null
    };
  }

  function ensureWindows() {
    app.setName?.("Chaos Cat Familiar");
    app.setAppUserModelId("wolframs.ChaosCatFamiliar");
  }

  function createTrayIcon() {
    // Let Windows choose a real 16/20/24/32px ICO representation for its DPI.
    // SVG data URLs decode as empty NativeImages on this Electron/Windows stack.
    return path.join(SHELL_ROOT, "assets", "tray", "chaos-cat.ico");
  }

  function saveSettingsPatch(patch) {
    if (Object.keys(patch).length === 2 && Object.hasOwn(patch, "overlayBounds")
      && Object.hasOwn(patch, "overlayDisplayId")) {
      return placementPersistence?.save(patch);
    }
    return writeSettingsPatch(patch);
  }

  // A patch to the core, the only writer of settings.json: it lands on the file's current value there, so preferences
  // edited outside CCF stay; the mirror shows it at once. No file I/O on this thread.
  function writeSettingsPatch(patch) {
    if (!settingsStore) {
      return;
    }
    // Electron's move/resize event and the bounds IPC can report the same placement.
    const current = settingsStore.load();
    if (Object.keys(patch).length === 2 && Object.hasOwn(patch, "overlayBounds")
      && Object.hasOwn(patch, "overlayDisplayId") && current.overlayBounds && patch.overlayBounds
      && current.overlayDisplayId === patch.overlayDisplayId
      && ["x", "y", "width", "height"].every((key) => current.overlayBounds[key] === patch.overlayBounds[key])) {
      return;
    }
    settingsStore.update(patch);
  }

  function applyOverlayPreferences() {
    const settings = currentSettings();
    overlayWindow?.setOpacity?.(Number.isFinite(settings.overlayOpacity) ? settings.overlayOpacity : 1);
    const snoozed = settings.snoozeUntil === "manual"
      || (typeof settings.snoozeUntil === "string" && !Number.isNaN(new Date(settings.snoozeUntil).getTime()) && new Date(settings.snoozeUntil).getTime() > Date.now());
    if (snoozed) {
      minimizeToTray();
    }
    syncOverlayHudWindows();
  }

  // The core's state reaches windows on their own ports (the overlay's: live sessions, approvals and counts; process-split
  // plan, step 7); main sends only its own part, and only when it changed.
  function broadcastState(changeSnapshot) {
    const payload = snapshotRuntime(changeSnapshot).state;
    for (const window of [overlayWindow, dashboardWindow, diagnosticsWindow]) {
      if (window && !window.isDestroyed?.()) sendShellState(window, payload);
    }
    syncOverlayHudWindows();
    refreshTrayToolTip();
  }

  // Main's part of a window's state when the core's part comes on the window's own port (renderer/legacy-state.js
  // puts them together): settings-derived meta, the shell UI state, the hosted Codex companion's session.
  function shellStateOf(payload) {
    const { unreadNotificationCount, approvalHistoryCount, revision, epoch, ...meta } = payload.meta ?? {};
    const hostedCompanion = payload.hostedCompanion ?? null;
    return { meta, ui: payload.ui ?? null, hostedCompanion,
      hostedSession: hostedCompanion ? payload.sessions?.find((session) => session.id === hostedCompanion.sessionId) ?? null : null };
  }

  const sentShellStates = new WeakMap();
  function sendShellState(window, payload) {
    const shell = shellStateOf(payload);
    const key = JSON.stringify([shell.meta, shell.ui, shell.hostedCompanion]);
    if (sentShellStates.get(window.webContents) === key) return;
    sentShellStates.set(window.webContents, key);
    window.webContents.send("ccf:shell-state", shell);
  }

  // A port change from the settings: the core rebinds (falling back to a free port) and persists what it got.
  async function rebindHookServer(requestedPort) {
    const result = await core.request("rebindHookServer", { port: requestedPort });
    core.hookPort = result.port;
    if (coreHost) coreHost.lastPort = result.port;
    await writeRuntimeMetadata();
    return result;
  }

  // What the core asks of main when /companion/* arrives on the hook server.
  function companionIntents() {
    return {
      companionStatus: (payload) => {
        if(companionBackend()==='codex'||payload.backend&&payload.backend!=='claude')return;
        if (!isWorkCompanionPath(payload.cwd ?? payload.workspace?.current_dir)) return;
        companionStatusBackend='claude';
        companionStatus = payload;
        companionStatusWindow?.webContents.send("ccf:companion-status", payload);
      },
      companionBubble: (payload) => addCompanionBubble(payload),
      companionOpen: async ({ backend } = {}) => {
        if (runtimePaths.testMode) throw new Error("Claude Code start is disabled in test mode.");
        // The launcher's open is the user's explicit start: it may bring back a companion that crashed.
        await ensureCompanion({ restart: true });
        if (backend && backend !== companion.snapshot().backend) await companion.selectBackend(backend);
        if (!companion.snapshot().connected) await companion.start({ userInitiated: true,
          cwd: currentSettings().companionRepoPath, model: currentSettings().codexModel });
        companionHudActive = true;
        runtimePaths.appModeOverride = "mascot";
        saveSettingsPatch({ appShellMode: "mascot", overlayVisible: true });
        showOverlay();
        broadcastSettings();
        companionConversationWindow?.focus();
      }
    };
  }

  function positionOverlayWindow() {
    if (!overlayWindow) {
      return;
    }
    const settings = currentSettings();
    const modeSize = overlayWindowSizeForMode(settings.appShellMode, settings.overlayBounds);
    const displays = screen.getAllDisplays();
    const testDisplay = runtimePaths.testMode && processLike.env.CCF_TEST_DISPLAY === "rightmost"
      ? displays.reduce((right, display) => display.bounds.x > right.bounds.x ? display : right)
      : null;
    const placement = deriveOverlayPlacement({
      displays,
      mode: testDisplay ? "remember" : settings.overlayDisplayMode ?? "remember",
      lastDisplayId: testDisplay?.id ?? settings.overlayDisplayId ?? null,
      savedBounds: settings.overlayBounds ? { ...settings.overlayBounds, ...modeSize } : null,
      cursorPoint: screen.getCursorScreenPoint(),
      primaryDisplayId: screen.getPrimaryDisplay()?.id ?? null,
      width: modeSize.width,
      height: modeSize.height
    });
    overlayWindow.setBounds(placement.bounds);
    saveSettingsPatch({
      overlayDisplayId: placement.display?.id ?? settings.overlayDisplayId ?? null,
      overlayBounds: placement.bounds
    });
    syncOverlayHudWindows();
  }

  function persistOverlayPlacement() {
    if (!overlayWindow || !settingsStore || applyingOverlayBounds) {
      return;
    }
    const bounds = overlayWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const workArea = display?.workArea ?? screen.getPrimaryDisplay().workArea;
    const clamped = clampBoundsToWorkArea(bounds, workArea, 24);
    saveSettingsPatch({
      overlayBounds: clamped,
      overlayDisplayId: display?.id ?? null
    });
    syncOverlayHudWindows();
  }

  function wireWindowLogging(window, name, transient = false) {
    if (!window) {
      return;
    }

    const listen = transient ? (emitter, event, handler) => emitter.on(event, handler) : onWithCleanup;
    listen(window.webContents, "console-message", (_event, level, message, line, sourceId) => {
      // Electron's dev-only security warning repeats on every page load and
      // design reload; keep one per view, at debug level, out of the console.
      if (ELECTRON_SECURITY_WARNING.test(String(message))) {
        if (!securityWarningViews.has(name)) logger?.debug("renderer-console", `${name}: ${message}`, { level });
        securityWarningViews.add(name);
        return;
      }
      logger?.info("renderer-console", `${name}: ${message}`, {
        level,
        line,
        sourceId
      });
    });
    listen(window.webContents, "render-process-gone", (_event, details) => {
      if (window === overlayWindow) finishOverlayDrag();
      logger?.error("renderer", `${name} render process gone`, details);
    });
    if (window === overlayWindow) listen(window.webContents, "did-start-loading", finishOverlayDrag);
    listen(window.webContents, "unresponsive", () => {
      logger?.warn("renderer", `${name} became unresponsive`);
    });
    listen(window.webContents, "responsive", () => {
      logger?.info("renderer", `${name} became responsive again`);
    });
  }

  function ensureUtilityWindow(kind) {
    if (kind === "diagnostics") {
      if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) return diagnosticsWindow;
      const window = new BrowserWindow({
        width: 980,
        height: 720,
        show: false,
        frame: false,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        backgroundColor: "#100d18",
        title: "Chaos Cat Familiar Diagnostics",
        webPreferences: {
          preload: path.join(SHELL_ROOT, "preload.js")
        }
      });
      diagnosticsWindow = window;
      wireWindowLogging(window, "diagnostics", true);
      window.loadFile(path.join(SHELL_ROOT, "renderer", "diagnostics.html"));
      window.on("close", () => { diagnosticsWindow = null; window.destroy(); });
      return window;
    }
    if (kind === "mascots") {
      if (mascotWindow && !mascotWindow.isDestroyed()) return mascotWindow;
      const window = new BrowserWindow({
        width: 1080,
        height: 760,
        show: false,
        frame: false,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        backgroundColor: "#100d18",
        title: "Chaos Cat Familiar Mascots",
        webPreferences: {
          preload: path.join(SHELL_ROOT, "preload.js")
        }
      });
      mascotWindow = window;
      wireWindowLogging(window, "mascots", true);
      window.loadFile(path.join(SHELL_ROOT, "renderer", "mascots.html"));
      window.on("close", () => { mascotWindow = null; window.destroy(); });
      return window;
    }
    if (kind === "preview") {
      if (mascotPreviewWindow && !mascotPreviewWindow.isDestroyed()) return mascotPreviewWindow;
      const window = new BrowserWindow({
        width: 1100,
        height: 760,
        show: false,
        frame: false,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        backgroundColor: "#100d18",
        title: "Chaos Cat Familiar Preview",
        webPreferences: {
          preload: path.join(SHELL_ROOT, "preload.js")
        }
      });
      mascotPreviewWindow = window;
      wireWindowLogging(window, "preview", true);
      window.loadFile(path.join(SHELL_ROOT, "renderer", "mascot-preview.html"));
      window.on("close", () => { mascotPreviewWindow = null; window.destroy(); });
      return window;
    }
    if (kind === "dashboard") {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
      const window = new BrowserWindow({
        width: 1200,
        height: 820,
        show: false,
        frame: false,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        backgroundColor: "#100d18",
        title: "Chaos Cat Familiar Dashboard",
        webPreferences: {
          preload: path.join(SHELL_ROOT, "preload.js")
        }
      });
      dashboardWindow = window;
      wireWindowLogging(window, "dashboard", true);
      window.webContents.on("did-finish-load", () => sendDashboardSection(window));
      window.loadFile(path.join(SHELL_ROOT, "renderer", "dashboard.html"));
      window.on("close", () => { dashboardWindow = null; dashboardRequestedSection = null; window.destroy(); });
      return window;
    }
  }


  function createWindows() {
    overlayWindow = new BrowserWindow({
      width: 420,
      height: 320,
      show: false,
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      title: "Chaos Cat Familiar Overlay",
      webPreferences: {
        preload: path.join(SHELL_ROOT, "preload.js")
      }
    });
    keepOnTop(overlayWindow);

    overlayWindow.loadFile(path.join(SHELL_ROOT, "renderer", "overlay.html"));

    wireWindowLogging(overlayWindow, "overlay");
    positionOverlayWindow();

    onWithCleanup(overlayWindow, "close", (event) => {
      if (!app.isQuiting) {
        event.preventDefault();
        saveSettingsPatch({ overlayVisible: false });
        overlayWindow.hide();
        refreshTrayMenu();
      }
    });
    onWithCleanup(overlayWindow, "move", persistOverlayPlacement);
    onWithCleanup(overlayWindow, "resize", persistOverlayPlacement);
    onWithCleanup(overlayWindow, "show", syncOverlayHudWindows);
    onWithCleanup(overlayWindow, "hide", syncOverlayHudWindows);
    onWithCleanup(overlayWindow, "focus", registerGlobalShortcuts);
    onWithCleanup(overlayWindow, "blur", registerGlobalShortcuts);
    // Clicking (or starting to drag) the cat brings its panels back with it.
    onWithCleanup(overlayWindow, "focus", () => raiseCompanionCluster("cat-focus"));
    onWithCleanup(overlayWindow, "blur", () => repairClusterTopmost("blur"));

  }

  function showUtilityWindow(window) {
    if (!window) {
      return;
    }
    logger?.info("window", "Showing utility window", {
      title: window.getTitle()
    });
    if (window.isMinimized()) {
      window.restore();
    }
    if (runtimePaths.testMode) {
      const area = screen.getDisplayMatching(overlayWindow.getBounds()).workArea;
      window.setBounds(clampBoundsToWorkArea(window.getBounds(), area));
      window.showInactive();
      return;
    }
    window.setAlwaysOnTop(true, "floating");
    window.show();
    window.focus();
    window.moveTop();
    const timer = timers.setTimeout(() => {
      utilityTimers.delete(timer);
      if (!window.isDestroyed()) {
        window.setAlwaysOnTop(false);
      }
    }, 250);
    utilityTimers.add(timer);
  }

  function showDiagnostics() {
    showUtilityWindow(ensureUtilityWindow("diagnostics"));
  }

  function sendDashboardSection(window) {
    if (!dashboardRequestedSection || window.isDestroyed()) return;
    const section = dashboardRequestedSection;
    dashboardRequestedSection = null;
    window.webContents.send("ccf:dashboard-section", section);
  }

  function showDashboard(section = null) {
    if (section) dashboardRequestedSection = section;
    const window = ensureUtilityWindow("dashboard");
    showUtilityWindow(window);
    if (!window.webContents.isLoading?.()) sendDashboardSection(window);
  }

  function showMascotManager() {
    showUtilityWindow(ensureUtilityWindow("mascots"));
  }

  function showMascotPreview() {
    showUtilityWindow(ensureUtilityWindow("preview"));
  }

  function showOverlay() {
    logger?.info("window", "Showing overlay window");
    if (currentSettings().snoozeUntil === "manual") {
      return;
    }
    saveSettingsPatch({ overlayVisible: true });
    positionOverlayWindow();
    overlayWindow.showInactive();
    syncOverlayHudWindows();
    raiseCompanionCluster("show-overlay");
    refreshTrayMenu();
    refreshTrayToolTip();
  }

  // Escape hatch for a cluster buried behind other windows.
  function bringCompanionToFront(reason) {
    if (!overlayWindow.isVisible()) showOverlay();
    raiseCompanionCluster(reason, { focusComposer: true });
  }

  // Minimize to Tray (the tray's and the cat's menu; formerly "Hide Companion"): the whole cluster goes, bubbles stay
  // stacked, the panel's feed stops. It persists across restarts (overlayVisible: false). While hidden in mascot mode
  // approvals and bubbles do not bring the cat back; the tray tooltip counts them (applyCoreEffect, refreshTrayToolTip).
  function minimizeToTray() {
    overlayWindow.hide();
    companionConversationWindow?.hide();
    companionStatusWindow?.hide();
    hideSidePanel();
    companionBubbleWindow?.hide();
    stopClusterTopmostWatch();
    saveSettingsPatch({ overlayVisible: false });
    refreshTrayMenu();
    refreshTrayToolTip();
  }

  function toggleClusterAlwaysOnTop() {
    saveSettingsPatch({ clusterAlwaysOnTop: !clusterOnTop() });
    syncClusterTopmostSetting();
  }

  function toggleSidePanel() {
    saveSettingsPatch({ sidePanelVisible: currentSettings().sidePanelVisible === false });
    panelOmittedLogged = false;
    syncOverlayHudWindows();
    refreshTrayMenu();
  }

  // While the cluster is hidden: pending approvals and stacked bubbles (sessions waiting on him).
  function hiddenCounts() {
    if (overlayWindow?.isVisible()) return { approvals: 0, waiting: 0 };
    return { approvals: coreState().approvals?.length ?? 0, waiting: companionBubbles.size };
  }

  // Set only when the text changes; the tray menu is rebuilt only when its waiting count changes.
  function refreshTrayToolTip() {
    if (!tray || tray.isDestroyed?.()) return;
    const { approvals, waiting } = hiddenCounts();
    const text = ["Chaos Cat Familiar", approvals ? `${approvals} approval${approvals === 1 ? "" : "s"}` : null,
      waiting ? `${waiting} waiting` : null].filter(Boolean).join(" · ");
    if (text !== lastTrayToolTip) {
      lastTrayToolTip = text;
      tray.setToolTip(text);
    }
    if (approvals + waiting !== lastTrayWaiting) refreshTrayMenu();
  }

  // The library reads and writes its files asynchronously; windows get it once it is there.
  async function broadcastMascotLibrary() {
    let payload = null;
    try { payload = (await mascotLibrary?.list?.()) ?? null; }
    catch (error) { logger?.warn("mascot", "Mascot library unavailable", { error: String(error?.message ?? error) }); }
    overlayWindow?.webContents.send("ccf:mascot-library", payload);
    dashboardWindow?.webContents.send("ccf:mascot-library", payload);
    diagnosticsWindow?.webContents.send("ccf:mascot-library", payload);
    mascotWindow?.webContents.send("ccf:mascot-library", payload);
    mascotPreviewWindow?.webContents.send("ccf:mascot-library", payload);
  }

  function broadcastSettings() {
    const payload = currentSettings();
    if (overlayDragSettings) overlayDragSettings = payload;
    overlayWindow?.webContents.send("ccf:settings", payload);
    dashboardWindow?.webContents.send("ccf:settings", payload);
    diagnosticsWindow?.webContents.send("ccf:settings", payload);
    mascotWindow?.webContents.send("ccf:settings", payload);
    mascotPreviewWindow?.webContents.send("ccf:settings", payload);
    sidePanelFeed?.setPath();
    syncClusterTopmostSetting();
    applyOverlayPreferences();
    syncOverlayHudWindows();
    refreshTrayMenu();
  }

  async function handleCcfProtocol(rawUrl) {
    const parsed = parseCcfProtocolUrl(rawUrl);
    if (!parsed) {
      return;
    }
    if (parsed.action === "install") {
      const result = await mascotLibrary.installFromSlug(parsed.slug);
      await broadcastMascotLibrary();
      showMascotManager();
      logger?.info("mascot", "Handled ccf protocol install", {
        slug: parsed.slug,
        ok: result.ok
      });
    }
  }

  function registerCcfProtocolClient() {
    if (runtimePaths?.testMode) return;
    const smokeTestMs = Number.parseInt(processLike.env.CCF_SMOKE_TEST_MS ?? "", 10);
    if (Number.isFinite(smokeTestMs) && smokeTestMs > 0) {
      return;
    }
    if (runtimeMode().isDefaultApp) {
      app.setAsDefaultProtocolClient("ccf", processLike.execPath, [path.resolve(processLike.argv[1])]);
      return;
    }
    app.setAsDefaultProtocolClient("ccf");
  }

  function topPendingApproval() {
    const approvals = coreState().approvals ?? [];
    return approvals.find((item) => !item.collapsed) ?? approvals[0] ?? null;
  }

  async function focusSession(session, { launchFallback = true } = {}) {
    if (!session) {
      return {
        ok: false,
        reason: "no_session"
      };
    }
    return activation.activateTerminal({
      projectDir: session.projectDir ?? null,
      shellPid: session.shellPid ?? null,
      launchFallback
    });
  }

  function resolveTopApproval(approval, decision) {
    core.resolveApproval(approval.id, decision).then(() => {
      shellUiState?.sync?.(coreState());
      broadcastState();
    }, (error) => logger?.error("hotkey", "Approval hotkey failed", { decision, error: String(error?.message ?? error) }));
  }

  function registerGlobalShortcuts() {
    if (runtimePaths?.testMode) return;
    globalShortcut.unregisterAll();
    const settings = settingsStore.load();
    const hotkeys = settings.hotkeys ?? {};

    const bindings = [
      {
        accelerator: hotkeys.toggleOverlay,
        // Summon semantics while the work companion is up: a visible but
        // unfocused (possibly buried) cluster comes to the front first; the
        // next press hides it. Avoids claiming another system-wide shortcut.
        action: () => {
          if (!overlayWindow.isVisible()) showOverlay();
          else if (companionHudActive && mascotModeEnabled() && !clusterHasFocus()) bringCompanionToFront("hotkey");
          else overlayWindow.hide();
        }
      },
      {
        accelerator: hotkeys.openDiagnostics,
        action: () => showDiagnostics()
      },
      {
        accelerator: hotkeys.openDashboard,
        action: () => showDashboard()
      }
    ];

    if (!mascotModeEnabled() && overlayWindow?.isFocused?.()) {
      bindings.push(
      {
        accelerator: hotkeys.approveTop,
        action: () => {
          const ui = shellUiState?.snapshot?.();
          if (ui?.overlay?.sessionSwitcher?.isOpen) {
            shellUiState.dispatch("confirm-session-selection", null, {
              coreState,
              focusSession,
              saveSettingsPatch
            }).then(() => broadcastState()).catch(() => {});
            return;
          }
          if (ui?.overlay?.toast) {
            shellUiState.dismissToast();
            broadcastState();
            return;
          }
          const approval = topPendingApproval();
          if (approval) resolveTopApproval(approval, "allow");
        }
      },
      {
        accelerator: hotkeys.denyTop,
        action: () => {
          const approval = topPendingApproval();
          if (approval) resolveTopApproval(approval, "deny");
        }
      },
      {
        accelerator: hotkeys.deferTop,
        action: () => {
          const approval = topPendingApproval();
          if (approval) resolveTopApproval(approval, "defer");
        }
      },
      {
        accelerator: hotkeys.sessionSwitcherNext,
        action: () => {
          if (!shellUiState.snapshot().overlay.sessionSwitcher.isOpen) {
            shellUiState.openSessionSwitcher(coreState());
          } else {
            shellUiState.selectSessionOffset(1);
          }
          broadcastState();
        }
      },
      {
        accelerator: hotkeys.sessionSwitcherPrevious,
        action: () => {
          if (!shellUiState.snapshot().overlay.sessionSwitcher.isOpen) {
            shellUiState.openSessionSwitcher(coreState());
          } else {
            shellUiState.selectSessionOffset(-1);
          }
          broadcastState();
        }
      },
      {
        accelerator: hotkeys.toggleExpandedApproval,
        action: () => {
          shellUiState.toggleExpandedApproval(coreState());
          broadcastState();
        }
      }
      );

      for (let index = 1; index <= 9; index += 1) {
        bindings.push({
          accelerator: `CommandOrControl+${index}`,
          action: () => {
            shellUiState.selectIndex(index - 1, coreState());
            broadcastState();
          }
        });
      }
    }

    for (const binding of bindings) {
      if (!binding.accelerator) {
        continue;
      }
      const ok = globalShortcut.register(binding.accelerator, binding.action);
      logger?.info("hotkey", ok ? "Registered hotkey" : "Failed to register hotkey", {
        accelerator: binding.accelerator
      });
    }
  }

  function applyStartupSettings() {
    if (runtimePaths?.testMode) return;
    const settings = settingsStore.load();
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.openAtLogin)
    });
    logger?.info("startup", "Updated startup-at-login setting", {
      openAtLogin: Boolean(settings.openAtLogin)
    });
  }

  function setAppShellMode(mode) {
    const nextMode = normalizeShellMode(mode);
    const settings = settingsStore.load();
    saveSettingsPatch({ appShellMode: nextMode, snoozeUntil: null, overlayVisible: true });
    runtimePaths.appModeOverride = null; // Launch defaults must not defeat an explicit choice.
    registerGlobalShortcuts();
    logger?.info("window", "Updated app shell mode", {
      previousMode: settings.appShellMode ?? "developer",
      nextMode
    });
    positionOverlayWindow();
    showOverlay();
    broadcastSettings();
    broadcastState();
  }

  function showOverlayContextMenu() {
    shellUiState.dispatch("open-context-menu", { mode: "main" }, {
      coreState,
      focusSession,
      saveSettingsPatch
    }).then(() => {
      broadcastState();
    }).catch(() => {});
  }

  function createTray() {
    const icon = createTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip("Chaos Cat Familiar");
    lastTrayToolTip = "Chaos Cat Familiar";
    onWithCleanup(tray, "click", trayAction("Toggle companion", () => {
      overlayWindow.isVisible() ? minimizeToTray() : openCompanionFromTray();
    }));
    refreshTrayMenu();
  }

  function trayAction(label, action) {
    return async () => {
      try { await action(); }
      catch (error) {
        logger?.error("tray", `${label} failed`, { error: String(error?.stack ?? error) });
        try {
          dialog?.showErrorBox?.("Chaos Cat Familiar", `${label} could not be completed.\n\n${String(error?.message ?? error)}\n\nLog: ${logger?.filePath ?? "unavailable"}`);
        } catch { /* Reporting must not turn a menu failure into an app crash. */ }
      }
    };
  }

  function openCompanionFromTray() {
    if (currentSettings().appShellMode !== "mascot") setAppShellMode("mascot");
    companionHudActive = true;
    // The process only: Claude or Codex start when the user presses Start.
    ensureCompanion().catch((error) => logger?.warn("companion", "Companion not available", { error: String(error?.message ?? error) }));
    saveSettingsPatch({ snoozeUntil: null, overlayVisible: true });
    showOverlay();
    raiseCompanionCluster("tray", { focusComposer: true });
    refreshTrayMenu();
  }

  // The tray's and the cat's menu share one definition (services/companion-menu.js).
  function companionMenuState() {
    const settings = currentSettings();
    const { approvals, waiting } = hiddenCounts();
    return { visible: Boolean(overlayWindow?.isVisible()), mascotMode: mascotModeEnabled(settings),
      alwaysOnTop: settings.clusterAlwaysOnTop !== false, sidePanelVisible: settings.sidePanelVisible !== false,
      waitingCount: approvals + waiting, appShellMode: settings.appShellMode };
  }

  function companionMenuActions() {
    const actions = {
      "show-companion": ["Show Companion", openCompanionFromTray],
      "always-on-top": ["Always on Top", toggleClusterAlwaysOnTop],
      "side-panel": ["Side Panel", toggleSidePanel],
      "minimize-to-tray": ["Minimize to Tray", minimizeToTray],
      dashboard: ["Dashboard...", () => showDashboard()],
      settings: ["Settings...", () => showDashboard("settings")],
      mascots: ["Mascots...", showMascotManager],
      diagnostics: ["Diagnostics...", showDiagnostics],
      preview: ["Mascot Preview...", showMascotPreview],
      "mascot-mode": ["Floating Mascot", () => setAppShellMode("mascot")],
      "developer-mode": ["Developer Overlay", () => setAppShellMode("developer")],
      quit: ["Quit", async () => { await stop("tray-quit"); app.quit(); }]
    };
    return Object.fromEntries(Object.entries(actions).map(([id, [label, run]]) => [id, trayAction(label, run)]));
  }

  function companionMenu(surface) {
    return companionMenuTemplate(companionMenuState(), companionMenuActions(), { surface });
  }

  function refreshTrayMenu() {
    if (!tray || tray.isDestroyed?.()) return;
    const state = companionMenuState();
    lastTrayWaiting = state.waitingCount;
    tray.setContextMenu(Menu.buildFromTemplate(companionMenuTemplate(state, companionMenuActions(), { surface: "tray" })));
  }

  // The cat's right-click in mascot mode: the shared menu at the cursor.
  function showCompanionMenu() {
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return false;
    Menu.buildFromTemplate(companionMenu("cat")).popup({ window: overlayWindow });
    return true;
  }

  // The test route's click on a menu item by id.
  async function menuClick({ surface = "tray", id } = {}) {
    const item = flattenMenu(companionMenu(surface === "cat" ? "cat" : "tray")).find((entry) => entry.id === id);
    if (!item || typeof item.click !== "function") throw new Error(`No menu item ${id} on the ${surface} menu.`);
    if (item.enabled === false) throw new Error(`Menu item ${id} is disabled.`);
    await item.click();
    return { ok: true };
  }

  function wireDisplayObservers() {
    const reposition = () => {
      if (!overlayWindow) {
        return;
      }
      positionOverlayWindow();
      syncOverlayHudWindows();
      if (overlayWindow.isVisible()) {
        overlayWindow.showInactive();
      }
    };

    onWithCleanup(screen, "display-added", reposition);
    onWithCleanup(screen, "display-removed", reposition);
    onWithCleanup(screen, "display-metrics-changed", reposition);
  }

  function unregisterIpc() {
    for (const channel of IPC_HANDLES) {
      ipcMain.removeHandler?.(channel);
    }
    for (const channel of IPC_EVENTS) {
      const handler = ipcMain.__ccfHandlers?.[channel];
      if (typeof handler === "function") ipcMain.off?.(channel, handler);
    }
    if (ipcMain.__ccfHandlers) {
      ipcMain.__ccfHandlers = {};
    }
  }

  function addIpcListener(channel, handler) {
    ipcMain.__ccfHandlers ??= {};
    ipcMain.__ccfHandlers[channel] = handler;
    ipcMain.on(channel, handler);
  }

  // The conversation window's actions (and the test control route). Main keeps the native parts (dialogs, clipboard,
  // links, settings); everything else is a request to the companion process, started here when first needed.
  async function companionAction(payload) {
    if (!companion || !payload || typeof payload !== "object") throw new Error("Companion unavailable.");
    switch (payload.action) {
      case "open-settings":
        showDashboard('settings');return {ok:true};
      case 'install-codex-hooks':
      case 'remove-codex-hooks': {
        const settings=currentSettings();
        if(!settings.codexAuthenticationHome||!settings.codexHookNodeExecutable)throw new Error('Configure the absolute Codex home and Node executable in companion settings first.');
        const result=await runHookOperation(()=>coreHooks(payload.action==='install-codex-hooks'?'codex-install':'codex-remove',
          {codexHome:settings.codexAuthenticationHome,nodeExecutable:settings.codexHookNodeExecutable}));
        return{ok:true,...result,message:'Codex observation hooks updated. Review trust and enablement with Codex /hooks.'};
      }
      case "open-link":
        // OSC 8 links from the terminal: web links in the browser, file links in their default app.
        await openLink(payload.url);
        return { ok: true };
      case "resize":
        if (runtimePaths.testMode && companionPreviewSnapshot && companion.status !== "ready") return { ok: true };
        if (runtimePaths.testMode && companionPreviewSnapshot && !companion.snapshot()?.connected) return { ok: true };
        break;
      default: break;
    }
    // Start is the explicit restart of a companion that crashed; every other action needs a running one.
    const fixture = runtimePaths.testMode ? processLike.env.CCF_TEST_COMPANION_FIXTURE || null : null;
    if (payload.action === "start" && runtimePaths.testMode && !fixture) throw new Error("Claude Code start is disabled in test mode.");
    await ensureCompanion({ restart: payload.action === "start" });
    switch (payload.action) {
      case "start":
        // Test mode starts only the PowerShell fixture named by CCF_TEST_COMPANION_FIXTURE, never Claude or Codex.
        if (fixture && companion.snapshot()?.backend !== "claude") throw new Error("Test mode starts only the Claude fixture.");
        await companion.start({ userInitiated: true, cwd: fixture ?? currentSettings().companionRepoPath,
          model: currentSettings().codexModel });
        return { ok: true };
      case "send": {
        // Selection, submission and releasing accepted images happen in the companion, in that order.
        const submission = await companion.send({ submissionId: payload.submissionId, text: payload.text,
          attachmentIds: payload.attachmentIds ?? [], draftRevision: payload.draftRevision });
        return { ok: true, submission };
      }
      case "select-backend":
        await companion.selectBackend(payload.backend);
        return { ok: true };
      case "switch-backend":
        await companion.switchBackend({ backend: payload.backend, userInitiated: payload.userInitiated === true });
        return { ok: true };
      case "resolve-request":
        return { ok: await companion.resolveRequest({ key: payload.key, response: payload.response }) };
      case "resolve-unknown":
        await companion.resolveUnknown(payload);
        return { ok: true };
      case "history":
        return { ok: true, ...await companion.history(payload) };
      case 'read-output':
        return{ok:true,output:await companion.getOutput({itemId:payload.itemId})};
      case "stop":
        await companion.stop();
        return { ok: true };
      case "end-day":
        await companion.stop({disposition:'day-end'});
        return {ok:true};
      case "recover-launch":
        await companion.recoverFailedStart({userInitiated:true,retainUnknown:payload.retainUnknown===true});
        return {ok:true};
      case "attach-image":
        await companion.addAttachment({ name: payload.name, dataUrl: payload.dataUrl });
        return { ok: true };
      case "paste-image": {
        const image = clipboard?.readImage();
        if (!image || image.isEmpty()) throw new Error("There is no image on the clipboard.");
        await companion.addAttachment({ name: "Screenshot.png", dataUrl: image.toDataURL() });
        return { ok: true };
      }
      case "pick-images": {
        const result = await dialog.showOpenDialog(companionConversationWindow, { title: "Attach images",
          properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
        if (!result.canceled && result.filePaths?.length) await companion.addAttachmentFiles(result.filePaths);
        return { ok: true };
      }
      case "remove-image":
        await companion.removeAttachment(payload.id);
        return { ok: true };
      case "raw-input": await companion.write(payload.text, { ptyId: payload.ptyId ?? null }); return { ok: true };
      case "interrupt": await companion.interrupt(); return { ok: true };
      case "resize":
        await companion.resize(payload.cols, payload.rows);
        return { ok: true };
      default: throw new Error("Unsupported companion action.");
    }
  }

  // Web links go to the browser, file links (an existing local folder or document, OPENABLE_FILE_TYPES) to their
  // default app; everything else is refused. Shared by the conversation's links and the side panel's rows.
  async function openLink(raw) {
    let url;
    try { url = new URL(String(raw)); } catch { throw new Error("Not a link."); }
    if (url.protocol === "file:") {
      if (url.hostname && url.hostname !== "localhost") throw new Error("Only local file links open.");
      const local = new URL(url.href);
      local.hostname = "";
      const file = fileURLToPath(local);
      const stat = await fs.stat(file).catch(() => null);
      const refused = refusedFileReason(file, { directory: Boolean(stat?.isDirectory()) });
      if (refused) throw new Error(refused);
      if (!stat) throw new Error(`File not found: ${file}`);
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    } else if (url.protocol === "http:" || url.protocol === "https:") await shell.openExternal(url.href);
    else throw new Error("Only web and file links open.");
  }

  // The side panel's row actions. The panel window is not focusable, so copying happens here, not in the page.
  async function sidePanelAction(payload) {
    try {
      switch (payload?.action) {
        case "open-link":
          await openLink(payload.url);
          return { ok: true };
        case "copy": {
          if (typeof payload.text !== "string" || !payload.text || payload.text.length > 200) return { ok: false, reason: "nothing_to_copy" };
          clipboard?.writeText(payload.text);
          return { ok: true };
        }
        case "focus-session": {
          const session = typeof payload.sessionId === "string"
            ? (coreState().sessions ?? []).find((item) => item.id === payload.sessionId) : null;
          if (!session) return { ok: false, reason: "unknown_session" };
          if (session.status === "ended") return { ok: false, reason: "session_ended" };
          // Windows Terminal tabs and panes cannot be selected from here: say "window raised" unless the exact tab was
          // confirmed, and never open a new terminal for a row click.
          const result = await focusSession(session, { launchFallback: false });
          return result?.ok === false ? { ok: false, reason: result.reason ?? "focus_failed" }
            : { ok: true, exact: result?.exactTabConfirmed === true };
        }
        case "mark-done": {
          // He marked a row done: one JSON line next to the panel file, for the companion's watcher. CCF keeps no
          // meaning of its own; the key is the item's `done`, handed back verbatim.
          if (!isDoneKey(payload.key)) return { ok: false, reason: "no_done_key" };
          const panelFile = sidePanelPath(currentSettings(), runtimePaths.home);
          if (!panelFile) return { ok: false, reason: "not_configured" };
          const text = typeof payload.text === "string" ? payload.text.slice(0, 160) : null;
          await fs.appendFile(path.join(path.dirname(panelFile), "panel-done.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), key: payload.key, text })}\n`, "utf8");
          return { ok: true };
        }
        default:
          return { ok: false, reason: "unsupported_action" };
      }
    } catch (error) {
      logger?.info("side-panel", "Side panel action failed", { action: payload?.action ?? null, error: String(error?.message ?? error) });
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  function wireIpc() {
    ipcMain.handle("ccf:get-shell-state", () => shellStateOf(snapshotRuntime().state));
    // A window's own state or frames port (process-split plan, step 5): bulk traffic bypasses main.
    ipcMain.handle("ccf:subscribe", (event, request) => viewSubscriptions.subscribe(event?.sender, request));
    ipcMain.handle("ccf:unsubscribe", (event, { id } = {}) => viewSubscriptions.unsubscribe(event?.sender, id));
    ipcMain.handle("ccf:get-settings", () => currentSettings());
    // The conversation window exists only while the companion is shown: its first read starts the process (never
    // Claude or Codex). A crashed one stays down; its snapshot says so.
    ipcMain.handle("ccf:get-companion", async () => {
      if (companion?.status === "idle" || companion?.status === "starting") {
        await withDeadline(ensureCompanion().catch(() => {}), 15000);
      }
      return companionSnapshot();
    });
    ipcMain.handle("ccf:get-companion-status", () => companionStatus);
    ipcMain.handle("ccf:get-companion-bubbles", () => companionBubbles.list());
    ipcMain.handle("ccf:companion-action", (_event, payload) => companionAction(payload));
    ipcMain.handle("ccf:get-side-panel", () => sidePanelFeed?.snapshot() ?? null);
    ipcMain.handle("ccf:side-panel-action", (_event, payload) => sidePanelAction(payload));
    ipcMain.handle("ccf:show-companion-menu", () => showCompanionMenu());
    ipcMain.handle("ccf:get-overlay-bounds", () => overlayWindow?.getBounds?.() ?? null);
    ipcMain.handle("ccf:show-overlay-context-menu", () => {
      showOverlayContextMenu();
      return true;
    });
    ipcMain.handle("ccf:get-mascot-library", async () => mascotLibrary.list());
    ipcMain.handle("ccf:get-log-metadata", async () => {
      const status = await core.request("status", null, { timeoutMs: 5000 }).catch(() => null);
      return {
        ...(status?.logging ?? logger?.status()),
        performance: performanceSampler?.snapshot() ?? null,
        persistence: status?.persistence ?? null,
        placement: placementPersistence?.status() ?? null,
        recovery: coreRecovery,
        core: { mode: coreHost?.mode ?? null, pid: coreHost?.pid ?? null, status: core?.status ?? null },
        companion: companionHost ? { mode: companionHost.mode, pid: companionHost.pid, status: companion?.status ?? null } : null
      };
    });
    ipcMain.handle("ccf:notification-action", (_event, { action, id }) => core.notificationAction(action, id));
    ipcMain.handle("ccf:dispatch-command", async (_event, { command, payload }) => {
      const result = await shellUiState.dispatch(command, payload ?? {}, {
        coreState,
        focusSession,
        saveSettingsPatch
      });
      broadcastSettings();
      broadcastState();
      return {
        ...result,
        state: snapshotRuntime().state
      };
    });
    ipcMain.handle("ccf:cleanup-action", async (_event, { action }) => {
      let result;
      switch (action) {
        case "remove-hooks":
          result = await runHookOperation(() => coreHooks("remove"));
          break;
        case "remove-ide-integration":
          result = removeIdeIntegration();
          break;
        case "clear-local-data":
          // The history lives in the core's database (step 6): the core clears it, then main removes the rest.
          await core.request("clearHistory", null, { timeoutMs: 10000 });
          result = await clearCcfLocalData({
            appDataRoot: runtimePaths.root,
            homeRoot: path.join(runtimePaths.home, ".chaos-cat-familiar"),
            preserveHooks: true
          });
          break;
        case "clear-cache-logs":
          result = await clearCcfCacheAndLogs({
            appDataRoot: runtimePaths.root
          });
          // runtime.json went with the cache; CCF still runs.
          await writeRuntimeMetadata();
          break;
        case "reset-onboarding":
          result = await shellUiState.dispatch("reset-onboarding", {}, {
            coreState,
            focusSession,
            saveSettingsPatch
          });
          break;
        default:
          throw new Error(`unsupported_cleanup_action:${action}`);
      }
      broadcastSettings();
      broadcastState();
      return result;
    });
    ipcMain.handle("ccf:window-action", (event, action) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        return false;
      }
      switch (action) {
        case "minimize":
          window.minimize();
          return true;
        case "toggle-maximize":
          window.isMaximized() ? window.unmaximize() : window.maximize();
          return true;
        case "close":
          window.close();
          return true;
        default:
          return false;
      }
    });
    ipcMain.handle("ccf:select-mascot", async (_event, id) => {
      const result = await mascotLibrary.select(id);
      await broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:install-mascot", async (_event, slug) => {
      const result = await mascotLibrary.installFromSlug(slug);
      await broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:import-mascot", async (_event, { config, options }) => {
      const result = await mascotLibrary.importConfig(config, options ?? {});
      await broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:update-mascot", async (_event, { id, config }) => {
      const result = await mascotLibrary.updateConfig(id, config);
      await broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:delete-mascot", async (_event, id) => {
      const result = await mascotLibrary.remove(id);
      await broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:open-dashboard", () => {
      showDashboard();
      return true;
    });
    ipcMain.handle("ccf:open-diagnostics", () => {
      showDiagnostics();
      return true;
    });
    ipcMain.handle("ccf:open-mascot-manager", () => {
      showMascotManager();
      return true;
    });
    ipcMain.handle("ccf:open-mascot-preview", () => {
      showMascotPreview();
      return true;
    });
    ipcMain.handle("ccf:update-settings", async (_event, nextSettings) => {
      if (Object.hasOwn(nextSettings,'companionRepoPath')) {
        const selected=nextSettings.companionRepoPath;
        if(typeof selected!=='string'||!path.isAbsolute(selected))throw new Error('Choose an absolute Claude companion repository path.');
        const stat=(file)=>fs.stat(file).catch(()=>null);
        if(!(await stat(selected))?.isDirectory()||!(await stat(path.join(selected,'start-companion.ps1')))?.isFile())throw new Error('Choose the companion folder containing start-companion.ps1.');
      }
      const current = settingsStore.load();
      // The core merges the patch onto the file (notifications and hotkeys one level deep) and answers the result.
      const saved = await settingsStore.update({
        ...nextSettings,
        appShellMode: normalizeShellMode(nextSettings.appShellMode ?? current.appShellMode)
      });
      const merged = saved?.value ?? settingsStore.load();
      if (nextSettings.appShellMode != null) runtimePaths.appModeOverride = null;
      logger.configure({ debugLogging: merged.debugLogging === true });
      performanceSampler.configure(merged.performanceProfiling === true);
      logger.info("diagnostics", "Diagnostic settings applied", {
        debugLogging: merged.debugLogging === true, performanceProfiling: merged.performanceProfiling === true
      });
      if (nextSettings.port && nextSettings.port !== current.port) {
        await rebindHookServer(merged.port);
        await runHookOperation(() => coreHooks("repair"));
      }
      applyStartupSettings();
      registerGlobalShortcuts();
      if (
        nextSettings.appShellMode ||
        nextSettings.overlayDisplayMode ||
        nextSettings.overlayBounds ||
        nextSettings.showOverlayOnStartup != null
      ) {
        positionOverlayWindow();
      }
      broadcastSettings();
      await core.checkpoint();
      await writeRuntimeMetadata();
      broadcastState();
      return merged;
    });
    ipcMain.handle("ccf:approval-action", async (_event, { id, action, payload }) => {
      if (action === "restore") {
        await core.restoreApproval(id);
        shellUiState?.sync?.(coreState());
        const snapshot = snapshotRuntime().state;
        broadcastState();
        return snapshot;
      }
      let decision = action;
      let extra = payload ?? {};
      const originalInput = coreState().approvals.find((item) => item.id === id)?.event?.toolInput ?? {};
      if (action === "allowWithAnswers") {
        decision = "allow";
        extra = { updatedInput: { ...originalInput, answers: payload?.answers ?? {} } };
      } else if (action === "allowWithFeedback") {
        decision = "allow";
        extra = { updatedInput: { ...originalInput, userFeedback: payload?.feedback ?? "" } };
      } else if (action === "allowWithPermissions") {
        decision = "allow";
        extra = { updatedPermissions: payload?.updatedPermissions ?? [] };
      }
      await core.resolveApproval(id, decision, extra);
      shellUiState?.sync?.(coreState());
      const snapshot = snapshotRuntime().state;
      broadcastState();
      return snapshot;
    });
    ipcMain.handle("ccf:activate-editor", async (_event, payload) => {
      return activation.activateEditor(payload);
    });
    ipcMain.handle("ccf:activate-terminal", async (_event, payload) => {
      return activation.activateTerminal(payload);
    });
    ipcMain.handle("ccf:detect-claude-runtime", async () => {
      return runHookOperation(() => coreHooks("diagnose")).then((result) => ({
        claudeProcesses: result.claudeProcesses ?? [],
        hookExists: result.hookExists,
        registeredEvents: result.registeredEvents ?? [],
        health: result.health
      }));
    });
    ipcMain.handle("ccf:diagnose-hooks", async () => runHookOperation(() => coreHooks("diagnose")));
    ipcMain.handle("ccf:install-hooks", async () => runHookOperation(() => coreHooks("install")));
    ipcMain.handle("ccf:repair-hooks", async () => runHookOperation(() => coreHooks("repair")));

    addIpcListener("ccf:renderer-log", (_event, payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }

      const level = payload.level === "error"
        ? "error"
        : payload.level === "warn"
          ? "warn"
          : payload.level === "debug"
            ? "debug"
            : "info";
      const category = typeof payload.category === "string" ? payload.category : "renderer";
      const message = typeof payload.message === "string" ? payload.message : "Renderer log";
      const context = payload.context && typeof payload.context === "object" ? payload.context : {};
      logger?.[level]?.(category, message, context);
    });

    addIpcListener("ccf:companion-bubble-dismiss", (_event, id) => {
      if (typeof id === "string") dismissCompanionBubble(id);
    });
    addIpcListener("ccf:view-revision", (event, payload) => {
      // Only the overlay targets effects so far; its own webContents must say so.
      if (payload?.view === "overlay" && event?.sender && event.sender !== overlayWindow?.webContents) return;
      onViewRevision(payload?.view, payload?.revision, payload?.epoch ?? null);
    });
    addIpcListener("ccf:companion-bubble-pointer", (_event, inside) => {
      companionBubbleWindow?.setIgnoreMouseEvents?.(!inside, { forward: true });
    });
    addIpcListener("ccf:set-overlay-bounds", (_event, payload) => {
      if (!overlayWindow || !payload || typeof payload !== "object") {
        return;
      }
      if (payload.dragging === true && !overlayDragSettings) {
        try { overlayDragSettings = currentSettings(); }
        catch (error) {
          overlayDragSettings = lastKnownSettings;
          logger.warn("placement", "Using cached preferences for drag; settings could not be read", { error: String(error?.message ?? error) });
        }
        placementPersistence.beginDrag();
      }
      const settings = overlayDragSettings ?? currentSettings();
      const currentBounds = overlayWindow.getBounds();
      let nextBounds = {
        x: Number.isFinite(payload.x) ? payload.x : currentBounds.x,
        y: Number.isFinite(payload.y) ? payload.y : currentBounds.y,
        width: Number.isFinite(payload.width) ? payload.width : currentBounds.width,
        height: Number.isFinite(payload.height) ? payload.height : currentBounds.height
      };
      // Apply the cluster constraint before moving the cat, never move out then
      // correct it in a native move callback (which visibly bounces at edges).
      if (companionHudActive && overlayWindow.isVisible() && settings.overlayVisible !== false && mascotModeEnabled(settings)) {
        nextBounds = clusterPlacement(nextBounds, screen.getDisplayMatching(nextBounds).workArea, settings).cat;
      }
      if (["x", "y", "width", "height"].some((key) => currentBounds[key] !== nextBounds[key])) {
        applyingOverlayBounds = true;
        try { overlayWindow.setBounds(nextBounds, false); }
        finally { applyingOverlayBounds = false; }
      }
      saveSettingsPatch({
        overlayBounds: nextBounds,
        overlayDisplayId: screen.getDisplayMatching(nextBounds)?.id ?? null
      });
      syncOverlayHudWindows(settings);
      if (payload.dragging === false) finishOverlayDrag();
    });
  }

  function finishOverlayDrag() {
    if (!overlayDragSettings) return;
    overlayDragSettings = null;
    placementPersistence?.endDrag();
  }

  let pendingHookOperations = 0;
  function runHookOperation(operation) {
    pendingHookOperations += 1;
    const pending = hookOperations.then(() => {
      if (stoppingPromise) return { ok: false, skipped: true, reason: "runtime-stopping" };
      return operation();
    }).finally(() => { pendingHookOperations -= 1; });
    hookOperations = pending.catch(() => {});
    return pending;
  }

  async function bootstrapClaudeHooks() {
    const smokeTestMs = Number.parseInt(processLike.env.CCF_SMOKE_TEST_MS ?? "", 10);
    if (Number.isFinite(smokeTestMs) && smokeTestMs > 0) {
      return {
        ok: true,
        skipped: true,
        reason: "smoke-test"
      };
    }

    try {
      const diagnosis = await coreHooks("diagnose", { detailed: false });
      if (stoppingPromise) return { ok: false, skipped: true, reason: "runtime-stopping" };
      if (!diagnosis.hookExists || !diagnosis.drift?.healthy) {
        const result = diagnosis.hookExists
          ? await coreHooks("repair")
          : await coreHooks("install");
        logger?.info("hooks", "Bootstrapped Claude hooks on startup", {
          action: result.action,
          repaired: result.repaired ?? [],
          registeredEvents: result.registeredEvents ?? []
        });
        return result;
      }

      logger?.info("hooks", "Claude hooks already healthy on startup", {
        registeredEvents: diagnosis.registeredEvents ?? []
      });
      return {
        ok: true,
        action: "noop",
        registeredEvents: diagnosis.registeredEvents ?? []
      };
    } catch (error) {
      logger?.warn("hooks", "Startup hook bootstrap failed", {
        error: String(error.message ?? error)
      });
      return {
        ok: false,
        error: String(error.message ?? error)
      };
    }
  }

  async function ingestPayload(payload) {
    return core.ingestHook(payload);
  }

  async function injectEvent(payload = {}) {
    const kind = payload.kind ?? "hook";
    if (kind === "hook") {
      await ingestPayload(payload.payload ?? payload.event ?? payload);
      return { ok: true, kind };
    }
    throw new Error("unsupported_inject_event_kind");
  }

  async function dispatchCommand(command, payload = {}) {
    const result = await shellUiState.dispatch(command, payload, {
      coreState,
      focusSession,
      saveSettingsPatch
    });
    broadcastSettings();
    broadcastState();
    return {
      ...result,
      state: snapshotRuntime().state
    };
  }

  async function diagnosticsSummary() {
    const state = coreState();
    const settings = currentSettings();
    const status = await core?.request("status", null, { timeoutMs: 5000 }).catch(() => null);
    return {
      runtime: snapshotRuntime().runtime,
      displays: screen.getAllDisplays().map(({ id, label, bounds, workArea }) => ({ id, label, bounds, workArea })),
      processes: app.getAppMetrics?.() ?? [],
      logging: status?.logging ?? logger?.status(),
      performance: performanceSampler?.snapshot(),
      eventLoop: eventLoopMonitor?.snapshot() ?? null,
      // Synchronous work on main's thread, timed where it runs: the HUD layout pass and the hosts' liveness checks.
      mainLatency: { layout: { ...layoutStats, totalMs: Math.round(layoutStats.totalMs * 1000) / 1000,
        maxMs: Math.round(layoutStats.maxMs * 1000) / 1000 }, liveness: livenessStats() },
      persistence: status?.persistence ?? null,
      // The core's storage worker (step 6): database path and row counts, commit timings, settings writes, log appends.
      storage: status?.storage ?? null,
      settingsWrites: status?.settings ?? null,
      effects: status?.effects ?? null,
      intents: status?.intents ?? null,
      core: { mode: coreHost?.mode ?? null, pid: status?.pid ?? coreHost?.pid ?? null, status: core?.status ?? null,
        hookPort: status?.hookPort ?? null, revision: status?.revision ?? null,
        // Each state subscription (main's and every window's own port): frames, coalesced changes, unacknowledged.
        subscriptions: status?.subscriptions ?? null },
      views: viewSubscriptions ? { ...viewSubscriptions.stats, subscriptions: viewSubscriptions.list() } : null,
      // Hook diagnosis, install or repair running in the core (a detailed diagnosis starts PowerShell children).
      pendingHookOperations,
      companionFrames: companion?.status === "ready"
        ? await companion.request("frames.stats", null, { timeoutMs: 5000 }).catch(() => null) : null,
      companion: companionHost?.status() ?? null,
      placement: placementPersistence?.status(),
      recovery: coreRecovery,
      // The companion cluster's windows (smoke checks: placement, visibility, topmost). kind, because a page's <title>
      // replaces the window's title once it loads.
      cluster: [["cat", overlayWindow], ["conversation", companionConversationWindow], ["status", companionStatusWindow],
        ["panel", companionPanelWindow], ["bubble", companionBubbleWindow]]
        .filter(([, window]) => window && !window.isDestroyed?.())
        .map(([kind, window]) => ({ kind, title: window.getTitle?.() ?? null, visible: window.isVisible(), bounds: window.getBounds(),
          alwaysOnTop: window.isAlwaysOnTop?.() ?? null })),
      sidePanel: sidePanelFeed ? (({ status, file, error, dropped, changedAt, panel }) => ({ status, file, error, dropped, changedAt,
        generatedAt: panel?.generatedAt ?? null, sections: panel?.sections?.map((section) => ({ id: section.id,
          items: section.items.map((item) => item.text) })) ?? null }))(sidePanelFeed.snapshot()) : null,
      latestEventAt: state.summary?.latestEventAt ?? state.events?.[0]?.receivedAt ?? null,
      activeSessionCount: state.sessions.filter((item) => item.status === "active").length,
      pendingApprovalCount: state.approvals.length,
      unreadNotificationCount: state.notifications.filter((item) => !item.isRead).length,
      // The mascot cache's own files (one directory listing in the library, not a tree walk on main).
      cacheStats: await Promise.resolve(mascotLibrary?.cacheStats?.()).catch(() => null) ?? null,
      settingsSummary: {
        port: settings.port,
        appShellMode: settings.appShellMode,
        overlayOpacity: settings.overlayOpacity ?? 1,
        permissionPanelScale: settings.permissionPanelScale ?? 1,
        onboardingVersion: settings.onboardingVersion ?? null,
        onboardingCompletedAt: settings.onboardingCompletedAt ?? null,
        openAtLogin: settings.openAtLogin ?? false
      }
    };
  }

  function matchesStateItem(item, match = {}) {
    return Object.entries(match).every(([key, expected]) => item?.[key] === expected);
  }

  async function awaitState(payload = {}) {
    const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 15000;
    const pollMs = Number.isFinite(payload.pollMs) ? payload.pollMs : 100;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = snapshotRuntime().state;
      const items = payload.type === "approval"
        ? snapshot.approvals ?? []
        : payload.type === "notification"
          ? snapshot.notifications ?? []
          : payload.type === "ui"
            ? [snapshot.ui ?? {}]
            : snapshot.sessions ?? [];
      const found = items.find((item) => matchesStateItem(item, payload.match ?? {}));
      if (found) {
        return { ok: true, item: found };
      }
      await new Promise((resolve) => timers.setTimeout(resolve, pollMs));
    }

    throw new Error("await_state_timeout");
  }

  async function stop(reason = "stop") {
    if (stoppingPromise) {
      return stoppingPromise;
    }

    stoppingPromise = (async () => {
      app.isQuiting = true;
      performanceSampler?.stop();
      eventLoopMonitor?.stop();
      logger?.info("shutdown", "Stopping Windows shell runtime", { reason });

      if (smokeQuitTimer) {
        timers.clearTimeout(smokeQuitTimer);
        smokeQuitTimer = null;
      }

      for (const timer of utilityTimers) timers.clearTimeout(timer);
      utilityTimers.clear();
      stopClusterTopmostWatch();
      sidePanelFeed?.stop();
      shellUiState?.dispose?.();
      unregisterIpc();

      while (cleanupFns.length > 0) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch {}
      }

      globalShortcut.unregisterAll();

      if (controlServer) {
        await controlServer.stop().catch(() => {});
        controlServer = null;
      }
      // Quit order (process-split plan): hook-file work finishes, the core stops intake (pending permission requests
      // are released without a decision, routine hooks drain), the companion's children stop, then finishPersistence()
      // has the core flush state and log, with deadlines.
      if (await withDeadline(hookOperations, quitDeadlines.hooks) === TIMED_OUT) {
        logger?.warn("shutdown", "Hook-file work did not finish in time; quitting without it");
      }
      if (core?.status === "ready") {
        await core.request("stopIntake", null, { timeoutMs: quitDeadlines.intake }).catch((error) => logger?.warn("shutdown",
          "The core did not stop taking hooks in time", { error: String(error?.message ?? error) }));
      }
      // The companion stops its sessions and children, then its process exits (killed past the deadline; its job
      // ends whatever it still had running).
      try {
        const stopped = await withDeadline(companionHost?.stop({ deadlineMs: quitDeadlines.companion }), quitDeadlines.companion + 3500);
        if (stopped === TIMED_OUT) logger?.warn("shutdown", "The companion did not stop in time");
      } catch (error) {
        logger?.warn("shutdown", "The companion did not stop cleanly", { error: String(error?.message ?? error) });
      }
      mascotLibrary?.dispose?.();
      mascotWarmupPromise = null;

      for (const window of [
        overlayWindow,
        companionConversationWindow,
        companionStatusWindow,
        companionBubbleWindow,
        companionPanelWindow,
        dashboardWindow,
        diagnosticsWindow,
        mascotWindow,
        mascotPreviewWindow
      ]) {
        try {
          window?.destroy?.();
        } catch {}
      }
      overlayWindow = null;
      companionConversationWindow = null;
      companionStatusWindow = null;
      companionBubbleWindow = null;
      companionPanelWindow = null;
      dashboardWindow = null;
      diagnosticsWindow = null;
      mascotWindow = null;
      mascotPreviewWindow = null;

      try {
        tray?.destroy?.();
      } catch {}
      tray = null;

      await removeRuntimeMetadata();
      started = false;
    })().then(() => finishPersistence(!["uncaughtException", "unhandledRejection", "bootstrap-failure"].includes(reason)),
      (error) => finishPersistence(false).then(() => { throw error; }));

    return stoppingPromise;
  }

  async function finishPersistence(cleanExit) {
    const placementSaved = placementPersistence?.close() !== false;
    const drained = settingsStore ? await withDeadline(settingsStore.drain(), quitDeadlines.settings) : true;
    if (drained === TIMED_OUT) logger?.warn("persistence", "The core did not answer settings writes before quit");
    // A patch the core holds unsaved (a held file) counts once the core's final flush wrote it (review of step 4, P2).
    const heldByCore = drained === false && settingsStore?.heldByCore === true;
    // The core commits its final state, settings and log, answers, and exits (killed past its deadline). Before it
    // goes, main judges the whole quit: only a clean one has the core's storage worker remove the run marker.
    const verdict = async (result) => {
      const settingsSent = drained === true || (heldByCore && result?.settingsSaved === true);
      if (coreHost && !result) logger?.error("persistence", "The core did not confirm its final state and log flush");
      logger?.detach?.();
      // Lines main logged after the core closed its log (or while it was gone) go to the file directly, without
      // blocking main.
      const leftoversSaved = (await logger?.writeQueuedToFile?.()) !== false;
      const saved = result?.stateSaved === true && result?.logsSaved === true && result?.settingsSaved !== false;
      // A fatal exit or failed final write must remain visible on the next launch.
      return cleanExit && saved && placementSaved && settingsSent && leftoversSaved;
    };
    const result = coreHost ? await coreHost.stop({ deadlineMs: quitDeadlines.core, finalize: verdict }).catch(() => null) : null;
    if (!coreHost) await verdict(null);
    if (result && result.markedClean === false) logger?.info?.("shutdown", "This quit stays marked unclean for the next start");
    // Lines logged since the verdict (the one above, the core's goodbye) follow the same way.
    await logger?.writeQueuedToFile?.();
    process.off("exit", flushPendingOnExit);
    app.off("window-all-closed", keepRunningWithoutWindows);
  }

  function keepRunningWithoutWindows(event) {
    event?.preventDefault?.();
  }

  function flushPendingOnExit() {
    // Synchronous best effort only; abrupt exit never marks this run clean.
    placementPersistence?.flush({ retry: false, force: true });
    coreHost?.flushSync();
    // No file work can finish in an exit handler (and main does none synchronously): the console gets what is left.
    logger?.writeQueuedToConsole?.();
  }

  function showFatalError() {
    if (fatalErrorShown || runtimePaths?.testMode) return;
    fatalErrorShown = true;
    try {
      dialog?.showErrorBox?.("Chaos Cat Familiar stopped unexpectedly",
        `CCF encountered an unexpected error and needs to close. You can restart it.\n\nDetails were written to:\n${logger?.filePath ?? "the CCF log"}`);
    } catch { /* A notification failure must not interrupt crash cleanup. */ }
  }

  function installProcessHandlers() {
    // Keep this listener through asynchronous shutdown, past cleanupFns removal.
    process.on("exit", flushPendingOnExit);
    onWithCleanup(process, "uncaughtException", (error) => {
      logger?.error("process", "uncaughtException", {
        error: String(error?.stack ?? error?.message ?? error)
      });
      showFatalError();
      stop("uncaughtException").finally(() => {
        app.exit(1);
      });
    });

    onWithCleanup(process, "unhandledRejection", (error) => {
      logger?.error("process", "unhandledRejection", {
        error: String(error?.stack ?? error?.message ?? error)
      });
      showFatalError();
      stop("unhandledRejection").finally(() => {
        app.exit(1);
      });
    });

    onWithCleanup(app, "second-instance", async (_event, argv) => {
      const protocolArg = findCcfProtocolArg(argv);
      if (protocolArg) {
        await handleCcfProtocol(protocolArg);
        return;
      }
      showOverlay();
    });

    // Not removed with the other listeners: quit destroys the windows before the core's final flush, and without a
    // listener Electron would quit on its own when the last one goes, ending the core (and companion) processes.
    app.on("window-all-closed", keepRunningWithoutWindows);

    onWithCleanup(app, "before-quit", (event) => {
      if (!started || app.isQuiting) return;
      event.preventDefault();
      stop("before-quit").then(() => app.quit()).catch(() => {});
    });
  }

  async function start() {
    if (started) {
      return startedSnapshot;
    }

    try { return await startFresh(); }
    catch (error) { await stop("startup-failure"); throw error; }
  }

  // What the core process needs to know: paths, settings defaults, the port override, test mode.
  // What the companion process needs: paths, the current settings (pushed again when they change), test mode. Test
  // mode with CCF_TEST_COMPANION_FIXTURE also serves the stdio fixture route for the real-process tests.
  function companionConfig() {
    return {
      paths: { home: runtimePaths.home, root: runtimePaths.root },
      settings: currentSettings(),
      testMode: runtimePaths.testMode,
      killOnCloseJob: services.companionKillOnCloseJob ?? true,
      testFixtures: Boolean(runtimePaths.testMode && processLike.env.CCF_TEST_COMPANION_FIXTURE)
    };
  }

  function coreConfig() {
    return {
      paths: { home: runtimePaths.home, root: runtimePaths.root, settingsPath: runtimePaths.settingsPath,
        statePath: runtimePaths.statePath, dbPath: runtimePaths.dbPath, logPath: runtimePaths.logPath,
        markerPath: path.join(runtimePaths.root, "run-marker.json") },
      run: { runId, pid: processLike.pid },
      settingsDefaults: settingsDefaults({ home: runtimePaths.home, portOverride: runtimePaths.portOverride,
        appModeOverride: runtimePaths.appModeOverride }),
      preferredPort: runtimePaths.portOverride,
      testMode: runtimePaths.testMode,
      watchSettingsMs: 1000,
      logToConsole: services.coreLogToConsole ?? true
    };
  }

  function applyCoreEffect(effect) {
    switch (effect?.type) {
      case "toast": toastPresenter?.show(effect.notification); break;
      case "show-overlay":
        // Minimized to the tray in mascot mode, an approval does not bring the cat back (it cannot answer approvals
        // there, and with several sessions it would undo the minimize within minutes): the tooltip counts it, and the
        // toast still fires. In developer mode the overlay is the approval UI, so it shows. Checked when the show runs,
        // not when it arrives: a show held for the overlay's revision report must not undo a minimize in between.
        afterViewRevision("overlay", effect, () => {
          if (mascotModeEnabled() && currentSettings().overlayVisible === false) refreshTrayToolTip();
          else overlayService?.showOverlay();
        });
        break;
      case "hide-overlay": overlayService?.hideOverlay(); break;
      default: break;
    }
  }

  // Effects that target a window run once that window reported drawing the revision they belong to (process-split
  // plan, "Ordering across ports"; the overlay reports ccf:view-revision after it rendered a state). A window that has
  // never reported in this core epoch (a page from before step 5, or one still loading) is not waited for, and none is
  // waited for longer than VIEW_EFFECT_WAIT_MS.
  const viewRevisions = new Map();
  const heldViewEffects = [];
  function afterViewRevision(view, effect, apply) {
    const seen = viewRevisions.get(view);
    if (!seen || seen.epoch !== core?.epoch || seen.revision >= (effect.revision ?? 0)) { apply(); return; }
    const entry = { view, revision: effect.revision, apply, timer: null };
    entry.timer = timers.setTimeout(() => releaseViewEffect(entry, true), VIEW_EFFECT_WAIT_MS);
    heldViewEffects.push(entry);
  }

  function releaseViewEffect(entry, timedOut = false) {
    const index = heldViewEffects.indexOf(entry);
    if (index < 0) return;
    heldViewEffects.splice(index, 1);
    timers.clearTimeout(entry.timer);
    if (timedOut) logger?.debug?.("view", "A window did not report its revision in time; applying the effect", { view: entry.view });
    try { entry.apply(); } catch (error) { logger?.warn("view", "An effect failed", { error: String(error?.message ?? error) }); }
  }

  function onViewRevision(view, revision, epoch) {
    if (typeof view !== "string" || !Number.isInteger(revision)) return;
    viewRevisions.set(view, { revision, epoch });
    if (epoch !== core?.epoch) return;
    for (const entry of [...heldViewEffects]) if (entry.view === view && revision >= entry.revision) releaseViewEffect(entry);
  }

  function wireCoreHost() {
    onWithCleanup(core, "effect", applyCoreEffect);
    onWithCleanup(core, "settings", ({ value }) => {
      logger?.configure({ debugLogging: value?.debugLogging === true });
      companion?.pushSettings(value);
      // The mirror's own listener ran first (it subscribed earlier), so clusterOnTop() reads the pushed value.
      syncClusterTopmostSetting();
    });
    onWithCleanup(core, "status", (status) => { if (status === "ready") logger?.flushQueue(); });
    onWithCleanup(coreHost, "crashed", ({ code }) => logger?.warn("core", "Core process stopped; approvals are paused until it is back", { code }));
    onWithCleanup(coreHost, "restarted", (info) => {
      logger?.info("core", "Core process restarted", { pid: coreHost.pid, port: info.port, previousPort: info.previousPort });
      settingsStore?.reset(info.settings);
      syncClusterTopmostSetting();
      void writeRuntimeMetadata();
      broadcastState();
      // Windows with their own state port get a new one from the new core (a newer epoch, a fresh projection).
      void viewSubscriptions?.reopen("core");
      // A changed port (or token) is hook drift: diagnose and repair as at startup.
      void runHookOperation(bootstrapClaudeHooks);
    });
    onWithCleanup(coreHost, "failed", () => {
      if (runtimePaths?.testMode) return;
      try {
        dialog?.showErrorBox?.("Chaos Cat Familiar", "The CCF core keeps stopping, so hooks and approvals are paused. "
          + `Restart CCF to try again.\n\nLog: ${runtimePaths?.logPath ?? "the CCF log"}`);
      } catch { /* reporting must not break the shell */ }
    });
  }

  async function startFresh() {
    ensureWindows();
    runtimePaths = resolveRuntimePaths();
    registerCcfProtocolClient();
    // Main's log lines go to the core's log file; they wait in a queue until the core is up.
    logger = new MainLogger({ filePath: runtimePaths.logPath });
    logger.info("startup", "Chaos Cat Familiar starting", {
      appData: runtimePaths.appData,
      home: runtimePaths.home,
      testMode: runtimePaths.testMode
    });

    // The core first: it owns settings (and creates the hook token), the log file, the state checkpoint and the hook
    // server. It reports ready once its hook server answered an authenticated probe on its port.
    core = new CoreClient({ onError: (error, context) => logger.error("core", "Core event listener failed", {
      topic: context?.topic ?? null, error: String(error?.stack ?? error?.message ?? error) }) });
    viewSubscriptions = new ViewSubscriptions({
      open: (service, kind, options) => (service === "core" ? coreHost : companionHost).openViewPort(kind, options),
      onChange: () => { broadcastState(); },
      onError: (error, context) => logger?.[context?.pending ? "info" : "warn"]("view", context?.pending ? "A window waits for its service to start" : "A window's port could not be reopened", {
        id: context?.id ?? null, service: context?.service ?? null, error: String(error?.message ?? error) })
    });
    coreHost = createCoreHost({ electron, client: core, config: coreConfig(), services, timers, logger,
      onError: (error, context) => {
        // A message to a core that is exiting (crash, restart) is expected to fail: the restart recovers.
        const level = error?.code === "ERR_IPC_CHANNEL_CLOSED" ? "info" : "error";
        logger[level]("core", "Core channel error", {
          topic: context?.topic ?? context?.method ?? context?.send ?? null, error: String(error?.message ?? error) });
      } });
    const ready = await coreHost.start();
    coreRecovery = ready.recovery ?? null;
    logger.attach((entries) => core.sendLog(entries));
    settingsStore = new SettingsMirror({ client: core, logger, initial: ready.settings,
      peek: coreHost.peekSettings ? () => coreHost.peekSettings() : null });
    const initialSettings = settingsStore.load();
    logger.configure({ debugLogging: initialSettings.debugLogging === true });
    syncClusterTopmostSetting();
    shellUiState = new ShellUiState({
      settingsStore,
      timers
    });
    placementPersistence = new OverlayPlacementPersistence({ save: writeSettingsPatch, logger, timers });
    performanceSampler = new PerformanceSampler({ app, logger, getCounts: () => ({
      windows: BrowserWindow.getAllWindows?.().length ?? 0,
      sessions: core?.state().sessions.length ?? 0,
      pendingApprovals: core?.state().approvals.length ?? 0
    }) });
    performanceSampler.configure(initialSettings.performanceProfiling === true);
    // Its own unref'd timer, not the injected UI timers: tests count those.
    eventLoopMonitor = services.eventLoopMonitor ?? new EventLoopMonitor({ logger });
    eventLoopMonitor.start();
    mascotLibrary = services.mascotLibrary ?? new MascotLibrary({
      filePath: runtimePaths.mascotsPath,
      cacheDir: runtimePaths.mascotCacheDir,
      logger
    });
    // The companion's client and host. With fakes (tests) the backend is composed in this process at once; otherwise
    // its utility process starts when the companion is first needed (tray, launcher, conversation window, an action).
    companion = new CompanionClient();
    companionHost = createCompanionHost({ electron, client: companion, services, logger, getConfig: companionConfig,
      onSettingsPatch: (patch) => saveSettingsPatch(patch),
      // Companion delivery records live in the core's database (step 6): main relays the companion's few, small requests
      // and refuses at once while the core is not ready (the companion then blocks its sends until Start).
      onDelivery: (op, params) => (core?.status === "ready"
        ? core.request(`delivery.${op}`, params ?? null, { timeoutMs: 10000 })
        : Promise.reject(new ServiceError("The CCF core is not running, so delivery records are unavailable.", "storage_unavailable"))),
      onError: (error, context) => {
        const level = error?.code === "ERR_IPC_CHANNEL_CLOSED" ? "info" : "error";
        logger[level]("companion", "Companion channel error", {
          topic: context?.topic ?? context?.method ?? context?.send ?? null, error: String(error?.stack ?? error?.message ?? error) });
      } });
    if (companionHost.mode === "in-process") await companionHost.ensure();
    onWithCleanup(companion, "status", (status) => {
      if (status === "ready") {
        // Windows with a frames port get a new one from the new companion process.
        void viewSubscriptions?.reopen("companion");
      } else if (status === "crashed" || status === "stopped") {
        // The offline view comes from main: the frames port died with the process.
        pushCompanionToWindow();
      }
      logger.info("companion", "Companion process status", { status, mode: companionHost.mode, pid: companionHost.pid });
      // Settings that changed while it booted.
      if (status === "ready") companion.pushSettings(currentSettings());
    });
    // A test preview is shown instead of the port's frames, so the companion's own changes reach the page from main
    // while it lasts: staged images come as "projection" events, the session's as "change".
    const pushUnderPreview = (snapshot) => { if (snapshot && runtimePaths?.testMode && companionPreviewSnapshot) pushCompanionToWindow(snapshot); };
    onWithCleanup(companion, "projection", pushUnderPreview);
    onWithCleanup(companion, "change", (snapshot) => {
      if (!snapshot) return;
      pushUnderPreview(snapshot);
      if(snapshot.backend&&companionStatusBackend!==snapshot.backend){
        companionStatusBackend=snapshot.backend;companionStatus=null;
        companionStatusWindow?.webContents.send('ccf:companion-status',null);
      }
      if(snapshot.backend==='codex'){
        const tokens=snapshot.usage?.tokens,last=tokens?.last,window=tokens?.modelContextWindow;
        companionStatus={backend:'codex',session_id:snapshot.conversationId,model:{display_name:snapshot.environment?.model??currentSettings().codexModel},
          context_window:{...(Number.isFinite(window)&&window>0?{context_window_size:window}:{}),...(Number.isFinite(last?.totalTokens)?{total_input_tokens:last.totalTokens,...(window>0?{used_percentage:Math.min(100,last.totalTokens/window*100)}:{})}:{})},cost:null};
        companionStatusWindow?.webContents.send('ccf:companion-status',companionStatus);
      }
      if(snapshot.backend==='codex'){
        const stateKey=JSON.stringify([snapshot.backend,snapshot.conversationId,snapshot.connected,snapshot.phase,snapshot.pendingRequests?.length,snapshot.error]);
        if(stateKey!==lastHostedStateKey){lastHostedStateKey=stateKey;broadcastState(snapshot);}
      }
    });

    sidePanelFeed = new SidePanelFeed({ resolvePath: () => sidePanelPath(currentSettings(), runtimePaths.home), timers, logger,
      onUpdate: (snapshot) => {
        if (companionPanelWindow && !companionPanelWindow.isDestroyed?.()) companionPanelWindow.webContents.send("ccf:side-panel", snapshot);
      } });
    createWindows();
    const designReload = createDesignReload({
      rendererDir: path.join(SHELL_ROOT, "renderer"),
      enabled: (processLike.env.CCF_DESIGN_RELOAD === "1"
        || (!runtimePaths.testMode && processLike.env.CCF_DESIGN_RELOAD !== "0")),
      isPackaged: app.isPackaged,
      getWindows: () => [overlayWindow, companionConversationWindow, companionStatusWindow, companionPanelWindow,
        dashboardWindow, diagnosticsWindow, mascotWindow, mascotPreviewWindow],
      onError: (error) => logger?.warn("design-reload", "Design watcher error", { error: String(error?.message ?? error) })
    });
    cleanupFns.push(() => designReload.dispose());
    createTray();
    wireDisplayObservers();
    installProcessHandlers();

    activation = services.activation ?? new ElectronActivationService(shell, logger);
    // Main's side of the core's effects: the overlay (the "change" listener below runs broadcastState(), so
    // updateOverlay does nothing) and the native toast (the core already applied the notification preferences).
    overlayService = new ElectronOverlayService(
      () => overlayWindow,
      () => diagnosticsWindow,
      () => dashboardWindow,
      () => snapshotRuntime().state,
      { publishesOnChange: true, publish: () => broadcastState() }
    );
    toastPresenter = new ElectronNotificationService(Notification, logger, () => showOverlay(), null);
    wireCoreHost();
    core.handleIntents(companionIntents());

    // The work companion's view of a hook event: its conversation identity, a completed reply, its presentation.
    function observeForCompanion(state, event) {
      // Id first: the companion-path test reads settings and copies the companion snapshot, and running it for
      // every retained session (91 on 2026-11-05) cost ~100 file opens per hook event.
      const eventSession = event?.sessionId ? state.sessions.find((item) => item.id === event.sessionId) : null;
      // Observations reach a running companion only; they never start its process.
      const session = eventSession && companion?.status === "ready" && isWorkCompanionPath(eventSession.projectDir) ? eventSession : null;
      if(session&&event?.backend!=='codex'&&companion?.snapshot()?.backend==='claude'){
        companion.observeConversation({backend:'claude',conversationId:event.conversationId??event.sessionId})
          .catch(error=>logger.warn('companion','Claude identity recovery needs attention',{error:String(error.message)}));
      }
      if (session && event?.hookEventName === "Stop" && typeof event.lastAssistantMessage === "string") {
        companion?.recordAssistantMessage(event.lastAssistantMessage, { eventId: event.id })
          ?.catch(error=>logger.warn('companion','Assistant reply could not be recorded',{error:String(error.message)}));
      }
      if (session && companion?.snapshot()?.connected) {
        const pending = state.approvals.find((item) => item.event?.sessionId === session.id);
        companion.updatePresentation({
          phase: pending ? "attention" : session.phase === "idle" ? "idle" : "working",
          pendingPrompt: pending ? { kind: "approval", label: `${pending.event?.toolName ?? "A tool"} needs approval` } : null
        }).catch(error=>logger.warn('companion','Companion presentation could not be updated',{error:String(error.message)}));
      }
    }

    // Every event's summary arrives as a lossless observation effect, once main holds its revision (frames coalesce and
    // a resync's projection carries no summaries; review of step 5, P1).
    onWithCleanup(core, "effect", (effect) => {
      if (effect?.type === "observe" && effect.event) observeForCompanion(core.state(), effect.event);
    });
    // Main's mirror moved: its own decisions (shell UI state) and its own part of the windows' state.
    onWithCleanup(core, "state", (info) => {
      shellUiState.sync(core.state(), info?.lastEvent ?? null);
      broadcastState();
    });

    wireIpc();
    logger.info("core", "Core ready", { mode: coreHost.mode, pid: coreHost.pid, hookPort: core.hookPort });
    void writeRuntimeMetadata();
    if (runtimePaths.testMode && runtimePaths.testToken) {
      controlServer = createTestControlServer({
        token: runtimePaths.testToken,
        snapshot: async () => snapshotRuntime(undefined, await fullCoreState()),
        stop: (reason) => stop(reason).then(() => app.quit()),
        injectEvent,
        injectCompanionPreview,
        companionAction,
        dispatchCommand,
        diagnosticsSummary,
        captureOverlay: async () => (await overlayWindow.webContents.capturePage()).toPNG(),
        captureCompanion: async () => (await companionConversationWindow.webContents.capturePage()).toPNG(),
        captureCompanionStatus: async () => (await companionStatusWindow.webContents.capturePage()).toPNG(),
        captureCompanionBubble: async () => companionBubbleWindow
          ? (await companionBubbleWindow.webContents.capturePage()).toPNG() : null,
        captureCompanionPanel: async () => companionPanelWindow?.isVisible()
          ? (await companionPanelWindow.webContents.capturePage()).toPNG() : null,
        menuClick,
        captureDashboard: async () => {
          showDashboard();
          const contents = dashboardWindow.webContents;
          if (contents.isLoading()) await new Promise((resolve) => contents.once("did-finish-load", resolve));
          await new Promise((resolve) => timers.setTimeout(resolve, 700));
          return (await contents.capturePage()).toPNG();
        },
        closeDashboard: () => dashboardWindow?.close(),
        awaitState,
        logger
      });
      await controlServer.start();
    }
    void broadcastMascotLibrary();
    broadcastSettings();
    mascotWarmupPromise = Promise.resolve()
      .then(() => runtimePaths.testMode && !services.mascotLibrary ? null : mascotLibrary.warmBundledAssets?.())
      .then((warmedMascot) => {
        if (warmedMascot) {
          logger?.info("mascot", "Bundled mascot assets warmed", {
            mascotId: warmedMascot.id ?? null,
            slug: warmedMascot.slug ?? null
          });
        }
        return broadcastMascotLibrary();
      })
      .catch((error) => {
        logger?.warn("mascot", "Bundled mascot warmup failed", {
          error: String(error?.message ?? error)
        });
      });

    const initialProtocolArg = findCcfProtocolArg(processLike.argv);
    if (initialProtocolArg) {
      await handleCcfProtocol(initialProtocolArg);
    }

    if (shellUiState.snapshot().onboarding.required && shouldAutoOpenDashboardOnStartup()) {
      showDashboard();
    }

    const smokeTestMs = Number.parseInt(processLike.env.CCF_SMOKE_TEST_MS ?? "", 10);
    if (!Number.isFinite(smokeTestMs) || smokeTestMs <= 0) {
      applyStartupSettings();
      registerGlobalShortcuts();
    }
    if (settingsStore.load().showOverlayOnStartup && settingsStore.load().overlayVisible) {
      showOverlay();
    }
    if (Number.isFinite(smokeTestMs) && smokeTestMs > 0) {
      smokeQuitTimer = timers.setTimeout(() => {
        stop("smoke-timeout").finally(() => app.quit());
      }, smokeTestMs);
    }

    await writeRuntimeMetadata();
    started = true;
    startedSnapshot = snapshotRuntime();
    void runHookOperation(bootstrapClaudeHooks);
    return startedSnapshot;
  }

  return {
    start,
    stop,
    snapshot: snapshotRuntime,
    // The whole state (event history and log, asked of the core): the test control route and tests. No window gets it
    // from main (process-split plan, step 7).
    fullSnapshot: async () => snapshotRuntime(undefined, await fullCoreState()),
    diagnosticsSummary
  };
}
