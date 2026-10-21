import { MascotStateMachine, mascotInputsFromState } from "./mascot-state-machine.js";
import { companionAttention, sessionIdentity, syncCompanionPlayback, syncCompanionMedia } from "./companion-attention.js";
import { sessionActivationTarget } from "./session-activation.js";

const approvalsRoot = document.getElementById("approvals");
const status = document.getElementById("status");
const collapsed = document.getElementById("collapsed");
const activeSessions = document.getElementById("activeSessions");
const recentEvents = document.getElementById("recentEvents");
const topEditor = document.getElementById("topEditor");
const openEditor = document.getElementById("openEditor");
const openTerminal = document.getElementById("openTerminal");
const openMascots = document.getElementById("openMascots");
const openPreview = document.getElementById("openPreview");
const openDashboard = document.getElementById("connectClaude");
const mascotVideo = document.getElementById("mascotVideo");
const mascotFallback = document.getElementById("mascotFallback");
const mascotName = document.getElementById("mascotName");
const mascotState = document.getElementById("mascotState");
const mascotCaption = document.getElementById("mascotCaption");
const connectionHint = document.getElementById("connectionHint");
const overlayRoot = document.querySelector(".overlay");
const mascotShell = document.querySelector(".mascot-shell");
const statsPill = document.getElementById("statsPill");
const finishedToast = document.getElementById("finishedToast");
const toastProject = document.getElementById("toastProject");
const toastLabel = document.getElementById("toastLabel");
const toastAssistant = document.getElementById("toastAssistant");
const toastProgress = document.getElementById("toastProgress");
const sessionSwitcher = document.getElementById("sessionSwitcher");
const expandedApproval = document.getElementById("expandedApproval");
const contextPanel = document.getElementById("contextPanel");

let latestState = null;
let latestSettings = null;
let mascotLibrary = null;
let mascot = null;
let lastMascotUrl = null;
let mascotVideoReady = false;
let mascotVideoFallbackUrl = null;
let lastMascotAttentionKind = null;
let latestClaudeRuntime = null;
let overlayDrag = null;
let pendingOverlayDragFrame = null;
let claudeRuntimeRefresh = { inFlight: null, lastLoadedAt: 0 };
let stateExpiryTimer = null;

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function logUi(level, message, context = {}) {
  window.ccf?.log?.({
    level,
    category: "overlay-ui",
    message,
    context
  });
}

function ensureMascotRuntime() {
  const currentMascot = mascotLibrary?.mascots?.find((item) => item.id === mascotLibrary.currentMascotId) ?? mascotLibrary?.mascots?.[0] ?? null;
  if (!currentMascot) {
    return null;
  }
  if (!mascot || mascot.config !== currentMascot.config) {
    mascot = new MascotStateMachine(currentMascot.config);
    lastMascotUrl = null;
    lastMascotAttentionKind = null;
  }
  return currentMascot;
}

function relativeTime(dateValue) {
  if (!dateValue) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateValue).getTime()) / 1000));
  if (seconds < 5) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}

function topVisibleApproval(state) {
  return state.approvals.find((item) => !item.collapsed) ?? state.approvals[0] ?? null;
}

function mascotCaptionForState(state, mascotSnapshot) {
  const topApproval = topVisibleApproval(state);
  if (topApproval) {
    return `${topApproval.assistantLabel ?? "Assistant"} needs your attention for ${topApproval.event.toolName ?? "a request"} in ${topApproval.event.cwd ?? "the current workspace"}.`;
  }

  const activeSession = state.sessions.find((session) => session.status === "active");
  if (!activeSession) {
    if ((latestClaudeRuntime?.claudeProcesses?.length ?? 0) > 0) {
      return "Claude is running, but this app has not received hook events from it yet.";
    }
    return "Waiting for an assistant session to connect.";
  }
  if (mascotSnapshot.nodeName === "Thinking") {
    return `${activeSession.assistantLabel ?? "Assistant"} is compacting context in ${activeSession.projectName ?? activeSession.projectDir ?? "your workspace"}.`;
  }
  if (mascotSnapshot.nodeName === "Working") {
    return `${activeSession.assistantLabel ?? "Assistant"} is working in ${activeSession.projectName ?? activeSession.projectDir ?? "your workspace"}.`;
  }
  return `${activeSession.assistantLabel ?? "Assistant"} is connected to ${activeSession.projectName ?? activeSession.projectDir ?? "your workspace"}.`;
}

function renderMascot(state) {
  const currentMascot = ensureMascotRuntime();
  if (!currentMascot || !mascot) {
    return;
  }
  const attention = companionAttention(state);
  const inputs = mascotInputsFromState(state);
  const animateWhenVisible = currentMascot.config?.animateWhenVisible === true;
  const shouldPlay = animateWhenVisible || attention.kind === "working";
  const interrupted = animateWhenVisible && mascot.phase === "transition"
    && lastMascotAttentionKind !== null && lastMascotAttentionKind !== attention.kind;
  lastMascotAttentionKind = attention.kind;
  let snapshot = !shouldPlay || document.hidden || interrupted
    ? mascot.settleWithoutPlayback(inputs)
    : mascot.applyInputs(inputs);
  if (!snapshot.media?.url) snapshot = mascot.settleWithoutPlayback(inputs);
  mascotName.textContent = currentMascot.name;
  mascotState.textContent = attention.label;
  mascotCaption.textContent = `${attention.summary} · ${attention.identity}`;

  if (snapshot.thumbnailUrl) {
    mascotFallback.src = snapshot.thumbnailUrl;
  }
  if (!shouldPlay || document.hidden || !snapshot.media?.url) {
    syncCompanionMedia(mascotVideo, null, attention, document.hidden, animateWhenVisible);
    lastMascotUrl = null;
    mascotVideoReady = false;
    mascotVideoFallbackUrl = null;
    mascotFallback.style.display = "block";
    return;
  }
  if (snapshot.media.url !== lastMascotUrl) {
    lastMascotUrl = snapshot.media.url;
    mascotVideoReady = false;
    mascotVideoFallbackUrl = snapshot.media.fallbackUrl ?? null;
    syncCompanionMedia(mascotVideo, snapshot.media, attention, document.hidden, animateWhenVisible);
  }
  syncCompanionPlayback(mascotVideo, attention, document.hidden, animateWhenVisible);
  mascotFallback.style.display = mascotVideoReady && shouldPlay ? "none" : "block";
}

async function loadSettings() {
  latestSettings = await window.ccf.getSettings();
  topEditor.textContent = latestSettings.editorPreference === "cursor" ? "Cursor" : "VS Code";
  document.body.classList.toggle("shell-mode-mascot", latestSettings.appShellMode === "mascot");
}

async function loadClaudeRuntime() {
  claudeRuntimeRefresh.lastLoadedAt = Date.now();
  latestClaudeRuntime = await window.ccf.detectClaudeRuntime();
}

async function refreshClaudeRuntimeIfStale(maxAgeMs = 15000) {
  if (claudeRuntimeRefresh.inFlight) {
    await claudeRuntimeRefresh.inFlight;
    return;
  }
  if (latestClaudeRuntime && Date.now() - claudeRuntimeRefresh.lastLoadedAt < maxAgeMs) {
    return;
  }
  claudeRuntimeRefresh.inFlight = loadClaudeRuntime().finally(() => {
    claudeRuntimeRefresh.inFlight = null;
  });
  await claudeRuntimeRefresh.inFlight;
}

async function loadMascotLibrary() {
  mascotLibrary = await window.ccf.getMascotLibrary();
  ensureMascotRuntime();
}

function pickActivationTarget() {
  const attention = companionAttention(latestState ?? {});
  return sessionActivationTarget(attention.session, attention.approval?.event);
}

function questionList(approval) {
  const questions = approval.event.toolInput?.questions;
  return Array.isArray(questions) ? questions : [];
}

function suggestionList(approval) {
  return Array.isArray(approval.event.permissionSuggestions)
    ? approval.event.permissionSuggestions.filter((item) => item && typeof item === "object")
    : [];
}

function formatSuggestion(item) {
  if (item.type === "addRules" && Array.isArray(item.rules) && item.rules[0]) {
    return `${item.rules[0].toolName ?? "tool"}: ${item.rules[0].ruleContent ?? ""}`;
  }
  if (item.type === "setMode") {
    return `Mode: ${item.mode ?? "unknown"}`;
  }
  return JSON.stringify(item);
}

function renderStandardApprovalActions(approval, root) {
  root.querySelector(".allow")?.addEventListener("click", async () => {
    await window.ccf.approvalAction({ id: approval.id, action: "allow" });
  });
  root.querySelector(".deny")?.addEventListener("click", async () => {
    await window.ccf.approvalAction({ id: approval.id, action: "deny" });
  });
  root.querySelector(".defer")?.addEventListener("click", async () => {
    await window.ccf.approvalAction({ id: approval.id, action: approval.collapsed ? "restore" : "defer" });
  });
  root.querySelector(".expand")?.addEventListener("click", async () => {
    await window.ccf.dispatchCommand("toggle-expanded-approval", { approvalId: approval.id });
  });
}

function renderApprovalCard(approval) {
  const wrapper = document.createElement("article");
  wrapper.className = "approval";
  const preview = approval.event.toolInput?.command
    ?? approval.event.toolInput?.file_path
    ?? approval.event.message
    ?? approval.event.toolInput?.prompt
    ?? "";
  const suggestions = suggestionList(approval);
  const questions = questionList(approval);
  wrapper.innerHTML = `
    <div class="overlay-header">
      <div>
        <div class="title">${esc(approval.event.toolName ?? "Permission request")}</div>
        <div class="subtitle">${esc(approval.assistantLabel ?? "Assistant")} • ${esc(approval.event.cwd ?? "Unknown workspace")}</div>
      </div>
      <div class="pill">${approval.collapsed ? "Deferred" : "Waiting"}</div>
    </div>
    <div class="approval-body">
      <div class="meta-row">
        ${approval.event.sessionId ? `<span>${esc(approval.event.sessionId)}</span>` : ""}
      </div>
      ${preview ? `<div class="command-preview">${esc(preview)}</div>` : ""}
      ${questions.length > 0 ? `<div class="subtitle">${questions.length} question${questions.length === 1 ? "" : "s"} waiting</div>` : ""}
      ${suggestions.length > 0 ? `<div class="subtitle">${suggestions.length} suggested permission update${suggestions.length === 1 ? "" : "s"}</div>` : ""}
    </div>
    <div class="meta-row"><span class="hotkey-hint">Ctrl+Enter confirm</span></div>
    <div class="approval-toolbar">
      <button class="allow">Approve</button>
      <button class="deny">Deny</button>
      <button class="defer">${approval.collapsed ? "Restore" : "Later"}</button>
      <button class="secondary expand">Expand</button>
    </div>
  `;
  renderStandardApprovalActions(approval, wrapper);
  return wrapper;
}

function renderExpandedApproval(state) {
  const approvalId = state.ui?.overlay?.expandedApproval?.approvalId ?? null;
  const approval = state.approvals.find((item) => item.id === approvalId);
  expandedApproval.innerHTML = "";
  expandedApproval.classList.toggle("visible", Boolean(approval));
  if (!approval) {
    return;
  }

  const suggestions = suggestionList(approval);
  const questions = questionList(approval);
  const preview = approval.event.toolInput?.command
    ?? approval.event.toolInput?.file_path
    ?? approval.event.message
    ?? JSON.stringify(approval.event.toolInput ?? {}, null, 2);

  expandedApproval.innerHTML = `
    <div class="overlay-header">
      <div>
        <div class="title">${esc(approval.event.toolName ?? "Permission request")}</div>
        <div class="subtitle">${esc(approval.assistantLabel ?? "Assistant")} • ${esc(approval.event.cwd ?? "Unknown workspace")}</div>
      </div>
      <button class="secondary close-expanded">Close</button>
    </div>
    <div class="subpanel">
      <strong>Full input</strong>
      <pre class="command-preview" style="margin:8px 0 0;">${esc(preview)}</pre>
    </div>
    ${questions.length > 0 ? `<div class="subpanel" data-role="questions"><strong>Questions</strong></div>` : ""}
    ${suggestions.length > 0 ? `<div class="subpanel" data-role="suggestions"><strong>Suggestions</strong></div>` : ""}
    <div class="approval-toolbar">
      <button class="allow">Approve</button>
      <button class="deny">Deny</button>
      <button class="defer">${approval.collapsed ? "Restore" : "Later"}</button>
    </div>
  `;
  renderStandardApprovalActions(approval, expandedApproval);
  expandedApproval.querySelector(".close-expanded")?.addEventListener("click", async () => {
    await window.ccf.dispatchCommand("toggle-expanded-approval", { approvalId: approval.id });
  });

  if (questions.length > 0) {
    const panel = expandedApproval.querySelector('[data-role="questions"]');
    for (const question of questions) {
      const label = document.createElement("label");
      label.textContent = question.question ?? "Question";
      panel.append(label);
      const field = Array.isArray(question.options) && question.options.length > 0
        ? document.createElement("select")
        : document.createElement("input");
      if (field.tagName === "SELECT") {
        for (const option of question.options) {
          const item = document.createElement("option");
          item.value = option.label ?? "";
          item.textContent = option.label ?? option.description ?? "";
          field.append(item);
        }
      } else {
        field.type = "text";
        field.placeholder = question.header ?? "Your answer";
      }
      field.dataset.question = question.question ?? "";
      panel.append(field);
    }
    const submit = document.createElement("button");
    submit.className = "secondary";
    submit.textContent = "Send answers";
    submit.addEventListener("click", async () => {
      const answers = {};
      panel.querySelectorAll("[data-question]").forEach((input) => {
        answers[input.dataset.question] = input.value;
      });
      await window.ccf.approvalAction({
        id: approval.id,
        action: "allowWithAnswers",
        payload: { answers }
      });
    });
    panel.append(submit);
  }

  if (suggestions.length > 0) {
    const panel = expandedApproval.querySelector('[data-role="suggestions"]');
    suggestions.forEach((suggestion, index) => {
      const row = document.createElement("label");
      row.className = "checkbox";
      row.innerHTML = `
        <input type="checkbox" checked data-suggestion-index="${index}" />
        <span>${esc(formatSuggestion(suggestion))}</span>
      `;
      panel.append(row);
    });
    const apply = document.createElement("button");
    apply.className = "secondary";
    apply.textContent = "Approve selected suggestions";
    apply.addEventListener("click", async () => {
      const updatedPermissions = suggestions.filter((_item, index) => {
        return panel.querySelector(`[data-suggestion-index="${index}"]`)?.checked;
      });
      await window.ccf.approvalAction({
        id: approval.id,
        action: "allowWithPermissions",
        payload: { updatedPermissions }
      });
    });
    panel.append(apply);
  }
}

function renderSessionSwitcher(state) {
  const switcher = state.ui?.overlay?.sessionSwitcher;
  sessionSwitcher.classList.toggle("visible", Boolean(switcher?.isOpen));
  sessionSwitcher.innerHTML = "";
  if (!switcher?.isOpen) {
    return;
  }
  sessionSwitcher.innerHTML = `
    <div class="overlay-header">
      <div>
        <div class="title">Session Switcher</div>
        <div class="subtitle">Running sessions first, then most recent activity.</div>
      </div>
      <div class="pill">Ctrl+Tab</div>
    </div>
    <div class="meta-row"><span class="hotkey-hint">Ctrl+Tab cycle</span><span class="hotkey-hint">Ctrl+Enter focus</span><span class="hotkey-hint">Esc cancel</span></div>
  `;
  (switcher.sessions ?? []).forEach((session, index) => {
    const row = document.createElement("button");
    row.className = `switcher-row ${index === switcher.selectedIndex ? "active" : ""}`;
    row.innerHTML = `
      <div>
        <div><strong>${esc(session.projectName ?? session.projectDir ?? session.id)}</strong></div>
        <div class="subtitle">${esc(sessionIdentity(session))} • ${esc(session.phase ?? "idle")} • ${relativeTime(session.lastEventAt ?? session.startedAt)}</div>
      </div>
      <span class="tag">Ctrl+${index + 1}</span>
    `;
    row.addEventListener("click", async () => {
      await window.ccf.dispatchCommand("select-index", { index });
      await window.ccf.dispatchCommand("confirm-session-selection");
    });
    sessionSwitcher.append(row);
  });
}

function renderStatsPill(state) {
  const active = state.sessions.filter((item) => item.status === "active");
  const activeSubagents = active.reduce((count, item) => count + (item.activeSubagentCount ?? 0), 0);
  const compacting = active.filter((item) => item.isCompacting).length;
  const running = active.filter((item) => item.phase === "running").length;
  const pending = state.approvals.length;
  const visible = active.length > 0 || activeSubagents > 0 || compacting > 0 || running > 0 || pending > 0;
  statsPill.classList.toggle("visible", visible);
  statsPill.innerHTML = visible
    ? `
      <span>${active.length} sessions</span>
      ${activeSubagents > 0 ? `<span>${activeSubagents} subagents</span>` : ""}
      ${compacting > 0 ? `<span>${compacting} compacting</span>` : ""}
      ${pending > 0 ? `<span>${pending} approvals</span>` : ""}
      ${running > 0 ? `<span>${running} running</span>` : ""}
    `
    : "";
}

function renderToast(state) {
  const toast = state.ui?.overlay?.toast;
  finishedToast.classList.toggle("visible", Boolean(toast) && toast.visibleUntil > Date.now() && state.approvals.length === 0 && !mascotModeEnabled());
  if (!toast) {
    return;
  }
  toastProject.textContent = toast.projectName ?? "Session";
  toastLabel.textContent = toast.completedCount > 1 ? `${toast.completedCount} sessions completed` : "Task completed";
  toastAssistant.textContent = toast.assistantLabel ?? "Assistant";
  const progress = Math.max(0, Math.min(1, (toast.visibleUntil - Date.now()) / 8000));
  toastProgress.style.width = `${progress * 100}%`;
}

function renderContextPanel(state) {
  const context = state.ui?.overlay?.contextMenu ?? { isOpen: false, mode: "closed" };
  contextPanel.classList.toggle("visible", Boolean(context.isOpen));
  contextPanel.innerHTML = "";
  if (!context.isOpen) {
    return;
  }

  if (context.mode === "opacity" || context.mode === "scale") {
    const label = context.mode === "opacity" ? "Overlay opacity" : "Permission panel scale";
    const key = context.mode === "opacity" ? "overlayOpacity" : "permissionPanelScale";
    const min = context.mode === "opacity" ? "0.1" : "0.8";
    const max = context.mode === "opacity" ? "1" : "2.5";
    const step = context.mode === "opacity" ? "0.05" : "0.1";
    contextPanel.innerHTML = `
      <div class="overlay-header">
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Adjust your companion and its Windows controls.</div>
        </div>
        <button class="secondary back-context">Back</button>
      </div>
      <div class="range-row">
        <input type="range" min="${min}" max="${max}" step="${step}" value="${latestSettings?.[key] ?? 1}" />
        <span>${latestSettings?.[key] ?? 1}</span>
      </div>
    `;
    const input = contextPanel.querySelector("input");
    const valueEl = contextPanel.querySelector("span");
    input?.addEventListener("input", async () => {
      valueEl.textContent = input.value;
      await window.ccf.updateSettings({
        [key]: Number(input.value)
      });
    });
    contextPanel.querySelector(".back-context")?.addEventListener("click", async () => {
      await window.ccf.dispatchCommand("set-context-mode", { mode: "main" });
    });
    return;
  }

  contextPanel.innerHTML = `
    <div class="overlay-header">
      <div>
        <div class="title">Overlay Controls</div>
        <div class="subtitle">Snooze, shell mode, appearance, and dashboard shortcuts.</div>
      </div>
      <div class="pill">${latestSettings?.appShellMode ?? "developer"}</div>
    </div>
    <div class="context-actions">
      <button class="secondary" data-command="snooze-overlay" data-minutes="15">15m</button>
      <button class="secondary" data-command="snooze-overlay" data-minutes="30">30m</button>
      <button class="secondary" data-command="snooze-overlay" data-minutes="60">1h</button>
      <button class="secondary" data-command="snooze-overlay" data-minutes="120">2h</button>
      <button class="secondary" data-command="snooze-overlay" data-minutes="0">Until resumed</button>
      <button class="secondary" data-command="resume-overlay">Resume</button>
      <button class="secondary" data-shell-mode="mascot">Mascot mode</button>
      <button class="secondary" data-shell-mode="developer">Developer mode</button>
      <button class="secondary" data-context-mode="opacity">Opacity</button>
      <button class="secondary" data-context-mode="scale">Panel scale</button>
      <button class="secondary" data-open-dashboard="true">Open dashboard</button>
      <button class="secondary" data-close-overlay="true">Close overlay</button>
    </div>
  `;
  contextPanel.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.dispatchCommand(button.dataset.command, {
        minutes: Number(button.dataset.minutes ?? 0)
      });
    });
  });
  contextPanel.querySelectorAll("[data-shell-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.updateSettings({ appShellMode: button.dataset.shellMode });
    });
  });
  contextPanel.querySelectorAll("[data-context-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.dispatchCommand("set-context-mode", { mode: button.dataset.contextMode });
    });
  });
  contextPanel.querySelector("[data-open-dashboard]")?.addEventListener("click", async () => {
    await window.ccf.openDashboard();
    await window.ccf.dispatchCommand("close-context-menu");
  });
  contextPanel.querySelector("[data-close-overlay]")?.addEventListener("click", async () => {
    await window.ccf.updateSettings({ overlayVisible: false });
  });
}

function renderState(state) {
  latestState = state;
  if (document.hidden) {
    ensureMascotRuntime();
    mascot?.settleWithoutPlayback(mascotInputsFromState(state));
    syncCompanionMedia(mascotVideo, null, companionAttention(state), true);
    lastMascotUrl = null;
    mascotVideoReady = false;
    mascotVideoFallbackUrl = null;
    return;
  }
  renderMascot(state);
  renderStatsPill(state);
  renderToast(state);
  renderSessionSwitcher(state);
  renderExpandedApproval(state);
  renderContextPanel(state);

  approvalsRoot.innerHTML = "";
  const visibleApprovals = state.approvals.filter((item) => !item.collapsed);
  const deferredApprovals = state.approvals.filter((item) => item.collapsed);
  const collapsedCount = deferredApprovals.length;
  const topSession = state.sessions.find((session) => session.status === "active");

  status.textContent =
    visibleApprovals.length > 0
      ? `${visibleApprovals.length} approval request${visibleApprovals.length === 1 ? "" : "s"}`
      : topSession
        ? `${topSession.assistantLabel ?? "Assistant"} connected`
        : (latestClaudeRuntime?.claudeProcesses?.length ?? 0) > 0
          ? `Detected ${latestClaudeRuntime.claudeProcesses.length} Claude process${latestClaudeRuntime.claudeProcesses.length === 1 ? "" : "es"}`
          : "Waiting for assistant activity";
  collapsed.textContent = `${collapsedCount} deferred`;
  activeSessions.textContent = String(state.sessions.filter((session) => session.status === "active").length);
  recentEvents.textContent = String(state.events.length);
  connectionHint.textContent =
    !topSession && (latestClaudeRuntime?.claudeProcesses?.length ?? 0) > 0
      ? latestClaudeRuntime.hookExists
        ? "Claude hooks exist, so restart the running Claude session to begin forwarding events."
        : "Claude is running, but its hooks are not installed yet. Open diagnostics and install them."
      : "";

  const canBulkResolve = visibleApprovals.length > 1;
  if (canBulkResolve) {
    const bulk = document.createElement("article");
    bulk.className = "approval";
    bulk.innerHTML = `
      <div><strong>${visibleApprovals.length} pending approvals</strong></div>
      <div class="subtitle">Bulk resolve is available because every visible approval supports background responses.</div>
      <div class="approval-toolbar">
        <button class="allow">Approve all</button>
        <button class="deny">Deny all</button>
      </div>
    `;
    bulk.querySelector(".allow")?.addEventListener("click", async () => {
      for (const approval of visibleApprovals) {
        await window.ccf.approvalAction({ id: approval.id, action: "allow" });
      }
    });
    bulk.querySelector(".deny")?.addEventListener("click", async () => {
      for (const approval of visibleApprovals) {
        await window.ccf.approvalAction({ id: approval.id, action: "deny" });
      }
    });
    approvalsRoot.append(bulk);
  }

  visibleApprovals.forEach((approval) => approvalsRoot.append(renderApprovalCard(approval)));
  deferredApprovals.forEach((approval) => approvalsRoot.append(renderApprovalCard(approval)));
  scheduleStateExpiry(state);
}

function scheduleStateExpiry(state) {
  clearTimeout(stateExpiryTimer);
  stateExpiryTimer = null;
  const now = Date.now();
  const deadlines = [state.ui?.overlay?.toast?.visibleUntil, ...state.sessions
    .filter((item) => item.status === "active" && item.phase === "running" && !(item.activeSubagentCount > 0))
    .map((item) => new Date(item.lastEventAt).getTime() + 90_001)]
    .filter((value) => Number.isFinite(value) && value > now);
  if (deadlines.length && !document.hidden) {
    stateExpiryTimer = setTimeout(() => renderState(latestState), Math.min(...deadlines) - now);
  }
}

function mascotModeEnabled() {
  return latestSettings?.appShellMode === "mascot";
}

function flushOverlayDrag() {
  if (!overlayDrag?.latestBounds) {
    pendingOverlayDragFrame = null;
    return;
  }
  window.ccf.setOverlayBounds(overlayDrag.latestBounds);
  pendingOverlayDragFrame = null;
}

function queueOverlayDrag(bounds) {
  if (!overlayDrag) {
    return;
  }
  overlayDrag.latestBounds = bounds;
  if (pendingOverlayDragFrame != null) {
    return;
  }
  pendingOverlayDragFrame = requestAnimationFrame(flushOverlayDrag);
}

async function beginMascotDrag(event) {
  if (event.button !== 0 || !mascotModeEnabled()) {
    return;
  }
  const bounds = await window.ccf.getOverlayBounds();
  if (!bounds) {
    return;
  }
  overlayDrag = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startBounds: bounds,
    latestBounds: bounds
  };
  document.body.classList.add("dragging");
  mascotShell.setPointerCapture(event.pointerId);
}

function updateMascotDrag(event) {
  if (!overlayDrag || event.pointerId !== overlayDrag.pointerId) {
    return;
  }
  queueOverlayDrag({
    ...overlayDrag.startBounds,
    x: Math.round(overlayDrag.startBounds.x + (event.screenX - overlayDrag.startScreenX)),
    y: Math.round(overlayDrag.startBounds.y + (event.screenY - overlayDrag.startScreenY))
  });
}

function endMascotDrag(event) {
  if (!overlayDrag || event.pointerId !== overlayDrag.pointerId) {
    return;
  }
  const finalBounds = overlayDrag.latestBounds ?? overlayDrag.startBounds;
  overlayDrag = null;
  document.body.classList.remove("dragging");
  if (pendingOverlayDragFrame != null) {
    cancelAnimationFrame(pendingOverlayDragFrame);
    pendingOverlayDragFrame = null;
  }
  window.ccf.setOverlayBounds(finalBounds);
}

mascotVideo.addEventListener("ended", () => {
  if (!mascot) {
    return;
  }
  const snapshot = mascot.handleVideoEnded();
  if (snapshot.media?.url && snapshot.media.url !== lastMascotUrl) {
    lastMascotUrl = null;
    renderMascot(latestState ?? { approvals: [], sessions: [], ui: { overlay: {} } });
  }
});
mascotVideo.addEventListener("error", () => {
  if (mascotVideoFallbackUrl && mascotVideo.src !== mascotVideoFallbackUrl) {
    mascotVideo.src = mascotVideoFallbackUrl;
    mascotVideo.load();
    syncCompanionPlayback(mascotVideo, companionAttention(latestState ?? {}), document.hidden, mascot?.config?.animateWhenVisible === true);
    return;
  }
  mascotVideoReady = false;
  mascotFallback.style.display = "block";
});
mascotVideo.addEventListener("loadeddata", () => {
  mascotVideoReady = true;
  mascotFallback.style.display = "block";
  syncCompanionPlayback(mascotVideo, companionAttention(latestState ?? {}), document.hidden, mascot?.config?.animateWhenVisible === true);
});
mascotVideo.addEventListener("playing", () => {
  mascotVideoReady = true;
  syncCompanionPlayback(mascotVideo, companionAttention(latestState ?? {}), document.hidden, mascot?.config?.animateWhenVisible === true);
  mascotFallback.style.display = mascotVideo.paused ? "block" : "none";
});

openEditor.addEventListener("click", async () => {
  await loadSettings();
  await window.ccf.activateEditor({
    editor: latestSettings.editorPreference,
    ...pickActivationTarget()
  });
});
openTerminal.addEventListener("click", async () => {
  await window.ccf.activateTerminal(pickActivationTarget());
});
openMascots.addEventListener("click", async () => {
  await window.ccf.openMascotManager();
});
openPreview.addEventListener("click", async () => {
  await window.ccf.openMascotPreview();
});
openDashboard.addEventListener("click", async () => {
  await window.ccf.openDashboard();
});
statsPill.addEventListener("click", async () => {
  const active = latestState?.sessions?.filter((item) => item.status === "active") ?? [];
  if (active.length === 1) {
    await window.ccf.activateTerminal(sessionActivationTarget(active[0]));
    return;
  }
  await window.ccf.openDashboard();
});
overlayRoot.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

window.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    await window.ccf.dispatchCommand("close-context-menu");
    if (latestState?.ui?.overlay?.expandedApproval?.approvalId) {
      await window.ccf.dispatchCommand("toggle-expanded-approval", {
        approvalId: latestState.ui.overlay.expandedApproval.approvalId
      });
    }
    return;
  }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (latestState?.ui?.overlay?.toast) {
      await window.ccf.dispatchCommand("dismiss-toast");
    }
  }
});

mascotShell.addEventListener("pointerdown", (event) => {
  beginMascotDrag(event).catch(() => {});
});
mascotShell.addEventListener("pointermove", updateMascotDrag);
mascotShell.addEventListener("pointerup", endMascotDrag);
mascotShell.addEventListener("pointercancel", endMascotDrag);

window.ccf.onState(async (state) => {
  if (!latestSettings) await loadSettings();
  if (!mascotLibrary) {
    await loadMascotLibrary();
  }
  renderState(state);
});
window.ccf.onMascotLibrary(async (value) => {
  mascotLibrary = value;
  ensureMascotRuntime();
  if (latestState) {
    renderState(latestState);
  }
});
window.ccf.onSettings((value) => {
  latestSettings = value;
  document.body.classList.toggle("shell-mode-mascot", latestSettings.appShellMode === "mascot");
  if (latestState) {
    renderState(latestState);
  }
});

async function refresh() {
  latestState = await window.ccf.getState();
  await loadSettings();
  await loadMascotLibrary();
  renderState(latestState);
  // Process diagnosis can involve PowerShell; the companion must paint first.
  refreshClaudeRuntimeIfStale(0).then(() => {
    if (latestState) renderState(latestState);
  }).catch((error) => {
    logUi("warn", "Optional Claude process diagnosis failed", { error: String(error?.message ?? error) });
  });
}

refresh().catch((error) => {
  logUi("error", "Initial overlay refresh failed", {
    error: String(error?.message ?? error)
  });
});

document.addEventListener("visibilitychange", () => {
  clearTimeout(stateExpiryTimer);
  stateExpiryTimer = null;
  if (latestState) renderState(latestState);
});
window.addEventListener("beforeunload", () => {
  clearTimeout(stateExpiryTimer);
  if (pendingOverlayDragFrame != null) cancelAnimationFrame(pendingOverlayDragFrame);
  mascotVideo.pause();
});
