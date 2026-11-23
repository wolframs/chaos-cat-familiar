import { COLLECTIONS } from "./state-mirror.js";

// The producer side of state publication (process-split plan, step 5, "Publication"). Two traffic classes, never
// mixed:
// - Replaceable frames: StateHub (the core's state as versioned deltas) and FrameStream (whole frames such as the
//   companion's terminal screen). Each subscriber has a credit window of unacknowledged frames; while it is full,
//   changes coalesce, and a subscriber that falls behind gets one frame that brings it to the current revision instead
//   of a backlog. Nothing here waits for a consumer.
// - Lossless traffic: LosslessQueue (effects such as toasts, intents such as bubbles). Bounded, delivered in order,
//   each item acknowledged; producers wait for room (backpressure) instead of dropping.
//
// A port is anything with postMessage(message) and onMessage(listener); onClose(listener) and close() are optional.
// portAdapter() turns a worker_threads MessagePort, Electron's MessagePortMain or a DOM MessagePort into one.

const IMMUTABLE = new Set(["events", "logs"]);   // retained entries never change after they were recorded
// base: what the dashboard and diagnostics show; sessions + approvals: the overlay (step 7), which counts notifications.
const TOPICS = { base: ["sessions", "approvals", "notifications"], sessions: ["sessions"], approvals: ["approvals"],
  events: ["events"], logs: ["logs"] };
const EVENT_RING = 256;                           // per-revision event summaries kept for coalesced frames
export const DEFAULT_EVENT_LIMIT = 50;

// Every service boot gets a larger epoch than the one before: a consumer tells an older process's messages from a
// newer one's by it, also across a restart within the same millisecond.
let lastEpoch = 0;
export function nextEpoch(now = Date.now()) {
  lastEpoch = Math.max(now, lastEpoch + 1);
  return lastEpoch;
}
export const DEFAULT_LOG_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

export function portAdapter(port) {
  if (!port) throw new Error("No port to adapt.");
  const unwrap = (event) => (event && typeof event === "object" && "data" in event && "ports" in event ? event.data : event);
  const listen = (type, listener) => {
    if (typeof port.on === "function") port.on(type, listener);
    else port.addEventListener?.(type, listener);
  };
  return {
    raw: port,
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      listen("message", (event) => listener(unwrap(event)));
      port.start?.();
    },
    onClose(listener) { listen("close", listener); },
    close() { try { port.close?.(); } catch { /* closed already */ } }
  };
}

let fallbackIds = new WeakMap();
let fallbackSeq = 0;
function idOf(entity) {
  if (entity && (typeof entity.id === "string" || typeof entity.id === "number")) return entity.id;
  if (!entity || typeof entity !== "object") return `value:${JSON.stringify(entity)}`;
  if (!fallbackIds.has(entity)) fallbackIds.set(entity, `anon:${++fallbackSeq}`);
  return fallbackIds.get(entity);
}

function topicCollections(topics) {
  return [...new Set((topics ?? ["base"]).flatMap((topic) => TOPICS[topic] ?? []))];
}

function boundedLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_QUERY_LIMIT) : fallback;
}

export function summarizeEvent(event, fields) {
  if (!event) return null;
  return Object.fromEntries(fields.map((key) => [key, event[key] ?? null]));
}

// The core's state as versioned deltas. source() returns the controller's snapshot (sessions, approvals,
// notifications, events, logs, notificationSummary). publish() records a revision; every subscription then sends what
// changed for its topics when its window allows. epoch: a number that grows with every core boot (main's counter), so
// a consumer can tell an older process's messages from a newer one's.
export class StateHub {
  constructor({ source, epoch = Date.now(), summarize = (event) => event, onError = () => {} }) {
    this.source = source;
    this.epoch = epoch;
    this.summarize = summarize;
    this.onError = onError;
    this.revision = 0;
    this.versions = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
    this.tracked = null;
    this.trackedRevision = -1;
    this.lastEvent = null;
    this.eventRing = [];          // [{revision, event}] newest last
    this.ringFloor = 0;           // the newest revision whose summary left the ring
    this.subscriptions = new Set();
    this.stats = { publishes: 0, trackMs: 0 };
  }

  publish(lastEvent = null) {
    this.revision += 1;
    this.lastEvent = lastEvent ? this.summarize(lastEvent) : null;
    if (this.lastEvent) {
      this.eventRing.push({ revision: this.revision, event: this.lastEvent });
      if (this.eventRing.length > EVENT_RING) this.ringFloor = this.eventRing.shift().revision;
    }
    this.#track();
    this.stats.publishes += 1;
    for (const subscription of [...this.subscriptions]) subscription.changed();
    return this.revision;
  }

  // Entity versions: an entity keeps its revision while its content is unchanged. Retained events and log lines never
  // change, so their id is enough; sessions, approvals and notifications are compared by content.
  #track() {
    if (this.trackedRevision === this.revision) return this.tracked;
    const started = performance.now();
    const state = this.source() ?? {};
    const tracked = {};
    for (const name of COLLECTIONS) {
      const previous = this.versions[name];
      const next = new Map();
      const items = [];
      for (const entity of state[name] ?? []) {
        const id = idOf(entity);
        if (next.has(id)) continue;   // a duplicate id would make counts disagree forever: first one wins
        const fingerprint = IMMUTABLE.has(name) ? null : JSON.stringify(entity);
        const known = previous.get(id);
        const revision = known && known.fingerprint === fingerprint ? known.revision : this.revision;
        next.set(id, { fingerprint, revision });
        items.push({ id, revision, entity });
      }
      this.versions[name] = next;
      tracked[name] = items;
    }
    const logs = tracked.logs;
    tracked.scalars = {
      notificationSummary: state.notificationSummary ?? { unreadCount: 0, pendingApprovalHistoryCount: 0 },
      summary: {
        eventCount: tracked.events.length,
        latestEventAt: tracked.events[0]?.entity?.receivedAt ?? null,
        logCount: logs.length,
        latestLogAt: logs[0]?.entity?.timestamp ?? null,
        latestLogId: logs[0]?.id ?? null
      }
    };
    this.tracked = tracked;
    this.trackedRevision = this.revision;
    this.stats.trackMs += performance.now() - started;
    return tracked;
  }

  // What a subscriber with these options sees, as items with ids and revisions. Bounded: events and logs are windows.
  #items(options) {
    const tracked = this.#track();
    const limits = { events: options.eventLimit, logs: options.logLimit };
    return Object.fromEntries(options.collections.map((name) => {
      const items = tracked[name];
      return [name, limits[name] === undefined ? items : items.slice(0, limits[name])];
    }));
  }

  // The reference: what a subscriber's mirror must hold at the current revision (tests compare against it).
  view(options = {}) {
    const normalized = normalizeOptions(options);
    const items = this.#items(normalized);
    const tracked = this.#track();
    const state = { sessions: [], approvals: [], notifications: [], events: [], logs: [] };
    for (const [name, list] of Object.entries(items)) state[name] = list.map((item) => item.entity);
    return { ...state, notificationSummary: tracked.scalars.notificationSummary, summary: tracked.scalars.summary };
  }

  // Bulk reads on demand (dashboard history, diagnostics logs), bounded to what the core retains.
  query(method, params = {}) {
    const tracked = this.#track();
    const limit = boundedLimit(params?.limit, MAX_QUERY_LIMIT);
    if (method === "history") {
      const search = typeof params?.search === "string" ? params.search.toLowerCase() : "";
      const type = typeof params?.hookEventName === "string" && params.hookEventName !== "all" ? params.hookEventName : null;
      const matches = tracked.events.map((item) => item.entity).filter((event) =>
        (!type || event.hookEventName === type) && (!search || JSON.stringify(event).toLowerCase().includes(search)));
      return { revision: this.revision, total: tracked.events.length, matched: matches.length, events: matches.slice(0, limit) };
    }
    if (method === "logs") {
      const category = typeof params?.category === "string" ? params.category : null;
      const logs = tracked.logs.map((item) => item.entity).filter((entry) => !category || entry.category === category);
      return { revision: this.revision, total: tracked.logs.length, logs: logs.slice(0, limit) };
    }
    throw Object.assign(new Error(`Unknown state query ${method}.`), { code: "unknown_query" });
  }

  // Event summaries recorded after `revision` (oldest first); null when the ring no longer reaches back that far.
  eventsSince(revision) {
    if (revision < this.ringFloor) return null;
    return this.eventRing.filter((item) => item.revision > revision).map((item) => item.event);
  }

  subscribe(port, options = {}) {
    const subscription = new StateSubscription(this, port, normalizeOptions(options));
    this.subscriptions.add(subscription);
    subscription.start();
    return subscription;
  }

  close() {
    for (const subscription of [...this.subscriptions]) subscription.close("hub closed");
  }

  // used by StateSubscription
  _items(options) { return this.#items(options); }
  _scalars() { return this.#track().scalars; }
}

function normalizeOptions(options = {}) {
  const topics = Array.isArray(options.topics) && options.topics.length ? options.topics.filter((topic) => TOPICS[topic]) : ["base"];
  return {
    id: options.id ?? null,
    topics,
    collections: topicCollections(topics),
    eventLimit: boundedLimit(options.eventLimit, DEFAULT_EVENT_LIMIT),
    logLimit: boundedLimit(options.logLimit, DEFAULT_LOG_LIMIT),
    window: Number.isInteger(options.window) && options.window > 0 ? options.window : 2,
    events: options.events === true      // carry the event summaries of every revision since the last frame
  };
}

class StateSubscription {
  constructor(hub, port, options) {
    this.hub = hub;
    this.port = port;
    this.options = options;
    this.id = options.id;
    this.shadow = Object.fromEntries(options.collections.map((name) => [name, { revisions: new Map(), order: [] }]));
    this.sentRevision = 0;
    this.inflight = [];           // revisions sent and not acknowledged yet
    this.needProjection = true;
    this.dirty = true;
    this.closed = false;
    this.stats = { frames: 0, projections: 0, deltas: 0, coalesced: 0, resyncs: 0, queries: 0, maxInflight: 0 };
  }

  start() {
    this.port.onMessage((message) => this.#receive(message));
    this.port.onClose?.(() => this.close("port closed"));
    this.#pump();
  }

  changed() {
    if (this.closed) return;
    if (this.dirty && this.inflight.length >= this.options.window) this.stats.coalesced += 1;
    this.dirty = true;
    this.#pump();
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.hub.subscriptions.delete(this);
    this.port.close?.();
  }

  #receive(message) {
    if (this.closed || !message || typeof message !== "object") return;
    switch (message.kind) {
      case "ack":
        this.inflight = this.inflight.filter((revision) => revision > message.revision);
        this.#pump();
        break;
      case "resync":
        // The consumer dropped its state: whatever is in flight will be ignored there, so the window is free.
        this.stats.resyncs += 1;
        this.needProjection = true;
        this.inflight = [];
        this.#pump();
        break;
      case "query":
        this.stats.queries += 1;
        try {
          const result = this.hub.query(message.method, message.params);
          this.#send({ kind: "result", id: message.id, ok: true, result });
        } catch (error) {
          this.#send({ kind: "result", id: message.id, ok: false, error: { message: String(error?.message ?? error), code: error?.code ?? null } });
        }
        break;
      case "unsubscribe":
        this.close("unsubscribed");
        break;
      default:
        break;
    }
  }

  #pump() {
    if (this.closed || (!this.dirty && !this.needProjection)) return;
    if (this.inflight.length >= this.options.window) return;   // coalesce: the next frame covers everything since
    const frame = this.needProjection ? this.#projection() : this.#delta();
    // Bookkeeping before the send: an in-process port delivers synchronously, and the consumer's ack can arrive (and
    // pump again) before postMessage returns.
    this.inflight.push(frame.revision);
    this.stats.maxInflight = Math.max(this.stats.maxInflight, this.inflight.length);
    this.stats.frames += 1;
    this.sentRevision = frame.revision;
    this.dirty = false;
    this.needProjection = false;
    this.#send(frame);
  }

  #send(message) {
    try {
      this.port.postMessage(message);
      return true;
    } catch (error) {
      this.hub.onError(error, { topic: "subscription", id: this.id });
      this.close("send failed");
      return false;
    }
  }

  #frame(kind) {
    const frame = { kind, epoch: this.hub.epoch, revision: this.hub.revision, scalars: this.hub._scalars(),
      lastEvent: this.hub.lastEvent };
    if (this.options.events) {
      const events = this.hub.eventsSince(this.sentRevision);
      frame.events = events ?? this.hub.eventRing.map((item) => item.event);
      if (events === null) frame.eventsTruncated = true;
    }
    return frame;
  }

  #projection() {
    const items = this.hub._items(this.options);
    const state = {};
    const counts = {};
    for (const [name, list] of Object.entries(items)) {
      state[name] = list.map((item) => item.entity);
      counts[name] = list.length;
      this.shadow[name] = { revisions: new Map(list.map((item) => [item.id, item.revision])), order: list.map((item) => item.id) };
    }
    this.stats.projections += 1;
    // A fresh projection carries no event summaries from before it (a new consumer starts from now).
    return { ...this.#frame("projection"), topics: this.options.topics, state, counts, events: [] };
  }

  #delta() {
    const items = this.hub._items(this.options);
    const changes = {};
    const counts = {};
    for (const [name, list] of Object.entries(items)) {
      const shadow = this.shadow[name];
      const present = new Set();
      const upsert = [];
      for (const item of list) {
        present.add(item.id);
        if (shadow.revisions.get(item.id) !== item.revision) upsert.push(item.entity);
      }
      const remove = shadow.order.filter((id) => !present.has(id));
      const order = list.map((item) => item.id);
      const orderChanged = order.length !== shadow.order.length || order.some((id, index) => id !== shadow.order[index]);
      if (upsert.length || remove.length || orderChanged) {
        changes[name] = { upsert, remove, ...(orderChanged ? { order } : {}) };
      }
      counts[name] = list.length;
      this.shadow[name] = { revisions: new Map(list.map((item) => [item.id, item.revision])), order };
    }
    this.stats.deltas += 1;
    return { ...this.#frame("delta"), base: this.sentRevision, changes, counts };
  }
}

// Whole replaceable frames (the companion's snapshot with its terminal screen). Each subscriber gets the latest frame
// when its window allows; frames in between are never queued.
export class FrameStream {
  constructor({ epoch = Date.now(), onError = () => {} } = {}) {
    this.epoch = epoch;
    this.onError = onError;
    this.revision = 0;
    this.latest = null;
    this.subscriptions = new Set();
  }

  publish(frame) {
    this.revision += 1;
    this.latest = frame;
    for (const subscription of [...this.subscriptions]) subscription.pump();
    return this.revision;
  }

  subscribe(port, { window = 2, id = null } = {}) {
    const stream = this;
    const subscription = {
      id, port, window, inflight: [], sentRevision: 0, closed: false,
      stats: { frames: 0, coalesced: 0, maxInflight: 0 },
      pump() {
        if (this.closed || stream.latest === null || this.sentRevision === stream.revision) return;
        if (this.inflight.length >= this.window) { this.stats.coalesced += 1; return; }
        // Bookkeeping first: a synchronous port can deliver the ack before postMessage returns.
        this.inflight.push(stream.revision);
        this.stats.maxInflight = Math.max(this.stats.maxInflight, this.inflight.length);
        this.stats.frames += 1;
        this.sentRevision = stream.revision;
        try {
          port.postMessage({ kind: "frame", epoch: stream.epoch, revision: stream.revision, frame: stream.latest });
        } catch (error) {
          stream.onError(error, { topic: "frames", id });
          this.close();
        }
      },
      close() {
        if (this.closed) return;
        this.closed = true;
        stream.subscriptions.delete(this);
        port.close?.();
      }
    };
    port.onMessage((message) => {
      if (subscription.closed || !message) return;
      if (message.kind === "ack") {
        subscription.inflight = subscription.inflight.filter((revision) => revision > message.revision);
        subscription.pump();
      } else if (message.kind === "resync") {
        subscription.inflight = [];
        subscription.sentRevision = 0;
        subscription.pump();
      } else if (message.kind === "unsubscribe") subscription.close();
    });
    port.onClose?.(() => subscription.close());
    this.subscriptions.add(subscription);
    subscription.pump();
    return subscription;
  }

  close() {
    for (const subscription of [...this.subscriptions]) subscription.close();
  }
}

// Lossless, ordered, acknowledged, bounded. deliver(item) returns a promise that settles when the consumer
// acknowledged the item. At most `window` items are in flight. push() never drops. Producers that must not outrun the
// consumer ask ready() first: it resolves with a ticket that reserves room for one item (granted one producer at a time,
// in the order they asked, so concurrent producers never hold more than `capacity` between them; review of step 5, P1),
// and push(item, ticket) turns the reservation into the item; ticket.release() gives unused room back. push() without
// a ticket is never refused either, but is not bounded. A delivery that fails (the transport closed) fails that item and
// every item behind it; they are reported to onFailed, never retried silently or reordered.
// A producer that sends several items for one unit of work reserves them together (ready(slots)): reserving them one
// after another lets concurrent producers each hold part of what they need and wait forever for the rest (review of
// step 6, P1). Each push(item, ticket) spends one slot; release() gives back what is left.
const SPENT_TICKET = Object.freeze({ release() {} });

export class LosslessQueue {
  constructor({ deliver, window = 8, capacity = 256, onFailed = () => {} }) {
    this.deliver = deliver;
    this.window = window;
    this.capacity = capacity;
    this.onFailed = onFailed;
    this.waiting = [];            // [{item, resolve, reject}]
    this.inflight = 0;
    this.roomWaiters = [];        // [{slots, resolve}], in the order producers asked
    this.reserved = new Map();    // ticket -> slots it still holds for items not pushed yet
    this.reservedSlots = 0;
    this.failed = null;
    this.stats = { pushed: 0, delivered: 0, failed: 0, maxWaiting: 0, maxInflight: 0, backpressured: 0 };
  }

  get size() { return this.waiting.length + this.inflight; }

  // Resolves with the consumer's answer once the item was acknowledged. ticket: from ready(); `true` spends the oldest
  // reservation still held (for producers whose admission and push happen in different places).
  push(item, ticket = null) {
    this.#spend(ticket === true ? this.reserved.keys().next().value ?? null : ticket);
    if (this.failed) {
      this.stats.failed += 1;
      this.onFailed(item, this.failed);
      return Promise.reject(this.failed);
    }
    this.stats.pushed += 1;
    return new Promise((resolve, reject) => {
      this.waiting.push({ item, resolve, reject });
      this.stats.maxWaiting = Math.max(this.stats.maxWaiting, this.waiting.length);
      this.#pump();
    });
  }

  // A ticket now if there is room and nobody is waiting for it, else null (the caller then waits on ready()).
  tryReserve(slots = 1) {
    if (this.failed) return SPENT_TICKET;
    const wanted = this.#slots(slots);
    return !this.roomWaiters.length && this.#fits(wanted) ? this.#reserve(wanted) : null;
  }

  // Backpressure: resolves with a ticket once there is room for this producer's items (`slots` of them, together).
  ready(slots = 1) {
    if (this.failed) return Promise.resolve(SPENT_TICKET);   // push() reports the failure
    const wanted = this.#slots(slots);
    if (!this.roomWaiters.length && this.#fits(wanted)) return Promise.resolve(this.#reserve(wanted));
    this.stats.backpressured += 1;
    return new Promise((resolve) => this.roomWaiters.push({ slots: wanted, resolve }));
  }

  #slots(slots) { return Math.min(Math.max(1, Number.isInteger(slots) ? slots : 1), this.capacity); }

  #occupied() { return this.waiting.length + this.reservedSlots; }

  #fits(slots) { return this.#occupied() + slots <= this.capacity; }

  #reserve(slots) {
    const ticket = { release: () => {
      const left = this.reserved.get(ticket);
      if (!left) return;
      this.reserved.delete(ticket);
      this.reservedSlots -= left;
      this.#grant();
    } };
    this.reserved.set(ticket, slots);
    this.reservedSlots += slots;
    return ticket;
  }

  // One slot of the ticket becomes an item.
  #spend(ticket) {
    const left = ticket ? this.reserved.get(ticket) : undefined;
    if (!left) return false;
    if (left > 1) this.reserved.set(ticket, left - 1);
    else this.reserved.delete(ticket);
    this.reservedSlots -= 1;
    return true;
  }

  #grant() {
    while (this.roomWaiters.length && this.#fits(this.roomWaiters[0].slots)) {
      const { slots, resolve } = this.roomWaiters.shift();
      resolve(this.#reserve(slots));
    }
  }

  #pump() {
    while (!this.failed && this.inflight < this.window && this.waiting.length) {
      const entry = this.waiting.shift();
      this.inflight += 1;
      this.stats.maxInflight = Math.max(this.stats.maxInflight, this.inflight);
      let delivered;
      try { delivered = Promise.resolve(this.deliver(entry.item)); }
      catch (error) { delivered = Promise.reject(error); }
      delivered.then((value) => {
        this.inflight -= 1;
        this.stats.delivered += 1;
        entry.resolve(value);
        this.#pump();
      }, (error) => {
        this.inflight -= 1;
        this.#fail(error, entry);
      });
    }
    this.#grant();
  }

  #fail(error, entry) {
    this.failed ??= error;
    for (const failed of [entry, ...this.waiting.splice(0)]) {
      this.stats.failed += 1;
      try { this.onFailed(failed.item, error); } catch { /* reporting */ }
      failed.reject(error);
    }
    this.reserved.clear();
    this.reservedSlots = 0;
    for (const { resolve } of this.roomWaiters.splice(0)) resolve(SPENT_TICKET);
  }
}
