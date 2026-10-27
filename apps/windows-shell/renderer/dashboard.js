import { sessionActivationTarget } from "./session-activation.js";
import { dashboardApprovalSubmission } from "./dashboard-approval-input.js";

const nav = document.getElementById("nav");
const summary = document.getElementById("summary");
const viewTitle = document.getElementById("viewTitle");
const viewSubtitle = document.getElementById("viewSubtitle");
const viewToolbar = document.getElementById("viewToolbar");
const viewBody = document.getElementById("viewBody");
const openDiagnostics = document.getElementById("openDiagnostics");
const rerunOnboarding = document.getElementById("rerunOnboarding");
const onboarding = document.getElementById("onboarding");
const onboardingStepLabel = document.getElementById("onboardingStepLabel");
const onboardingTitle = document.getElementById("onboardingTitle");
const onboardingBody = document.getElementById("onboardingBody");
const onboardingActions = document.getElementById("onboardingActions");
const onboardingDots = document.getElementById("onboardingDots");

const sections = [
  ["activity", "Activity", "Live activity feed and ingestion status."],
  ["notifications", "Notifications", "Unread and archived notices."],
  ["sessions", "Sessions", "Live workspaces and focus actions."],
  ["approvals", "Approvals", "Pending and resolved approval state."],
  ["mascots", "Mascots", "Installed mascots and imports."],
  ["settings", "Settings", "Hook setup and cleanup."]
];

const onboardingSteps = [
  "Chaos Cat Familiar keeps your Claude Code sessions close to your work, and lets you answer approvals without bringing the terminal forward.",
  "Install or repair the Claude Code hooks from Settings.",
  "Choose overlay visibility, startup behavior, and notification readiness before the first long-running session.",
  "Floating mode uses Ctrl+Shift+Space for the overlay, Ctrl+Shift+O for the dashboard and Ctrl+Shift+D for diagnostics.",
  "Check detected editors, exact-tab focus support, and install readiness for Windows integration.",
  "Pick a mascot, then decide whether you want mascot mode or the richer developer overlay.",
  "The dashboard is now your durable home for approvals, notifications, settings, and onboarding resets."
];
const onboardingTitles = [
  "Welcome",
  "Hook Health",
  "Overlay Readiness",
  "Keyboard Shortcuts",
  "IDE Integration",
  "Settings",
  "You're Ready"
];

let state = null;
let settings = null;
let mascotLibrary = null;
let diagnostics = null;
let logMetadata = null;
let currentSection = "activity";
let notificationFilter = "all";
let activityFilter = "all";
let activitySearch = "";
let receivedInitialState = false;
const approvalDrafts = new Map();
const expandedApprovals = new Set();
let lastApprovalsSignature = null;

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function ago(dateValue) {
  if (!dateValue) return "now";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateValue).getTime()) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function badge(text, kind = "") {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function card(title, body, meta = [], actions = "", selected = false) {
  return `
    <article class="ccf-card item ${selected ? "selected" : ""}">
      <div class="item-head">
        <div class="item-copy">
          <strong>${esc(title)}</strong>
          ${body ? `<div class="muted">${esc(body)}</div>` : ""}
          ${meta.length ? `<div class="item-meta">${meta.join("")}</div>` : ""}
        </div>
      </div>
      ${actions ? `<div class="card-actions">${actions}</div>` : ""}
    </article>
  `;
}

function empty(title, body, action = "") {
  return `<section class="empty-state"><strong>${esc(title)}</strong><div class="muted">${esc(body)}</div>${action}</section>`;
}

function sectionMeta(id) {
  const item = sections.find(([sectionId]) => sectionId === id);
  return { label: item?.[1] ?? "Dashboard", description: item?.[2] ?? "" };
}

function countFor(sectionId) {
  if (!state) return "";
  if (sectionId === "notifications") return String(state.meta?.unreadNotificationCount ?? state.notificationSummary?.unreadCount ?? 0);
  if (sectionId === "approvals") return String(state.approvals?.length ?? 0);
  if (sectionId === "sessions") return String((state.sessions ?? []).filter((item) => item.status === "active").length);
  if (sectionId === "mascots") return String(mascotLibrary?.mascots?.length ?? 0);
  return "";
}

function renderNav() {
  nav.innerHTML = sections.map(([id, label, description]) => `
    <button class="nav-button ${id === currentSection ? "active" : ""}" data-section="${id}">
      <span class="nav-copy"><strong>${label}</strong><span>${description}</span></span>
      ${countFor(id) ? `<span class="nav-count">${countFor(id)}</span>` : ""}
    </button>
  `).join("");
  nav.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      currentSection = button.dataset.section;
      renderNav();
      renderView();
    });
  });
}

function renderSummary() {
  const activeSessions = (state?.sessions ?? []).filter((item) => item.status === "active").length;
  const pendingApprovals = state?.approvals?.length ?? 0;
  const unread = state?.meta?.unreadNotificationCount ?? state?.notificationSummary?.unreadCount ?? 0;
  const mascots = mascotLibrary?.mascots?.length ?? 0;
  summary.innerHTML = [
    ["Active Sessions", activeSessions, activeSessions === 1 ? "1 workspace is live" : "Running assistant workspaces"],
    ["Pending Approvals", pendingApprovals, pendingApprovals ? "Urgent overlay work is waiting" : "No approval debt right now"],
    ["Unread Notifications", unread, unread ? "Attention items in the center" : "All notifications reviewed"],
    ["Mascots", mascots, settings?.appShellMode === "mascot" ? "Mascot shell is active" : "Developer shell is active"]
  ].map(([label, value, detail]) => `<article class="ccf-card summary-card"><span class="muted">${label}</span><strong>${value}</strong><div class="muted">${detail}</div></article>`).join("");
}

function setSection(id, toolbar = "") {
  if (id !== "approvals") lastApprovalsSignature = null;
  const meta = sectionMeta(id);
  viewTitle.textContent = meta.label;
  viewSubtitle.textContent = meta.description;
  viewToolbar.innerHTML = toolbar;
}

function renderActivity() {
  const events = (state?.events ?? []).filter((item) => {
    const typeMatch = activityFilter === "all" || (item.hookEventName ?? "") === activityFilter;
    const textMatch = !activitySearch || JSON.stringify(item).toLowerCase().includes(activitySearch.toLowerCase());
    return typeMatch && textMatch;
  }).slice(0, 40);
  setSection("activity", `
    <div class="search-row">
      <input class="ccf-input" id="activitySearch" placeholder="Search events, tools, paths, or session ids" value="${esc(activitySearch)}" />
      <select class="ccf-select" id="activityFilter">
        <option value="all">All events</option>
        <option value="SessionStart">Session starts</option>
        <option value="PermissionRequest">Permission requests</option>
        <option value="AskUserQuestion">Questions</option>
        <option value="Stop">Completed</option>
      </select>
      <div class="ccf-chip accent">${diagnostics?.drift?.healthy ? "Live ingestion healthy" : "Hook health needs attention"}</div>
    </div>
  `);
  viewToolbar.querySelector("#activityFilter").value = activityFilter;
  viewToolbar.querySelector("#activitySearch").addEventListener("input", (event) => { activitySearch = event.target.value; renderActivity(); });
  viewToolbar.querySelector("#activityFilter").addEventListener("change", (event) => { activityFilter = event.target.value; renderActivity(); });
  viewBody.innerHTML = events.length ? events.map((item) => card(
    item.hookEventName ?? "Event",
    item.message ?? item.cwd ?? item.projectDir ?? item.sessionId ?? "Runtime event",
    [item.toolName ? badge(item.toolName) : "", item.timestamp ? `<span class="ccf-chip">${ago(item.timestamp)}</span>` : ""].filter(Boolean)
  )).join("") : empty("No matching activity", "Adjust the filter or wait for a new assistant event.");
}

function renderNotifications() {
  const all = state?.notifications ?? [];
  const items = all.filter((item) => notificationFilter === "unread" ? !item.isRead : notificationFilter === "approval-history" ? item.category === "permission_request" : true);
  setSection("notifications", `
    <div class="split-actions">
      <select class="ccf-select" id="notificationFilter">
        <option value="all">All notifications</option>
        <option value="unread">Unread only</option>
        <option value="approval-history">Approval history</option>
      </select>
      <button class="ccf-button" id="markAllRead">Mark All Read</button>
    </div>
  `);
  viewToolbar.querySelector("#notificationFilter").value = notificationFilter;
  viewToolbar.querySelector("#notificationFilter").addEventListener("change", (event) => { notificationFilter = event.target.value; renderNotifications(); });
  viewToolbar.querySelector("#markAllRead").addEventListener("click", async () => { await window.ccf.notificationAction({ action: "mark-all-read" }); await refresh(); });
  viewBody.innerHTML = items.length ? items.map((item) => card(
    item.title ?? "Notification",
    item.body ?? "Runtime notification",
    [badge(item.isRead ? "Read" : "Unread", item.isRead ? "neutral" : "success"), badge(item.category ?? "general", item.category === "permission_request" ? "warn" : "neutral"), item.resolutionOutcome ? badge(item.resolutionOutcome, item.resolutionOutcome === "allowed" ? "success" : item.resolutionOutcome === "denied" ? "danger" : "neutral") : "", item.createdAt ? `<span class="ccf-chip">${ago(item.createdAt)}</span>` : ""].filter(Boolean),
    `<button class="ccf-button" data-mark-read="${item.id}">Mark Read</button><button class="ccf-button" data-dismiss="${item.id}">Dismiss</button>`,
    !item.isRead
  )).join("") : empty("Notification center is quiet", "Unread dots and history will appear here as the runtime records events.");
  viewBody.querySelectorAll("[data-mark-read]").forEach((button) => button.addEventListener("click", async () => { await window.ccf.notificationAction({ action: "mark-read", id: button.dataset.markRead }); await refresh(); }));
  viewBody.querySelectorAll("[data-dismiss]").forEach((button) => button.addEventListener("click", async () => { await window.ccf.notificationAction({ action: "dismiss", id: button.dataset.dismiss }); await refresh(); }));
}

function renderSessions() {
  const sessions = [...(state?.sessions ?? [])].sort((left, right) => ((left.status === "active") === (right.status === "active")) ? new Date(right.lastEventAt ?? right.startedAt ?? 0) - new Date(left.lastEventAt ?? left.startedAt ?? 0) : left.status === "active" ? -1 : 1);
  setSection("sessions", `<div class="ccf-chip accent">${sessions.filter((item) => item.status === "active").length} active</div>`);
  viewBody.innerHTML = sessions.length ? sessions.map((item) => card(
    item.projectName ?? item.projectDir ?? item.id,
    `${item.assistantLabel ?? "Assistant"} in ${item.phase ?? "idle"} phase · ${item.id}`,
    [badge(item.status ?? "unknown", item.status === "active" ? "success" : "neutral"), badge(item.phase ?? "idle", item.phase === "running" ? "warn" : "neutral"), item.eventCount != null ? `<span class="ccf-chip">${item.eventCount} events</span>` : "", `<span class="ccf-chip">${ago(item.lastEventAt ?? item.startedAt)}</span>`].filter(Boolean),
    `<button class="ccf-button" data-open-terminal="${esc(item.id)}">Open Terminal</button>`,
    item.status === "active"
  )).join("") : empty("No sessions yet", "Start a Claude Code session to populate the session list.");
  viewBody.querySelectorAll("[data-open-terminal]").forEach((button) => button.addEventListener("click", async () => {
    const session = state?.sessions?.find((item) => item.id === button.dataset.openTerminal);
    if (session) await window.ccf.activateTerminal(sessionActivationTarget(session));
  }));
}

function renderApprovals() {
  const pending = state?.approvals ?? [];
  const history = (state?.notifications ?? []).filter((item) => item.category === "permission_request" && item.resolutionOutcome && item.resolutionOutcome !== "pending");
  const signature = JSON.stringify([pending, history]);
  if (signature === lastApprovalsSignature) return;
  lastApprovalsSignature = signature;
  setSection("approvals", `<div class="ccf-chip accent">${pending.length} pending</div><div class="ccf-chip">${history.length} resolved</div>`);
  viewBody.innerHTML = `
    <div class="split">
      <div class="section-grid">
        <section class="ccf-card section-panel"><h3>Pending</h3><p class="muted">Current approval requests mirror the urgent overlay state.</p></section>
        ${pending.length ? pending.map(renderApprovalReview).join("") : empty("No pending approvals", "The overlay is clear right now.")}
      </div>
      <div class="section-grid">
        <section class="ccf-card section-panel"><h3>History</h3><p class="muted">Resolved approval requests remain here with outcome badges and timestamps.</p></section>
        ${history.length ? history.map((item) => card(
          item.title ?? "Approval",
          item.body ?? "",
          [badge(item.resolutionOutcome, item.resolutionOutcome === "allow" ? "success" : item.resolutionOutcome === "deny" ? "danger" : "neutral"), item.assistantLabel ? badge(item.assistantLabel) : "", item.createdAt ? `<span class="ccf-chip">${ago(item.createdAt)}</span>` : ""].filter(Boolean)
        )).join("") : empty("No approval history yet", "Resolved approvals will be kept here after they leave the overlay.")}
      </div>
    </div>
  `;
  viewBody.querySelectorAll("[data-review]").forEach((form) => {
    const id = form.dataset.review;
    form.addEventListener("input", () => {
      const answers = {};
      form.querySelectorAll("[data-question]").forEach((field) => { answers[field.dataset.question] = field.value; });
      approvalDrafts.set(id, { answers, feedback: form.querySelector("[data-feedback]")?.value ?? "" });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval) return;
      try {
        const submission = dashboardApprovalSubmission(approval, approvalDrafts.get(id));
        await window.ccf.approvalAction(submission);
      } catch (error) {
        form.querySelector("[data-error]").textContent = String(error?.message ?? error);
      }
    });
  });
  viewBody.querySelectorAll("[data-details]").forEach((details) => details.addEventListener("toggle", () => {
    if (details.open) expandedApprovals.add(details.dataset.details);
    else expandedApprovals.delete(details.dataset.details);
  }));
  viewBody.querySelectorAll("[data-deny]").forEach((button) => button.addEventListener("click", async () => { await window.ccf.approvalAction({ id: button.dataset.deny, action: "deny" }); }));
}

function renderApprovalReview(approval) {
  const event = approval.event ?? {};
  const input = event.toolInput ?? {};
  const draft = approvalDrafts.get(approval.id) ?? {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const preview = input.command ?? input.file_path ?? input.plan ?? input.prompt ?? event.message ?? "";
  return `<article class="ccf-card item">
    <strong>${esc(event.toolName ?? "Permission request")}</strong>
    <div class="muted">${esc(event.cwd ?? "Unknown workspace")} · ${esc(event.sessionId ?? "Unknown session")}</div>
    ${preview ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(preview)}</pre>` : ""}
    <details data-details="${esc(approval.id)}" ${expandedApprovals.has(approval.id) ? "open" : ""}>
      <summary>Full request details</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(input, null, 2))}</pre>
    </details>
    <form data-review="${esc(approval.id)}">
      ${questions.map((question, index) => `<label style="display:block;margin:12px 0">${esc(question.question ?? "Question")}
        <input class="ccf-input" required data-question="${esc(question.question ?? "")}" list="answers-${esc(approval.id)}-${index}" value="${esc(draft.answers?.[question.question] ?? "")}" placeholder="${question.multiSelect ? "Separate multiple choices with commas" : "Choose or type your answer"}" />
        <datalist id="answers-${esc(approval.id)}-${index}">${(question.options ?? []).map((option) => `<option value="${esc(option.label)}">${esc(option.description ?? "")}</option>`).join("")}</datalist>
        <div class="muted">${(question.options ?? []).map((option) => `${esc(option.label)}${option.description ? `: ${esc(option.description)}` : ""}`).join(" · ")}</div>
      </label>`).join("")}
      ${event.toolName === "ExitPlanMode" ? `<label style="display:block;margin:12px 0">Feedback to include with plan approval (optional)<textarea class="ccf-input" data-feedback>${esc(draft.feedback ?? "")}</textarea></label>` : ""}
      <div class="muted" data-error role="status"></div>
      <div class="card-actions"><button class="ccf-button primary" type="submit">${questions.length ? "Send answers" : event.toolName === "ExitPlanMode" ? "Approve plan" : "Approve"}</button><button class="ccf-button" type="button" data-deny="${esc(approval.id)}">Deny</button></div>
    </form>
  </article>`;
}

async function importMascotFromJson() {
  const raw = window.prompt("Paste mascot JSON");
  if (!raw) return;
  await window.ccf.importMascot({ config: JSON.parse(raw), options: {} });
  await refresh();
}

function renderMascots() {
  const mascots = mascotLibrary?.mascots ?? [];
  setSection("mascots", `<button class="ccf-button primary" id="importMascot">Import JSON</button><button class="ccf-button" id="openMascotManager">Open Manager Window</button><div class="ccf-chip accent">${mascots.length} installed</div>`);
  viewToolbar.querySelector("#importMascot")?.addEventListener("click", () => { importMascotFromJson().catch(() => {}); });
  viewToolbar.querySelector("#openMascotManager")?.addEventListener("click", async () => { await window.ccf.openMascotManager(); });
  viewBody.innerHTML = mascots.length ? `
    <section class="three-up">
      ${mascots.map((item) => card(
        item.name,
        item.description ?? item.slug ?? item.id,
        [badge(item.source ?? "bundled", item.source === "bundled" ? "neutral" : "success"), mascotLibrary.currentMascotId === item.id ? badge("Selected") : ""].filter(Boolean),
        `<div class="split-actions"><button class="ccf-button primary" data-select-mascot="${item.id}">${mascotLibrary.currentMascotId === item.id ? "Using Mascot" : "Use Mascot"}</button>${item.source === "bundled" ? "" : `<button class="ccf-button" data-delete-mascot="${item.id}">Remove</button>`}</div>`
      )).join("")}
    </section>
    <section class="two-up">
      <article class="ccf-card section-panel"><h3>Community Mascots</h3><p class="muted">Import a mascot configuration to add it to your collection.</p></article>
      <article class="ccf-card section-panel"><h3>Create Your Own</h3><p class="muted">Import JSON definitions to iterate locally with the same runtime store.</p></article>
    </section>
  ` : empty("No mascots installed", "Install or import a mascot to get started.", `<button class="ccf-button primary" id="emptyImportMascot">Import Mascot</button>`);
  viewBody.querySelector("#emptyImportMascot")?.addEventListener("click", () => { importMascotFromJson().catch(() => {}); });
  viewBody.querySelectorAll("[data-select-mascot]").forEach((button) => button.addEventListener("click", async () => { await window.ccf.selectMascot(button.dataset.selectMascot); await window.ccf.updateSettings({ appShellMode: "mascot" }); await refresh(); }));
  viewBody.querySelectorAll("[data-delete-mascot]").forEach((button) => button.addEventListener("click", async () => { await window.ccf.deleteMascot(button.dataset.deleteMascot); await refresh(); }));
}

function settingsRow(label, value, detail = "") {
  return `<div class="setting-row"><div class="setting-copy"><strong>${esc(label)}</strong>${detail ? `<span class="muted">${esc(detail)}</span>` : ""}</div><div class="setting-value">${esc(value)}</div></div>`;
}

function renderSettings() {
  const editors = diagnostics?.editors?.filter((item) => item.detected) ?? [];
  setSection("settings", `<div class="ccf-chip accent">Onboarding ${state?.ui?.onboarding?.completed ? "completed" : "required"}</div>`);
  viewBody.innerHTML = `
    <div class="settings-grid">
      <section class="ccf-card settings-group"><h3>Claude Code Hooks</h3>${settingsRow("Claude hooks", diagnostics?.drift?.healthy ? "Healthy" : "Needs attention", "Install, repair, or remove the Windows hook sender.")}<div class="controls"><button class="ccf-button" id="installHooks">Install Hooks</button><button class="ccf-button" id="repairHooks">Repair Hooks</button><button class="ccf-button" id="removeHooks">Remove CCF Claude Hooks</button></div></section>
      <section class="ccf-card settings-group"><h3>Overlay & Hotkeys</h3>${settingsRow("Shell mode", settings?.appShellMode ?? "developer", "Developer overlay or mascot shell.")}${settingsRow("Overlay opacity", String(settings?.overlayOpacity ?? 1), "Matches the overlay context panel slider.")}${settingsRow("Permission panel scale", String(settings?.permissionPanelScale ?? 1), "Expanded permission readability on Windows.")}${settingsRow("Snooze", settings?.snoozeUntil ?? "off", "Overlay snooze state from shell-owned UI settings.")}${settingsRow("Session switcher hotkeys", "Ctrl+Tab / Ctrl+Shift+Tab", "Available in developer mode; floating mode leaves these keys with your apps.")}<div class="controls"><select class="ccf-select" id="shellMode"><option value="developer" ${settings?.appShellMode === "developer" ? "selected" : ""}>Developer</option><option value="mascot" ${settings?.appShellMode === "mascot" ? "selected" : ""}>Mascot</option></select><input class="ccf-input" id="overlayOpacity" type="range" min="0.1" max="1" step="0.05" value="${settings?.overlayOpacity ?? 1}" /><input class="ccf-input" id="panelScale" type="range" min="0.8" max="2.5" step="0.1" value="${settings?.permissionPanelScale ?? 1}" /><button class="ccf-button" id="resumeOverlay">Resume Overlay</button></div></section>
      <section class="ccf-card settings-group"><h3>IDE Integration</h3>${settingsRow("Detected editors", editors.map((item) => item.id).join(", ") || "None detected", "Windows focus and activation targets.")}${settingsRow("Exact-tab activation", "URI-based focus only", "Current Windows implementation status.")}<div class="controls"><button class="ccf-button" id="removeIde">Remove IDE Integration</button></div></section>
      <section class="ccf-card settings-group"><h3>Debug & Performance</h3>
        ${settingsRow("Log file", logMetadata?.filePath ?? "Available after startup", "Current log plus one previous file, up to 2 MiB each.")}
        <label><input type="checkbox" id="debugLogging" ${settings?.debugLogging ? "checked" : ""} /> Debug logging</label>
        <p class="muted">Hook identities, response status and elapsed time. Request bodies and credentials are omitted.</p>
        <label><input type="checkbox" id="performanceProfiling" ${settings?.performanceProfiling ? "checked" : ""} /> Light performance profiling</label>
        <p class="muted">CPU, memory, processes and main-loop scheduling delay every 30 seconds. Both switches apply immediately and persist across restarts.</p>
        ${settingsRow("Log write error", logMetadata?.lastWriteError ?? "None")}
        ${settingsRow("Profiler error", logMetadata?.performance?.lastError ?? "None")}
        <button class="ccf-button" id="refreshDebugStatus">Refresh diagnostic status</button>
      </section>
      <section class="ccf-card settings-group"><h3>Storage & Cleanup</h3>${settingsRow("Runtime mode", diagnostics?.desktop?.runtimeMode?.mode ?? "unknown", "Used for packaged-vs-dev diagnostics.")}${settingsRow("Cache and logs", JSON.stringify(diagnostics?.cacheStats ?? {}), "CCF-owned data only.")}${settingsRow("Onboarding", state?.ui?.onboarding?.completed ? "Completed" : "Required", "Versioned and resettable from the shell.")}<div class="controls"><button class="ccf-button" id="clearLocalData">Clear Local CCF Data</button><button class="ccf-button" id="clearCacheLogs">Clear Mascot/Cache/Logs</button><button class="ccf-button" id="resetOnboarding">Reset Onboarding</button></div></section>
      <section class="ccf-card settings-group"><h3>Install & Uninstall</h3>${settingsRow("Startup at login", diagnostics?.desktop?.openAtLogin ? "Enabled" : "Disabled", "Windows startup preference exposed through the runtime.")}${settingsRow("Protocol readiness", diagnostics?.desktop?.runtimeMode?.isPackaged ? "Packaged validation required" : "Development registration only", "Release-lane validation remains separate from parity work.")}${settingsRow("Retention policy", "Preserve app data by default", "Destructive cleanup remains explicit and opt-in, matching the Windows docs.")}</section>
    </div>
  `;
  for (const key of ["debugLogging", "performanceProfiling"]) {
    viewBody.querySelector(`#${key}`)?.addEventListener("change", async (event) => {
      await window.ccf.updateSettings({ [key]: event.target.checked });
      await refresh();
    });
  }
  viewBody.querySelector("#refreshDebugStatus")?.addEventListener("click", refresh);
  viewBody.querySelector("#installHooks")?.addEventListener("click", async () => { await window.ccf.installHooks(); await refresh(); });
  viewBody.querySelector("#repairHooks")?.addEventListener("click", async () => { await window.ccf.repairHooks(); await refresh(); });
  viewBody.querySelector("#removeHooks")?.addEventListener("click", async () => { await window.ccf.cleanupAction("remove-hooks"); await refresh(); });
  viewBody.querySelector("#shellMode")?.addEventListener("change", async (event) => { await window.ccf.updateSettings({ appShellMode: event.target.value }); });
  viewBody.querySelector("#overlayOpacity")?.addEventListener("input", async (event) => { await window.ccf.updateSettings({ overlayOpacity: Number(event.target.value) }); });
  viewBody.querySelector("#panelScale")?.addEventListener("input", async (event) => { await window.ccf.updateSettings({ permissionPanelScale: Number(event.target.value) }); });
  viewBody.querySelector("#resumeOverlay")?.addEventListener("click", async () => { await window.ccf.dispatchCommand("resume-overlay"); await refresh(); });
  viewBody.querySelector("#removeIde")?.addEventListener("click", async () => { await window.ccf.cleanupAction("remove-ide-integration"); });
  viewBody.querySelector("#clearLocalData")?.addEventListener("click", async () => { await window.ccf.cleanupAction("clear-local-data"); await refresh(); });
  viewBody.querySelector("#clearCacheLogs")?.addEventListener("click", async () => { await window.ccf.cleanupAction("clear-cache-logs"); await refresh(); });
  viewBody.querySelector("#resetOnboarding")?.addEventListener("click", async () => { await window.ccf.cleanupAction("reset-onboarding"); await refresh(); });
}

function renderView() {
  if (!state || !settings || !mascotLibrary) {
    viewBody.innerHTML = `<div class="muted">Loading runtime state...</div>`;
    return;
  }
  if (currentSection === "notifications") return renderNotifications();
  if (currentSection === "sessions") return renderSessions();
  if (currentSection === "approvals") return renderApprovals();
  if (currentSection === "mascots") return renderMascots();
  if (currentSection === "settings") return renderSettings();
  return renderActivity();
}

function renderOnboarding() {
  const ui = state?.ui?.onboarding;
  const visible = Boolean(ui?.required) && !(state?.approvals?.length > 0)
    && !["settings", "mascots"].includes(currentSection);
  onboarding.classList.toggle("visible", visible);
  if (!visible) return;
  const step = Math.max(0, Math.min(ui.currentStep ?? 0, onboardingSteps.length - 1));
  onboardingStepLabel.textContent = `Step ${step + 1} of ${onboardingSteps.length}`;
  onboardingTitle.textContent = onboardingTitles[step] ?? "Onboarding";
  onboardingBody.textContent = onboardingSteps[step];
  onboardingDots.innerHTML = onboardingSteps.map((_item, index) => `<span class="${index === step ? "active" : ""}"></span>`).join("");
  onboardingActions.innerHTML = "";
  const actions = [];
  if (step === 1) {
    actions.push(["Install Hooks", async () => window.ccf.installHooks()]);
    actions.push(["Repair Hooks", async () => window.ccf.repairHooks()]);
  }
  if (step === 5 && mascotLibrary?.mascots?.[0]) {
    actions.push(["Use Default Mascot", async () => { await window.ccf.selectMascot(mascotLibrary.mascots[0].id); await window.ccf.updateSettings({ appShellMode: "mascot" }); }]);
  }
  if (step < onboardingSteps.length - 1) {
    actions.push(["Continue", async () => window.ccf.dispatchCommand("advance-onboarding")]);
  } else {
    actions.push(["Finish", async () => window.ccf.dispatchCommand("complete-onboarding")]);
  }
  actions.push(["Skip", async () => window.ccf.dispatchCommand(step === onboardingSteps.length - 1 ? "complete-onboarding" : "advance-onboarding")]);
  actions.forEach(([label, handler], index) => {
    const button = document.createElement("button");
    button.className = `ccf-button ${index === 0 ? "primary" : ""}`;
    button.textContent = label;
    button.addEventListener("click", async () => { await handler(); await refresh(); });
    onboardingActions.append(button);
  });
}

async function refresh() {
  [state, settings, mascotLibrary, logMetadata] = await Promise.all([
    window.ccf.getState(),
    window.ccf.getSettings(),
    window.ccf.getMascotLibrary(),
    window.ccf.getLogMetadata()
  ]);
  selectInitialSection();
  renderNav();
  renderSummary();
  renderView();
  renderOnboarding();
  window.ccf.diagnoseHooks().then((value) => {
    diagnostics = value;
    if (currentSection === "activity" || currentSection === "settings") renderView();
  }).catch(() => {});
}

function selectInitialSection() {
  if (!receivedInitialState) {
    currentSection = state?.approvals?.length ? "approvals" : "activity";
    receivedInitialState = true;
  }
  const pendingIds = new Set((state?.approvals ?? []).map((item) => item.id));
  for (const id of approvalDrafts.keys()) if (!pendingIds.has(id)) approvalDrafts.delete(id);
  for (const id of expandedApprovals) if (!pendingIds.has(id)) expandedApprovals.delete(id);
}

window.ccf.onState((value) => { state = value; selectInitialSection(); renderNav(); renderSummary(); renderView(); renderOnboarding(); });
window.ccf.onSettings((value) => { settings = value; renderSummary(); renderView(); });
window.ccf.onMascotLibrary((value) => { mascotLibrary = value; renderSummary(); renderView(); });
window.ccf.onDashboardSection?.((section) => {
  if (!sections.some(([id]) => id === section)) return;
  currentSection = section;
  receivedInitialState = true;
  renderNav();
  renderView();
  renderOnboarding();
});

for (const [id, action] of [["windowMinimize", "minimize"], ["windowMaximize", "toggle-maximize"], ["windowClose", "close"]]) {
  document.getElementById(id)?.addEventListener("click", () => window.ccf.windowAction(action));
}

openDiagnostics.addEventListener("click", async () => { await window.ccf.openDiagnostics(); });
rerunOnboarding.addEventListener("click", async () => { currentSection = "activity"; await window.ccf.dispatchCommand("reset-onboarding"); await refresh(); });

refresh();
