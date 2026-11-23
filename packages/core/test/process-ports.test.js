import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ServiceEndpoint } from "../src/service-rpc.js";
import { childSidePort, createSocketChannel, livenessStats, parentSidePort, processAlive, transferPort, watchLiveness } from "../src/process-ports.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "support", "echo-child.js");

function spawn() {
  // "advanced" serialization is the structured clone an Electron utility process uses.
  const child = fork(CHILD, [], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const endpoint = new ServiceEndpoint({ port: parentSidePort(child), name: "parent" });
  return { child, exited, endpoint };
}

test("a forked child serves requests and events over the process port, with structured-clone values", { timeout: 20000 }, async () => {
  const { child, exited, endpoint } = spawn();
  try {
    const info = await endpoint.whenReady();
    assert.equal(info.pid, child.pid);
    assert.deepEqual(await endpoint.request("echo", { nested: [1, { two: 2 }] }), { nested: [1, { two: 2 }] });
    const date = await endpoint.request("date");
    assert.ok(date instanceof Date, "a Date crosses as a Date, not a string");
    const pushed = new Promise((resolve) => endpoint.on("hello", resolve));
    await endpoint.request("push", { topic: "hello", payload: { from: "child" } });
    assert.deepEqual(await pushed, { from: "child" });
  } finally {
    endpoint.close("test done");
  }
  assert.equal(await exited, 0, "the child exits when the parent closes");
});

test("a child that dies settles the parent's pending requests once the endpoint is closed, and sends then fail fast", { timeout: 20000 }, async () => {
  const { exited, endpoint, child } = spawn();
  await endpoint.whenReady();
  await endpoint.request("crash");
  assert.equal(await exited, 3);
  assert.throws(() => parentSidePort(child).postMessage({ type: "event" }), /not connected/);
  const pending = endpoint.request("echo", 1, { timeoutMs: 5000 });
  await assert.rejects(pending, /not connected/, "a send to a dead child rejects at once instead of timing out");
  endpoint.close("child exited");
  await assert.rejects(endpoint.request("echo", 1), (error) => error.code === "service_closed");
});

test("childSidePort prefers an Electron parentPort and unwraps its message events", () => {
  const sent = [];
  const listeners = [];
  const fakeProcess = { parentPort: { postMessage: (message) => sent.push(message), on: (event, listener) => listeners.push([event, listener]) } };
  const port = childSidePort(fakeProcess);
  port.postMessage({ type: "ready" });
  const received = [];
  port.onMessage((message) => received.push(message));
  listeners[0][1]({ data: { type: "request", id: 1 } });
  assert.deepEqual(sent, [{ type: "ready" }]);
  assert.equal(listeners[0][0], "message");
  assert.deepEqual(received, [{ type: "request", id: 1 }]);
  assert.throws(() => childSidePort({}), /utility process or a forked child/);
});

// Process-split plan, step 5: a window's state bypasses main on a port of its own. Electron hands a MessagePortMain to
// a utility process; the Node stand-in hands one end of a loopback socket pair to a forked child.
test("a socket channel gives a forked child one end: structured-clone messages both ways, close seen on both", { timeout: 20000 }, async () => {
  const { child, exited, endpoint } = spawn();
  try {
    await endpoint.whenReady();
    const { servicePort, rendererPort } = await createSocketChannel();
    transferPort(child, { type: "port", kind: "test", options: { n: 1 } }, servicePort);
    const replies = [];
    rendererPort.on("message", (message) => replies.push(message));
    rendererPort.postMessage({ when: new Date(Date.UTC(2026, 10, 5)), big: "x".repeat(200000) });
    rendererPort.postMessage({ second: true });
    const deadline = Date.now() + 5000;
    while (replies.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replies.length, 2);
    assert.ok(replies[0].echo.when instanceof Date);
    assert.equal(replies[0].echo.big.length, 200000, "a large message crosses whole");
    assert.deepEqual(replies[0].info, { type: "port", kind: "test", options: { n: 1 } });
    assert.deepEqual(replies[1].echo, { second: true });
    const closed = new Promise((resolve) => rendererPort.on("close", resolve));
    await endpoint.request("crash");
    await closed;
    assert.throws(() => rendererPort.postMessage({ late: true }), /closed/);
  } finally {
    endpoint.close("test done");
  }
  await exited;
});

test("childSidePort hands an Electron port message to onPort, not to the endpoint", () => {
  const listeners = [];
  const ports = [];
  const fakeProcess = { parentPort: { postMessage() {}, on: (event, listener) => listeners.push(listener) } };
  const port = childSidePort(fakeProcess, { onPort: (info, adapted) => ports.push([info, adapted]) });
  const received = [];
  port.onMessage((message) => received.push(message));
  const transferred = { on() {}, postMessage() {}, start() {} };
  listeners[0]({ data: { type: "port", kind: "state" }, ports: [transferred] });
  listeners[0]({ data: { type: "request", id: 2 }, ports: [] });
  assert.deepEqual(received, [{ type: "request", id: 2 }]);
  assert.equal(ports.length, 1);
  assert.deepEqual(ports[0][0], { type: "port", kind: "state" });
  assert.equal(ports[0][1].raw, transferred);
});

// Found by the step-6 smoke (2026-11-05): Electron reports a utility process's pid only once it has spawned, so main's
// "ready", sent right after fork, was refused as "not connected" and never sent again: every request the child made
// to main (the companion's delivery records, the core's effects and intents) waited forever. The Node stand-in queues
// messages before spawn, which hid it.
test("messages to an Electron utility process that has not spawned yet wait for its spawn; after its exit they fail", () => {
  const { EventEmitter } = process.getBuiltinModule("node:events");
  const child = new EventEmitter();
  const sent = [];
  child.pid = undefined;
  child.postMessage = (message) => { if (child.pid === undefined) throw new Error("not spawned"); sent.push(message); };
  const port = parentSidePort(child);
  port.postMessage({ type: "ready" });
  port.postMessage({ type: "request", id: 1 });
  assert.deepEqual(sent, [], "held until the process runs");
  child.pid = 4242;
  child.emit("spawn");
  assert.deepEqual(sent.map((message) => message.type), ["ready", "request"], "sent in order once it spawned");
  port.postMessage({ type: "event" });
  assert.equal(sent.length, 3);
  child.pid = undefined;
  child.emit("exit", 0);
  assert.throws(() => port.postMessage({ type: "event" }), /not connected/);
});

// Final review, item 5: the liveness checks run synchronously on main's thread, so their cost is measured where they run
// (diagnostics show it; the plan has the numbers from a real Electron main).
test("liveness checks are timed: count, total and slowest", async () => {
  const before = { ...livenessStats() };
  let calls = 0;
  const stop = watchLiveness({ everyMs: 5, pid: () => process.pid, isAlive: (pid) => { calls++; return processAlive(pid); } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  const after = livenessStats();
  assert.ok(calls >= 2);
  assert.equal(after.checks - before.checks, calls);
  assert.ok(after.totalMs >= before.totalMs && after.maxMs >= 0);
  assert.ok(Number.isInteger(after.over4ms));
});
