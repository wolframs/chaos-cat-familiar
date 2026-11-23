// Transports that carry a ServiceEndpoint across a process boundary (process-split plan, step 3). Both ends speak
// structured clone: an Electron utility process does, and a Node child forked with serialization "advanced" (the
// stand-in where Electron is not available: tests, the load fixture) does too.
//
// Step 5 adds ports of their own for a window's state and frames, so bulk traffic bypasses main: main makes a channel,
// hands one end to the service process and the other to the renderer. Electron transfers a MessagePortMain; the Node
// stand-in hands over one end of a loopback socket pair (socketPort speaks length-prefixed v8 serialization, which is
// structured clone).
import net from "node:net";
import v8 from "node:v8";
import { EventEmitter } from "node:events";
import { portAdapter } from "./state-sync.js";

function closedError() {
  return Object.assign(new Error("The core process is not connected."), { code: "ERR_IPC_CHANNEL_CLOSED" });
}

// Main's side. Electron's UtilityProcess has postMessage(); a Node ChildProcess has send(). Both emit "message" with
// the message itself. A send to a process that is gone throws at once, so the endpoint can settle the request.
export function parentSidePort(child, { onSendError = () => {} } = {}) {
  // Electron's pid is undefined before the process spawned as well as after it exited. Messages before the spawn wait
  // for it, in order (main's "ready" goes right after fork; refused, it never went, and every request the child made to
  // main waited forever: found by the step-6 smoke); after the exit they fail at once.
  let spawned = typeof child.postMessage === "function" && child.pid !== undefined;
  let exited = false;
  const early = [];
  if (typeof child.postMessage === "function") {
    child.once?.("spawn", () => {
      spawned = true;
      for (const message of early.splice(0)) { try { child.postMessage(message); } catch (error) { onSendError(error); } }
    });
    child.once?.("exit", () => { exited = true; early.length = 0; });
  }
  const postMessage = typeof child.postMessage === "function"
    ? (message) => {
      if (exited) throw closedError();
      if (child.pid === undefined) {
        if (spawned) throw closedError();   // it ran and is gone (its exit event may still be on its way)
        early.push(message);
        return;
      }
      spawned = true;
      child.postMessage(message);
    }
    : (message) => {
      if (!child.connected) throw closedError();
      // With a callback Node reports a late failure there instead of as an "error" event that would crash main.
      child.send(message, (error) => { if (error) onSendError(error); });
    };
  return {
    postMessage,
    onMessage(listener) { child.on("message", (message) => listener(message)); },
    close() {}
  };
}

// The core's side: Electron's process.parentPort (message events wrap the data) or Node's process.send. A message of
// type "port" that brings a port with it (Electron: event.ports; Node: the socket handle) goes to onPort(info, port)
// with the port adapted (postMessage, onMessage, onClose, close), never to the endpoint.
export function childSidePort(proc = process, { onSendError = () => {}, onPort = null } = {}) {
  if (proc.parentPort) {
    return {
      postMessage: (message) => proc.parentPort.postMessage(message),
      onMessage(listener) {
        proc.parentPort.on("message", (event) => {
          if (event?.data?.type === "port" && event.ports?.[0]) {
            if (onPort) onPort(event.data, portAdapter(event.ports[0]));
            else event.ports[0].close?.();
            return;
          }
          listener(event.data);
        });
      },
      close() {}
    };
  }
  if (typeof proc.send === "function") {
    return {
      postMessage(message) {
        if (!proc.connected) throw closedError();
        proc.send(message, (error) => { if (error) onSendError(error); });
      },
      onMessage(listener) {
        proc.on("message", (message, handle) => {
          if (message?.type === "port" && handle) {
            if (onPort) onPort(message, portAdapter(socketPort(handle)));
            else handle.destroy?.();
            return;
          }
          listener(message);
        });
      },
      close() {}
    };
  }
  throw new Error("No parent port: the core runs only as a utility process or a forked child.");
}

// Whether a process with this pid still runs. On Windows libuv also answers ESRCH for a process that ended while someone
// still holds its handle.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Supervision that does not rely on the platform's exit event alone (review of step 5, P2: once, under Electron, a core
// killed during a hook diagnosis was not reported for over 20 s; the cause could not be reproduced). Every `everyMs`
// it checks pid() and calls onGone() once when that process no longer runs. Returns stop().
// The checks are synchronous on the caller's thread (main's, for the hosts), so each is timed (livenessStats()).
const liveness = { checks: 0, totalMs: 0, maxMs: 0, over4ms: 0 };
export function livenessStats() {
  return { ...liveness, totalMs: Math.round(liveness.totalMs * 1000) / 1000, maxMs: Math.round(liveness.maxMs * 1000) / 1000 };
}

export function watchLiveness({ pid, onGone, everyMs = 1000, isAlive = processAlive }) {
  const timer = setInterval(() => {
    const current = pid();
    if (!Number.isInteger(current)) return;
    const started = performance.now();
    const alive = isAlive(current);
    const ms = performance.now() - started;
    liveness.checks++;
    liveness.totalMs += ms;
    liveness.maxMs = Math.max(liveness.maxMs, ms);
    if (ms >= 4) liveness.over4ms++;
    if (alive) return;
    clearInterval(timer);
    onGone(current);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Hands `port` to a child with `info` (type "port"):Electron's MessagePortMain through postMessage's transfer list, a
// socket from createSocketChannel() through Node's handle passing (the parent's copy closes once it was sent).
export function transferPort(child, info, port) {
  if (typeof child.postMessage === "function") {
    if (child.pid === undefined) throw closedError();
    child.postMessage(info, [port]);
    return;
  }
  if (!child.connected) throw closedError();
  child.send(info, port, (error) => { if (error) port.destroy?.(); });
}

// A MessagePort-like object over a net.Socket: on("message"|"close"), postMessage, close, start. Messages are
// structured clones (v8 serialization), each framed with a 4-byte length.
export function socketPort(socket) {
  const port = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message;
      try { message = v8.deserialize(body); } catch (error) { port.emit("error", error); continue; }
      port.emit("message", message);
    }
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    port.emit("close");
  };
  socket.on("close", finish);
  socket.on("error", () => { /* a reset ends in "close" */ });
  port.postMessage = (message) => {
    if (closed || socket.destroyed) throw Object.assign(new Error("The port is closed."), { code: "ERR_PORT_CLOSED" });
    const body = v8.serialize(message);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  };
  port.start = () => {};
  port.close = () => { socket.destroy(); finish(); };
  port.socket = socket;
  return port;
}

// The Node stand-in for Electron's MessageChannelMain: a loopback socket pair. servicePort is the raw socket to hand to
// a forked child (transferPort); rendererPort stays in this process. The accepted socket is never read here (a socket
// that was read from does not survive the handover on Windows); it is ours when its peer is our client's local port.
export async function createSocketChannel() {
  const server = net.createServer({ pauseOnConnect: true });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const client = net.connect(server.address().port, "127.0.0.1");
    const connected = new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
    const accepted = new Promise((resolve) => {
      server.on("connection", async (socket) => {
        await connected.catch(() => {});
        if (socket.remotePort === client.localPort && socket.remoteAddress === "127.0.0.1") resolve(socket);
        else socket.destroy();
      });
    });
    await connected;
    const serviceSocket = await accepted;
    return { servicePort: serviceSocket, rendererPort: socketPort(client) };
  } finally {
    server.close();
  }
}
