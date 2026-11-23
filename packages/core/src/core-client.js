import { EventEmitter } from "node:events";
import { ServiceError } from "./service-rpc.js";
import { StateMirror } from "./state-mirror.js";

const EMPTY_STATE = Object.freeze({ approvals: [], sessions: [], notifications: [], events: [], logs: [],
  notificationSummary: { unreadCount: 0, pendingApprovalHistoryCount: 0 }, summary: { eventCount: 0, latestEventAt: null } });

// Effects (toast, show overlay) carry the revision of the state they belong to. The gate applies one only after the
// view has applied that revision (process-split plan, "Ordering across ports"). CoreClient reaches a revision once its
// change listeners have returned, which is when main has sent that state to its windows; a view that defers drawing
// (step 5) reports reached() itself.
export class EffectGate {
  constructor(apply, { onError = () => {} } = {}) {
    this.apply = apply;
    this.onError = onError;
    this.reachedRevision = 0;
    this.held = [];
  }

  offer(effect) {
    if ((effect?.revision ?? 0) <= this.reachedRevision) this.#run(effect);
    else this.held.push(effect);
  }

  reached(revision) {
    this.reachedRevision = Math.max(this.reachedRevision, revision ?? 0);
    const due = this.held.filter((effect) => effect.revision <= this.reachedRevision);
    if (!due.length) return;
    this.held = this.held.filter((effect) => effect.revision > this.reachedRevision);
    for (const effect of due) this.#run(effect);
  }

  // A restarted core counts revisions from zero; effects of the old one are dropped, never replayed.
  reset() {
    this.reachedRevision = 0;
    this.held = [];
  }

  #run(effect) {
    try { this.apply(effect); } catch (error) { try { this.onError(error, { topic: "effect" }); } catch { /* reporting */ } }
  }
}

// Main's view of the core. Reads are projections (state(): main's mirror), everything else is an async request. Emits
// state(info) when main's mirror moved ({kind, revision, epoch, lastEvent}; kind "ready" after a boot, "detached"
// when the core went away), effect(effect) gated by revision, settings(payload) and status(status). A supervisor
// attaches a new endpoint after a core restart; listeners on the client stay.
//
// The state arrives as versioned deltas (state-sync.js, step 5) that a StateMirror applies. Since step 7 no listener
// is handed the whole state to pass on: windows take theirs on their own ports, and main reads its mirror for what it
// decides itself. Frames coalesce while main is busy and a resync starts from a projection, so the summary of every
// event comes separately, as an "observe" effect (lossless).
export class CoreClient extends EventEmitter {
  constructor({ endpoint = null, peek = null, onError = () => {} } = {}) {
    super();
    this.peek = peek;
    this.onError = onError;
    this.endpoint = null;
    this.projection = null;
    this.revision = 0;
    this.epoch = null;
    this.hookPort = null;
    this.status = "starting";
    this.intentHandlers = null;
    this.mirror = null;
    this.gate = new EffectGate((effect) => this.emit("effect", effect), { onError });
    if (endpoint) this.attach(endpoint, { peek });
  }

  attach(endpoint, { peek = this.peek } = {}) {
    this.endpoint = endpoint;
    this.peek = peek;
    this.revision = 0;
    this.gate.reset();
    const current = () => this.endpoint === endpoint;
    const mirror = new StateMirror({
      post: (message) => { if (current()) endpoint.emit("state-control", message); },
      onState: (state, info) => { if (current()) this.#applied(mirror, state, info); },
      onResync: (reason) => { if (current()) this.onError(new Error(`Core state resync (${reason}).`), { topic: "state" }); },
      onError: (error) => this.onError(error, { topic: "change" })
    });
    this.mirror = mirror;
    if (endpoint.peerInfo?.state) this.projection = endpoint.peerInfo.state;
    endpoint.whenReady().then((info) => {
      if (!current()) return;
      if (info?.state) this.projection ??= info.state;
      // A core that still has to boot says so; one that is serving already (in-process) is ready with its transport.
      if (info?.booted !== false && this.status !== "ready") this.#ready(info);
    }, () => {});
    endpoint.on("state", (frame) => { if (current()) mirror.receive(frame); });
    // Effects are acknowledged once main holds them (the gate applies each after its revision).
    endpoint.handle("effect", (effect) => { if (current()) this.gate.offer(effect); return true; });
    endpoint.on("settings", (payload) => { if (current()) this.emit("settings", payload); });
    // Intents that arrive before main registered its handlers wait for them, as they did for main's readiness.
    for (const [method, name] of [["companion.status", "companionStatus"], ["companion.open", "companionOpen"],
      ["companion.bubble", "companionBubble"]]) {
      endpoint.handle(method, async (payload, context) => (await this.#intentHandlers())[name](payload, context));
    }
    endpoint.markReady();
    return this;
  }

  #intentHandlers() {
    if (this.intentHandlers) return Promise.resolve(this.intentHandlers);
    this.intentsRegistered ??= new Promise((resolve) => { this.resolveIntents = resolve; });
    return this.intentsRegistered;
  }

  #applied(mirror, state, info) {
    // A projection that repeats what listeners have (the first one after boot, at the boot revision) is no change.
    const topics = (info.topics ?? []).join(",");
    const unchanged = info.kind === "projection" && info.revision === this.revision && info.epoch === this.epoch
      && topics === this.topics;
    this.projection = state;
    if (info.kind === "projection") this.topics = topics;
    this.revision = info.revision;
    this.epoch = info.epoch;
    if (info.eventsTruncated) {
      this.onError(new Error("Main fell so far behind that event summaries were coalesced away."), { topic: "state" });
    }
    try {
      if (!unchanged) this.emit("state", { kind: info.kind, revision: info.revision, epoch: info.epoch,
        lastEvent: info.lastEvent ?? null });
    }
    finally {
      this.gate.reached(info.revision);
      mirror.ack(info.revision);
    }
  }

  // The core has booted (its hook server listens and answered an authenticated probe).
  setReady(info = {}) {
    if (info.state) this.projection = info.state;
    this.revision = info.revision ?? this.revision;
    this.gate.reached(this.revision);
    this.#ready(info);
    this.emit("state", { kind: "ready", revision: this.revision, epoch: this.epoch, lastEvent: null });
  }

  // The core went away (crash, kill). Pending approvals drop from the projection: their HTTP waiters died with the
  // process, so a click could not reach Claude Code any more. The rest of the last projection stays visible.
  detach(reason = "core exited") {
    if (this.status === "recovering" || this.status === "stopped") return;
    this.status = "recovering";
    this.projection = { ...(this.projection ?? EMPTY_STATE), approvals: [] };
    this.gate.reset();
    this.emit("status", "recovering", { reason });
    this.emit("state", { kind: "detached", revision: this.revision, epoch: this.epoch, lastEvent: null });
  }

  markStopped() {
    this.status = "stopped";
    this.emit("status", "stopped", {});
  }

  #ready(info) {
    this.status = "ready";
    if (Number.isFinite(info?.port)) this.hookPort = info.port;
    // The ready state is the base projection at the core's current revision.
    if (info?.epoch !== undefined) this.epoch = info.epoch;
    this.topics = "base";
    this.emit("status", "ready", info ?? {});
    this.#subscribe();
  }

  // The state subscription starts once the core serves (a booting core has no hub yet). A restart starts a new one.
  #subscribe() {
    const endpoint = this.endpoint;
    if (!endpoint || endpoint.closed) return;
    endpoint.request("state.subscribe", {}).catch((error) => { if (this.endpoint === endpoint && !endpoint.closed) this.onError(error, { topic: "subscribe" }); });
  }

  whenReady() { return this.endpoint.whenReady(); }

  // The latest projection: read live in-process, otherwise the last one the core pushed.
  state() {
    return this.peek?.() ?? this.projection ?? EMPTY_STATE;
  }

  // Main's log lines go to the core's log file; false while no core is ready (the caller keeps them).
  sendLog(entries) {
    if (this.status !== "ready" || !this.endpoint || this.endpoint.closed) return false;
    return this.endpoint.emit("log", entries);
  }

  request(method, params = null, options) {
    if (!this.endpoint) return Promise.reject(new ServiceError(`${method}: no core is attached.`, "service_closed"));
    return this.endpoint.request(method, params, options);
  }

  #refuseWhileRecovering(method) {
    if (this.status !== "recovering") return null;
    return Promise.reject(new ServiceError(
      `${method}: the CCF core is restarting; approvals from before it stopped are gone.`, "core_recovering"));
  }

  query(options) { return this.request("state", null, options); }
  ingestHook(payload, options) { return this.request("ingestHook", { payload }, options); }
  resolveApproval(id, decision, extra = {}, options) {
    return this.#refuseWhileRecovering("resolveApproval") ?? this.request("resolveApproval", { id, decision, extra }, options);
  }
  restoreApproval(id, options) {
    return this.#refuseWhileRecovering("restoreApproval") ?? this.request("restoreApproval", { id }, options);
  }
  notificationAction(action, id, options) { return this.request("notificationAction", { action, id }, options); }
  checkpoint(options) { return this.request("checkpoint", null, options); }
  idle(options) { return this.request("idle", null, options); }

  // History and logs beyond what main's subscription holds, on demand.
  queryState(method, params = {}, options) { return this.request("state.query", { method, params }, options); }

  async startHookServer({ port, authToken }, options) {
    const result = await this.request("startHookServer", { port, authToken }, options);
    this.hookPort = result.port;
    return result;
  }

  async stopHookServer(options) {
    this.hookPort = null;
    return this.request("stopHookServer", null, options);
  }

  handleIntents({ companionStatus, companionOpen, companionBubble }) {
    this.intentHandlers = { companionStatus, companionOpen, companionBubble };
    this.resolveIntents?.(this.intentHandlers);
  }

  close(reason) { this.endpoint?.close(reason); }
}
