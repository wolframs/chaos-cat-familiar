import { normalizeCompanionSnapshot, normalizeSubmission, shouldSubmitOnKeydown } from "./companion-conversation-model.js";
import { hideClaudePromptBox, renderCompanionTerminal } from "./companion-terminal.js";
import { installCompanionTextSize } from "./companion-text-size.js";
import { promptKeySequence, terminalViewportSize } from "./companion-terminal-controls.js";

const elements = Object.fromEntries(["title", "presence", "start", "prompt", "draft", "send", "stop", "consoleScreen", "attach", "attachments"]
  .map((id) => [id, document.getElementById(id)]));
const phaseLabels = { idle: "Ready", working: "Working", attention: "Needs input", offline: "Offline" };
let snapshot = normalizeCompanionSnapshot(null);
let terminalKey = "";
let busy = false;
let receivedPush = false;
let resizeTimer;
let lastSize = "";
let attachmentKey = "";
let attaching = false;
let attachmentJobs = 0;
let attachmentQueue = Promise.resolve();
let localError = "";
const measure = document.createElement("canvas").getContext("2d");

async function action(payload) {
  if (typeof window.ccf?.companionAction !== "function") throw new Error("Companion transport is unavailable");
  const result = await window.ccf.companionAction(payload);
  if (result?.ok === false) throw new Error(result.error || "The companion could not receive that input");
  return result;
}

function showError(error) {
  localError = String(error?.message ?? error);
  elements.prompt.textContent = localError;
  elements.prompt.classList.add("visible");
}

function scheduleResize() {
  if (!snapshot.connected) { clearTimeout(resizeTimer); resizeTimer = undefined; lastSize = ""; return; }
  if (resizeTimer !== undefined) return;
  resizeTimer = setTimeout(async () => {
    resizeTimer = undefined;
    const style = getComputedStyle(elements.consoleScreen);
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const size = terminalViewportSize(elements.consoleScreen.clientWidth, elements.consoleScreen.clientHeight,
      measure.measureText("M").width, parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45);
    const key = `${size.cols}:${size.rows}`;
    if (key === lastSize || !snapshot.connected) return;
    lastSize = key;
    try { await action({ action: "resize", ...size }); }
    catch (error) { if (snapshot.connected) showError(error); }
  }, 100);
}

function updateButtons() {
  elements.start.hidden = snapshot.connected;
  elements.start.disabled = busy;
  elements.send.disabled = busy || attaching || !normalizeSubmission(elements.draft.value, snapshot.connected, snapshot.attachments);
  elements.attach.disabled = busy || attaching;
  elements.stop.disabled = busy || !snapshot.connected || snapshot.phase !== "working";
  elements.draft.disabled = !snapshot.connected;
}

function render() {
  elements.title.textContent = snapshot.title;
  elements.presence.dataset.phase = snapshot.phase;
  elements.presence.textContent = phaseLabels[snapshot.phase];
  elements.prompt.textContent = localError || snapshot.pendingPrompt?.label || "";
  elements.prompt.classList.toggle("visible", Boolean(localError || snapshot.pendingPrompt));
  const terminal = snapshot.terminal.screen || snapshot.terminal.lines.length || snapshot.terminal.history.length ? snapshot.terminal : {
    screen: snapshot.messages.map((message) => message.text).join("\n\n")
      || (snapshot.connected ? "Starting the companion…" : "Start the companion to begin.")
  };
  const key = JSON.stringify([terminal.screen, terminal.lines, terminal.history]);
  if (key !== terminalKey) {
    terminalKey = key;
    const scroller = elements.consoleScreen;
    const followsOutput = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const readingPosition = scroller.scrollTop;
    // The composer below replaces Claude's own input box; see hideClaudePromptBox.
    renderCompanionTerminal(scroller, terminal.lines ? { ...terminal, lines: hideClaudePromptBox(terminal.lines) } : terminal);
    if (followsOutput) scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop = readingPosition;
  }
  renderAttachments();
  updateButtons();
  scheduleResize();
}

async function sendMessage() {
  const payload = normalizeSubmission(elements.draft.value, snapshot.connected, snapshot.attachments);
  if (!payload || busy || attaching) return;
  busy = true;
  updateButtons();
  try {
    await action(payload);
    localError = "";
    elements.draft.value = "";
    elements.draft.style.height = "";
    elements.draft.focus();
  } catch (error) { showError(error); }
  finally { busy = false; updateButtons(); }
}

elements.draft.addEventListener("input", () => {
  localError = "";
  elements.draft.style.height = "auto";
  elements.draft.style.height = `${Math.min(elements.draft.scrollHeight, 154)}px`;
  updateButtons();
});
elements.draft.addEventListener("keydown", (event) => {
  if (!snapshot.connected || busy) return;
  const raw = promptKeySequence(event, elements.draft.value.length === 0 && snapshot.attachments.length === 0);
  if (raw !== null) {
    event.preventDefault();
    void action({ action: "raw-input", text: raw }).catch(showError);
  } else if (shouldSubmitOnKeydown(event)) {
    event.preventDefault();
    void sendMessage();
  }
});

function renderAttachments() {
  const key = JSON.stringify(snapshot.attachments);
  if (key === attachmentKey) return;
  attachmentKey = key;
  elements.attachments.replaceChildren(...snapshot.attachments.map((image) => {
    const card = document.createElement("figure");
    card.className = "attachment";
    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = image.name;
    const name = document.createElement("figcaption");
    name.textContent = image.name;
    name.title = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.dataset.id = image.id;
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    card.append(preview, name, remove);
    return card;
  }));
  elements.attachments.hidden = snapshot.attachments.length === 0;
}

function attachImages(work) {
  attachmentJobs++;
  attaching = true;
  localError = "";
  updateButtons();
  attachmentQueue = attachmentQueue.then(work).catch(showError).finally(() => {
    attachmentJobs--;
    attaching = attachmentJobs > 0;
    updateButtons();
  });
  return attachmentQueue;
}

function readImage(file) {
  if (file.size > 20 * 1024 * 1024) return Promise.reject(new Error("Images must be smaller than 20 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function addFiles(files) {
  return attachImages(async () => {
    for (const file of files) await action({ action: "attach-image", name: file.name, dataUrl: await readImage(file) });
  });
}

elements.attach.addEventListener("click", () => void attachImages(() => action({ action: "pick-images" })));
elements.attachments.addEventListener("click", (event) => {
  const id = event.target.closest("[data-id]")?.dataset.id;
  if (id) void action({ action: "remove-image", id }).catch(showError);
});
elements.draft.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
});
document.querySelector(".surface").addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.querySelector(".surface").addEventListener("drop", (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) void addFiles(files);
});
window.addEventListener("keydown", (event) => {
  if (event.altKey && !event.metaKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    void attachImages(() => action({ action: "paste-image" }));
  }
});
elements.send.addEventListener("click", () => void sendMessage());
elements.start.addEventListener("click", async () => {
  if (busy || snapshot.connected) return;
  busy = true;
  updateButtons();
  try { await action({ action: "start" }); }
  catch (error) { showError(error); }
  finally { busy = false; updateButtons(); }
});
elements.stop.addEventListener("click", () => void action({ action: "interrupt" }).catch(showError));
elements.consoleScreen.addEventListener("click", () => {
  if (window.getSelection()?.isCollapsed && snapshot.connected) elements.draft.focus();
});
window.ccf?.onCompanion?.((value) => {
  receivedPush = true;
  snapshot = normalizeCompanionSnapshot(value);
  render();
});

const textSize = installCompanionTextSize({ onChange: scheduleResize });
const observer = new ResizeObserver(scheduleResize);
observer.observe(elements.consoleScreen);
document.fonts?.ready.then(scheduleResize);
window.addEventListener("beforeunload", () => { clearTimeout(resizeTimer); observer.disconnect(); textSize.dispose(); });
render();
window.ccf?.getCompanion?.().then((value) => {
  if (receivedPush) return;
  snapshot = normalizeCompanionSnapshot(value);
  render();
}).catch(showError);
