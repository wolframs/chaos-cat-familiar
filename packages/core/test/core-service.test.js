import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EffectGate, createClonedPorts, createInProcessCore } from "../src/index.js";

function core(options = {}) {
  const logs = [];
  const logger = { entries: [], info() {}, debug() {}, error: (...args) => logs.push(["error", ...args]),
    warn: (...args) => logs.push(["warn", ...args]) };
  const created = createInProcessCore({ overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} },
    settings: { load: () => ({}) }, logger, ...options });
  return { ...created, logs };
}

test("the client mirrors the controller's change events and projection", async (t) => {
  const { client } = core();
  t.after(() => client.close());
  const changes = [];
  client.on("state", (info) => changes.push({ sessions: client.state().sessions.length, event: info.lastEvent?.hookEventName ?? null }));
  await client.ingestHook({ hook_event_name: "SessionStart", session_id: "s-1", cwd: "C:/fixture" });
  assert.deepEqual(changes, [{ sessions: 1, event: "SessionStart" }]);
  assert.equal(client.state().sessions[0].id, "s-1");
  assert.equal((await client.query()).sessions[0].id, "s-1");
});

test("a projection-only client starts from the ready projection and follows pushed changes", async (t) => {
  const { client } = core({ projectionOnly: true });
  t.after(() => client.close());
  await client.whenReady();
  assert.deepEqual(client.state().sessions, []);
  await client.ingestHook({ hook_event_name: "SessionStart", session_id: "s-2" });
  assert.equal(client.state().sessions[0].id, "s-2");
});

test("ingestHook queues a PermissionRequest without a waiter; resolving it returns whether it existed", async (t) => {
  const { client } = core();
  t.after(() => client.close());
  await client.ingestHook({ hook_event_name: "PermissionRequest", session_id: "s-3", tool_name: "Bash" });
  const [approval] = client.state().approvals;
  assert.ok(approval);
  assert.equal(await client.resolveApproval(approval.id, "defer"), true);
  assert.equal(client.state().approvals[0].collapsed, true);
  assert.equal(await client.restoreApproval(approval.id), true);
  assert.equal(client.state().approvals[0].collapsed, false);
  assert.equal(await client.resolveApproval(approval.id, "allow"), true);
  assert.equal(await client.resolveApproval(approval.id, "allow"), false);
});

test("the hook server falls back to a free port when the preferred one is taken, and refuses a second start", async (t) => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;
  const { client, logs } = core();
  t.after(async () => { await client.stopHookServer().catch(() => {}); client.close(); blocker.close(); });
  const result = await client.startHookServer({ port: busyPort, authToken: "token" });
  assert.equal(result.requestedPort, busyPort);
  assert.equal(result.fallbackUsed, true);
  assert.notEqual(result.port, busyPort);
  assert.equal(client.hookPort, result.port);
  assert.deepEqual(logs.map(([level, category, message]) => [level, category, message]),
    [["warn", "hook-server", "Hook server listen failed"]]);
  await assert.rejects(client.startHookServer({ port: 0, authToken: "token" }), /already running/);
  const health = await fetch(`http://127.0.0.1:${result.port}/health`);
  assert.equal(await health.text(), "ok");
  await client.stopHookServer();
  assert.equal(client.hookPort, null);
});

test("companion intents wait until main answers them, and keep main's error message", async (t) => {
  const { client } = core();
  t.after(async () => { await client.stopHookServer(); client.close(); });
  const { port } = await client.startHookServer({ port: 0, authToken: "token" });
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST",
    headers: { "content-type": "application/json", "x-ccf-token": "token" }, body: JSON.stringify(body) });
  const early = post("/companion/bubble", { text: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const opens = [];
  client.handleIntents({
    companionStatus: () => {},
    companionOpen: (payload) => { opens.push(payload); throw new Error("Work companion is already running (PID 9)."); },
    companionBubble: ({ text }) => ({ shown: text === "hello" })
  });
  assert.deepEqual(await (await early).json(), { ok: true, shown: true }, "held until main was ready");
  const opened = await post("/companion/open", { backend: "claude" });
  assert.equal(opened.status, 409);
  assert.deepEqual(await opened.json(), { error: "Work companion is already running (PID 9)." });
  assert.deepEqual(opens, [{ backend: "claude" }]);
});

// Step 3: a process boundary clones every push, so a change carries the overlay-sized projection (no event history,
// no log) unless main asked for detail (dashboard or diagnostics open). Revisions order effects across the port.
test("changes carry a revision and an overlay-sized projection; detail adds events and logs", async (t) => {
  const { client } = core({ projectionOnly: true, createPorts: createClonedPorts });
  t.after(() => client.close());
  await client.whenReady();
  const changes = [];
  client.on("state", (info) => changes.push({ state: client.state(), lastEvent: info.lastEvent, revision: info.revision }));
  await client.ingestHook({ hook_event_name: "PreToolUse", session_id: "s-5", tool_name: "Bash", tool_input: { command: "x".repeat(5000) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].revision, 1);
  assert.deepEqual(changes[0].state.events, [], "no event history by default");
  assert.deepEqual(changes[0].state.logs, []);
  assert.equal(changes[0].state.summary.eventCount, 1);
  assert.equal(changes[0].state.sessions[0].id, "s-5", "sessions and approvals stay in the projection");
  assert.deepEqual(Object.keys(changes[0].lastEvent).sort(),
    ["backend", "conversationId", "hookEventName", "id", "lastAssistantMessage", "receivedAt", "sessionId", "toolName", "toolUseId"],
    "the last event is a summary, never the tool input or response");
  assert.equal((await client.query()).events.length, 1, "a query returns the full state (main never subscribes to it)");
});

test("effects follow the change they belong to and carry its revision", async (t) => {
  const order = [];
  const { client } = core({ projectionOnly: true, createPorts: createClonedPorts,
    overlay: { showOverlay: () => order.push("show-overlay") },
    notifier: { notify: async (notification) => order.push(`toast:${notification.category}`) } });
  t.after(() => client.close());
  await client.whenReady();
  client.on("state", ({ revision }) => order.push(`change:${revision}:${client.state().approvals.length}`));
  await client.ingestHook({ hook_event_name: "PermissionRequest", session_id: "s-6", tool_name: "Bash" });
  const deadline = Date.now() + 2000;
  while (!order.includes("show-overlay") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["change:1:1", "toast:permission_request", "show-overlay"],
    "the toast and the overlay come after the state that holds the approval");
});

test("the effect gate holds an effect until the view has applied its revision", () => {
  const applied = [];
  const gate = new EffectGate((effect) => applied.push(effect.type));
  gate.offer({ type: "toast", revision: 2 });
  gate.offer({ type: "show-overlay", revision: 1 });
  assert.deepEqual(applied, []);
  gate.reached(1);
  assert.deepEqual(applied, ["show-overlay"]);
  gate.reached(2);
  assert.deepEqual(applied, ["show-overlay", "toast"]);
  gate.offer({ type: "late", revision: 2 });
  assert.deepEqual(applied.at(-1), "late", "a reached revision applies at once");
  gate.reset();
  gate.offer({ type: "after-restart", revision: 1 });
  assert.equal(applied.at(-1), "late", "a restarted core counts revisions from zero again");
});

test("a detached client drops pending approvals from its projection and refuses approval actions until ready", async (t) => {
  const { client } = core({ projectionOnly: true });
  t.after(() => client.close());
  await client.whenReady();
  await client.ingestHook({ hook_event_name: "PermissionRequest", session_id: "s-7", tool_name: "Bash" });
  const [approval] = client.state().approvals;
  const statuses = [];
  client.on("status", (status) => statuses.push(status));
  client.detach("core exited");
  assert.equal(client.status, "recovering");
  assert.deepEqual(client.state().approvals, [], "no stale approval can be clicked");
  assert.equal(client.state().sessions[0].id, "s-7", "the rest of the last projection stays visible");
  await assert.rejects(client.resolveApproval(approval.id, "allow"), (error) => error.code === "core_recovering");
  await assert.rejects(client.restoreApproval(approval.id), (error) => error.code === "core_recovering");
  assert.deepEqual(statuses, ["recovering"]);
});

test("a failing change listener in main is reported, and ingestion carries on", async (t) => {
  const errors = [];
  const { client } = core({ onError: (error, context) => errors.push([error.message, context.topic]) });
  t.after(() => client.close());
  client.on("state", () => { throw new Error("window destroyed"); });
  await client.ingestHook({ hook_event_name: "SessionStart", session_id: "s-4" });
  assert.deepEqual(errors, [["window destroyed", "change"]]);
  assert.equal(client.state().sessions.length, 1);
});

// Process-split plan, step 5: main's state arrives as versioned deltas that CoreClient's mirror applies.
function lossyPorts({ dropStateFrames = [] } = {}) {
  return () => {
    const [corePort, mainPort] = createClonedPorts();
    let stateFrames = 0;
    const post = corePort.postMessage.bind(corePort);
    corePort.postMessage = (message) => {
      if (message?.type === "event" && message.topic === "state" && dropStateFrames.includes(++stateFrames)) return;
      post(message);
    };
    return [corePort, mainPort];
  };
}

const settleClone = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("main's state is deltas after one projection, and equals the core's base view after every change", async (t) => {
  const { client, service, controller } = core({ projectionOnly: true, createPorts: createClonedPorts });
  t.after(() => client.close());
  await client.whenReady();
  await settleClone();
  const kinds = [];
  client.on("state", (info) => kinds.push(info?.kind));
  for (let i = 0; i < 20; i++) {
    await client.ingestHook({ hook_event_name: i % 4 ? "PreToolUse" : "SessionStart", session_id: `d-${i % 3}`, tool_name: "Bash", tool_input: { command: "x".repeat(3000) } });
    await settleClone();
    assert.deepEqual(JSON.parse(JSON.stringify(client.state())), JSON.parse(JSON.stringify(service.hub.view({ topics: ["base"] }))), `after change ${i}`);
  }
  assert.deepEqual([...new Set(kinds)], ["delta"]);
  assert.equal(client.mirror.stats.projections, 1);
  assert.equal(controller.events.length, 20);
});

test("a state frame lost on the way to main is a gap: main resyncs and nothing stays wrong", async (t) => {
  const errors = [];
  const { client, service } = core({ projectionOnly: true, createPorts: lossyPorts({ dropStateFrames: [3] }),
    onError: (error, context) => errors.push([error.message, context?.topic]) });
  t.after(() => client.close());
  await client.whenReady();
  for (let i = 0; i < 5; i++) {
    await client.ingestHook({ hook_event_name: "SessionStart", session_id: `gap-${i}` });
    await settleClone();
  }
  assert.deepEqual(client.state().sessions.map((session) => session.id).sort(), ["gap-0", "gap-1", "gap-2", "gap-3", "gap-4"]);
  assert.equal(client.mirror.stats.resyncs, 1);
  assert.equal(client.revision, service.revision);
  assert.ok(errors.some(([message, topic]) => topic === "state" && /resync \(gap\)/.test(message)), "the resync is reported");
});

// Review of step 5 (P1): observations rode on state frames, and a resync's projection carries none, so a lost frame lost
// the Stop whose reply the companion records. They are lossless effects now, gated by revision like toasts.
test("a state frame lost on the way to main loses no observation: each event reaches main once, in order", async (t) => {
  const { client, service } = core({ projectionOnly: true, createPorts: lossyPorts({ dropStateFrames: [3, 4] }) });
  t.after(() => client.close());
  await client.whenReady();
  const observed = [];
  client.on("effect", (effect) => { if (effect.type === "observe") observed.push([effect.event.hookEventName, effect.event.lastAssistantMessage ?? null]); });
  await client.ingestHook({ hook_event_name: "SessionStart", session_id: "obs" });
  await settleClone();
  await client.ingestHook({ hook_event_name: "UserPromptSubmit", session_id: "obs", prompt: "hi" });
  await client.ingestHook({ hook_event_name: "Stop", session_id: "obs", last_assistant_message: "the reply" });
  await settleClone();
  await client.ingestHook({ hook_event_name: "PreToolUse", session_id: "obs", tool_name: "Read" });
  await settleClone();
  assert.ok(client.mirror.stats.resyncs >= 1, "main resynced after the lost frames");
  assert.equal(client.revision, service.revision);
  assert.deepEqual(observed, [["SessionStart", null], ["UserPromptSubmit", null], ["Stop", "the reply"], ["PreToolUse", null]]);
});

test("frames that coalesce while main is busy still hand main every event summary, in order", async (t) => {
  const { client, controller } = core({ projectionOnly: true, createPorts: createClonedPorts });
  t.after(() => client.close());
  await client.whenReady();
  await settleClone();
  const seen = [];
  let changes = 0;
  client.on("state", () => { changes += 1; });
  client.on("effect", (effect) => { if (effect.type === "observe") seen.push(effect.event.sessionId); });
  // 40 changes in one turn: main's window (16 frames) fills before it acknowledges anything.
  for (let i = 0; i < 40; i++) controller.ingestEvent({ id: `c-${i}`, hookEventName: "SessionStart", sessionId: `c-${i}`, receivedAt: new Date() });
  // Observations are acknowledged effects, at most 8 in flight: a few round trips over the cloned ports.
  for (let round = 0; round < 20 && seen.length < 40; round++) await settleClone();
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => `c-${i}`));
  assert.ok(changes < 40, `frames coalesced: ${changes} changes for 40 revisions`);
  assert.equal(client.state().sessions.length, 40);
});

// Process-split plan, step 5: effects and intents are lossless traffic: acknowledged, bounded, never dropped.
test("effects are acknowledged requests; a burst waits for main's acknowledgements instead of piling up", async (t) => {
  const toasts = [];
  const { client, controller } = core({ projectionOnly: true, createPorts: createClonedPorts,
    notifier: { notify: async (notification) => toasts.push(notification.sessionId) } });
  t.after(() => client.close());
  await client.whenReady();
  // Main acknowledges an effect only after it handed it on; hold the acknowledgements back.
  const held = [];
  const handler = client.endpoint.handlers.get("effect");
  client.endpoint.handle("effect", (effect) => new Promise((resolve) => held.push(() => resolve(handler(effect)))));
  const ingesting = (async () => {
    for (let i = 0; i < 300; i++) {
      await controller.ingestEvent({ id: `n-${i}`, hookEventName: "Notification", sessionId: `n-${i}`, message: "needs you",
        notificationType: "permission_prompt", receivedAt: new Date() });
    }
  })();
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
  const outbox = controller.notifier.outbox;
  assert.ok(outbox.queue.inflight <= 8, `effects in flight: ${outbox.queue.inflight}`);
  assert.ok(outbox.queue.waiting.length <= 256, `never more waiting than the capacity: ${outbox.queue.waiting.length} ${JSON.stringify(outbox.queue.stats)} pending ${outbox.pending.length}`);
  let done = false;
  ingesting.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(outbox.queue.stats.backpressured > 0, "300 toasts against 8 in flight and 256 waiting");
  assert.equal(done, false, "ingestion waits while the outbox is full");
  const deadline = Date.now() + 5000;
  while ((!done || toasts.length < 300) && Date.now() < deadline) {
    for (const release of held.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(toasts, Array.from({ length: 300 }, (_, i) => `n-${i}`), "every toast, in order");
});

// Review of step 6 (P1): an ingestion reserved room for its observation, then waited for room for its toast. With as many
// concurrent ingestions as the capacity, every reservation was held by one that waited for a second: nothing queued,
// nothing in flight, no progress. An ingestion now reserves room for all it sends at once.
test("concurrent ingestions with toasts all finish within the outbox's bounds", async (t) => {
  const toasts = [];
  const { client, controller } = core({ projectionOnly: true, createPorts: createClonedPorts,
    notifier: { notify: async (notification) => toasts.push(notification.sessionId) } });
  t.after(() => client.close());
  await client.whenReady();
  const held = [];
  const handler = client.endpoint.handlers.get("effect");
  client.endpoint.handle("effect", (effect) => new Promise((resolve) => held.push(() => resolve(handler(effect)))));
  const outbox = controller.notifier.outbox;
  let done = 0;
  let maxWaiting = 0;
  const ingestions = Array.from({ length: 600 }, (_, i) => controller.ingestEvent({ id: `c-${i}`,
    hookEventName: "Notification", sessionId: `c-${i}`, message: "needs you", notificationType: "permission_prompt",
    receivedAt: new Date() }).then(() => { done += 1; }));
  const deadline = Date.now() + 10000;
  while (done < ingestions.length && Date.now() < deadline) {
    maxWaiting = Math.max(maxWaiting, outbox.queue.waiting.length);
    for (const release of held.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(done, 600, `ingestions finished: ${done}; queue ${JSON.stringify(outbox.queue.stats)}, waiting `
    + `${outbox.queue.waiting.length}, reserved ${outbox.queue.reserved.size}`);
  await Promise.all(ingestions);
  while (toasts.length < 600 && Date.now() < deadline + 5000) {
    for (const release of held.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(toasts.length, 600, "every toast");
  assert.ok(maxWaiting <= outbox.queue.capacity, `never more waiting than the capacity: ${maxWaiting}`);
});

test("bubbles and other intents go through a bounded queue and still answer each request", async (t) => {
  const { client, service } = core();
  t.after(() => client.close());
  let release = null;
  const order = [];
  client.handleIntents({
    companionStatus: async () => true,
    companionOpen: async () => true,
    companionBubble: (payload) => new Promise((resolve) => {
      order.push(payload.text);
      if (payload.text === "first") release = () => resolve({ shown: true, text: payload.text });
      else resolve({ shown: true, text: payload.text });
    })
  });
  const replies = Array.from({ length: 100 }, (_, i) => service.intents.bubble({ text: i ? `b-${i}` : "first" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(service.intents.queue.inflight <= 4, "a bounded number of intents in flight");
  release();
  const answers = await Promise.all(replies);
  assert.equal(answers[0].text, "first");
  assert.deepEqual(answers.map((answer) => answer.text).slice(1), Array.from({ length: 99 }, (_, i) => `b-${i + 1}`));
  assert.equal(order[0], "first");
  assert.equal(await service.intents.open({}), true);
});
