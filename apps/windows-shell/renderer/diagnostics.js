import { subscribeCoreState } from "./view-subscription.js";
import { composeLegacyState } from "./legacy-state.js";

const stateEl = document.getElementById("state");
const logsEl = document.getElementById("logs");
const supportTiersEl = document.getElementById("supportTiers");
const desktopIntegrationEl = document.getElementById("desktopIntegration");
const hookHealthEl = document.getElementById("hookHealth");
const runningWindowsEl = document.getElementById("runningWindows");
const activationAttemptsEl = document.getElementById("activationAttempts");
const portInput = document.getElementById("port");
const editorPreference = document.getElementById("editorPreference");
const appShellMode = document.getElementById("appShellMode");
const openAtLogin = document.getElementById("openAtLogin");
const showOverlayOnStartup = document.getElementById("showOverlayOnStartup");
const overlayDisplayMode = document.getElementById("overlayDisplayMode");
const notificationsEnabled = document.getElementById("notificationsEnabled");
const notificationPriority = document.getElementById("notificationPriority");
const toggleOverlayHotkey = document.getElementById("toggleOverlayHotkey");
const openDiagnosticsHotkey = document.getElementById("openDiagnosticsHotkey");
const approveTopHotkey = document.getElementById("approveTopHotkey");
const denyTopHotkey = document.getElementById("denyTopHotkey");
const deferTopHotkey = document.getElementById("deferTopHotkey");
const saveSettings = document.getElementById("saveSettings");
const diagnoseButton = document.getElementById("diagnose");
const installHooks = document.getElementById("installHooks");
const repairHooks = document.getElementById("repairHooks");
const mascotSlug = document.getElementById("mascotSlug");
const installMascot = document.getElementById("installMascot");
const mascotStatus = document.getElementById("mascotStatus");
const mascotLibraryEl = document.getElementById("mascotLibrary");

let latestMascotLibrary = null;
let logMetadata = null;

// Process-split plan, step 5: with a port of its own, diagnostics takes the core's base state from it while visible,
// and the expensive reads (hook diagnosis, settings, mascots, log metadata) and the log run on demand: when the window
// opens, on its buttons and after a hook install, no longer on every hook event. New log lines are fetched at most
// once a second while the window shows. Main sends no state of its own (step 7).
const LOG_LIMIT = 200;
let coreState = null;
let shellState = null;
let onDemand = null;          // { diagnostics, settings, mascotLibrary } from the last full render
let logs = [];
let logId = null;
let logTimer = null;
const live = subscribeCoreState({ topics: ["base"], whileVisible: true,
  onState: (value) => { coreState = value; renderLive(); } });
window.ccf.onShellState((value) => { shellState = value; renderLive(); });
window.ccf.getShellState().then((value) => { shellState ??= value; renderLive(); }).catch(() => {});

function livePayload() {
  const core = coreState ?? { sessions: [], approvals: [], notifications: [], events: [], logs: [] };
  return { state: { ...composeLegacyState(core, shellState, live?.mirror), logs }, ...onDemand };
}

function renderLive() {
  if (!onDemand) return;   // the first full render has not finished
  if ((coreState?.summary?.latestLogId ?? null) !== logId) scheduleLogs();
  renderPayload(livePayload());
}

async function loadLogs() {
  if (!live) return;
  const result = await live.query("logs", { limit: LOG_LIMIT });
  logs = result.logs ?? [];
  logId = logs[0]?.id ?? null;
}

function scheduleLogs() {
  if (logTimer !== null) return;
  logTimer = setTimeout(async () => {
    logTimer = null;
    try { await loadLogs(); if (onDemand) renderPayload(livePayload()); } catch { /* hidden or reconnecting */ }
  }, 1000);
}

function logUi(level, message, context = {}) {
  window.ccf?.log?.({
    level,
    category: "diagnostics-ui",
    message,
    context
  });
}

async function render() {
  const [diagnostics, settings, mascotLibrary, nextLogMetadata] = await Promise.all([
    window.ccf.diagnoseHooks(),
    window.ccf.getSettings(),
    window.ccf.getMascotLibrary(),
    window.ccf.getLogMetadata()
  ]);
  latestMascotLibrary = mascotLibrary;
  logMetadata = nextLogMetadata;

  portInput.value = settings.port;
  editorPreference.value = settings.editorPreference;
  appShellMode.value = settings.appShellMode ?? "developer";
  openAtLogin.value = String(Boolean(settings.openAtLogin));
  showOverlayOnStartup.value = String(settings.showOverlayOnStartup ?? true);
  overlayDisplayMode.value = settings.overlayDisplayMode ?? "remember";
  notificationsEnabled.value = String(settings.notifications?.enabled ?? true);
  notificationPriority.value = settings.notifications?.minPriority ?? "high";
  toggleOverlayHotkey.value = settings.hotkeys?.toggleOverlay ?? "";
  openDiagnosticsHotkey.value = settings.hotkeys?.openDiagnostics ?? "";
  approveTopHotkey.value = settings.hotkeys?.approveTop ?? "";
  denyTopHotkey.value = settings.hotkeys?.denyTop ?? "";
  deferTopHotkey.value = settings.hotkeys?.deferTop ?? "";
  onDemand = { diagnostics, settings, mascotLibrary };
  try { await loadLogs(); } catch { /* the port is not there yet: the first state fetches the log */ }
  renderPayload(livePayload());
}

function renderPayload(payload) {
  stateEl.textContent = JSON.stringify(payload, null, 2);
  logsEl.textContent = JSON.stringify(payload.state.logs ?? [], null, 2);
  const supportedNow = payload.diagnostics.supportTiers?.supportedNow ?? [];
  const limited = payload.diagnostics.supportTiers?.detectedButLimited ?? [];
  supportTiersEl.innerHTML = `
    <strong>Supported now</strong>
    <ul>${supportedNow.map((item) => `<li>${item}</li>`).join("")}</ul>
    <strong style="display:block;margin-top:12px;">Detected but limited</strong>
    <ul>${limited.map((item) => `<li>${item}</li>`).join("")}</ul>
  `;
  desktopIntegrationEl.innerHTML = `
    <div><strong>Native notifications:</strong> ${payload.diagnostics.desktop?.notificationsSupported ? "supported" : "not supported"}</div>
    <div><strong>Startup at login:</strong> ${payload.diagnostics.desktop?.openAtLogin ? "enabled" : "disabled"}</div>
    <div><strong>App shell mode:</strong> ${payload.settings.appShellMode ?? "developer"}</div>
    <div><strong>Runtime mode:</strong> ${payload.diagnostics.desktop?.runtimeMode?.mode ?? "unknown"}</div>
    <div><strong>Packaged build:</strong> ${payload.diagnostics.desktop?.runtimeMode?.isPackaged ? "yes" : "no"}</div>
    <div><strong>Log file:</strong> ${logMetadata?.filePath ?? "not configured"}</div>
    <div><strong>Startup overlay:</strong> ${payload.settings.showOverlayOnStartup ? "show overlay" : "tray only"}</div>
    <div><strong>Overlay monitor:</strong> ${payload.settings.overlayDisplayMode ?? "remember"}</div>
    <div><strong>Overlay display id:</strong> ${payload.settings.overlayDisplayId ?? "unknown"}</div>
    <div><strong>Registered hotkeys</strong></div>
    <ul>${Object.entries(payload.settings.hotkeys ?? {}).map(([key, value]) => `<li>${key}: ${value}</li>`).join("")}</ul>
  `;

  const drift = payload.diagnostics.drift ?? { healthy: false, missingEvents: [], unexpectedCommands: [] };
  hookHealthEl.innerHTML = `
    <div><strong>Server health:</strong> ${payload.diagnostics.health?.ok ? "healthy" : "unreachable"}</div>
    <div><strong>Hook config:</strong> ${drift.healthy ? "clean" : "drift detected"}</div>
    <div style="margin-top:8px;"><strong>Missing events</strong>
      <ul>${(drift.missingEvents ?? []).map((item) => `<li>${item}</li>`).join("") || "<li>None</li>"}</ul>
    </div>
    <div style="margin-top:8px;"><strong>Mismatched commands</strong>
      <ul>${(drift.unexpectedCommands ?? []).map((item) => `<li>${item.eventName}: ${item.commands.join(", ")}</li>`).join("") || "<li>None</li>"}</ul>
    </div>
  `;

  const windows = payload.diagnostics.runningWindows ?? {};
  runningWindowsEl.innerHTML = Object.entries(windows).map(([key, value]) => `
    <div style="margin-bottom:10px;">
      <strong>${key}</strong>
      <ul>${value.map((item) => `<li>${item.processName} (${item.id})${item.mainWindowTitle ? `: ${item.mainWindowTitle}` : ""}${typeof item.matchScore === "number" ? ` [score ${item.matchScore}]` : ""}${Array.isArray(item.matchReasons) && item.matchReasons.length > 0 ? ` [${item.matchReasons.join(", ")}]` : ""}</li>`).join("") || "<li>None</li>"}</ul>
    </div>
  `).join("");

  const activationLogs = (payload.state.logs ?? []).filter((entry) => entry.category === "activation").slice(0, 12);
  activationAttemptsEl.innerHTML = activationLogs.length > 0
    ? `<ul>${activationLogs.map((entry) => `<li>${entry.level}: ${entry.message}${entry.context?.windows ? ` -> ${entry.context.windows.map((item) => `${item.title || item.pid} [${item.score}]`).join(" | ")}` : ""}</li>`).join("")}</ul>`
    : "No activation attempts yet.";

  renderMascotLibrary(payload.mascotLibrary);
}

function renderMascotLibrary(library) {
  latestMascotLibrary = library;
  const mascots = library?.mascots ?? [];
  mascotLibraryEl.innerHTML = mascots.map((mascot) => `
    <article class="mascot-card">
      ${mascot.config?.nodes?.[0]?.transparentThumbnailUrl ? `<img src="${mascot.config.nodes[0].transparentThumbnailUrl}" alt="${mascot.name}" />` : ""}
      <div style="margin-top:10px;"><strong>${mascot.name}</strong></div>
      <div class="mascot-meta">${mascot.slug ? `slug: ${mascot.slug}` : "bundled default"}<br />source: ${mascot.source}</div>
      <div class="actions" style="margin-top:10px;">
        <button class="${library.currentMascotId === mascot.id ? "primary" : "secondary"}" data-mascot-id="${mascot.id}">
          ${library.currentMascotId === mascot.id ? "Active" : "Use mascot"}
        </button>
      </div>
    </article>
  `).join("") || "<div>No mascots installed yet.</div>";

  mascotLibraryEl.querySelectorAll("[data-mascot-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await window.ccf.selectMascot(button.dataset.mascotId);
      mascotStatus.textContent = result.ok ? `Selected ${result.mascot.name}.` : "Could not select mascot.";
      await render();
    });
  });
}

window.ccf.onHookInstallResult(async () => {
  await render();
});


saveSettings.addEventListener("click", async () => {
  await window.ccf.updateSettings({
    port: Number(portInput.value),
    editorPreference: editorPreference.value,
    appShellMode: appShellMode.value,
    openAtLogin: openAtLogin.value === "true",
    showOverlayOnStartup: showOverlayOnStartup.value === "true",
    overlayDisplayMode: overlayDisplayMode.value,
    notifications: {
      enabled: notificationsEnabled.value === "true",
      minPriority: notificationPriority.value
    },
    hotkeys: {
      toggleOverlay: toggleOverlayHotkey.value.trim(),
      openDiagnostics: openDiagnosticsHotkey.value.trim(),
      approveTop: approveTopHotkey.value.trim(),
      denyTop: denyTopHotkey.value.trim(),
      deferTop: deferTopHotkey.value.trim()
    }
  });
  await render();
});

diagnoseButton.addEventListener("click", render);
installHooks.addEventListener("click", async () => {
  logUi("info", "Install hooks clicked");
  await window.ccf.installHooks();
  await render();
});
repairHooks.addEventListener("click", async () => {
  logUi("info", "Repair hooks clicked");
  await window.ccf.repairHooks();
  await render();
});

installMascot.addEventListener("click", async () => {
  const slug = mascotSlug.value.trim();
  if (!slug) {
    mascotStatus.textContent = "Enter a mascot slug first.";
    return;
  }
  mascotStatus.textContent = `Installing ${slug}...`;
  const result = await window.ccf.installMascot(slug);
  if (result.ok) {
    mascotStatus.textContent = result.action === "selected_existing"
      ? `Selected existing mascot ${result.mascot.name}.`
      : `Installed ${result.mascot.name}.`;
    mascotSlug.value = "";
  } else {
    mascotStatus.textContent = `Install failed: ${result.error}${result.status ? ` (${result.status})` : ""}`;
  }
  await render();
});

window.ccf.onMascotLibrary((value) => {
  renderMascotLibrary(value);
});



render().catch((error) => {
  logUi("error", "Initial diagnostics render failed", {
    error: String(error?.message ?? error)
  });
});
