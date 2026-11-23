import { EventEmitter } from "node:events";
import { ServiceError } from "../../../packages/core/src/service-rpc.js";

// Main's side of the companion (process-split plan, step 4); the companion's side is companion-service.js, which main
// never loads (step 7, main-boundary.test.js).

// What main shows while the companion process is gone: the last snapshot, offline, with the reason. Uncertain
// submissions stay visible; nothing is started again until the user does.
function crashedSnapshot(snapshot, crash) {
  const base = snapshot ?? { backend: crash.backend ?? "claude", title: "Work companion", messages: [], liveText: "",
    attachments: [], watcher: { state: "disabled" } };
  return {
    ...base,
    connected: false, phase: "offline", switching: false, pendingPrompt: null, pendingPrompts: [], pendingRequests: [],
    terminal: { ...(base.terminal ?? {}), needed: false },
    claudeFolder: null,
    process: "crashed",
    error: `The companion process stopped (${crash.reason}). Start it again to resume; nothing was resent.`
  };
}

// Main's side of the companion. Status: idle (not started yet), starting, ready, crashed, stopped. snapshot(),
// activeClaudePath() and attachmentPinned() are synchronous queries: in-process they read the live session (`peek`),
// across a process boundary the last pushed snapshot. A host attaches a new endpoint after an explicit restart;
// listeners on the client stay.
export class CompanionClient extends EventEmitter {
  constructor({ endpoint = null, peek = null } = {}) {
    super();
    this.endpoint = null;
    this.peek = null;
    this.latest = null;
    this.info = null;
    this.crash = null;
    this.status = "idle";
    if (endpoint) this.attach(endpoint, { peek });
  }

  attach(endpoint, { peek = null } = {}) {
    this.endpoint = endpoint;
    this.peek = peek;
    this.crash = null;
    this.#setStatus("starting");
    const current = () => this.endpoint === endpoint;
    endpoint.on("change", (snapshot) => {
      if (!current()) return;
      this.latest = snapshot;
      this.emit("change", snapshot);
    });
    endpoint.on("watcher-change", (snapshot) => {
      if (!current()) return;
      if (snapshot) this.latest = snapshot;
      this.emit("watcher-change", snapshot);
    });
    endpoint.on("projection", (snapshot) => {
      if (!current()) return;
      if (snapshot) this.latest = snapshot;
      this.emit("projection", snapshot);
    });
    return this;
  }

  // The companion composed its backend: requests are served from now on.
  setReady(info = {}) {
    this.info = info ?? {};
    if (info?.snapshot !== undefined) this.latest = info.snapshot;
    this.#setStatus("ready");
    this.emit("change", this.snapshot());
  }

  // The companion process is gone (crash, kill) or was stopped. Its last snapshot stays visible, offline.
  detach(reason = "exited", { crashed = true } = {}) {
    if (!this.endpoint && this.status !== "starting") return;
    this.endpoint = null;
    this.peek = null;
    if (crashed) this.crash = { reason, at: new Date().toISOString(), backend: this.latest?.backend ?? null };
    this.#setStatus(crashed ? "crashed" : "stopped");
    this.emit("change", this.snapshot());
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  get hasDelivery() { return Boolean(this.info?.delivery); }

  snapshot() {
    if (this.status === "crashed") return crashedSnapshot(this.latest, this.crash);
    return this.peek && this.status === "ready" ? this.peek.snapshot() : this.latest;
  }

  // The Claude companion's folder while its PTY is connected (identifies its hooks), else null.
  activeClaudePath() { return this.status === "ready" ? this.snapshot()?.claudeFolder ?? null : null; }
  attachmentPinned(id) { return this.snapshot()?.pinnedAttachmentIds?.includes(id) ?? false; }

  request(method, params = null, options) {
    if (!this.endpoint) {
      return Promise.reject(this.status === "crashed"
        ? new ServiceError("The companion process stopped. Press Start to restart it.", "companion_crashed")
        : new ServiceError(`${method}: the companion is not running.`, "companion_unavailable"));
    }
    return this.endpoint.request(method, params, options);
  }

  // Main's settings, pushed to the companion when they change (it reads paths and backend choices from them).
  pushSettings(value) { if (this.endpoint && this.status === "ready") this.endpoint.emit("settings", value); }

  start(options) { return this.request("start", options); }
  submit(submission) { return this.request("submit", submission); }
  send(payload) { return this.request("send", payload); }
  addAttachment(payload) { return this.request("attachments.add", payload); }
  addAttachmentFiles(filePaths) { return this.request("attachments.addFiles", { filePaths }); }
  removeAttachment(id) { return this.request("attachments.remove", { id }); }
  selectBackend(backend) { return this.request("selectBackend", { backend }); }
  switchBackend(options) { return this.request("switchBackend", options); }
  resolveRequest(payload) { return this.request("resolveRequest", payload); }
  resolveUnknown(payload) { return this.request("resolveUnknown", payload); }
  history(payload) { return this.request("history", payload); }
  getOutput(payload) { return this.request("getOutput", payload); }
  stop(options = null) { return this.request("stop", options); }
  recoverFailedStart(options) { return this.request("recoverFailedStart", options); }
  write(text, { ptyId = null } = {}) { return this.request("write", { text, ptyId }); }
  interrupt() { return this.request("interrupt"); }
  resize(cols, rows) { return this.request("resize", { cols, rows }); }
  observeConversation(payload) { return this.request("observeConversation", payload); }
  recordAssistantMessage(text, options) { return this.request("recordAssistantMessage", { text, options }); }
  updatePresentation(payload) { return this.request("updatePresentation", payload); }
  dispose(options) { return this.request("dispose", null, options); }
  close(reason) { this.endpoint?.close(reason); }
}
