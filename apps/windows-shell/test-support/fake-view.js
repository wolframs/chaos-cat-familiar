// A renderer stand-in for a window's own state port (process-split plan, step 5): it asks main for a subscription as
// the page would (ccf:subscribe from the window's webContents), adopts every port main posts it under that id (a new
// one after a core restart), and reconstructs the state with the same StateMirror the page uses.
import { FrameMirror, StateMirror, portAdapter } from "../../../packages/core/src/index.js";

let counter = 0;

export async function fakeView(electron, window, { service = "core", topics = ["base"], eventLimit, logLimit, autoAck = true } = {}) {
  const id = `fake-${service}-${++counter}`;
  const view = { id, states: [], frames: [], ports: 0, mirror: null, port: null, results: new Map(), querySeq: 0 };
  const adopt = (entry) => {
    if (entry.channel !== "ccf:port" || entry.message?.id !== id) return;
    view.port?.close();
    const port = portAdapter(entry.ports[0]);
    view.port = port;
    view.ports += 1;
    const post = (message) => { try { port.postMessage(message); } catch { /* closed */ } };
    view.mirror = service === "core"
      ? new StateMirror({ post, onState: (state, info) => { view.states.push({ state, info }); if (autoAck) view.mirror.ack(info.revision); } })
      : new FrameMirror({ post, onFrame: (frame, info) => { view.frames.push({ frame, info }); if (autoAck) view.mirror.ack(info.revision); } });
    port.onMessage((message) => {
      if (message?.kind === "result") { view.results.get(message.id)?.(message); return; }
      view.mirror.receive(message);
    });
  };
  window.webContents.on("test:posted", adopt);
  for (const entry of window.webContents.posted ?? []) adopt(entry);
  await electron.ipcMain.invokeFrom(window.webContents, "ccf:subscribe", { id, service, topics, eventLimit, logLimit });
  view.state = () => view.mirror?.state() ?? null;
  view.query = (method, params) => new Promise((resolve) => {
    const queryId = ++view.querySeq;
    view.results.set(queryId, resolve);
    view.port.postMessage({ kind: "query", id: queryId, method, params });
  });
  view.close = () => { window.webContents.off("test:posted", adopt); view.port?.close(); };
  return view;
}

export async function until(read, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
