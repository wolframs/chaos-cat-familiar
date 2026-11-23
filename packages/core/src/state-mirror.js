// The consumer side of the core's state stream (process-split plan, step 5). Browser-safe (no Node imports): main's
// CoreClient and the renderers that subscribe over their own MessagePort use the same mirror. state-sync.js produces
// what it reads.
//
// Messages from the producer:
//   {kind: "projection", epoch, revision, state, counts, scalars, lastEvent, events}
//   {kind: "delta", epoch, revision, base, changes: {<collection>: {upsert: [entity], remove: [id], order?: [id]}},
//    counts: {<collection>: n}, scalars, lastEvent, events}
// Messages to the producer: {kind: "ack", revision}, {kind: "resync", reason, revision}.
//
// A delta applies only on top of exactly its base revision in the same epoch; a projection only at or after the mirror's
// revision in the same epoch, or in a newer one. Anything else is ignored (an older revision or an older epoch: stale or
// reordered) or answered with a resync request (a gap, a newer epoch without its
// projection, counts that disagree after applying); until the fresh projection arrives, deltas are ignored.

export const COLLECTIONS = Object.freeze(["sessions", "approvals", "notifications", "events", "logs"]);

export function emptyCoreState() {
  return { sessions: [], approvals: [], notifications: [], events: [], logs: [],
    notificationSummary: { unreadCount: 0, pendingApprovalHistoryCount: 0 },
    summary: { eventCount: 0, latestEventAt: null, logCount: 0, latestLogAt: null } };
}

export class StateMirror {
  // post(message): the way back to the producer (acks, resync requests). onState(state, info) after every applied
  // message; info = {revision, epoch, lastEvent, events, kind}. onResync(reason) when a resync was requested.
  constructor({ post = () => {}, onState = () => {}, onResync = () => {},
    onError = (error) => globalThis.reportError?.(error) } = {}) {
    this.post = post;
    this.onState = onState;
    this.onResync = onResync;
    this.onError = onError;
    this.epoch = null;
    this.revision = 0;
    this.waiting = true;          // no projection yet, or a resync is pending
    this.collections = Object.fromEntries(COLLECTIONS.map((name) => [name, { byId: new Map(), order: [] }]));
    this.scalars = {};
    this.cached = null;
    this.stats = { projections: 0, deltas: 0, ignored: 0, resyncs: 0 };
  }

  // Returns "applied", "ignored" or "resync".
  receive(message) {
    if (!message || typeof message !== "object") return "ignored";
    if (message.kind === "projection") return this.#projection(message);
    if (message.kind === "delta") return this.#delta(message);
    return "ignored";
  }

  // An older epoch's projection, or an older revision's in the same epoch (delayed or reordered), is stale (review of
  // step 5, P2: it rewound the mirror). The same revision applies: a resubscription with other topics starts there.
  #projection(message) {
    if (this.epoch !== null && (message.epoch < this.epoch
      || (message.epoch === this.epoch && message.revision < this.revision))) return this.#ignore();
    this.epoch = message.epoch;
    this.revision = message.revision;
    for (const name of COLLECTIONS) {
      const list = message.state?.[name] ?? [];
      const target = this.collections[name];
      target.byId = new Map(list.map((entity) => [entity.id, entity]));
      target.order = list.map((entity) => entity.id);
    }
    this.scalars = { ...(message.scalars ?? {}) };
    this.waiting = false;
    this.cached = null;
    this.stats.projections += 1;
    this.#emit(message);
    return "applied";
  }

  #delta(message) {
    if (this.waiting) return this.#ignore();
    if (message.epoch < this.epoch) return this.#ignore();
    if (message.epoch > this.epoch) return this.requestResync("epoch");
    if (message.revision <= this.revision) return this.#ignore();
    if (message.base !== this.revision) return this.requestResync("gap");
    for (const [name, change] of Object.entries(message.changes ?? {})) {
      const target = this.collections[name];
      if (!target) continue;
      for (const id of change.remove ?? []) target.byId.delete(id);
      for (const entity of change.upsert ?? []) target.byId.set(entity.id, entity);
      if (change.order) target.order = change.order.slice();
      else if (change.remove?.length) target.order = target.order.filter((id) => target.byId.has(id));
    }
    for (const [name, count] of Object.entries(message.counts ?? {})) {
      const target = this.collections[name];
      if (!target) continue;
      if (target.order.length !== count || target.byId.size !== count
        || target.order.some((id) => !target.byId.has(id))) return this.requestResync("counts");
    }
    this.scalars = { ...this.scalars, ...(message.scalars ?? {}) };
    this.revision = message.revision;
    this.cached = null;
    this.stats.deltas += 1;
    this.#emit(message);
    return "applied";
  }

  #ignore() {
    this.stats.ignored += 1;
    return "ignored";
  }

  #emit(message) {
    try {
      this.onState(this.state(), { revision: this.revision, epoch: this.epoch, kind: message.kind, topics: message.topics ?? null,
        lastEvent: message.lastEvent ?? null, events: message.events ?? [], eventsTruncated: message.eventsTruncated === true });
    } catch (error) {
      // A view that throws must not wedge the stream: the next message still applies.
      try { this.onError(error); } catch { /* reporting */ }
    }
  }

  // The reconstructed state (cached until the next applied message).
  state() {
    if (this.cached) return this.cached;
    const state = emptyCoreState();
    for (const name of COLLECTIONS) {
      const { byId, order } = this.collections[name];
      state[name] = order.map((id) => byId.get(id));
    }
    if (this.scalars.notificationSummary) state.notificationSummary = this.scalars.notificationSummary;
    if (this.scalars.summary) state.summary = this.scalars.summary;
    this.cached = state;
    return state;
  }

  ack(revision = this.revision) {
    try { this.post({ kind: "ack", revision }); } catch { /* the port closed: nothing waits for this ack any more */ }
  }

  requestResync(reason = "requested") {
    this.waiting = true;
    this.stats.resyncs += 1;
    try { this.post({ kind: "resync", reason, revision: this.revision }); } catch { /* port closed */ }
    try { this.onResync(reason); } catch { /* reporting */ }
    return "resync";
  }
}

// The consumer of whole replaceable frames (FrameStream): the newest frame of the newest epoch wins; older ones are
// ignored. ack() returns the producer's credit once the frame was drawn.
export class FrameMirror {
  constructor({ post = () => {}, onFrame = () => {}, onError = (error) => globalThis.reportError?.(error) } = {}) {
    Object.assign(this, { post, onFrame, onError });
    this.epoch = null;
    this.revision = 0;
    this.frame = null;
    this.stats = { frames: 0, ignored: 0 };
  }

  receive(message) {
    if (message?.kind !== "frame") return "ignored";
    if (this.epoch !== null && (message.epoch < this.epoch || (message.epoch === this.epoch && message.revision <= this.revision))) {
      this.stats.ignored += 1;
      return "ignored";
    }
    this.epoch = message.epoch;
    this.revision = message.revision;
    this.frame = message.frame;
    this.stats.frames += 1;
    try { this.onFrame(message.frame, { epoch: this.epoch, revision: this.revision }); }
    catch (error) { try { this.onError(error); } catch { /* reporting */ } }
    return "applied";
  }

  ack(revision = this.revision) {
    try { this.post({ kind: "ack", revision }); } catch { /* port closed */ }
  }
}
