// A window's own subscription (process-split plan, step 5): the core's state (or the companion's frames) arrives on a
// MessagePort straight from the service process, not through main. Main only sets the port up (ccf:subscribe, then a
// "ccf:port" window message from the preload) and posts a new one under the same id after the service restarted.
//
// Returns null where the preload has no window.ccf.subscribe (a page hot-reloaded under a main from before step 5;
// since step 7 nothing else delivers the state: restart CCF). With whileVisible the subscription exists only while the page is visible;
// showing the page again subscribes anew and starts from a fresh projection.
import { FrameMirror, StateMirror } from "../../../packages/core/src/state-mirror.js";

let counter = 0;
const QUERY_TIMEOUT_MS = 10000;

function subscribe({ service, request, onMessage, onPort, whileVisible, onError }) {
  if (typeof window.ccf?.subscribe !== "function") return null;
  const handle = { id: null, port: null, active: false, closed: false };
  const pending = new Map();
  let querySeq = 0;

  const onWindowMessage = (event) => {
    if (event.source !== window || event.data?.ccfPort?.id !== handle.id || !event.ports?.[0]) return;
    adopt(event.ports[0]);
  };

  function adopt(port) {
    try { handle.port?.close(); } catch { /* replaced */ }
    handle.port = port;
    port.onmessage = (event) => {
      const message = event.data;
      if (message?.kind === "result") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(Object.assign(new Error(message.error?.message ?? "Query failed."), { code: message.error?.code ?? null }));
        return;
      }
      onMessage(message, port);
    };
    onPort?.(port);
  }

  function start() {
    if (handle.closed || handle.active) return;
    handle.active = true;
    handle.id = `${service}-${Date.now().toString(36)}-${++counter}`;
    window.ccf.subscribe({ ...request, id: handle.id, service }).catch((error) => {
      handle.active = false;
      onError?.(error);
    });
  }

  function stop() {
    if (!handle.active) return;
    handle.active = false;
    const { id, port } = handle;
    handle.id = null;
    handle.port = null;
    try { port?.postMessage({ kind: "unsubscribe" }); } catch { /* closed */ }
    try { port?.close(); } catch { /* closed */ }
    window.ccf.unsubscribe?.(id)?.catch?.(() => {});
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("The subscription ended.")); }
    pending.clear();
  }

  const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());

  handle.query = (method, params = {}) => new Promise((resolve, reject) => {
    if (!handle.port) { reject(new Error("Not subscribed.")); return; }
    const id = ++querySeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer.`)); }, QUERY_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    handle.port.postMessage({ kind: "query", id, method, params });
  });
  handle.close = () => {
    stop();
    handle.closed = true;
    window.removeEventListener("message", onWindowMessage);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  handle.post = (message) => { try { handle.port?.postMessage(message); } catch { /* closed */ } };

  window.addEventListener("message", onWindowMessage);
  if (whileVisible) document.addEventListener("visibilitychange", onVisibility);
  if (!whileVisible || document.visibilityState !== "hidden") start();
  window.addEventListener("beforeunload", () => handle.close());
  return handle;
}

// The core's state for this window: onState(state, info) after each applied message; the mirror acknowledges once
// onState returned (a view that defers drawing passes deferAck and calls handle.ack(revision) when it has drawn).
export function subscribeCoreState({ topics = ["base"], eventLimit, logLimit, whileVisible = true, deferAck = false,
  onState, onError = (error) => console.warn(error) }) {
  let mirror = null;
  const handle = subscribe({
    service: "core", whileVisible, onError,
    request: { topics, ...(eventLimit !== undefined ? { eventLimit } : {}), ...(logLimit !== undefined ? { logLimit } : {}) },
    onPort: () => {
      // A new port (a fresh subscription or a restarted core) starts from its projection.
      mirror = new StateMirror({
        post: (message) => handle.post(message),
        onState: (state, info) => {
          onState(state, info);
          if (!deferAck) mirror.ack(info.revision);
        },
        onError
      });
      handle.mirror = mirror;
    },
    onMessage: (message) => mirror?.receive(message)
  });
  if (handle) handle.ack = (revision) => mirror?.ack(revision);
  return handle;
}

// Whole frames (the companion's snapshot with its terminal screen): the newest wins, acknowledged once drawn.
export function subscribeFrames({ service = "companion", whileVisible = false, onFrame, onError = (error) => console.warn(error) }) {
  let mirror = null;
  const handle = subscribe({
    service, whileVisible, onError, request: {},
    onPort: () => {
      mirror = new FrameMirror({ post: (message) => handle.post(message),
        onFrame: (frame, info) => { onFrame(frame, info); mirror.ack(info.revision); }, onError });
      handle.mirror = mirror;
    },
    onMessage: (message) => mirror?.receive(message)
  });
  return handle;
}
