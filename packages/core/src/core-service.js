import { CcfCoreController } from "./core-controller.js";
import { HookServer } from "./hook-server.js";
import { HookEventType } from "./event-types.js";
import { normalizeEvent } from "./models.js";
import { ServiceEndpoint, createInProcessPorts } from "./service-rpc.js";
import { CoreClient } from "./core-client.js";
import { LosslessQueue, StateHub } from "./state-sync.js";

const LAST_EVENT_FIELDS = ["id", "hookEventName", "sessionId", "conversationId", "backend", "lastAssistantMessage",
  "toolName", "toolUseId", "receivedAt"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What main does with the event that caused a change (companion identity and replies, the completion toast): never
// the tool input or response, which a process boundary would clone with every push.
export function summarizeLastEvent(event) {
  if (!event) return null;
  return Object.fromEntries(LAST_EVENT_FIELDS.map((key) => [key, event[key] ?? null]));
}

export function withSummary(state) {
  return { ...state, summary: { eventCount: state.events?.length ?? 0, latestEventAt: state.events?.[0]?.receivedAt ?? null } };
}

// Main's session logic, the tray and hotkeys need sessions, approvals and notifications. The event history and the log
// are most of the state (~0.7 MB of tool inputs and responses on 2026-11-05); the dashboard and diagnostics take them on
// their own ports, and main reads them by query when it must (process-split plan, step 7: main never subscribes to them).
export function overlayProjection(state) {
  return { ...withSummary(state), events: [], logs: [] };
}

// Native effects the core asks of main (process-split plan, "Ordering across ports"): a toast, showing the overlay.
// The controller calls these adapters; an effect waits here until the change it belongs to has been published and
// then carries that change's revision. Effects raised after the last change leave on the next turn of the loop with
// the current revision. Effects are lossless traffic (step 5): each is a request main acknowledges, at most `window`
// in flight, and a toast raised while `capacity` effects wait makes the ingestion that raised it wait too.
export class EffectOutbox {
  constructor({ schedule = (callback) => setImmediate(callback), window = 8, capacity = 256 } = {}) {
    this.pending = [];
    this.scheduled = false;
    this.schedule = schedule;
    this.window = window;
    this.capacity = capacity;
    this.queue = null;
    this.revision = () => 0;
    this.overlay = {
      showOverlay: () => this.push({ type: "show-overlay" }),
      updateOverlay: () => {},   // every change is published anyway
      hideOverlay: () => this.push({ type: "hide-overlay" })
    };
    this.notifier = {
      outbox: this,
      // An ingestion's toast spends the room its admission reserved (context.ticket); asking for more room while
      // holding that admission could wait forever (review of step 6, P1). Any other toast waits for room first.
      notify: async (notification, context = null) => {
        const ticket = context?.ticket ?? await this.ready();
        this.push({ type: "toast", notification }, ticket);
      }
    };
  }

  // deliver(effect) resolves once main acknowledged it; revision() is the revision effects raised now belong to.
  connect({ deliver, revision, onFailed = () => {} }) {
    this.revision = revision;
    this.queue = new LosslessQueue({ deliver, window: this.window, capacity: this.capacity, onFailed });
    this.flush();
  }

  // ticket: the room ready() reserved for this effect (LosslessQueue), spent when it is queued.
  push(effect, ticket = null) {
    this.pending.push({ effect, ticket });
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => { this.scheduled = false; this.flush(); });
  }

  flush() {
    if (!this.queue) return;
    const revision = this.revision();
    for (const { effect, ticket } of this.pending.splice(0)) this.queue.push({ ...effect, revision }, ticket).catch(() => {});
  }

  // Backpressure: resolves with a ticket once there is room for one more effect (null before main is connected).
  ready() { return this.queue?.ready() ?? Promise.resolve(null); }

  // Admission for an ingestion: room for everything it sends main (its observation, its toast) in one reservation; a
  // ticket at once when there is room (ingestion stays synchronous), else a promise of one.
  admit(slots = 1) {
    if (!this.queue) return null;
    return this.queue.tryReserve(slots) ?? this.queue.ready(slots);
  }

  // What main observes of an event (companion identity and replies): lossless, after the revision it belongs to.
  observe(event, ticket = null) { this.push({ type: "observe", event }, ticket); }
}

// Main's side of an effect, for hosts that hand effects to plain overlay/notifier objects (tests, replays).
export function applyEffect(effect, { overlay = null, notifier = null } = {}) {
  switch (effect?.type) {
    case "toast": return notifier?.notify(effect.notification);
    case "show-overlay": return overlay?.showOverlay?.();
    case "hide-overlay": return overlay?.hideOverlay?.();
    case "observe": return undefined;   // main's companion observer; hosts without one have nothing to do
    default: return undefined;
  }
}

// Main's own subscription (process-split plan, step 5): the base state as deltas. The event summaries main acts on
// (companion identity and replies) are observation effects, not frame content: a resync's projection would drop them.
export const MAIN_SUBSCRIPTION = Object.freeze({ id: "main", topics: ["base"], window: 16 });

// The core side of the boundary: the controller and the HookServer with its approval waiters stay together behind
// one endpoint. Main reaches them only through requests (CoreClient); the core reaches main for the /companion/*
// intents the same way. State leaves as versioned deltas per subscription (state-sync.js): main subscribes over this
// endpoint ("state" frames out, "state-control" acks and resync requests in); a window subscribes over a port of its
// own (subscribe()). Effects follow the change they belong to and carry its revision.
export function serveCore({ endpoint, controller, effects = null, createHookServer = (options) => new HookServer(options),
  defaultPort = 49152, logger = controller.logger, epoch = Date.now() }) {
  let hookServer = null;
  // /companion/* intents (status, open, bubble) are lossless too: answered one by one, a bounded number in flight; a
  // burst of HTTP requests waits for room instead of flooding main. A refusal from main is that request's answer; only
  // a closed transport fails the queue.
  const intentQueue = new LosslessQueue({ window: 4, capacity: 64,
    deliver: ({ method, payload }) => endpoint.request(method, payload).then((value) => ({ ok: true, value }), (error) => {
      if (error?.code === "service_closed") throw error;
      return { ok: false, error };
    }),
    onFailed: ({ method }, error) => logger?.warn?.("intent", "A companion intent could not reach main", {
      method, error: String(error?.message ?? error) }) });
  const intent = (method) => async (payload) => {
    const ticket = await intentQueue.ready();
    const answer = await intentQueue.push({ method, payload }, ticket);
    if (!answer.ok) throw answer.error;
    return answer.value;
  };
  const intents = { queue: intentQueue, status: intent("companion.status"), open: intent("companion.open"),
    bubble: intent("companion.bubble") };
  const hub = new StateHub({ source: () => controller.snapshot(), epoch, summarize: summarizeLastEvent,
    onError: (error, context) => logger?.warn?.("state", "A state subscriber went away", {
      subscriber: context?.id ?? null, error: String(error?.message ?? error) }) });

  // Every ingested event's summary reaches main as an observation effect (lossless, after its revision; review of step
  // 5, P1): frames coalesce and a resync's projection carries no summaries. An ingestion waits for room first.
  if (effects) controller.admission = (slots) => effects.admit(slots);
  controller.on("change", (_state, lastEvent, context) => {
    hub.publish(lastEvent);
    if (lastEvent && effects) effects.observe(summarizeLastEvent(lastEvent), context?.ticket ?? null);
    effects?.flush();
  });
  effects?.connect({ deliver: (effect) => endpoint.request("effect", effect), revision: () => hub.revision,
    onFailed: (effect, error) => logger?.warn?.("effect", "An effect could not reach main", {
      type: effect?.type ?? null, error: String(error?.message ?? error) }) });

  // Main's subscription rides on the endpoint; a new one (after a resubscribe) replaces the old.
  let mainSubscription = null;
  let mainControl = null;
  endpoint.on("state-control", (message) => mainControl?.(message));
  function subscribeMain(options) {
    mainSubscription?.close("resubscribed");
    mainSubscription = hub.subscribe({
      postMessage: (message) => {
        if (!endpoint.emit("state", message)) throw new Error("Main is not connected.");
      },
      onMessage: (listener) => { mainControl = listener; }
    }, options);
    return { epoch: hub.epoch, revision: hub.revision };
  }

  // Listens on the preferred port, falling back to a free one when it is taken (EADDRINUSE/EACCES). A restarted core
  // retries its previous port for a moment first (retryDelaysMs): the old process's listener may still be closing.
  async function startHookServer({ port, authToken, retryDelaysMs = [] }) {
    if (hookServer) throw new Error("The hook server is already running.");
    const preferredPort = Number.isFinite(port) && port >= 0 ? port : defaultPort;
    let lastError = null;
    for (const candidatePort of [preferredPort, 0]) {
      const delays = candidatePort === preferredPort && preferredPort !== 0 ? retryDelaysMs : [];
      for (let attempt = 0; ; attempt++) {
        const candidate = createHookServer({ controller, port: candidatePort, authToken,
          onCompanionStatus: intents.status, onCompanionOpen: intents.open, onCompanionBubble: intents.bubble });
        try {
          await candidate.start();
          hookServer = candidate;
          return { port: candidate.port, requestedPort: preferredPort, fallbackUsed: candidate.port !== preferredPort,
            attempts: attempt + 1 };
        } catch (error) {
          lastError = error;
          logger?.warn?.("hook-server", "Hook server listen failed", {
            requestedPort: candidatePort,
            code: error.code ?? null,
            error: String(error.message ?? error)
          });
          await candidate.stop().catch(() => {});
          if (!["EADDRINUSE", "EACCES"].includes(error.code) || candidatePort === 0) throw error;
          if (attempt >= delays.length) break;
          await sleep(delays[attempt]);
        }
      }
    }
    throw lastError;
  }

  // Stops intake: pending permission requests are released without a decision, then routine hooks drain.
  async function stopHookServer() {
    const server = hookServer;
    hookServer = null;
    await server?.stop();
    return true;
  }

  endpoint
    .handle("state", () => withSummary(controller.snapshot()))
    .handle("ingestHook", async ({ payload }) => {
      const event = normalizeEvent(payload);
      if (event.hookEventName === HookEventType.PERMISSION_REQUEST) await controller.enqueueApproval(event, () => {});
      else await controller.ingestEvent(event);
      return { ok: true };
    })
    .handle("resolveApproval", ({ id, decision, extra }) => Boolean(controller.resolveApproval(id, decision, extra ?? {})))
    .handle("restoreApproval", ({ id }) => { controller.restoreApproval(id); return true; })
    .handle("notificationAction", ({ action, id }) => {
      switch (action) {
        case "mark-read": return controller.markNotificationRead(id);
        case "dismiss": return controller.dismissNotification(id);
        case "mark-all-read": return controller.markAllNotificationsRead();
        default: return false;
      }
    })
    .handle("checkpoint", () => { controller.persistState(); return true; })
    .handle("state.subscribe", (options) => subscribeMain({ ...MAIN_SUBSCRIPTION, ...(options ?? {}), id: "main" }))
    .handle("state.query", ({ method, params }) => hub.query(method, params))
    .handle("startHookServer", startHookServer)
    .handle("stopHookServer", stopHookServer)
    .handle("idle", async () => { await hookServer?.idle(); return true; });

  return {
    hub,
    intents,
    effects,
    get hookServer() { return hookServer; },
    get revision() { return hub.revision; },
    get epoch() { return hub.epoch; },
    projection: () => overlayProjection(controller.snapshot()),
    // A window's own subscription over a port main handed over (bulk state bypasses main).
    subscribe: (port, options) => hub.subscribe(port, options),
    subscriptions: () => [...hub.subscriptions].map((item) => ({ id: item.id, topics: item.options.topics, ...item.stats,
      inflight: item.inflight.length })),
    startHookServer,
    stopHookServer
  };
}

// Core and client in one process, joined by in-process ports (synchronous, by reference). The client reads the
// controller's projection directly (`peek`), which is what keeps every in-process read identical to today; across a
// process boundary the client keeps the last projection the core pushed instead. Effects reach `overlay` and
// `notifier` through the same protocol a utility process uses.
export function createInProcessCore({ overlay, notifier, stateStore, settings, logger, createHookServer, onError,
  projectionOnly = false, createPorts = createInProcessPorts } = {}) {
  const [corePort, mainPort] = createPorts();
  const effects = new EffectOutbox();
  const controller = new CcfCoreController({ overlay: effects.overlay, notifier: effects.notifier, stateStore, settings,
    logger });
  const coreEndpoint = new ServiceEndpoint({ port: corePort, name: "core", onError });
  const mainEndpoint = new ServiceEndpoint({ port: mainPort, name: "main", onError });
  const service = serveCore({ endpoint: coreEndpoint, controller, effects, createHookServer });
  // projectionOnly: read pushed projections as a client in another process would (tests prove both paths agree).
  coreEndpoint.markReady({ state: service.projection(), revision: service.revision, epoch: service.epoch });
  const client = new CoreClient({ endpoint: mainEndpoint, peek: projectionOnly ? null : () => controller.snapshot(),
    onError });
  client.on("effect", (effect) => applyEffect(effect, { overlay, notifier }));
  return { client, service, controller };
}
