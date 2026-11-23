import test from "node:test";
import assert from "node:assert/strict";
import { ServiceEndpoint, createClonedPorts, createInProcessPorts } from "../src/service-rpc.js";

function pair(options = {}) {
  const [hostPort, clientPort] = createInProcessPorts();
  const host = new ServiceEndpoint({ port: hostPort, name: "core", ...options.host });
  const client = new ServiceEndpoint({ port: clientPort, name: "main", ...options.client });
  return { host, client };
}

test("requests carry unique ids and resolve with the handler's result", async () => {
  const { host, client } = pair();
  const seen = [];
  host.handle("add", ({ a, b }, { requestId }) => { seen.push(requestId); return a + b; });
  host.markReady({ version: 1 });
  assert.deepEqual(await client.whenReady(), { version: 1 });
  assert.equal(await client.request("add", { a: 2, b: 3 }), 5);
  assert.equal(await client.request("add", { a: 1, b: 1 }), 2);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.match(seen[0], /^main:/);
});

test("in-process delivery runs the handler synchronously and passes values by reference", async () => {
  const { host, client } = pair();
  const shared = { big: "state" };
  let ran = false;
  host.handle("touch", (params) => { ran = true; return params; });
  host.markReady();
  const pending = client.request("touch", shared);
  assert.equal(ran, true, "the handler ran before request() returned");
  assert.equal(await pending, shared);
});

test("handler errors reject with message and code; unknown methods are reported", async () => {
  const { host, client } = pair();
  host.handle("fail", () => { throw Object.assign(new Error("Work companion is already running (PID 7)."), { code: "busy" }); });
  host.handle("failLater", async () => { throw new Error("later"); });
  host.markReady();
  await assert.rejects(client.request("fail"), (error) => error.message === "Work companion is already running (PID 7)." && error.code === "busy");
  await assert.rejects(client.request("failLater"), /later/);
  await assert.rejects(client.request("nope"), (error) => error.code === "unknown_method");
});

test("requests wait for the peer's readiness unless told not to", async () => {
  const { host, client } = pair();
  host.handle("ping", () => "pong");
  assert.equal(client.peerReady, false);
  await assert.rejects(client.request("ping", null, { waitForReady: false }), (error) => error.code === "not_ready");
  const queued = client.request("ping");
  let settled = false;
  queued.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "held until ready");
  host.markReady();
  assert.equal(await queued, "pong");
  assert.equal(client.peerReady, true);
});

test("cancellation rejects at once, aborts the handler's signal and ignores the late result", async () => {
  const { host, client } = pair();
  let handlerSignal;
  let finish;
  host.handle("slow", (_params, { signal }) => { handlerSignal = signal; return new Promise((resolve) => { finish = resolve; }); });
  host.markReady();
  const abort = new AbortController();
  const pending = client.request("slow", null, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(handlerSignal.aborted, true);
  finish("too late");
  await new Promise((resolve) => setImmediate(resolve));

  const already = new AbortController();
  already.abort();
  await assert.rejects(client.request("slow", null, { signal: already.signal }), (error) => error.name === "AbortError");
});

test("a timeout cancels the request", async () => {
  const { host, client } = pair();
  let handlerSignal;
  host.handle("hang", (_params, { signal }) => { handlerSignal = signal; return new Promise(() => {}); });
  host.markReady();
  await assert.rejects(client.request("hang", null, { timeoutMs: 20 }), (error) => error.code === "request_timeout");
  assert.equal(handlerSignal.aborted, true);
});

test("events reach subscribers in order; unsubscribe stops them; listener errors are reported, not thrown", () => {
  const errors = [];
  const { host, client } = pair({ client: { onError: (error, context) => errors.push([error.message, context.topic]) } });
  const received = [];
  const off = client.on("change", (payload) => received.push(payload));
  client.on("change", () => { throw new Error("renderer gone"); });
  host.emit("change", 1);
  host.emit("change", 2);
  off();
  host.emit("change", 3);
  assert.deepEqual(received, [1, 2]);
  assert.deepEqual(errors, [["renderer gone", "change"], ["renderer gone", "change"], ["renderer gone", "change"]]);
});

test("both sides can serve requests (core asks main for native intents)", async () => {
  const { host, client } = pair();
  client.handle("companion.open", ({ backend }) => ({ opened: backend }));
  client.markReady();
  host.markReady();
  assert.deepEqual(await host.request("companion.open", { backend: "claude" }), { opened: "claude" });
});

test("closing rejects pending requests on both sides and later requests fail fast", async () => {
  const { host, client } = pair();
  let hostSignal;
  host.handle("hang", (_params, { signal }) => { hostSignal = signal; return new Promise(() => {}); });
  host.markReady();
  client.markReady();
  const pending = client.request("hang");
  client.handle("never", () => new Promise(() => {}));
  const reverse = host.request("never");
  host.close("core exited");
  await assert.rejects(pending, (error) => error.code === "service_closed");
  await assert.rejects(reverse, (error) => error.code === "service_closed");
  assert.equal(hostSignal.aborted, true);
  assert.equal(client.peerReady, false);
  await assert.rejects(client.request("hang"), (error) => error.code === "service_closed");
});

// A transport that throws on send: a utility process that already exited, an IPC channel that closed.
function brokenPort({ throwAfter = 0 } = {}) {
  let sends = 0;
  return { listener: null, postMessage() { if (++sends > throwAfter) throw new Error("channel closed"); },
    onMessage(listener) { this.listener = listener; }, close() {} };
}

test("close() settles readiness waiters, pending requests and in-flight handlers even when the transport throws", async () => {
  const port = brokenPort({ throwAfter: 1 });
  const endpoint = new ServiceEndpoint({ port, name: "main" });
  const waiting = endpoint.whenReady();
  const pending = endpoint.request("state");   // queued until ready: nothing sent yet
  port.listener({ type: "ready" });
  await waiting;
  const closed = [];
  endpoint.onClose = (reason) => closed.push(reason);
  endpoint.close("core exited");
  await assert.rejects(pending, (error) => error.code === "service_closed");
  assert.equal(endpoint.pending.size, 0);
  assert.equal(endpoint.closed, true);
  assert.deepEqual(closed, ["core exited"]);
});

test("a request whose send fails rejects at once and leaves nothing pending", async () => {
  const port = brokenPort();
  const endpoint = new ServiceEndpoint({ port, name: "main" });
  port.listener({ type: "ready" });
  await assert.rejects(endpoint.request("state", null, { timeoutMs: 60000 }), /channel closed/);
  assert.equal(endpoint.pending.size, 0, "no leaked pending entry (or its timeout timer)");
});

test("a peer's closed message and a local close both run onClose once", () => {
  const [hostPort, clientPort] = createInProcessPorts();
  const host = new ServiceEndpoint({ port: hostPort, name: "core" });
  const reasons = [];
  const client = new ServiceEndpoint({ port: clientPort, name: "main", onClose: (reason) => reasons.push(reason) });
  host.close("core stopping");
  client.close("again");
  assert.deepEqual(reasons, ["core stopping"]);
});

test("cloned ports deliver asynchronously and by structured clone, like a process boundary", async () => {
  const [hostPort, clientPort] = createClonedPorts();
  const host = new ServiceEndpoint({ port: hostPort, name: "core" });
  const client = new ServiceEndpoint({ port: clientPort, name: "main" });
  const shared = { when: new Date(0), nested: { n: 1 } };
  let ran = false;
  host.handle("echo", (params) => { ran = true; params.nested.n = 2; return params; });
  host.markReady();
  const pending = client.request("echo", shared);
  assert.equal(ran, false, "nothing runs inside request()");
  const echoed = await pending;
  assert.notEqual(echoed, shared);
  assert.equal(shared.nested.n, 1, "the handler changed a copy");
  assert.ok(echoed.when instanceof Date, "dates survive like a structured clone");
  assert.throws(() => hostPort.postMessage({ fn() {} }), /could not be cloned/i, "functions cannot cross");
});

test("messages posted before the peer listens are delivered once it does", async () => {
  const [hostPort, clientPort] = createInProcessPorts();
  const host = new ServiceEndpoint({ port: hostPort, name: "core" });
  host.handle("ping", () => "pong");
  host.markReady({ early: true });
  const client = new ServiceEndpoint({ port: clientPort, name: "main" });
  assert.deepEqual(await client.whenReady(), { early: true });
  assert.equal(await client.request("ping"), "pong");
});
