// The page side of a window's own subscription (process-split plan, step 5): renderer/view-subscription.js with a
// stand-in for the preload (window.ccf.subscribe, the "ccf:port" window message) and a real worker_threads
// MessageChannel as the port. Hidden pages hold nothing; shown again they start from a fresh projection; a new port
// under the same id (a restarted core) replaces the old one; a page without the step-5 preload keeps its old path.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";

function page() {
  const events = new EventEmitter();
  const documentEvents = new EventEmitter();
  const calls = [];
  const window = {
    addEventListener: (type, listener) => events.on(type, listener),
    removeEventListener: (type, listener) => events.off(type, listener),
    ccf: {
      subscribe: async (request) => { calls.push(["subscribe", request]); return { id: request.id }; },
      unsubscribe: async (id) => { calls.push(["unsubscribe", id]); return true; }
    }
  };
  const document = { visibilityState: "visible",
    addEventListener: (type, listener) => documentEvents.on(type, listener),
    removeEventListener: (type, listener) => documentEvents.off(type, listener) };
  // The preload's window.postMessage({ccfPort}, "*", ports): a DOM-like port with onmessage.
  const deliverPort = (id) => {
    const { port1, port2 } = new MessageChannel();
    const dom = { postMessage: (message) => port2.postMessage(message), close: () => port2.close(), set onmessage(handler) { port2.on("message", (data) => handler({ data })); } };
    events.emit("message", { source: window, data: { ccfPort: { id, service: "core" } }, ports: [dom] });
    return port1;
  };
  const setVisibility = (state) => { document.visibilityState = state; documentEvents.emit("visibilitychange"); };
  return { window, document, calls, deliverPort, setVisibility };
}

async function load(env) {
  globalThis.window = env.window;
  globalThis.document = env.document;
  const module = await import(`../renderer/view-subscription.js?case=${Math.random()}`);
  return module;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const projection = (epoch, revision, ids) => ({ kind: "projection", epoch, revision, counts: { sessions: ids.length },
  state: { sessions: ids.map((id) => ({ id })) }, scalars: {} });

test("hidden, the page holds no subscription; shown again it asks anew and starts from a fresh projection", async (t) => {
  const env = page();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const { subscribeCoreState } = await load(env);
  const states = [];
  const handle = subscribeCoreState({ topics: ["base"], onState: (state, info) => states.push([info.kind, state.sessions.length]) });
  await tick();
  const first = env.calls.at(-1)[1];
  const service = env.deliverPort(first.id);
  const acks = [];
  service.on("message", (message) => acks.push(message));
  service.postMessage(projection(1, 3, ["a", "b"]));
  await tick();
  assert.deepEqual(states, [["projection", 2]]);
  assert.deepEqual(acks.at(-1), { kind: "ack", revision: 3 }, "acknowledged once applied");

  env.setVisibility("hidden");
  await tick();
  assert.deepEqual(env.calls.at(-1), ["unsubscribe", first.id]);
  assert.ok(acks.some((message) => message.kind === "unsubscribe"), "the service is told on the port too");
  env.setVisibility("visible");
  await tick();
  const second = env.calls.at(-1);
  assert.equal(second[0], "subscribe");
  assert.notEqual(second[1].id, first.id, "a new subscription");
  const again = env.deliverPort(second[1].id);
  again.postMessage(projection(1, 9, ["a", "b", "c"]));
  await tick();
  assert.deepEqual(states.at(-1), ["projection", 3]);
  handle.close();
});

test("a new port under the same id (a restarted core) replaces the old one; queries answer on the port", async (t) => {
  const env = page();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const { subscribeCoreState } = await load(env);
  const states = [];
  const handle = subscribeCoreState({ onState: (state, info) => states.push([info.epoch, state.sessions.map((s) => s.id)]) });
  await tick();
  const { id } = env.calls.at(-1)[1];
  const oldCore = env.deliverPort(id);
  oldCore.postMessage(projection(5, 10, ["old"]));
  await tick();
  const newCore = env.deliverPort(id);
  newCore.on("message", (message) => {
    if (message.kind === "query") newCore.postMessage({ kind: "result", id: message.id, ok: true, result: { events: [1, 2] } });
  });
  newCore.postMessage(projection(6, 1, ["new"]));
  await tick();
  assert.deepEqual(states.at(-1), [6, ["new"]], "the newer epoch's projection, at a lower revision");
  assert.deepEqual(await handle.query("history", {}), { events: [1, 2] });
  handle.close();
});

test("without the step-5 preload the page gets null and keeps its old path", async (t) => {
  const env = page();
  delete env.window.ccf.subscribe;
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const { subscribeCoreState, subscribeFrames } = await load(env);
  assert.equal(subscribeCoreState({ onState() {} }), null);
  assert.equal(subscribeFrames({ onFrame() {} }), null);
});
