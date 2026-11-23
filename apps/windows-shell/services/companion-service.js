import { FrameStream } from "../../../packages/core/src/state-sync.js";
import { ServiceEndpoint, createInProcessPorts } from "../../../packages/core/src/service-rpc.js";
import { composeImageMessage } from "./companion-attachments.js";
import { CompanionClient } from "./companion-client.js";

const UNRESOLVED = new Set(["pending", "outcomeUnknown"]);

// Attachments a pending or uncertain submission still needs (their files must stay).
export function pinnedAttachmentIds(delivery) {
  if (!delivery) return [];
  const submissions = delivery.pinnedSubmissions?.() ?? delivery.snapshot?.().submissions ?? [];
  return [...new Set(submissions.filter((record) => UNRESOLVED.has(record.state))
    .flatMap((record) => (record.attachments ?? []).map((image) => image.id)))];
}

// What leaves the companion: the backend's snapshot plus what main needs to know without asking (process-split plan,
// step 4): the staged attachments, the connected Claude companion's folder (identifies its hooks) and the attachments
// that pending or uncertain submissions pin.
export function projectCompanion(snapshot, { session, delivery = null, attachments = null }) {
  if (!snapshot) return null;
  const claude = session.sessions?.claude;
  return {
    ...snapshot,
    attachments: attachments?.list() ?? [],
    claudeFolder: claude?.getSnapshot?.().connected ? claude.spec?.cwd ?? null : null,
    pinnedAttachmentIds: pinnedAttachmentIds(delivery)
  };
}

// What main keeps of a snapshot once the conversation window takes the whole frames on its own port (step 5): no
// terminal screen, scrollback or streaming text, which change every ~33 ms and only that window draws.
export function slimCompanion(projected) {
  if (!projected) return projected;
  const { screen, lines, history, ...terminal } = projected.terminal ?? {};
  return { ...projected, terminal: { ...terminal, slim: true }, liveText: "" };
}

function slimKey(slim) {
  const messages = slim?.messages ?? [];
  return JSON.stringify({ ...slim, messages: undefined, messageCount: messages.length, lastMessage: messages.at(-1) ?? null,
    terminal: { ...slim?.terminal, revision: undefined } });
}

// The companion backend behind a service boundary: the session (Claude PTY or Codex), its delivery store, watcher and
// staged attachments are reached through requests; projected snapshots and watcher changes are pushed as events.
// Since step 4 this runs in the companion's own utility process (companion/companion-composition.js).
//
// Step 5: the whole snapshot, terminal screen included, is a replaceable frame (FrameStream) that the conversation
// window takes on its own port (subscribeFrames); main gets the same events with a slim snapshot, and only when that
// changed (step 7: main never relays frames).
export function serveCompanion({ endpoint, session, delivery = null, attachments = null, epoch = Date.now() }) {
  const project = (snapshot) => projectCompanion(snapshot, { session, delivery, attachments });
  const current = () => project(session.getSnapshot?.() ?? null);
  const frames = new FrameStream({ epoch });
  let lastSlimKey = null;
  const push = (topic, projected) => {
    if (projected) frames.publish(projected);
    if (!projected) { endpoint.emit(topic, projected); return; }
    const slim = slimCompanion(projected);
    const key = slimKey(slim);
    if (key === lastSlimKey) return;
    lastSlimKey = key;
    endpoint.emit(topic, slim);
  };
  const forwardChange = (snapshot) => push("change", project(snapshot ?? session.getSnapshot?.() ?? null));
  // The watcher's state is part of the session snapshot; a client that cannot peek needs it with the event.
  const forwardWatcher = () => push("watcher-change", current());
  // Attachment and send outcomes change only what the conversation window shows, not the session.
  const changed = () => push("projection", current());
  session.on?.("change", forwardChange);
  session.watcher?.on?.("change", forwardWatcher);
  let disposed = false;
  const requireAttachments = () => {
    if (!attachments) throw new Error("Image attachments are unavailable.");
    return attachments;
  };
  // Codex submits (with delivery records); a plain Claude PTY gets the text with image file references.
  const submit = async ({ id, text, attachments: images, draftRevision }) => {
    if (session.submit) return session.submit({ id, text, attachments: images, draftRevision });
    await session.send(composeImageMessage(text, images));
    return { state: "accepted", acceptanceBoundary: "pty-write" };
  };

  endpoint
    .handle("snapshot", () => slimCompanion(current()))
    .handle("frames.stats", () => ({ revision: frames.revision,
      subscriptions: [...frames.subscriptions].map((item) => ({ id: item.id, ...item.stats, inflight: item.inflight.length })) }))
    .handle("start", (options) => session.start(options))
    .handle("submit", submit)
    // The composer's send: the staged images it names are selected, submitted with the text, and released only once
    // the backend accepted (an uncertain outcome keeps them for the retry decision).
    .handle("send", async ({ submissionId, text, attachmentIds = [], draftRevision }) => {
      const selected = attachments ? attachments.select(attachmentIds ?? []) : [];
      try {
        const submission = await submit({ id: submissionId, text, attachments: selected, draftRevision });
        if (submission?.state === "accepted") attachments?.markSent(selected.map((image) => image.id));
        return submission;
      } finally { changed(); }
    })
    .handle("attachments.add", async ({ name, dataUrl }) => {
      try { await requireAttachments().addDataUrl({ name, dataUrl }); } finally { changed(); }
      return true;
    })
    .handle("attachments.addFiles", async ({ filePaths = [] }) => {
      try { for (const filename of filePaths) await requireAttachments().addFile(filename); } finally { changed(); }
      return true;
    })
    .handle("attachments.remove", async ({ id }) => {
      try { return await requireAttachments().remove(id); } finally { changed(); }
    })
    .handle("selectBackend", ({ backend }) => {
      if (!session.selectBackend) throw new Error("Backend selection unavailable.");
      session.selectBackend(backend);
      return true;
    })
    .handle("switchBackend", async (options) => {
      if (!session.switchBackend) throw new Error("Backend switching unavailable.");
      await session.switchBackend(options);
      return true;
    })
    .handle("resolveRequest", async (payload) => Boolean(await session.resolveRequest?.(payload)))
    .handle("resolveUnknown", async (payload) => { await session.resolveUnknown?.(payload); return true; })
    .handle("history", async (payload) => (await session.history?.(payload)) ?? null)
    .handle("getOutput", (payload) => session.getOutput(payload))
    .handle("stop", async (options) => { await (options ? session.stop(options) : session.stop()); return true; })
    .handle("recoverFailedStart", async (options) => { await session.recoverFailedStart(options); return true; })
    // Raw terminal input: one request per keystroke batch, answered after the PTY write, in order (lossless).
    // ptyId: the PTY the keys were typed for; the session refuses keys for an earlier one (review of step 5).
    .handle("write", ({ text, ptyId = null }) => { session.write(text, { ptyId }); return true; })
    .handle("interrupt", async () => { await session.interrupt(); return true; })
    .handle("resize", ({ cols, rows }) => { session.resize(cols, rows); return true; })
    .handle("observeConversation", async (payload) => { await session.observeConversation?.(payload); return true; })
    .handle("recordAssistantMessage", ({ text, options }) => { session.recordAssistantMessage?.(text, options); return true; })
    .handle("updatePresentation", (payload) => { session.updatePresentation?.(payload); return true; })
    .handle("dispose", async () => {
      if (disposed) return true;
      disposed = true;
      session.off?.("change", forwardChange);
      session.watcher?.off?.("change", forwardWatcher);
      try {
        if (session.dispose) await session.dispose();
        else await session.stop?.();
      } finally {
        delivery?.close();
      }
      return true;
    });
  // A window's own frames port: the newest whole snapshot now, then within its window of unacknowledged frames.
  function subscribeFrames(port, options = {}) {
    if (frames.latest === null) frames.publish(current());
    return frames.subscribe(port, { window: Number.isInteger(options.window) ? options.window : 2, id: options.id ?? null });
  }

  return { endpoint, snapshot: current, frames, subscribeFrames };
}

// A served companion joined to a client by in-process ports (tests and the in-process host). projectionOnly: no live
// reads, as across a process boundary. client: reattach an existing client (a restart).
export function createInProcessCompanion({ session, delivery = null, attachments = null, onError, projectionOnly = false,
  createPorts = createInProcessPorts, client = null }) {
  const [companionPort, mainPort] = createPorts();
  const companionEndpoint = new ServiceEndpoint({ port: companionPort, name: "companion", onError });
  const mainEndpoint = new ServiceEndpoint({ port: mainPort, name: "main", onError });
  const served = serveCompanion({ endpoint: companionEndpoint, session, delivery, attachments });
  const target = client ?? new CompanionClient();
  target.attach(mainEndpoint, { peek: projectionOnly ? null : { snapshot: served.snapshot } });
  companionEndpoint.markReady({ booted: true });
  mainEndpoint.markReady();
  const info = { snapshot: served.snapshot(), delivery: Boolean(delivery) };
  // In-process ports deliver at once (ready now, live reads); cloning ports a tick later, with a cloned snapshot.
  const ready = mainEndpoint.peerReady ? Promise.resolve(target.setReady(info))
    : mainEndpoint.whenReady().then(() => target.setReady(structuredClone(info)));
  return { client: target, ready, companionEndpoint };
}
