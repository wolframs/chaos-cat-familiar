// A consumer on another thread that can stop for real (process-split plan, step 5): Atomics.wait blocks its event loop,
// so nothing it was sent is read or acknowledged until the wait ends. It holds a StateMirror, a FrameMirror and a
// lossless receiver, each on its own MessagePort, and reports what it reconstructed.
import { parentPort, workerData } from "node:worker_threads";
import { FrameMirror, StateMirror } from "../../src/state-mirror.js";

const control = new Int32Array(workerData.control);
let mirror = null;
let frames = null;
const states = [];
const received = [];

parentPort.on("message", (message) => {
  switch (message.kind) {
    case "state": {
      const { port } = message;
      mirror = new StateMirror({ post: (reply) => port.postMessage(reply),
        onState: (_state, info) => { states.push(info.revision); mirror.ack(info.revision); } });
      port.on("message", (frame) => mirror.receive(frame));
      break;
    }
    case "frames": {
      const { port } = message;
      frames = new FrameMirror({ post: (reply) => port.postMessage(reply), onFrame: (_frame, info) => frames.ack(info.revision) });
      port.on("message", (frame) => frames.receive(frame));
      break;
    }
    case "lossless": {
      const { port } = message;
      port.on("message", ({ seq, item }) => { received.push(item); port.postMessage({ kind: "ack", seq }); });
      break;
    }
    case "stall":
      parentPort.postMessage({ kind: "stalling" });
      Atomics.wait(control, 0, 0, message.ms);   // blocks this thread: no message is read meanwhile
      parentPort.postMessage({ kind: "resumed" });
      break;
    case "report":
      parentPort.postMessage({ kind: "report", state: mirror?.state() ?? null, revision: mirror?.revision ?? null,
        mirrorStats: mirror?.stats ?? null, states, frame: frames?.frame ?? null, frameStats: frames?.stats ?? null, received });
      break;
    default:
      break;
  }
});
parentPort.postMessage({ kind: "ready" });
