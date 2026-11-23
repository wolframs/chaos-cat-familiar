import { randomUUID } from "node:crypto";

// Service boundary transport (process-split plan, step 2). One ServiceEndpoint per side of a port: requests with ids,
// readiness, cancellation and timeouts, plus fire-and-forget events, in both directions (main asks core to resolve an
// approval; core asks main to open the companion). The port is anything with postMessage(message) and
// onMessage(listener). Today both ends share a process through createInProcessPorts(); step 3 hands the same
// endpoints an Electron MessagePort, whose messages are structured clones.
//
// Messages: {type:"ready", info} {type:"request", id, method, params} {type:"response", id, ok, result | error}
//           {type:"cancel", id} {type:"event", topic, payload} {type:"closed", reason}

export class ServiceError extends Error {
  constructor(message, code, name) {
    super(message);
    this.code = code;
    if (name) this.name = name;
  }
}

function abortError(reason) {
  return new ServiceError(typeof reason === "string" ? reason : "The request was cancelled.", "ABORT_ERR", "AbortError");
}

// In-process ports: synchronous delivery by reference, no cloning. A handler runs inside the caller's request(), so
// effects keep today's order and a snapshot handed through keeps its identity. Messages posted before the other side
// listens are buffered.
export function createInProcessPorts() {
  const left = new InProcessPort();
  const right = new InProcessPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

// Cloned ports: what a process boundary does to messages (structured clone, asynchronous delivery, functions cannot
// cross) without a second process. Tests use them to prove that a client does not depend on shared references.
export function createClonedPorts() {
  const left = new InProcessPort({ cloned: true });
  const right = new InProcessPort({ cloned: true });
  left.peer = right;
  right.peer = left;
  return [left, right];
}

class InProcessPort {
  constructor({ cloned = false } = {}) {
    this.peer = null;
    this.listener = null;
    this.buffer = [];
    this.closed = false;
    this.cloned = cloned;
  }

  postMessage(message) {
    if (this.closed || this.peer.closed) return;
    if (!this.cloned) {
      this.peer.#deliver(message);
      return;
    }
    const copy = structuredClone(message);   // throws DataCloneError like a real port
    const peer = this.peer;
    setImmediate(() => { if (!peer.closed) peer.#deliver(copy); });
  }

  onMessage(listener) {
    this.listener = listener;
    for (const message of this.buffer.splice(0)) listener(message);
  }

  close() { this.closed = true; }

  #deliver(message) {
    if (this.listener) this.listener(message);
    else this.buffer.push(message);
  }
}

export class ServiceEndpoint {
  constructor({ port, name = "service", epoch = randomUUID().slice(0, 8), onError = () => {}, onClose = null }) {
    this.port = port;
    this.name = name;
    this.epoch = epoch;
    this.onError = onError;
    this.onClose = onClose;   // runs once, after a local close() or the peer's "closed" message
    this.sequence = 0;
    this.handlers = new Map();
    this.listeners = new Map();
    this.pending = new Map();       // our requests awaiting a response
    this.inflight = new Map();      // the peer's requests our handlers are working on
    this.waitingForReady = [];
    this.peerReady = false;
    this.peerInfo = null;
    this.closed = false;
    this.closeReason = null;
    this.readyWaiters = [];
    port.onMessage((message) => this.#receive(message));
  }

  handle(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  on(topic, listener) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic).add(listener);
    return () => this.off(topic, listener);
  }

  off(topic, listener) {
    this.listeners.get(topic)?.delete(listener);
  }

  // Returns whether the event left (false once closed or when the transport refused it).
  emit(topic, payload) {
    return !this.closed && this.#send({ type: "event", topic, payload });
  }

  markReady(info = null) {
    if (!this.closed) this.#send({ type: "ready", info });
  }

  whenReady() {
    if (this.peerReady) return Promise.resolve(this.peerInfo);
    if (this.closed) return Promise.reject(this.#closedError());
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  request(method, params = null, { signal = null, timeoutMs = null, waitForReady = true } = {}) {
    if (this.closed) return Promise.reject(this.#closedError());
    if (signal?.aborted) return Promise.reject(abortError(signal.reason?.message));
    if (!this.peerReady && !waitForReady) {
      return Promise.reject(new ServiceError(`${method}: the ${this.name} peer is not ready.`, "not_ready"));
    }
    const id = `${this.name}:${this.epoch}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const entry = { id, method, resolve, reject, cleanup: [] };
      this.pending.set(id, entry);
      if (signal) {
        const onAbort = () => this.#cancel(id, abortError(signal.reason?.message));
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup.push(() => signal.removeEventListener("abort", onAbort));
      }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timer = setTimeout(() => this.#cancel(id,
          new ServiceError(`${method} did not answer within ${timeoutMs} ms.`, "request_timeout")), timeoutMs);
        timer.unref?.();
        entry.cleanup.push(() => clearTimeout(timer));
      }
      const message = { type: "request", id, method, params };
      if (!this.peerReady) {
        this.waitingForReady.push(message);
        return;
      }
      try { this.port.postMessage(message); }
      catch (error) {
        // The request never left: nothing will answer it, so it must not stay pending (or keep its timer).
        this.#settle(id);
        reject(error);
      }
    });
  }

  // Cleanup does not depend on the transport: a dead process or closed channel may throw on the last send.
  close(reason = "closed") {
    if (this.closed) return;
    try { this.port.postMessage({ type: "closed", reason }); }
    catch { /* The peer is gone already; settle locally all the same. */ }
    finally {
      this.#shutDown(reason);
      try { this.port.close?.(); } catch { /* Closing a dead transport must not throw out of close(). */ }
    }
  }

  // Events, readiness and responses are best effort once the transport is gone; requests report their own failure.
  #send(message) {
    try {
      this.port.postMessage(message);
      return true;
    } catch (error) {
      this.#reportError(error, { send: message.type });
      return false;
    }
  }

  #closedError() {
    return new ServiceError(`The ${this.name} service is closed (${this.closeReason ?? "closed"}).`, "service_closed");
  }

  #settle(id) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    for (const cleanup of entry.cleanup) cleanup();
    return entry;
  }

  #cancel(id, error) {
    const entry = this.#settle(id);
    if (!entry) return;
    const queued = this.waitingForReady.findIndex((message) => message.id === id);
    if (queued >= 0) this.waitingForReady.splice(queued, 1);
    else if (!this.closed) this.#send({ type: "cancel", id });
    entry.reject(error);
  }

  #shutDown(reason) {
    if (this.closed && this.closeReason !== null) return;
    this.closed = true;
    this.closeReason = reason;
    this.peerReady = false;
    this.waitingForReady.length = 0;
    const error = this.#closedError();
    for (const id of [...this.pending.keys()]) this.#settle(id).reject(error);
    for (const controller of this.inflight.values()) controller.abort(error);
    this.inflight.clear();
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
    try { this.onClose?.(reason); } catch (closeError) { this.#reportError(closeError, { topic: "close" }); }
  }

  #receive(message) {
    if (this.closed || !message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        this.peerReady = true;
        this.peerInfo = message.info ?? null;
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(this.peerInfo);
        for (const queued of this.waitingForReady.splice(0)) {
          try { this.port.postMessage(queued); }
          catch (error) { this.#settle(queued.id)?.reject(error); }
        }
        break;
      case "request":
        this.#serve(message);
        break;
      case "response": {
        const entry = this.#settle(message.id);
        if (!entry) break;   // cancelled or timed out: the late answer is dropped
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new ServiceError(message.error?.message ?? "Request failed.", message.error?.code ?? null,
          message.error?.name));
        break;
      }
      case "cancel":
        this.inflight.get(message.id)?.abort(abortError());
        this.inflight.delete(message.id);
        break;
      case "event":
        for (const listener of [...(this.listeners.get(message.topic) ?? [])]) {
          try { listener(message.payload); }
          catch (error) { this.#reportError(error, { topic: message.topic }); }
        }
        break;
      case "closed":
        this.#shutDown(message.reason ?? "peer closed");
        break;
      default:
        break;
    }
  }

  #serve({ id, method, params }) {
    const respond = (response) => {
      if (!this.inflight.has(id)) return;   // cancelled meanwhile
      this.inflight.delete(id);
      if (this.closed) return;
      try { this.port.postMessage({ type: "response", id, ...response }); }
      catch (error) {
        // A result that cannot cross (a function, a socket) must still answer the request.
        this.#reportError(error, { method });
        this.#send({ type: "response", id, ok: false,
          error: { message: `${method}: the result could not be sent (${error?.message ?? error}).`, code: "send_failed" } });
      }
    };
    const fail = (error) => respond({ ok: false, error: { message: String(error?.message ?? error),
      code: error?.code ?? null, name: error?.name === "Error" ? undefined : error?.name } });
    const controller = new AbortController();
    this.inflight.set(id, controller);
    const handler = this.handlers.get(method);
    if (!handler) {
      fail(new ServiceError(`Unknown method ${method}.`, "unknown_method"));
      return;
    }
    let result;
    try { result = handler(params, { signal: controller.signal, requestId: id }); }
    catch (error) { fail(error); return; }
    if (result && typeof result.then === "function") result.then((value) => respond({ ok: true, result: value }), fail);
    else respond({ ok: true, result });
  }

  #reportError(error, context) {
    try { this.onError(error, context); } catch { /* Reporting must not break delivery. */ }
  }
}
