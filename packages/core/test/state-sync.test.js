// State publication (process-split plan, step 5): versioned deltas with explicit upserts, removals and counts, a bounded
// initial projection, resync after gaps, reordering, stale epochs and restarts; replaceable frames with a credit window
// that coalesce for a slow consumer; lossless queues that wait instead of dropping. The reference for every
// reconstruction is the hub's own view of the controller's current state.
import test from "node:test";
import assert from "node:assert/strict";
import { Worker, MessageChannel } from "node:worker_threads";
import { CcfCoreController } from "../src/core-controller.js";
import { InMemoryLogger } from "../src/logger.js";
import { normalizeEvent } from "../src/models.js";
import { createClonedPorts } from "../src/service-rpc.js";
import { FrameStream, LosslessQueue, StateHub, portAdapter } from "../src/state-sync.js";
import { FrameMirror, StateMirror } from "../src/state-mirror.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 6) { for (let i = 0; i < rounds; i++) await tick(); }

function controllerFixture() {
  const logger = new InMemoryLogger(200);
  const controller = new CcfCoreController({ overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} },
    settings: { load: () => ({}) }, logger });
  return { controller, logger };
}

function hubFor(controller, { epoch = 1 } = {}) {
  const hub = new StateHub({ source: () => controller.snapshot(), epoch });
  controller.on("change", (_state, event) => hub.publish(event));
  return hub;
}

// A port pair whose hub side can drop, hold back or rewrite frames before they cross (structured clone, async).
function faultyPorts() {
  const [hubSide, mirrorSide] = createClonedPorts();
  const faults = { drop: new Set(), hold: null, rewrite: null, sent: 0, log: [] };
  const port = {
    postMessage(message) {
      faults.sent += 1;
      faults.log.push(message);
      if (faults.drop.has(faults.sent)) return;
      if (faults.hold?.at === faults.sent) { faults.hold.message = message; return; }
      hubSide.postMessage(faults.rewrite ? faults.rewrite(message, faults.sent) : message);
      if (faults.hold?.releaseAfter === faults.sent && faults.hold.message) hubSide.postMessage(faults.hold.message);
    },
    onMessage: (listener) => hubSide.onMessage(listener)
  };
  return { port, mirrorSide, faults };
}

function mirrorOn(port, { autoAck = true } = {}) {
  const seen = [];
  const mirror = new StateMirror({ post: (message) => port.postMessage(message),
    onState: (_state, info) => { seen.push(info); if (autoAck) mirror.ack(info.revision); } });
  port.onMessage((message) => mirror.receive(message));
  return { mirror, seen };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function assertMirrors(mirror, hub, options, message) {
  assert.equal(mirror.revision, hub.revision, `${message}: revision`);
  assert.deepEqual(plain(mirror.state()), plain(hub.view(options)), `${message}: state`);
}

// A small deterministic PRNG so a failing sequence can be replayed.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

async function randomOperation(controller, next, index) {
  const sessionId = `s-${Math.floor(next() * 12)}`;
  const roll = next();
  const event = (fields) => normalizeEvent({ session_id: sessionId, cwd: `C:/work/${sessionId}`, ...fields });
  if (roll < 0.35) return controller.ingestEvent(event({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `t-${index}`, tool_input: { command: `echo ${index}` } }));
  if (roll < 0.5) return controller.ingestEvent(event({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `t-${index - 1}` }));
  if (roll < 0.6) return controller.ingestEvent(event({ hook_event_name: "SessionStart" }));
  if (roll < 0.66) return controller.ingestEvent(event({ hook_event_name: "Stop", last_assistant_message: `done ${index}` }));
  if (roll < 0.7) return controller.ingestEvent(event({ hook_event_name: "SessionEnd" }));
  if (roll < 0.78) return controller.enqueueApproval(event({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_use_id: `p-${index}`, tool_input: { file_path: `f${index}` } }), () => {});
  const approvals = controller.snapshot().approvals;
  if (roll < 0.85 && approvals.length) return controller.resolveApproval(approvals[Math.floor(next() * approvals.length)].id, next() < 0.3 ? "defer" : "allow");
  if (roll < 0.88 && approvals.some((item) => item.collapsed)) return controller.restoreApproval(approvals.find((item) => item.collapsed).id);
  const notifications = controller.notifications;
  if (roll < 0.94 && notifications.length) return controller.markNotificationRead(notifications[Math.floor(next() * notifications.length)].id);
  if (notifications.length) return controller.dismissNotification(notifications[Math.floor(next() * notifications.length)].id);
  return controller.markAllNotificationsRead();
}

test("a subscriber's mirror equals the reference after every change of a long random sequence", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const options = { topics: ["base", "events", "logs"], eventLimit: 30, logLimit: 40 };
  const [hubSide, mirrorSide] = createClonedPorts();
  const { mirror } = mirrorOn(mirrorSide);
  hub.subscribe(hubSide, options);
  const next = random(20261105);
  for (let index = 0; index < 400; index++) {
    await randomOperation(controller, next, index);
    await settle();
    assertMirrors(mirror, hub, options, `after operation ${index}`);
  }
  assert.ok(controller.events.length >= 200, "retention pruned events along the way");
  assert.ok(mirror.stats.deltas > 300, "it followed by deltas");
  assert.equal(mirror.stats.projections, 1, "one projection, at the start");
  assert.equal(mirror.stats.resyncs, 0);
  const sessionDeltas = hub.subscriptions.size;
  assert.equal(sessionDeltas, 1);
});

test("deltas carry only what changed, with counts; the initial projection is bounded", async () => {
  const { controller } = controllerFixture();
  for (let i = 0; i < 120; i++) await controller.ingestEvent(normalizeEvent({ hook_event_name: "PreToolUse", session_id: `s-${i % 5}`, tool_name: "Bash", tool_use_id: `t-${i}`, tool_input: { command: "x".repeat(2000) } }));
  const hub = hubFor(controller);
  const { port, mirrorSide, faults } = faultyPorts();
  const { mirror } = mirrorOn(mirrorSide);
  hub.subscribe(port, { topics: ["base", "events"], eventLimit: 10 });
  await settle();
  const [projection] = faults.log;
  assert.equal(projection.kind, "projection");
  assert.equal(projection.state.events.length, 10, "only the newest 10 of 120 events");
  assert.equal(projection.state.logs, undefined, "no logs topic, no logs");
  assert.deepEqual(projection.counts, { sessions: 5, approvals: 0, notifications: 0, events: 10 });
  assert.equal(projection.scalars.summary.eventCount, 120);

  await controller.ingestEvent(normalizeEvent({ hook_event_name: "PostToolUse", session_id: "s-2", tool_name: "Bash", tool_use_id: "t-117" }));
  await settle();
  const delta = faults.log.at(-1);
  assert.equal(delta.kind, "delta");
  assert.equal(delta.base, projection.revision);
  assert.deepEqual(delta.changes.sessions.upsert.map((session) => session.id), ["s-2"], "one session changed");
  assert.deepEqual(delta.changes.sessions.remove, []);
  assert.equal(delta.changes.sessions.order, undefined, "the session order did not change");
  assert.equal(delta.changes.events.upsert.length, 1, "one new event");
  assert.equal(delta.changes.events.remove.length, 1, "one left the window");
  assert.equal(delta.changes.events.order.length, 10);
  assert.equal(delta.changes.approvals, undefined, "untouched collections are left out");
  assert.deepEqual(delta.counts, { sessions: 5, approvals: 0, notifications: 0, events: 10 });
  assertMirrors(mirror, hub, { topics: ["base", "events"], eventLimit: 10 }, "after one delta");
});

test("history and logs beyond the window load on demand, filtered and bounded", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  for (let i = 0; i < 30; i++) {
    await controller.ingestEvent(normalizeEvent({ hook_event_name: i % 3 ? "PreToolUse" : "Stop", session_id: "s-1", tool_name: "Bash", tool_use_id: `t-${i}`, tool_input: { command: i === 7 ? "needle" : "hay" } }));
  }
  assert.equal(hub.query("history", {}).events.length, 30);
  assert.deepEqual(hub.query("history", { search: "NEEDLE" }).events.map((event) => event.toolUseId), ["t-7"]);
  assert.equal(hub.query("history", { hookEventName: "Stop" }).matched, 10);
  assert.equal(hub.query("history", { limit: 5 }).events.length, 5);
  assert.equal(hub.query("history", { limit: 5000 }).events.length, 30, "limits are capped at what is retained");
  assert.ok(hub.query("logs", { category: "hook" }).logs.every((entry) => entry.category === "hook"));
  assert.throws(() => hub.query("everything"), /Unknown state query/);

  // Through a subscription port, as a renderer asks.
  const [hubSide, mirrorSide] = createClonedPorts();
  hub.subscribe(hubSide, { topics: ["base"] });
  const results = [];
  mirrorSide.onMessage((message) => { if (message.kind === "result") results.push(message); });
  mirrorSide.postMessage({ kind: "query", id: 1, method: "history", params: { search: "needle" } });
  mirrorSide.postMessage({ kind: "query", id: 2, method: "nope" });
  await settle();
  assert.equal(results[0].ok, true);
  assert.equal(results[0].result.events.length, 1);
  assert.equal(results[1].ok, false);
});

test("subscribing while changes are published in the same turn starts from a projection and misses nothing", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const options = { topics: ["base", "events"], eventLimit: 50 };
  const mirrors = [];
  // Subscriptions interleaved with synchronous publishes: none of their frames has crossed yet.
  for (let i = 0; i < 5; i++) {
    const [hubSide, mirrorSide] = createClonedPorts();
    mirrors.push(mirrorOn(mirrorSide).mirror);
    hub.subscribe(hubSide, options);
    controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `race-${i}` }));
  }
  await settle(10);
  for (const [index, mirror] of mirrors.entries()) assertMirrors(mirror, hub, options, `subscriber ${index}`);
  assert.ok(mirrors.every((mirror) => mirror.stats.resyncs === 0));
});

test("a lost frame is a gap: the mirror asks for a resync and catches up from a fresh projection", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const { port, mirrorSide, faults } = faultyPorts();
  faults.drop.add(3);
  const { mirror } = mirrorOn(mirrorSide);
  const subscription = hub.subscribe(port, { topics: ["base", "events"] });
  for (let i = 0; i < 6; i++) {
    await controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `gap-${i}` }));
    await settle();
  }
  assert.equal(mirror.stats.resyncs, 1);
  assert.equal(subscription.stats.projections, 2, "the first one and the resync");
  assertMirrors(mirror, hub, { topics: ["base", "events"] }, "after the gap");
});

test("reordered frames: the later one is a gap, the earlier one arrives stale and is ignored", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const { port, mirrorSide, faults } = faultyPorts();
  faults.hold = { at: 2, releaseAfter: 3 };   // frame 2 crosses after frame 3
  const { mirror } = mirrorOn(mirrorSide, { autoAck: true });
  hub.subscribe(port, { window: 4 });
  for (let i = 0; i < 4; i++) controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `order-${i}` }));
  await settle(10);
  for (let i = 0; i < 2; i++) { await controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `after-${i}` })); await settle(); }
  assert.equal(mirror.stats.resyncs, 1);
  assert.ok(mirror.stats.ignored >= 1, "the late frame was ignored");
  assertMirrors(mirror, hub, {}, "after reordering");
});

test("counts that disagree after applying a delta force a resync", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const { port, mirrorSide, faults } = faultyPorts();
  // Frame 3 loses its upserts on the way: the mirror would silently miss a session without the counts.
  faults.rewrite = (message, sent) => sent === 3 ? { ...message, changes: { ...message.changes, sessions: { ...message.changes.sessions, upsert: [] } } } : message;
  const { mirror } = mirrorOn(mirrorSide);
  hub.subscribe(port);
  for (let i = 0; i < 4; i++) { await controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `count-${i}` })); await settle(); }
  assert.equal(mirror.stats.resyncs, 1);
  assertMirrors(mirror, hub, {}, "after the bad delta");
});

test("epochs: an older process's frames are ignored, a newer one's delta waits for its projection, a restart resyncs", async () => {
  const sent = [];
  const mirror = new StateMirror({ post: (message) => sent.push(message) });
  const projection = (epoch, revision, ids) => ({ kind: "projection", epoch, revision, counts: { sessions: ids.length },
    state: { sessions: ids.map((id) => ({ id })) }, scalars: {} });
  // Appends one session to `before`.
  const delta = (epoch, base, revision, id, before = []) => ({ kind: "delta", epoch, base, revision,
    counts: { sessions: before.length + 1 }, changes: { sessions: { upsert: [{ id }], remove: [], order: [...before, id] } }, scalars: {} });
  assert.equal(mirror.receive(delta(2, 0, 1, "early")), "ignored", "a delta before any projection");
  assert.equal(mirror.receive(projection(2, 5, ["s0"])), "applied");
  assert.equal(mirror.receive(delta(1, 5, 6, "old")), "ignored", "an older epoch's delta");
  assert.equal(mirror.receive(projection(1, 9, ["x"])), "ignored", "an older epoch's projection");
  assert.deepEqual(mirror.state().sessions, [{ id: "s0" }]);
  // A restarted core counts from zero again in a newer epoch.
  assert.equal(mirror.receive(delta(3, 0, 1, "s1")), "resync", "a newer epoch's delta without its projection");
  assert.deepEqual(sent.at(-1), { kind: "resync", reason: "epoch", revision: 5 });
  assert.equal(mirror.receive(delta(3, 0, 1, "s1")), "ignored", "deltas wait for the projection");
  assert.equal(mirror.receive(projection(3, 1, ["s0", "s1"])), "applied", "a lower revision in a newer epoch");
  assert.equal(mirror.receive(delta(3, 1, 2, "s2", ["s0", "s1"])), "applied");
  assert.equal(mirror.receive(delta(3, 1, 2, "s2", ["s0", "s1"])), "ignored", "a duplicate");
  assert.deepEqual(mirror.state().sessions.map((session) => session.id), ["s0", "s1", "s2"]);
});

// Review of step 5 (P2): a delayed projection of the same epoch rewound the mirror (revision 10 -> 1).
test("a projection older than the mirror in the same epoch is ignored; the same revision with other topics applies", () => {
  const mirror = new StateMirror();
  const projection = (revision, ids, topics = ["base"]) => ({ kind: "projection", epoch: 7, revision, topics,
    counts: { sessions: ids.length }, state: { sessions: ids.map((id) => ({ id })) }, scalars: {} });
  assert.equal(mirror.receive(projection(10, ["a", "b"])), "applied");
  assert.equal(mirror.receive(projection(1, ["old"])), "ignored", "a delayed, older projection");
  assert.equal(mirror.revision, 10);
  assert.deepEqual(mirror.state().sessions.map((session) => session.id), ["a", "b"]);
  // A resubscription with other topics (main's detail switch) starts at an unchanged revision.
  assert.equal(mirror.receive(projection(10, ["a", "b"], ["base", "events"])), "applied");
});

test("a core restart: the same mirror follows a new hub on a new port from its projection", async () => {
  const first = controllerFixture();
  const hub1 = hubFor(first.controller, { epoch: 10 });
  const mirror = new StateMirror({ onState: (_state, info) => mirror.ack(info.revision) });
  const attach = (hub) => {
    const [hubSide, mirrorSide] = createClonedPorts();
    mirror.post = (message) => mirrorSide.postMessage(message);
    mirrorSide.onMessage((message) => mirror.receive(message));
    hub.subscribe(hubSide);
    return hubSide;
  };
  attach(hub1);
  for (let i = 0; i < 3; i++) await first.controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: `old-${i}` }));
  await settle();
  assert.equal(mirror.state().sessions.length, 3);
  const second = controllerFixture();
  const hub2 = hubFor(second.controller, { epoch: 11 });
  await second.controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: "new-0" }));
  attach(hub2);
  await settle();
  assertMirrors(mirror, hub2, {}, "after the restart");
  assert.equal(mirror.epoch, 11);
});

test("a consumer that does not acknowledge holds the producer at its window; one frame catches it up", async () => {
  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const { port, mirrorSide, faults } = faultyPorts();
  const { mirror } = mirrorOn(mirrorSide, { autoAck: false });
  const subscription = hub.subscribe(port, { topics: ["base", "events"], window: 2 });
  for (let i = 0; i < 100; i++) await controller.ingestEvent(normalizeEvent({ hook_event_name: "PreToolUse", session_id: `w-${i % 7}`, tool_name: "Read", tool_use_id: `w-${i}` }));
  await settle();
  assert.equal(faults.sent, 2, "the projection and one delta, then nothing until an acknowledgement");
  assert.ok(subscription.stats.coalesced >= 90);
  mirror.ack();
  await settle();
  assert.equal(faults.sent, 3, "one frame for the 99 changes it missed");
  assertMirrors(mirror, hub, { topics: ["base", "events"] }, "after catching up");
});

test("event summaries of every revision travel with coalesced frames, and a truncated ring says so", async () => {
  const hubState = { sessions: [] };
  const hub = new StateHub({ source: () => hubState, epoch: 1 });
  const { port, mirrorSide } = faultyPorts();
  const { mirror, seen } = mirrorOn(mirrorSide, { autoAck: false });
  hub.subscribe(port, { events: true, window: 1 });
  await settle();
  for (let i = 1; i <= 5; i++) hub.publish({ id: `e${i}` });
  await settle();
  mirror.ack();
  await settle();
  assert.deepEqual(seen.flatMap((info) => info.events.map((event) => event.id)), ["e1", "e2", "e3", "e4", "e5"]);
  for (let i = 6; i <= 400; i++) hub.publish({ id: `e${i}` });
  mirror.ack();
  await settle();
  const last = seen.at(-1);
  assert.equal(last.eventsTruncated, true, "more than the ring holds were coalesced");
  assert.equal(last.events.at(-1).id, "e400");
});

test("FrameStream sends whole frames within a window and only the newest after a stall", async () => {
  const stream = new FrameStream({ epoch: 4 });
  const { port, mirrorSide, faults } = faultyPorts();
  const frames = [];
  const mirror = new FrameMirror({ post: (message) => mirrorSide.postMessage(message), onFrame: (frame) => frames.push(frame.n) });
  mirrorSide.onMessage((message) => mirror.receive(message));
  const subscription = stream.subscribe(port, { window: 1 });
  for (let n = 1; n <= 50; n++) stream.publish({ n });
  await settle();
  assert.deepEqual(frames, [1]);
  assert.equal(faults.sent, 1);
  mirror.ack();
  await settle();
  assert.deepEqual(frames, [1, 50], "the 48 frames in between were never queued");
  assert.ok(subscription.stats.coalesced >= 48);
  assert.equal(mirror.receive({ kind: "frame", epoch: 3, revision: 99, frame: { n: -1 } }), "ignored", "an older epoch");
});

test("LosslessQueue: ordered, acknowledged, bounded by waiting producers, and failing loudly instead of dropping", async () => {
  const delivered = [];
  const acks = [];
  const queue = new LosslessQueue({ window: 2, capacity: 3,
    deliver: (item) => new Promise((resolve) => { delivered.push(item); acks.push(() => resolve(`ok ${item}`)); }) });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(queue.push(i));
  assert.deepEqual(delivered, [0, 1], "two in flight");
  let room = false;
  let ticket = null;
  queue.ready().then((granted) => { room = true; ticket = granted; });
  await tick();
  assert.equal(room, true, "two waiting leave room for a third");
  results.push(queue.push(4, ticket));
  room = false;
  queue.ready().then(() => { room = true; });
  await tick();
  assert.equal(room, false, "a full queue makes producers wait");
  results.push(queue.push(5));   // a producer that does not wait is still never dropped
  acks.shift()();
  await tick();
  assert.deepEqual(delivered, [0, 1, 2]);
  assert.equal(room, false, "still four waiting");
  acks.shift()();
  acks.shift()();
  await tick();
  assert.equal(room, true, "acknowledgements make room");
  while (acks.length) { acks.shift()(); await tick(); }
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4, 5].map((i) => `ok ${i}`));
  assert.deepEqual(delivered, [0, 1, 2, 3, 4, 5]);

  const failedItems = [];
  const broken = new LosslessQueue({ window: 1, deliver: () => Promise.reject(new Error("port closed")),
    onFailed: (item) => failedItems.push(item) });
  const first = broken.push("a");
  const second = broken.push("b");
  await assert.rejects(first, /port closed/);
  await assert.rejects(second, /port closed/);
  await assert.rejects(broken.push("c"), /port closed/);
  assert.deepEqual(failedItems, ["a", "b", "c"], "every item is accounted for");
});

// Review of step 5 (P1): producers that all asked ready() in the same turn were all admitted (996 waiting at capacity
// 64). Room is reserved at admission now, one producer at a time, in the order they asked.
test("LosslessQueue: concurrent producers never hold more than the capacity, and are admitted in order", async () => {
  const delivered = [];
  const acks = [];
  const queue = new LosslessQueue({ window: 4, capacity: 64,
    deliver: (item) => new Promise((resolve) => { delivered.push(item); acks.push(() => resolve(item)); }) });
  let maxOccupied = 0;
  const producers = Array.from({ length: 1000 }, async (_, i) => {
    const ticket = await queue.ready();
    const result = queue.push(i, ticket);
    maxOccupied = Math.max(maxOccupied, queue.waiting.length);
    return result;
  });
  await tick();
  assert.ok(queue.waiting.length <= 64, `waiting ${queue.waiting.length} at capacity 64`);
  while (delivered.length < 1000) {
    const release = acks.shift();
    assert.ok(release, `stalled at ${delivered.length}`);
    release();
    await tick();
    assert.ok(queue.waiting.length <= 64, `waiting ${queue.waiting.length} at capacity 64`);
  }
  while (acks.length) { acks.shift()(); await tick(); }
  assert.deepEqual(await Promise.all(producers), delivered);
  assert.deepEqual(delivered, Array.from({ length: 1000 }, (_, i) => i), "admitted and delivered in the order they asked");
  assert.ok(maxOccupied <= 64);

  // A reservation given back without an item frees its room for the next producer.
  const small = new LosslessQueue({ window: 1, capacity: 1, deliver: () => new Promise(() => {}) });
  small.push("in flight");
  const held = await small.ready();
  let next = false;
  small.ready().then(() => { next = true; });
  await tick();
  assert.equal(next, false, "the room is reserved");
  held.release();
  await tick();
  assert.equal(next, true, "released room goes to the next producer");

  // Several items for one unit of work are reserved together (review of step 6, P1): each push spends one slot, the
  // rest goes back on release, and a producer asking for two waits until two fit.
  const pair = new LosslessQueue({ window: 1, capacity: 3, deliver: () => new Promise(() => {}) });
  pair.push("in flight");
  const both = await pair.ready(2);
  let second = null;
  pair.ready(2).then((ticket) => { second = ticket; });
  await tick();
  assert.equal(second, null, "one slot is free, two are needed");
  pair.push("observation", both);
  await tick();
  assert.equal(second, null, "the first item took a slot of its own reservation");
  both.release();
  await tick();
  assert.ok(second, "the unused slot went back, so two fit now");
  assert.equal(pair.reservedSlots, 2);
});

// The step-1 "stalled renderer" was only a log line (fake windows accept every send). Here the consumer is a real
// thread that blocks its event loop; the transport is a real MessagePort, which, like Electron's, queues without limit.
test("a really stalled consumer on another thread: bounded frames, no backlog, nothing lossless dropped", { timeout: 30000 }, async (t) => {
  const control = new SharedArrayBuffer(4);
  const worker = new Worker(new URL("./support/slow-consumer-worker.js", import.meta.url), { workerData: { control } });
  t.after(() => worker.terminate());
  const inbox = [];
  const waiters = [];
  worker.on("message", (message) => { inbox.push(message); for (const waiter of waiters.splice(0)) waiter(); });
  const next = async (kind) => {
    for (;;) {
      const index = inbox.findIndex((message) => message.kind === kind);
      if (index >= 0) return inbox.splice(index, 1)[0];
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  await next("ready");

  const { controller } = controllerFixture();
  const hub = hubFor(controller);
  const options = { topics: ["base", "events"], eventLimit: 20, window: 2 };
  const stateChannel = new MessageChannel();
  worker.postMessage({ kind: "state", port: stateChannel.port2 }, [stateChannel.port2]);
  const subscription = hub.subscribe(portAdapter(stateChannel.port1), options);
  const stream = new FrameStream({ epoch: 1 });
  const frameChannel = new MessageChannel();
  worker.postMessage({ kind: "frames", port: frameChannel.port2 }, [frameChannel.port2]);
  const frames = stream.subscribe(portAdapter(frameChannel.port1), { window: 2 });
  const losslessChannel = new MessageChannel();
  worker.postMessage({ kind: "lossless", port: losslessChannel.port2 }, [losslessChannel.port2]);
  const pendingAcks = new Map();
  let seq = 0;
  losslessChannel.port1.on("message", ({ seq: acked }) => { pendingAcks.get(acked)?.(); pendingAcks.delete(acked); });
  const queue = new LosslessQueue({ window: 4, capacity: 16,
    deliver: (item) => new Promise((resolve) => { const id = ++seq; pendingAcks.set(id, resolve); losslessChannel.port1.postMessage({ seq: id, item }); }) });

  await controller.ingestEvent(normalizeEvent({ hook_event_name: "SessionStart", session_id: "stall-0" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  worker.postMessage({ kind: "stall", ms: 1500 });
  await next("stalling");
  const framesBefore = subscription.stats.frames;
  const terminalBefore = frames.stats.frames;

  // While the consumer is stopped: 300 state changes, 300 terminal frames, 100 lossless items from a producer that
  // respects backpressure.
  let maxQueued = 0;
  const losslessDone = (async () => {
    const pushed = [];
    for (let i = 0; i < 100; i++) {
      const ticket = await queue.ready();
      pushed.push(queue.push(i, ticket));
      maxQueued = Math.max(maxQueued, queue.waiting.length);
    }
    return Promise.all(pushed);
  })();
  for (let i = 0; i < 300; i++) {
    await controller.ingestEvent(normalizeEvent({ hook_event_name: "PreToolUse", session_id: `stall-${i % 9}`, tool_name: "Bash", tool_use_id: `stall-${i}`, tool_input: { command: "y".repeat(500) } }));
    stream.publish({ n: i, screen: "z".repeat(2000) });
  }
  assert.ok(subscription.stats.frames - framesBefore <= 2, `state frames sent during the stall: ${subscription.stats.frames - framesBefore}`);
  assert.ok(frames.stats.frames - terminalBefore <= 2, `terminal frames sent during the stall: ${frames.stats.frames - terminalBefore}`);
  assert.ok(maxQueued <= 16, `lossless items waiting never exceeded the capacity: ${maxQueued}`);
  assert.ok(queue.stats.backpressured > 0, "the lossless producer had to wait");

  await next("resumed");
  await losslessDone;
  await new Promise((resolve) => setTimeout(resolve, 300));
  worker.postMessage({ kind: "report" });
  const report = await next("report");
  assert.deepEqual(plain(report.state), plain(hub.view(options)), "the stalled consumer caught up to the reference");
  assert.equal(report.revision, hub.revision);
  assert.equal(report.mirrorStats.resyncs, 0, "no resync needed: one coalesced delta");
  assert.ok(subscription.stats.frames - framesBefore <= 5, `frames for 300 changes: ${subscription.stats.frames - framesBefore}`);
  assert.equal(report.frame.n, 299, "the newest terminal frame, not a backlog");
  assert.deepEqual(report.received, Array.from({ length: 100 }, (_, i) => i), "every lossless item, in order");
});
