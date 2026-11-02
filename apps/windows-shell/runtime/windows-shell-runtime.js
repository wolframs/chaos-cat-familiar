import fs from "node:fs";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileSettingsStore,
  FileJsonStateStore,
  HookServer,
  CcfCoreController,
  normalizeEvent,
  CompanionDeliveryStore
} from "../../../packages/core/src/index.js";
import {
  ElectronActivationService,
  ElectronHookInstallationService,
  ElectronNotificationService,
  ElectronOverlayService
} from "../services/platform-services.js";
import { deriveOverlayPlacement, clampBoundsToWorkArea } from "../services/display-placement.js";
import { MascotLibrary } from "../services/mascot-library.js";
import { hasPendingBackgroundWork } from "../services/claude-session-status.js";
import { findCcfProtocolArg, parseCcfProtocolUrl } from "../services/ccf-protocol.js";
import { detectRuntimeMode } from "../services/runtime-mode.js";
import { PerformanceSampler } from "../services/performance-sampler.js";
import { RuntimeLogger } from "../services/runtime-logger.js";
import { RuntimeRunMarker } from "../services/runtime-run-marker.js";
import { OverlayPlacementPersistence } from "../services/overlay-placement-persistence.js";
import { normalizeShellMode, overlayWindowSizeForMode } from "../services/overlay-shell-mode.js";
import { placeCompanionCluster } from "../services/companion-cluster-layout.js";
import { BUBBLE_SIZE, placeCompanionBubble } from "../services/companion-bubble-layout.js";
import { CompanionBubbles } from "../services/companion-bubbles.js";
import { CatLines, loadCatLinesCatalog } from "../services/cat-lines.js";
import { CompanionSession } from "../services/companion-session.js";
import { CodexCompanionSession } from "../services/codex-companion-session.js";
import { CompanionBackends } from "../services/companion-backends.js";
import { createProductionCompanionServices } from "../services/companion-production.js";
import { mergeHostedCompanion } from "../services/hosted-companion-state.js";
import { CodexHookInstaller } from "../services/codex-hook-installer.js";
import { CompanionAttachments, composeImageMessage } from "../services/companion-attachments.js";
import { createDesignReload } from "../services/design-reload.js";
import { fontSizeShortcut } from "../renderer/companion-text-size.js";
import { ShellUiState } from "./shell-ui-state.js";
import {
  clearCcfCacheAndLogs,
  clearCcfLocalData,
  removeIdeIntegration,
  removeCcfClaudeHooks
} from "../services/windows-cleanup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_ROOT = path.resolve(__dirname, "..");
const IPC_HANDLES = [
  "ccf:get-state",
  "ccf:get-settings",
  "ccf:get-overlay-bounds",
  "ccf:show-overlay-context-menu",
  "ccf:get-mascot-library",
  "ccf:get-log-metadata",
  "ccf:get-companion",
  "ccf:get-companion-status",
  "ccf:get-companion-bubbles",
  "ccf:companion-action",
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
  "ccf:repair-hooks"
];
const IPC_EVENTS = [
  "ccf:renderer-log",
  "ccf:set-overlay-bounds",
  "ccf:companion-bubble-dismiss",
  "ccf:companion-bubble-pointer"
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

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  dispatchCommand,
  diagnosticsSummary,
  captureOverlay,
  captureCompanion,
  captureCompanionStatus,
  captureCompanionBubble,
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
      res.end(JSON.stringify(snapshot()));
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
    if (req.method === "GET" && (req.url === "/capture-companion" || req.url === "/capture-companion-status")) {
      const png = req.url === "/capture-companion" ? await captureCompanion() : await captureCompanionStatus();
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }

    if (req.method === "GET" && req.url === "/diagnostics-summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(diagnosticsSummary()));
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
  const companionBubbles = new CompanionBubbles({ random: services.random ?? Math.random });
  let catLines; // loaded with the first event bubble
  let companionSession = null;
  let companionDelivery = null;
  let companionAttachments = null;
  let companionStatus = null;
  let companionStatusBackend = null;
  let lastHostedStateKey = null;
  let companionPreviewSnapshot = null;
  let companionHudActive = false;
  let syncingCompanionCluster = false;
  let clusterTopmostTimer = null;
  let hookServer = null;
  let controller = null;
  let settingsStore = null;
  let stateStore = null;
  let runMarker = null;
  let placementPersistence = null;
  let overlayDragSettings = null;
  let applyingOverlayBounds = false;
  let lastKnownSettings = {};
  let fatalErrorShown = false;
  let runtimePaths = null;
  let logger = null;
  let performanceSampler = null;
  let mascotLibrary = null;
  let shellUiState = null;
  let smokeQuitTimer = null;
  let controlServer = null;
  let started = false;
  let stoppingPromise = null;
  let startedSnapshot = null;
  let mascotWarmupPromise = null;
  let hookOperations = Promise.resolve();
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
    const snapshot = runtimePaths?.testMode && companionPreviewSnapshot
      ? companionPreviewSnapshot
      : changeSnapshot ?? companionSession?.getSnapshot?.() ?? null;
    return snapshot ? { ...snapshot, attachments: companionAttachments?.list() ?? [], debugUi:processLike.env.CCF_DEBUG_UI==='1'||(processLike.argv??[]).includes('--debug-ui') } : null;
  }

  function injectCompanionPreview(payload) {
    if (!runtimePaths.testMode) throw new Error("Companion preview is only available in test mode.");
    companionPreviewSnapshot = payload;
    companionHudActive = true;
    syncOverlayHudWindows();
    companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot());
  }

  function isWorkCompanionPath(value) {
    const settings=currentSettings();
    const claude=companionSession?.sessions?.claude;
    const activeClaudePath=claude?.getSnapshot().connected?claude.spec?.cwd:null;
    return typeof value==='string'&&[activeClaudePath,settings.companionRepoPath,settings.codexCompanionRepoPath,settings.companionDataPath,path.win32.resolve(runtimePaths.home,'repos','work-companion')]
      .filter(Boolean).some(candidate=>path.win32.resolve(value).toLowerCase()===path.win32.resolve(candidate).toLowerCase());
  }

  function shouldAutoOpenDashboardOnStartup() {
    return currentSettings().appShellMode === "developer";
  }

  function coreState() {
    return controller?.snapshot?.() ?? {
      approvals: [],
      sessions: [],
      notifications: [],
      events: [],
      logs: []
    };
  }

  function mascotModeEnabled(settings = currentSettings()) {
    return settings.appShellMode === "mascot";
  }

  function syncOverlayHudWindows(settings = overlayDragSettings ?? currentSettings()) {
    if (!overlayWindow) return;
    syncCompanionBubbleWindow();
    const canShow = overlayWindow.isVisible() && settings.overlayVisible !== false && mascotModeEnabled(settings);
    const bounds = overlayWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    if (!canShow || !companionHudActive) {
      companionConversationWindow?.hide();
      companionStatusWindow?.hide();
      stopClusterTopmostWatch();
    } else if (!syncingCompanionCluster) {
      syncingCompanionCluster = true;
      try {
        const placement = placeCompanionCluster({ cat: bounds, workArea: area });
        if (["x", "y", "width", "height"].some((key) => placement.cat[key] !== bounds[key])) {
          overlayWindow.setBounds(placement.cat);
          saveSettingsPatch({ overlayBounds: placement.cat, overlayDisplayId: screen.getDisplayMatching(placement.cat)?.id ?? null });
        }
        companionConversationWindow ??= createCompanionWindow("conversation");
        companionStatusWindow ??= createCompanionWindow("status");
        for (const [window, nextBounds] of [[companionConversationWindow, placement.conversation], [companionStatusWindow, placement.status]]) {
          const current = window.getBounds();
          if (["x", "y", "width", "height"].some((key) => current[key] !== nextBounds[key])) window.setBounds(nextBounds);
        }
        const revealing = !companionConversationWindow.isVisible() || !companionStatusWindow.isVisible();
        if (!companionConversationWindow.isVisible()) companionConversationWindow.showInactive();
        if (!companionStatusWindow.isVisible()) companionStatusWindow.showInactive();
        if (revealing) raiseCompanionCluster("show");
        startClusterTopmostWatch();
      } finally {
        syncingCompanionCluster = false;
      }
    }
  }

  function keepOnTop(window) {
    window.setAlwaysOnTop(true, CLUSTER_TOP_LEVEL);
  }

  function visibleClusterWindows() {
    // Cat last: each setAlwaysOnTop puts its window at the top of the topmost band.
    // The speech bubbles overlap the conversation, so they go above everything.
    return [companionStatusWindow, companionConversationWindow, overlayWindow, companionBubbleWindow]
      .filter((window) => window && !window.isDestroyed?.() && window.isVisible());
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
    warnLostTopmost(lostTopmost(windows), reason);
    for (const window of windows) keepOnTop(window);
    if (focusComposer && companionConversationWindow?.isVisible()) {
      companionConversationWindow.focus();
      companionConversationWindow.webContents.executeJavaScript?.("document.getElementById('draft')?.focus()")
        ?.catch?.(() => {});
    }
  }

  // Restores only demoted windows. Restacking on every blur would push the
  // cluster above windows the user has just raised on purpose.
  function repairClusterTopmost(reason) {
    const lost = lostTopmost(visibleClusterWindows());
    if (!lost.length) return;
    warnLostTopmost(lost, reason);
    for (const window of lost) keepOnTop(window);
  }

  function startClusterTopmostWatch() {
    if (clusterTopmostTimer !== null) return;
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

  function createCompanionWindow(kind) {
    const isConversation = kind === "conversation";
    const window = new BrowserWindow({
      width: isConversation ? 700 : 520,
      height: isConversation ? 500 : 144,
      show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true,
      title: `Chaos Cat Familiar Companion ${isConversation ? "Conversation" : "Status"}`,
      webPreferences: { preload: path.join(SHELL_ROOT, "preload.js") }
    });
    keepOnTop(window);
    wireClusterWindow(window, () => raiseCompanionCluster("panel-focus"));
    if (!isConversation) window.setIgnoreMouseEvents?.(true, { forward: true });
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
      if (isConversation) companionConversationWindow = null;
      else companionStatusWindow = null;
      window.destroy();
    });
    return window;
  }

  // The cat's speech bubbles (POST /companion/bubble from the work companion's
  // watcher). They stack until each is clicked away; the window exists only
  // while there is a bubble, and follows the cat's visibility and position.
  // An event ({event, placeholders}) gets its line from the cat's catalog (services/cat-lines.js);
  // free text is shown as sent. Text sent with an event is the fallback for an event the catalog lacks.
  function addCompanionBubble({ text = null, event = null, placeholders = null, style = null, special = null }) {
    let line = null;
    if (event) {
      line = companionCatLines()?.pick(event, placeholders ?? {}) ?? null;
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
    // The cat's visibility, not the bubble window's: a just-created window can report
    // isVisible() false right after showInactive() (2026-10-30: a bubble on screen came back shown: false).
    return { shown: Boolean(companionBubbleWindow && overlayWindow?.isVisible()),
      ...(line ? { tier: line.tier, kind: line.kind, text: line.text } : {}) };
  }

  function companionCatLines() {
    if (catLines !== undefined) return catLines;
    try {
      catLines = services.catLines ?? new CatLines({
        catalog: loadCatLinesCatalog(path.join(SHELL_ROOT, "assets", "cat-lines.json")),
        random: services.random ?? Math.random, now: services.now ?? Date.now });
    } catch (error) {
      // A broken catalog must not cost the bubble: events then fall back to the text sent along.
      logger?.error("companion-bubble", "Cat line catalog failed to load", { error: String(error?.message ?? error) });
      catLines = null;
    }
    return catLines;
  }

  function dismissCompanionBubble(id) {
    if (!companionBubbles.dismiss(id)) return;
    broadcastCompanionBubbles();
    syncCompanionBubbleWindow();
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
    const catBounds = overlayWindow.getBounds();
    const next = placeCompanionBubble({ cat: catBounds, workArea: screen.getDisplayMatching(catBounds).workArea });
    const current = companionBubbleWindow.getBounds();
    if (["x", "y", "width", "height"].some((key) => current[key] !== next[key])) companionBubbleWindow.setBounds(next);
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

  function snapshotRuntime(changeSnapshot) {
    const state = mergeHostedCompanion(coreState(),changeSnapshot??companionSession?.getSnapshot?.(),currentSettings().companionDataPath??currentSettings().companionRepoPath);
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
          onboardingCompletedAt: settings.onboardingCompletedAt ?? null
        },
        ui: shellUiState?.snapshot?.() ?? null
      },
      settings,
      runtime: {
        hookPort: hookServer?.port ?? null,
        controlPort: controlServer?.port ?? null,
        metadataPath: runtimePaths?.runtimeMetadataPath ?? null,
        logPath: logger?.filePath ?? null,
        pid: processLike.pid ?? null
      }
    };
  }

  function writeRuntimeMetadata() {
    if (!runtimePaths?.runtimeMetadataPath) {
      return;
    }
    mkdirp(path.dirname(runtimePaths.runtimeMetadataPath));
    fs.writeFileSync(runtimePaths.runtimeMetadataPath, JSON.stringify({
      pid: processLike.pid ?? null,
      hookPort: hookServer?.port ?? null,
      controlPort: controlServer?.port ?? null,
      logPath: logger?.filePath ?? null
    }, null, 2));
  }

  function removeRuntimeMetadata() {
    if (!runtimePaths?.runtimeMetadataPath || !fs.existsSync(runtimePaths.runtimeMetadataPath)) {
      return;
    }
    fs.rmSync(runtimePaths.runtimeMetadataPath, { force: true });
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

  function writeSettingsPatch(patch) {
    if (!settingsStore) {
      return;
    }
    const current = settingsStore.load();
    // Electron's move/resize event and the bounds IPC can report the same placement.
    // Read first so unrelated preferences edited outside CCF remain current.
    if (Object.keys(patch).length === 2 && Object.hasOwn(patch, "overlayBounds")
      && Object.hasOwn(patch, "overlayDisplayId") && current.overlayBounds && patch.overlayBounds
      && current.overlayDisplayId === patch.overlayDisplayId
      && ["x", "y", "width", "height"].every((key) => current.overlayBounds[key] === patch.overlayBounds[key])) {
      return;
    }
    settingsStore.save({
      ...current,
      ...patch,
      notifications: {
        ...(current.notifications ?? {}),
        ...(patch.notifications ?? {})
      },
      hotkeys: {
        ...(current.hotkeys ?? {}),
        ...(patch.hotkeys ?? {})
      }
    });
  }

  function applyOverlayPreferences() {
    const settings = currentSettings();
    overlayWindow?.setOpacity?.(Number.isFinite(settings.overlayOpacity) ? settings.overlayOpacity : 1);
    const snoozed = settings.snoozeUntil === "manual"
      || (typeof settings.snoozeUntil === "string" && !Number.isNaN(new Date(settings.snoozeUntil).getTime()) && new Date(settings.snoozeUntil).getTime() > Date.now());
    if (snoozed) {
      hideOverlayWindow();
    }
    syncOverlayHudWindows();
  }

  function broadcastState(changeSnapshot) {
    const payload = snapshotRuntime(changeSnapshot).state;
    overlayWindow?.webContents.send("ccf:state", payload);
    dashboardWindow?.webContents.send("ccf:state", payload);
    diagnosticsWindow?.webContents.send("ccf:state", payload);
    companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot(changeSnapshot));
    syncOverlayHudWindows();
  }

  function updatePersistedPort(port) {
    const current = settingsStore.load();
    if (current.port === port) {
      return current;
    }

    const merged = {
      ...current,
      port
    };
    settingsStore.save(merged);
    return merged;
  }

  async function startHookServerWithFallback(requestedPort) {
    const preferredPort = Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 49152;
    const attempts = [preferredPort, 0];
    let lastError = null;

    for (const port of attempts) {
      const candidate = new HookServer({
        controller,
        port,
        authToken: settingsStore.load().hookToken,
        onCompanionStatus: (payload) => {
          if(companionSession?.getSnapshot?.().backend==='codex'||payload.backend&&payload.backend!=='claude')return;
          if (!isWorkCompanionPath(payload.cwd ?? payload.workspace?.current_dir)) return;
          companionStatusBackend='claude';
          companionStatus = payload;
          companionStatusWindow?.webContents.send("ccf:companion-status", payload);
        },
        onCompanionBubble: (payload) => addCompanionBubble(payload),
        onCompanionOpen: async ({ backend } = {}) => {
          if (runtimePaths.testMode) throw new Error("Claude Code start is disabled in test mode.");
          if (backend && backend !== companionSession.getSnapshot().backend) companionSession.selectBackend(backend);
          if (!companionSession.getSnapshot().connected) await companionSession.start({ userInitiated: true,
            cwd: currentSettings().companionRepoPath, model: currentSettings().codexModel });
          companionHudActive = true;
          runtimePaths.appModeOverride = "mascot";
          saveSettingsPatch({ appShellMode: "mascot", overlayVisible: true });
          showOverlay();
          broadcastSettings();
          companionConversationWindow?.focus();
        }
      });

      try {
        await candidate.start();
        hookServer = candidate;
        updatePersistedPort(candidate.port);
        logger?.info("hook-server", "Hook server listening", {
          requestedPort: preferredPort,
          activePort: candidate.port,
          fallbackUsed: candidate.port !== preferredPort
        });
        writeRuntimeMetadata();
        return candidate;
      } catch (error) {
        lastError = error;
        logger?.warn("hook-server", "Hook server listen failed", {
          requestedPort: port,
          code: error.code ?? null,
          error: String(error.message ?? error)
        });
        await candidate.stop().catch(() => {});

        if (!["EADDRINUSE", "EACCES"].includes(error.code) || port === 0) {
          throw error;
        }
      }
    }

    throw lastError;
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
  }

  // Escape hatch for a cluster buried behind other windows.
  function bringCompanionToFront(reason) {
    if (!overlayWindow.isVisible()) showOverlay();
    raiseCompanionCluster(reason, { focusComposer: true });
  }

  function hideOverlayWindow() {
    overlayWindow.hide();
    companionConversationWindow?.hide();
    companionStatusWindow?.hide();
    saveSettingsPatch({ overlayVisible: false });
    refreshTrayMenu();
  }

  function broadcastMascotLibrary() {
    const payload = mascotLibrary?.list?.() ?? null;
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
      broadcastMascotLibrary();
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

  async function focusSession(session) {
    if (!session) {
      return {
        ok: false,
        reason: "no_session"
      };
    }
    return controller.activation.activateTerminal({
      projectDir: session.projectDir ?? null,
      shellPid: session.shellPid ?? null
    });
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
          if (approval) {
            controller.resolveApproval(approval.id, "allow");
            shellUiState?.sync?.(coreState());
            broadcastState();
          }
        }
      },
      {
        accelerator: hotkeys.denyTop,
        action: () => {
          const approval = topPendingApproval();
          if (approval) {
            controller.resolveApproval(approval.id, "deny");
            shellUiState?.sync?.(coreState());
            broadcastState();
          }
        }
      },
      {
        accelerator: hotkeys.deferTop,
        action: () => {
          const approval = topPendingApproval();
          if (approval) {
            controller.resolveApproval(approval.id, "defer");
            shellUiState?.sync?.(coreState());
            broadcastState();
          }
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
    onWithCleanup(tray, "click", trayAction("Toggle companion", () => {
      overlayWindow.isVisible() ? hideOverlayWindow() : openCompanionFromTray();
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
    saveSettingsPatch({ snoozeUntil: null, overlayVisible: true });
    showOverlay();
    raiseCompanionCluster("tray", { focusComposer: true });
    refreshTrayMenu();
  }

  function refreshTrayMenu() {
    if (!tray || tray.isDestroyed?.()) return;
    const mode = currentSettings().appShellMode;
    const action = (id, label, run, extra = {}) => ({ id, label, ...extra, click: trayAction(label, run) });
    tray.setContextMenu(
      Menu.buildFromTemplate([
        action("show-companion", "Show Companion", openCompanionFromTray),
        action("hide-companion", "Hide Companion", hideOverlayWindow, { enabled: Boolean(overlayWindow?.isVisible()) }),
        { type: "separator" },
        action("dashboard", "Dashboard...", () => showDashboard()),
        action("settings", "Settings...", () => showDashboard("settings")),
        action("mascots", "Mascots...", showMascotManager),
        { id: "advanced", label: "Advanced", submenu: [
          action("diagnostics", "Diagnostics...", showDiagnostics),
          action("preview", "Mascot Preview...", showMascotPreview),
          { type: "separator" },
          action("mascot-mode", "Floating Mascot", () => setAppShellMode("mascot"), { type: "radio", checked: mode === "mascot" }),
          action("developer-mode", "Developer Overlay", () => setAppShellMode("developer"), { type: "radio", checked: mode === "developer" })
        ] },
        { type: "separator" },
        action("quit", "Quit", async () => { await stop("tray-quit"); app.quit(); })
      ])
    );
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

  function wireIpc() {
    ipcMain.handle("ccf:get-state", () => snapshotRuntime().state);
    ipcMain.handle("ccf:get-settings", () => currentSettings());
    ipcMain.handle("ccf:get-companion", () => companionSnapshot());
    ipcMain.handle("ccf:get-companion-status", () => companionStatus);
    ipcMain.handle("ccf:get-companion-bubbles", () => companionBubbles.list());
    ipcMain.handle("ccf:companion-action", async (_event, payload) => {
      if (!companionSession || !payload || typeof payload !== "object") throw new Error("Companion unavailable.");
      switch (payload.action) {
        case "start":
          if (runtimePaths.testMode) throw new Error("Claude Code start is disabled in test mode.");
          await companionSession.start({ userInitiated: true, cwd: currentSettings().companionRepoPath,
            model: currentSettings().codexModel });
          return { ok: true };
        case "send": {
          const selected = companionAttachments.select(payload.attachmentIds ?? []);
          const submission = companionSession.submit
            ? await companionSession.submit({ id: payload.submissionId, text: payload.text,
              attachments: selected, draftRevision: payload.draftRevision })
            : await (async () => { await companionSession.send(composeImageMessage(payload.text, selected));
              return { state: "accepted", acceptanceBoundary: "pty-write" }; })();
          if (submission.state === "accepted") companionAttachments.markSent(selected.map((image) => image.id));
          companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot());
          return { ok: true, submission };
        }
        case "select-backend":
          if (!companionSession.selectBackend) throw new Error("Backend selection unavailable.");
          companionSession.selectBackend(payload.backend);
          return { ok: true };
        case "switch-backend":
          if (!companionSession.switchBackend) throw new Error("Backend switching unavailable.");
          await companionSession.switchBackend({ backend: payload.backend, userInitiated: payload.userInitiated === true });
          return { ok: true };
        case "resolve-request":
          return { ok: Boolean(await companionSession.resolveRequest?.({ key: payload.key, response: payload.response })) };
        case "resolve-unknown":
          companionSession.resolveUnknown?.(payload);
          return { ok: true };
        case "history":
          return { ok: true, ...await companionSession.history?.(payload) };
        case 'read-output':
          return{ok:true,output:await companionSession.getOutput({itemId:payload.itemId})};
        case "stop":
          await companionSession.stop();
          return { ok: true };
        case "end-day":
          await companionSession.stop({disposition:'day-end'});
          return {ok:true};
        case "recover-launch":
          await companionSession.recoverFailedStart({userInitiated:true,retainUnknown:payload.retainUnknown===true});
          return {ok:true};
        case "open-settings":
          showDashboard('settings');return {ok:true};
        case 'install-codex-hooks':
        case 'remove-codex-hooks': {
          const settings=currentSettings();
          if(!settings.codexAuthenticationHome||!settings.codexHookNodeExecutable)throw new Error('Configure the absolute Codex home and Node executable in companion settings first.');
          const installer=new CodexHookInstaller({codexHome:settings.codexAuthenticationHome,nodeExecutable:settings.codexHookNodeExecutable,senderPath:path.resolve(SHELL_ROOT,'../../scripts/windows/codex-hook-sender.mjs'),settingsPath:runtimePaths.settingsPath});
          const result=payload.action==='install-codex-hooks'?installer.install({userInitiated:true}):installer.remove({userInitiated:true});
          return{ok:true,...result,message:'Codex observation hooks updated. Review trust and enablement with Codex /hooks.'};
        }
        case "attach-image":
          await companionAttachments.addDataUrl({ name: payload.name, dataUrl: payload.dataUrl });
          companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot());
          return { ok: true };
        case "paste-image": {
          const image = clipboard?.readImage();
          if (!image || image.isEmpty()) throw new Error("There is no image on the clipboard.");
          await companionAttachments.addDataUrl({ name: "Screenshot.png", dataUrl: image.toDataURL() });
          companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot());
          return { ok: true };
        }
        case "pick-images": {
          const result = await dialog.showOpenDialog(companionConversationWindow, { title: "Attach images",
            properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
          try { if (!result.canceled) for (const filename of result.filePaths) await companionAttachments.addFile(filename); }
          finally { companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot()); }
          return { ok: true };
        }
        case "remove-image":
          await companionAttachments.remove(payload.id);
          companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot());
          return { ok: true };
        case "raw-input": companionSession.write(payload.text); return { ok: true };
        case "interrupt": await companionSession.interrupt(); return { ok: true };
        case "open-link": {
          // OSC 8 links from the terminal: web links in the browser, file links in their default app.
          const url = new URL(String(payload.url));
          if (url.protocol === "file:") {
            const file = fileURLToPath(url);
            if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
            const error = await shell.openPath(file);
            if (error) throw new Error(error);
          } else if (url.protocol === "http:" || url.protocol === "https:") await shell.openExternal(url.href);
          else throw new Error("Only web and file links open from the conversation.");
          return { ok: true };
        }
        case "resize":
          if (runtimePaths.testMode && companionPreviewSnapshot && !companionSession.getSnapshot().connected) return { ok: true };
          companionSession.resize(payload.cols, payload.rows);
          return { ok: true };
        default: throw new Error("Unsupported companion action.");
      }
    });
    ipcMain.handle("ccf:get-overlay-bounds", () => overlayWindow?.getBounds?.() ?? null);
    ipcMain.handle("ccf:show-overlay-context-menu", () => {
      showOverlayContextMenu();
      return true;
    });
    ipcMain.handle("ccf:get-mascot-library", () => mascotLibrary.list());
    ipcMain.handle("ccf:get-log-metadata", () => ({
      ...logger?.status(),
      performance: performanceSampler?.snapshot() ?? null,
      persistence: stateStore?.status() ?? null,
      placement: placementPersistence?.status() ?? null,
      recovery: runMarker?.status() ?? null
    }));
    ipcMain.handle("ccf:notification-action", (_event, { action, id }) => {
      switch (action) {
        case "mark-read":
          return controller.markNotificationRead(id);
        case "dismiss":
          return controller.dismissNotification(id);
        case "mark-all-read":
          return controller.markAllNotificationsRead();
        default:
          return false;
      }
    });
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
          result = await runHookOperation(() => removeCcfClaudeHooks({
            home: runtimePaths.home
          }));
          break;
        case "remove-ide-integration":
          result = removeIdeIntegration();
          break;
        case "clear-local-data":
          result = clearCcfLocalData({
            appDataRoot: runtimePaths.root,
            homeRoot: path.join(runtimePaths.home, ".chaos-cat-familiar"),
            preserveHooks: true
          });
          break;
        case "clear-cache-logs":
          result = clearCcfCacheAndLogs({
            appDataRoot: runtimePaths.root
          });
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
      const result = mascotLibrary.select(id);
      broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:install-mascot", async (_event, slug) => {
      const result = await mascotLibrary.installFromSlug(slug);
      broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:import-mascot", async (_event, { config, options }) => {
      const result = mascotLibrary.importConfig(config, options ?? {});
      broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:update-mascot", async (_event, { id, config }) => {
      const result = mascotLibrary.updateConfig(id, config);
      broadcastMascotLibrary();
      return result;
    });
    ipcMain.handle("ccf:delete-mascot", async (_event, id) => {
      const result = mascotLibrary.remove(id);
      broadcastMascotLibrary();
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
        if(!fs.statSync(selected,{throwIfNoEntry:false})?.isDirectory()||!fs.statSync(path.join(selected,'start-companion.ps1'),{throwIfNoEntry:false})?.isFile())throw new Error('Choose the companion folder containing start-companion.ps1.');
      }
      const current = settingsStore.load();
      const merged = {
        ...current,
        ...nextSettings,
        appShellMode: normalizeShellMode(nextSettings.appShellMode ?? current.appShellMode),
        notifications: {
          ...(current.notifications ?? {}),
          ...(nextSettings.notifications ?? {})
        },
        hotkeys: {
          ...(current.hotkeys ?? {}),
          ...(nextSettings.hotkeys ?? {})
        }
      };
      settingsStore.save(merged);
      if (nextSettings.appShellMode != null) runtimePaths.appModeOverride = null;
      logger.configure({ debugLogging: merged.debugLogging === true });
      performanceSampler.configure(merged.performanceProfiling === true);
      logger.info("diagnostics", "Diagnostic settings applied", {
        debugLogging: merged.debugLogging === true, performanceProfiling: merged.performanceProfiling === true
      });
      if (nextSettings.port && nextSettings.port !== current.port) {
        await hookServer.stop();
        hookServer = null;
        await startHookServerWithFallback(merged.port);
        await runHookOperation(() => controller.hookInstaller.repair());
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
      controller.persistState();
      writeRuntimeMetadata();
      broadcastState();
      return merged;
    });
    ipcMain.handle("ccf:approval-action", (_event, { id, action, payload }) => {
      if (action === "restore") {
        controller.restoreApproval(id);
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
      controller.resolveApproval(id, decision, extra);
      shellUiState?.sync?.(coreState());
      const snapshot = snapshotRuntime().state;
      broadcastState();
      return snapshot;
    });
    ipcMain.handle("ccf:activate-editor", async (_event, payload) => {
      return controller.activation.activateEditor(payload);
    });
    ipcMain.handle("ccf:activate-terminal", async (_event, payload) => {
      return controller.activation.activateTerminal(payload);
    });
    ipcMain.handle("ccf:detect-claude-runtime", async () => {
      return runHookOperation(() => controller.hookInstaller.diagnose()).then((result) => ({
        claudeProcesses: result.claudeProcesses ?? [],
        hookExists: result.hookExists,
        registeredEvents: result.registeredEvents ?? [],
        health: result.health
      }));
    });
    ipcMain.handle("ccf:diagnose-hooks", async () => runHookOperation(() => controller.hookInstaller.diagnose()));
    ipcMain.handle("ccf:install-hooks", async () => runHookOperation(() => controller.hookInstaller.install()));
    ipcMain.handle("ccf:repair-hooks", async () => runHookOperation(() => controller.hookInstaller.repair()));

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
        nextBounds = placeCompanionCluster({ cat: nextBounds, workArea: screen.getDisplayMatching(nextBounds).workArea }).cat;
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

  function runHookOperation(operation) {
    const pending = hookOperations.then(() => {
      if (stoppingPromise) return { ok: false, skipped: true, reason: "runtime-stopping" };
      return operation();
    });
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
      const diagnosis = await controller.hookInstaller.diagnose({ detailed: false });
      if (stoppingPromise) return { ok: false, skipped: true, reason: "runtime-stopping" };
      if (!diagnosis.hookExists || !diagnosis.drift?.healthy) {
        const result = diagnosis.hookExists
          ? await controller.hookInstaller.repair()
          : await controller.hookInstaller.install();
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
    const event = normalizeEvent(payload);
    if (event.hookEventName === "PermissionRequest") {
      return controller.enqueueApproval(event, () => {});
    }
    return controller.ingestEvent(event);
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

  function diagnosticsSummary() {
    const state = controller?.snapshot?.() ?? { approvals: [], sessions: [], notifications: [], events: [] };
    const settings = currentSettings();
    return {
      runtime: snapshotRuntime().runtime,
      displays: screen.getAllDisplays().map(({ id, label, bounds, workArea }) => ({ id, label, bounds, workArea })),
      processes: app.getAppMetrics?.() ?? [],
      logging: logger?.status(),
      performance: performanceSampler?.snapshot(),
      persistence: stateStore?.status(),
      placement: placementPersistence?.status(),
      recovery: runMarker?.status(),
      latestEventAt: state.events[0]?.timestamp ?? null,
      activeSessionCount: state.sessions.filter((item) => item.status === "active").length,
      pendingApprovalCount: state.approvals.length,
      unreadNotificationCount: state.notifications.filter((item) => !item.isRead).length,
      cacheStats: summarizeDirectory(runtimePaths?.mascotCacheDir),
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

  function summarizeDirectory(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return {
        exists: false,
        bytes: 0,
        files: 0
      };
    }
    let bytes = 0;
    let files = 0;
    const stack = [dirPath];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        const stat = fs.statSync(fullPath);
        files += 1;
        bytes += stat.size;
      }
    }
    return {
      exists: true,
      bytes,
      files
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
      const state = controller?.snapshot?.() ?? {};
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
      logger?.info("shutdown", "Stopping Windows shell runtime", { reason });

      if (smokeQuitTimer) {
        timers.clearTimeout(smokeQuitTimer);
        smokeQuitTimer = null;
      }

      for (const timer of utilityTimers) timers.clearTimeout(timer);
      utilityTimers.clear();
      stopClusterTopmostWatch();
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
      if (companionSession?.dispose) await companionSession.dispose();
      else await companionSession?.stop?.();
      companionSession = null;
      companionDelivery?.close();
      companionDelivery = null;
      mascotLibrary?.dispose?.();
      mascotWarmupPromise = null;
      await hookOperations;
      if (hookServer) {
        await hookServer.stop().catch(() => {});
        hookServer = null;
      }

      for (const window of [
        overlayWindow,
        companionConversationWindow,
        companionStatusWindow,
        companionBubbleWindow,
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
      dashboardWindow = null;
      diagnosticsWindow = null;
      mascotWindow = null;
      mascotPreviewWindow = null;

      try {
        tray?.destroy?.();
      } catch {}
      tray = null;

      removeRuntimeMetadata();
      started = false;
    })().then(() => {
      finishPersistence(!["uncaughtException", "unhandledRejection", "bootstrap-failure"].includes(reason));
    }, (error) => {
      finishPersistence(false);
      throw error;
    });

    return stoppingPromise;
  }

  function finishPersistence(cleanExit) {
    const placementSaved = placementPersistence?.close() !== false;
    let stateSaved = true;
    try { controller?.persistState?.(); }
    catch (error) {
      stateSaved = false;
      logger?.error("persistence", "Final state snapshot failed", { error: String(error?.message ?? error) });
    }
    try { stateSaved = stateStore?.close() !== false && stateSaved; }
    catch (error) {
      stateSaved = false;
      logger?.error("persistence", "Final state flush failed", { error: String(error?.message ?? error) });
    }
    const logsSaved = logger?.close() !== false;
    // A fatal exit or failed final write must remain visible on the next launch.
    if (cleanExit && stateSaved && logsSaved && placementSaved) runMarker?.markClean();
    process.off("exit", flushPendingOnExit);
  }

  function flushPendingOnExit() {
    // Synchronous best effort only; abrupt exit never marks this run clean.
    placementPersistence?.flush({ retry: false, force: true });
    stateStore?.flush();
    logger?.flush();
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

    onWithCleanup(app, "window-all-closed", (event) => {
      event.preventDefault();
    });

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

  async function startFresh() {
    ensureWindows();
    runtimePaths = resolveRuntimePaths();
    registerCcfProtocolClient();
    settingsStore = new FileSettingsStore(
      runtimePaths.settingsPath,
      {
        port: runtimePaths.portOverride ?? 49152,
        editorPreference: "vscode",
        overlayVisible: true,
        showOverlayOnStartup: true,
        openAtLogin: false,
        debugLogging: false,
        performanceProfiling: false,
        companionBackend: "claude",
        companionRepoPath: path.join(runtimePaths.home, "repos", "work-companion"),
        codexModel: null,
        codexAuthenticationMode: null,
        codexAuthenticationHome: null,
        codexCompanionRepoPath: null,
        companionDataPath: null,
        companionCorePath: null,
        companionPythonExecutable: null,
        codexExecutable: null,
        companionSensorsEnabled: false,
        appShellMode: runtimePaths.appModeOverride ?? "mascot",
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
      }
    );
    const initialSettings = settingsStore.load();
    if (!initialSettings.hookToken) settingsStore.save({ ...initialSettings, hookToken: randomBytes(32).toString("hex") });
    shellUiState = new ShellUiState({
      settingsStore,
      timers
    });
    logger = new RuntimeLogger({
      limit: 1000,
      filePath: runtimePaths.logPath,
      flushDelayMs: 250,
      timers
    });
    logger.configure({ debugLogging: initialSettings.debugLogging === true });
    placementPersistence = new OverlayPlacementPersistence({ save: writeSettingsPatch, logger, timers });
    runMarker = new RuntimeRunMarker({ filePath: path.join(runtimePaths.root, "run-marker.json"), pid: processLike.pid });
    const recovery = runMarker.start();
    if (recovery.previousUncleanExit) {
      logger.warn("recovery", "Previous run ended uncleanly; loading the last atomic state checkpoint. Recent buffered history may be missing.",
        { previousRun: recovery.previousRun });
    }
    if (recovery.lastError) logger.warn("recovery", "Run marker unavailable", { error: recovery.lastError });
    performanceSampler = new PerformanceSampler({ app, logger, getCounts: () => ({
      windows: BrowserWindow.getAllWindows?.().length ?? 0,
      sessions: controller?.sessions?.sessions?.length ?? 0,
      pendingApprovals: controller?.approvals?.pending?.length ?? 0
    }) });
    performanceSampler.configure(initialSettings.performanceProfiling === true);
    logger.info("startup", "Chaos Cat Familiar starting", {
      appData: runtimePaths.appData,
      home: runtimePaths.home,
      testMode: runtimePaths.testMode
    });
    mascotLibrary = services.mascotLibrary ?? new MascotLibrary({
      filePath: runtimePaths.mascotsPath,
      cacheDir: runtimePaths.mascotCacheDir,
      logger
    });
    if (services.companionSession) {companionSession = services.companionSession;companionDelivery=services.companionDelivery??null;}
    else {
      // Codex delivery state must never keep CCF (or Claude) from starting.
      try { companionDelivery = new CompanionDeliveryStore({ filePath: path.join(runtimePaths.root, "companion-delivery.json") }); }
      catch (error) { companionDelivery = null; logger.error("companion", "Codex delivery state is unreadable; Codex sends stay off until it is repaired", { error: String(error.message) }); }
      const production=createProductionCompanionServices({getSettings:currentSettings,home:runtimePaths.home,appData:runtimePaths.root,parentEnv:processLike.env});
      companionSession = new CompanionBackends({
        claude: new CompanionSession({ repoPath: initialSettings.companionRepoPath }),
        codex: services.codexCompanionSession ?? production.codex,
        habitat:services.companionHabitat??production.habitat,
        backend: initialSettings.companionBackend === "codex" ? "codex" : "claude", delivery: companionDelivery,
        onSelect: (backend) => saveSettingsPatch({ companionBackend: backend })
      });
      companionSession.watcher=production.createWatcher({delivery:companionDelivery,backend:companionSession});
      companionSession.watcher?.on('change',()=>companionConversationWindow?.webContents.send('ccf:companion',companionSnapshot()));
      companionSession.watcher?.on('fault',error=>logger.warn('companion','Watcher needs attention',{error:String(error.message)}));
      production.habitat.on('fault',error=>logger.warn('companion','Habitat connection needs attention',{error:String(error.message)}));
    }
    companionAttachments = services.companionAttachments ?? new CompanionAttachments({
      directory: path.join(runtimePaths.root, "companion-attachments"),
      isPinned: (id) => companionDelivery?.snapshot().submissions.some(record =>
        ["pending", "outcomeUnknown"].includes(record.state) && record.attachments?.some(image => image.id === id)) ?? false
    });
    if (companionDelivery) {
      const unresolved=companionSession.getSnapshot().submission;
      if (unresolved?.state === "outcomeUnknown" && unresolved.attachments?.length) {
        try { await companionAttachments.restore(unresolved.attachments); }
        catch(error) { logger.error("companion", "Uncertain attachment recovery needs attention; original evidence retained", {error:String(error.message)}); }
      }
    }
    onWithCleanup(companionSession, "change", (snapshot) => {
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
      companionConversationWindow?.webContents.send("ccf:companion", companionSnapshot(snapshot));
      if(snapshot.backend==='codex'){
        const stateKey=JSON.stringify([snapshot.backend,snapshot.conversationId,snapshot.connected,snapshot.phase,snapshot.pendingRequests?.length,snapshot.error]);
        if(stateKey!==lastHostedStateKey){lastHostedStateKey=stateKey;broadcastState(snapshot);}
      }
    });

    createWindows();
    const designReload = createDesignReload({
      rendererDir: path.join(SHELL_ROOT, "renderer"),
      enabled: (processLike.env.CCF_DESIGN_RELOAD === "1"
        || (!runtimePaths.testMode && processLike.env.CCF_DESIGN_RELOAD !== "0")),
      isPackaged: app.isPackaged,
      getWindows: () => [overlayWindow, companionConversationWindow, companionStatusWindow,
        dashboardWindow, diagnosticsWindow, mascotWindow, mascotPreviewWindow],
      onError: (error) => logger?.warn("design-reload", "Design watcher error", { error: String(error?.message ?? error) })
    });
    cleanupFns.push(() => designReload.dispose());
    createTray();
    wireDisplayObservers();
    installProcessHandlers();

    const hookInstaller = services.hookInstaller ?? new ElectronHookInstallationService(
      {
        getHomePath: () => runtimePaths.home,
        notificationsSupported: () => Notification.isSupported(),
        getLoginItemSettings: () => app.getLoginItemSettings(),
        runtimeMode: () => runtimeMode()
      },
      settingsStore,
      logger
    );

    stateStore = new FileJsonStateStore(runtimePaths.statePath, {
      events: [], notifications: [], sessions: [], settings: settingsStore.load()
    // state.json is ~1 MB pretty-printed and fsync'd per flush: checkpoint at most every 2 s.
    // stop() drains the hook server and finishPersistence() flushes; process exit flushes too.
    }, { flushDelayMs: 2000, timers, logger,
      onError: (error) => logger.error("persistence", "State checkpoint failed; latest state remains in memory", {
        error: String(error?.message ?? error)
      })
    });
    controller = new CcfCoreController({
      overlay: new ElectronOverlayService(
        () => overlayWindow,
        () => diagnosticsWindow,
        () => dashboardWindow,
        () => snapshotRuntime().state
      ),
      notifier: new ElectronNotificationService(
        Notification,
        logger,
        () => showOverlay(),
        () => runtimePaths.testMode
          ? { ...settingsStore.load().notifications, enabled: false }
          : settingsStore.load().notifications,
        { hasPendingBackgroundWork: services.hasPendingBackgroundWork ?? hasPendingBackgroundWork }
      ),
      stateStore,
      settings: settingsStore,
      activation: services.activation ?? new ElectronActivationService(shell, logger),
      terminalLocator: services.terminalLocator ?? {},
      hookInstaller,
      logger
    });

    onWithCleanup(controller, "change", (state, event) => {
      const session = state.sessions.find((item) => isWorkCompanionPath(item.projectDir)
        && item.id === event?.sessionId);
      if(session&&event?.backend!=='codex'&&companionSession?.getSnapshot?.().backend==='claude'){
        try{companionSession.observeConversation?.({backend:'claude',conversationId:event.conversationId??event.sessionId});}
        catch(error){logger.warn('companion','Claude identity recovery needs attention',{error:String(error.message)});}
      }
      if (session && event?.hookEventName === "Stop" && typeof event.lastAssistantMessage === "string") {
        companionSession?.recordAssistantMessage?.(event.lastAssistantMessage, { eventId: event.id });
      }
      if (session && companionSession?.getSnapshot?.().connected) {
        const pending = state.approvals.find((item) => item.event?.sessionId === session.id);
        companionSession.updatePresentation?.({
          phase: pending ? "attention" : session.phase === "idle" ? "idle" : "working",
          pendingPrompt: pending ? { kind: "approval", label: `${pending.event?.toolName ?? "A tool"} needs approval` } : null
        });
      }
      shellUiState.sync(state, event);
      broadcastState();
    });

    wireIpc();
    await startHookServerWithFallback(runtimePaths.portOverride ?? settingsStore.load().port);
    if (runtimePaths.testMode && runtimePaths.testToken) {
      controlServer = createTestControlServer({
        token: runtimePaths.testToken,
        snapshot: snapshotRuntime,
        stop: (reason) => stop(reason).then(() => app.quit()),
        injectEvent,
        injectCompanionPreview,
        dispatchCommand,
        diagnosticsSummary,
        captureOverlay: async () => (await overlayWindow.webContents.capturePage()).toPNG(),
        captureCompanion: async () => (await companionConversationWindow.webContents.capturePage()).toPNG(),
        captureCompanionStatus: async () => (await companionStatusWindow.webContents.capturePage()).toPNG(),
        captureCompanionBubble: async () => companionBubbleWindow
          ? (await companionBubbleWindow.webContents.capturePage()).toPNG() : null,
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
      writeRuntimeMetadata();
    }
    broadcastMascotLibrary();
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
        broadcastMascotLibrary();
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

    writeRuntimeMetadata();
    started = true;
    startedSnapshot = snapshotRuntime();
    void runHookOperation(bootstrapClaudeHooks);
    return startedSnapshot;
  }

  return {
    start,
    stop,
    snapshot: snapshotRuntime
  };
}
