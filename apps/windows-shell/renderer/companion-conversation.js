import { normalizeCompanionSnapshot, normalizeSubmission, shouldSubmitOnKeydown, submissionStatusText, backendSwitchGuard } from "./companion-conversation-model.js";
import { hideClaudePromptBox, renderCompanionTerminal } from "./companion-terminal.js";
import { installCompanionTextSize } from "./companion-text-size.js";
import { promptKeySequence, terminalViewportSize } from "./companion-terminal-controls.js";
import { createStructuredConversation } from "./companion-structured.js";

const elements = Object.fromEntries(["title", "presence", "start", "prompt", "draft", "send", "stop", "shutdown", "endDay", "consoleScreen", "attach", "attachments", "requests", "jumpLatest", "submissionStatus", "backend", "uncertainActions", "reconnect", "acknowledgeUnknown", "loadOlder", "backendReason"]
  .map((id) => [id, document.getElementById(id)]));
const phaseLabels = { idle: "Ready", working: "Working", attention: "Needs input", offline: "Offline" };
let snapshot = normalizeCompanionSnapshot(null);
let terminalRevision = null;
let renderedBackend = null;
let busy = false;
let switchAttempted = false;
let receivedPush = false;
let resizeTimer;
let lastSize = "";
let attachmentKey = "";
let attaching = false;
let attachmentJobs = 0;
let attachmentQueue = Promise.resolve();
let localError = "";
let recoveredSubmission = null;
let historyCursor = null; let historyIdentity = ''; let loadingHistory = false; let viewingHistory = false; let historyGeneration = 0;
const measure = document.createElement("canvas").getContext("2d");
const structured = createStructuredConversation({container:elements.consoleScreen,requests:elements.requests,jump:elements.jumpLatest,action,onError:showError});

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

// After a relaunch, put the text of an uncertain Codex message back into an empty draft once.
function recoverUncertainDraft() {
  const submission = snapshot.submission;
  if (snapshot.backend !== 'codex' || submission?.state !== 'outcomeUnknown' || typeof submission.text !== 'string'
    || submission.id === recoveredSubmission || elements.draft.value) return;
  recoveredSubmission = submission.id;
  elements.draft.value = submission.text;
}

function scheduleResize() {
  if (snapshot.backend === "codex") return;
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
  const controlsBusy=busy||snapshot.switching;
  elements.start.hidden = snapshot.connected;
  elements.start.disabled = controlsBusy;
  const codexBlocked = snapshot.backend === "codex" && (snapshot.phase !== "idle" || snapshot.submission?.state === "outcomeUnknown");
  elements.send.disabled = controlsBusy || attaching || codexBlocked || !normalizeSubmission(elements.draft.value, snapshot.connected, snapshot.attachments);
  elements.send.title = codexBlocked ? "Wait for the current turn or resolve the uncertain message before sending." : "Send message";
  elements.attach.disabled = controlsBusy || attaching;
  const codex = snapshot.backend === 'codex';
  elements.stop.disabled = controlsBusy || !snapshot.connected || !(codex ? ["working", "attention"] : ["working"]).includes(snapshot.phase);
  elements.stop.textContent = codex ? 'Interrupt' : 'Stop';
  elements.shutdown.hidden = !codex || !snapshot.connected;
  elements.shutdown.disabled=controlsBusy;
  elements.endDay.hidden=snapshot.backend!=='codex';
  elements.endDay.disabled=controlsBusy||!snapshot.connected||snapshot.phase!=='idle'||['pending','outcomeUnknown'].includes(snapshot.submission?.state);
  elements.draft.disabled = !snapshot.connected && snapshot.backend !== 'codex';
  elements.backend.value = snapshot.backend;
  const guard=backendSwitchGuard(snapshot,{busy,attaching});
  elements.backend.disabled = snapshot.switching;
  elements.backend.title = 'Choose another companion backend';
  if (guard.allowed) switchAttempted = false;
  elements.backendReason.textContent = switchAttempted ? guard.reason : '';
  elements.backendReason.hidden = !switchAttempted;
}

// The live view holds the newest retained items (at most 500). Its resume cursor
// points just past them, unless the window was trimmed: then paging starts over at
// the newest saved page.
const LIVE_LIMIT = 500;
function olderCursor() {
  if (viewingHistory) return historyCursor ? { cursor: historyCursor } : null;
  if (snapshot.messages.length >= LIVE_LIMIT) return {};
  return snapshot.historyCursor ? { cursor: snapshot.historyCursor } : null;
}

function updateHistoryButton() {
  elements.loadOlder.hidden = snapshot.backend !== 'codex';
  elements.loadOlder.disabled = !snapshot.connected || loadingHistory || !olderCursor();
}

// Claude's own menu (in the terminal above) takes the keys only while the input is empty.
// Codex errors get their own recovery card in the conversation.
function renderPrompt() {
  const pending = snapshot.pendingPrompt;
  const empty = elements.draft.value.length === 0 && snapshot.attachments.length === 0;
  const howTo = snapshot.backend !== "claude" ? ""
    : empty ? " — choose in Claude's menu above with ↑ ↓ and Enter"
    : " — clear your input, then choose in Claude's menu above with ↑ ↓ and Enter";
  const notice = localError || (snapshot.errorInfo ? "" : snapshot.error) || (pending ? `${pending.label}${howTo}` : "");
  elements.prompt.textContent = notice;
  elements.prompt.classList.toggle("visible", Boolean(notice));
}

function render() {
  if (renderedBackend !== snapshot.backend) { terminalRevision = null; renderedBackend = snapshot.backend; elements.consoleScreen.replaceChildren(); }
  recoverUncertainDraft();
  const nextHistoryIdentity = `${snapshot.backend}:${snapshot.conversationId}:${snapshot.connectionEpoch}`;
  if (historyIdentity !== nextHistoryIdentity) { historyIdentity = nextHistoryIdentity; viewingHistory = false; historyCursor = null; historyGeneration++; }
  updateHistoryButton();
  elements.title.textContent = snapshot.title;
  document.body.dataset.backend = snapshot.backend;
  elements.presence.dataset.phase = snapshot.phase;
  elements.presence.textContent = phaseLabels[snapshot.phase];
  renderPrompt();
  elements.consoleScreen.classList.toggle("structured-screen", snapshot.backend === "codex");
  elements.consoleScreen.setAttribute("aria-label", snapshot.backend === "codex" ? `Codex conversation ${snapshot.conversationId ?? "not started"}` : "Live terminal screen");
  const submission = snapshot.submission;
  elements.uncertainActions.hidden = submission?.state !== 'outcomeUnknown';
  elements.reconnect.disabled = snapshot.connected || busy;
  elements.submissionStatus.textContent = submissionStatusText(snapshot);
  if (snapshot.backend === "codex") structured.update(snapshot);
  else {
  structured.suspend();
  elements.requests.hidden = true; elements.jumpLatest.hidden = true;
  const terminal = snapshot.terminal.screen || snapshot.terminal.lines.length || snapshot.terminal.history.length ? snapshot.terminal : {
    screen: snapshot.messages.map((message) => message.text).join("\n\n")
      || (snapshot.connected ? "Starting the companion…" : "Start the companion to begin.")
  };
  const revision = Number.isSafeInteger(terminal.revision) ? terminal.revision : null;
  if (revision === null || revision !== terminalRevision) {
    terminalRevision = revision;
    const scroller = elements.consoleScreen;
    const followsOutput = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const readingPosition = scroller.scrollTop;
    const lineHeight = parseFloat(getComputedStyle(scroller).lineHeight) || 1;
    const readingAnchor = followsOutput ? null : scroller.children[Math.floor(readingPosition / lineHeight)];
    const anchorTop = readingAnchor?.getBoundingClientRect().top;
    // The composer below replaces Claude's own input box; see hideClaudePromptBox.
    const changed = renderCompanionTerminal(scroller, terminal.lines ? { ...terminal, lines: hideClaudePromptBox(terminal.lines) } : terminal);
    if (changed) {
      if (followsOutput) scroller.scrollTop = scroller.scrollHeight;
      else if (readingAnchor?.parentNode === scroller) scroller.scrollTop += readingAnchor.getBoundingClientRect().top - anchorTop;
      else scroller.scrollTop = readingPosition;
    }
  }
  }
  renderAttachments();
  updateButtons();
  scheduleResize();
}

async function sendMessage() {
  const payload = normalizeSubmission(elements.draft.value, snapshot.connected, snapshot.attachments);
  if (!payload || busy || attaching || elements.send.disabled) return;
  const sentText = elements.draft.value;
  busy = true;
  updateButtons();
  try {
    const result = await action({ ...payload, submissionId: crypto.randomUUID() });
    if (snapshot.backend === "codex" && result?.submission?.state !== "accepted") {
      if (result?.submission?.state === "outcomeUnknown") showError("May have been sent. Your draft is retained; inspect the conversation before resending.");
      else if (result?.submission?.state === "rejected") showError(result.submission.reason || "Message rejected; your draft is retained.");
      return;
    }
    localError = "";
    // Text typed while the send was in flight stays.
    if (elements.draft.value === sentText) {
      elements.draft.value = "";
      elements.draft.style.height = "";
      renderPrompt();
    }
  } catch (error) { showError(error); }
  finally { busy = false; updateButtons(); if (!elements.draft.disabled) elements.draft.focus(); }
}

elements.draft.addEventListener("input", () => {
  localError = "";
  elements.draft.style.height = "auto";
  elements.draft.style.height = `${Math.min(elements.draft.scrollHeight, 154)}px`;
  renderPrompt();
  updateButtons();
});
elements.draft.addEventListener("keydown", (event) => {
  if (!snapshot.connected || busy || snapshot.switching) return;
  const raw = snapshot.backend === "claude" ? promptKeySequence(event, elements.draft.value.length === 0 && snapshot.attachments.length === 0) : null;
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
  if(snapshot.switching||busy)return Promise.resolve();
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
  if(snapshot.switching||busy)return;
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
elements.shutdown.addEventListener('click',() => void action({action:'stop'}).catch(showError));
elements.endDay.addEventListener('click',async()=>{
  if(elements.endDay.disabled)return;busy=true;updateButtons();
  try{await action({action:'end-day'});}catch(error){showError(error);}finally{busy=false;updateButtons();}
});
elements.backend.addEventListener('change',async()=>{
  const target=elements.backend.value;elements.backend.value=snapshot.backend;
  if(target===snapshot.backend||!['claude','codex'].includes(target))return;
  if(!backendSwitchGuard(snapshot,{busy,attaching}).allowed){switchAttempted=true;updateButtons();return;}
  busy=true;updateButtons();
  try{await action({action:'switch-backend',backend:target,userInitiated:true});localError='';}
  catch(error){showError(error);}
  finally{busy=false;updateButtons();}
});
elements.reconnect.addEventListener("click",() => {if(!snapshot.switching)void action({action:'start'}).catch(showError);});
elements.acknowledgeUnknown.addEventListener("click",() => void action({action:'resolve-unknown',submissionId:snapshot.submission?.id,disposition:'acknowledged'}).catch(showError));
elements.loadOlder.addEventListener('click',async () => {
  const from = olderCursor();
  if (elements.loadOlder.disabled || !from) return;
  loadingHistory = true; elements.loadOlder.disabled = true;
  const identity = historyIdentity;
  const generation = historyGeneration;
  try {
    const page = await action({action:'history',...from,limit:100});
    if (identity !== historyIdentity || generation !== historyGeneration) return;
    if (!Array.isArray(page.items)) throw new Error('The backend did not return a history page');
    historyCursor = page.nextCursor ?? null; viewingHistory = true; structured.showHistory(page.items);
  } catch (error) { showError(error); }
  finally { loadingHistory = false; updateHistoryButton(); }
});
elements.jumpLatest.addEventListener('click', () => {
  viewingHistory = false; historyGeneration++; historyCursor = null;
  updateHistoryButton();
});
elements.consoleScreen.addEventListener("click", (event) => {
  if (!window.getSelection()?.isCollapsed) return;
  const link = event.target.closest?.("[data-link]")?.dataset.link;
  if (link) { void action({ action: "open-link", url: link }).catch(showError); return; }
  if (snapshot.backend === "claude" && snapshot.connected) elements.draft.focus();
});
window.ccf?.onCompanion?.((value) => {
  receivedPush = true;
  snapshot = normalizeCompanionSnapshot(value, snapshot);
  render();
});

const textSize = installCompanionTextSize({ onChange: scheduleResize });
const observer = new ResizeObserver(scheduleResize);
observer.observe(elements.consoleScreen);
document.fonts?.ready.then(scheduleResize);
window.addEventListener("beforeunload", () => { clearTimeout(resizeTimer); observer.disconnect(); textSize.dispose(); structured.dispose(); });
render();
window.ccf?.getCompanion?.().then((value) => {
  if (receivedPush) return;
  snapshot = normalizeCompanionSnapshot(value, snapshot);
  render();
}).catch(showError);
