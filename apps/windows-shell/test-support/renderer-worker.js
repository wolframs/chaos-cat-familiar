// A renderer stand-in on a thread of its own (process-split plan, step 5, load fixture). It owns one view's port end
// (a socket the service process writes to, or a worker_threads MessagePort in-process), so the bytes of that view's
// state or frames never reach main's thread. It reconstructs what the page would (StateMirror / FrameMirror), records
// when each tool event first became visible (absolute time: timeOrigin + now, comparable across threads), and can
// stop for real: "stall" blocks its event loop with Atomics.wait, so nothing is read or acknowledged meanwhile.
import net from "node:net";
import { parentPort, workerData } from "node:worker_threads";
import { FrameMirror, StateMirror, portAdapter, socketPort } from "../../../packages/core/src/index.js";

const { view, service } = workerData;
const control = new Int32Array(workerData.control);
const now = () => performance.timeOrigin + performance.now();
const visibleAt = new Map();
const stats = { ports: 0, messages: 0, bytes: 0, states: 0, frames: 0, maxScrollback: 0, stalls: [], posted: 0, postErrors: 0 };
let mirror = null;
let scrollbackReported = false;

function adopt(port) {
  stats.ports += 1;
  const post = (message) => {
    try { port.postMessage(message); stats.posted += 1; }
    catch { stats.postErrors += 1; /* closed */ }
  };
  if (service === "companion") {
    mirror = new FrameMirror({ post, onFrame: (frame, info) => {
      stats.frames += 1;
      const rows = frame?.terminal?.history?.length ?? 0;
      stats.maxScrollback = Math.max(stats.maxScrollback, rows);
      if (!scrollbackReported && rows >= 1000) { scrollbackReported = true; parentPort.postMessage({ kind: "scrollback", rows }); }
      mirror.ack(info.revision);
    } });
  } else {
    mirror = new StateMirror({ post, onState: (state, info) => {
      stats.states += 1;
      const at = now();
      for (const event of state.events ?? []) {
        if (event?.toolUseId && !visibleAt.has(event.toolUseId)) visibleAt.set(event.toolUseId, at);
      }
      for (const approval of state.approvals ?? []) {
        const id = approval?.event?.toolUseId;
        if (id && !visibleAt.has(id)) visibleAt.set(id, at);
      }
      mirror.ack(info.revision);
    } });
  }
  port.onMessage((message) => { stats.messages += 1; mirror.receive(message); });
}

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => { stats.bytes += chunk.length; });
  adopt(portAdapter(socketPort(socket)));
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage({ kind: "listening", port: server.address().port }));

parentPort.on("message", (message) => {
  switch (message.kind) {
    case "port":
      adopt(portAdapter(message.port));
      break;
    case "stall": {
      const started = now();
      parentPort.postMessage({ kind: "stalling" });
      Atomics.wait(control, 0, 0, message.ms);
      stats.stalls.push({ ms: Math.round(now() - started) });
      break;
    }
    case "report":
      parentPort.postMessage({ kind: "report", view, stats, visibleAt: [...visibleAt],
        state: service === "core" ? mirror?.state() ?? null : null, revision: mirror?.revision ?? null,
        mirrorStats: mirror?.stats ?? null, frame: service === "companion" ? { revision: mirror?.revision ?? null } : null });
      break;
    case "close":
      server.close();
      parentPort.close();
      break;
    default:
      break;
  }
});
