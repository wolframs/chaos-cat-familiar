import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInProcessCompanion } from "../services/companion-service.js";
import { createClonedPorts } from "../../../packages/core/src/service-rpc.js";

function fakeSession(extra = {}) {
  const session = new EventEmitter();
  const calls = [];
  let snapshot = { backend: "claude", connected: true, phase: "idle", submission: null };
  Object.assign(session, {
    calls,
    getSnapshot: () => ({ ...snapshot }),
    set: (patch) => { snapshot = { ...snapshot, ...patch }; },
    sessions: { claude: { spec: { cwd: "C:\\work-companion" }, getSnapshot: () => ({ connected: snapshot.connected }) } },
    send: async (text) => { calls.push(["send", text]); },
    write: (text) => { calls.push(["write", text]); if (text === "boom") throw new Error("Terminal input is unavailable for Codex."); },
    resize: (cols, rows) => calls.push(["resize", cols, rows]),
    stop: async (...args) => { calls.push(["stop", ...args]); },
    ...extra
  });
  return session;
}

test("requests reach the session; a plain PTY session gets the text with image references", async () => {
  const session = fakeSession();
  const { client } = createInProcessCompanion({ session });
  const result = await client.submit({ id: "in-1", text: "look", attachments: [{ id: "a", path: "C:\\img\\a.png" }] });
  assert.deepEqual(result, { state: "accepted", acceptanceBoundary: "pty-write" });
  assert.equal(session.calls[0][0], "send");
  assert.ok(session.calls[0][1].includes("C:\\img\\a.png"));
  await client.write("\r");
  await client.resize(90, 30);
  await assert.rejects(client.write("boom"), /unavailable for Codex/);
  await assert.rejects(client.selectBackend("codex"), /Backend selection unavailable/);
  await assert.rejects(client.switchBackend({ backend: "codex" }), /Backend switching unavailable/);
  assert.equal(await client.resolveRequest({ key: "k" }), false, "a session without requests resolves nothing");
  assert.equal(await client.history({}), null);
  await client.stop();
  await client.stop({ disposition: "day-end" });
  assert.deepEqual(session.calls.slice(1), [["write", "\r"], ["resize", 90, 30], ["write", "boom"], ["stop"], ["stop", { disposition: "day-end" }]]);
});

test("change snapshots are pushed with the session's fields and watcher changes are forwarded", () => {
  const session = fakeSession();
  session.watcher = new EventEmitter();
  const { client } = createInProcessCompanion({ session });
  const seen = [];
  client.on("change", (snapshot) => seen.push(snapshot));
  let watcherChanges = 0;
  client.on("watcher-change", () => watcherChanges++);
  const snapshot = { backend: "claude", terminal: { lines: [[{ text: "screen" }]], revision: 1 } };
  session.emit("change", snapshot);
  session.watcher.emit("change");
  // Main's snapshot is slim (process-split plan, step 7): the screen goes only to the conversation window's port.
  assert.deepEqual(seen[0].terminal, { revision: 1, slim: true }, "main gets no terminal screen");
  assert.equal(seen[0].backend, "claude");
  assert.deepEqual(seen[0].attachments, []);
  assert.equal(watcherChanges, 1);
});

test("in-process queries read the live session: snapshot, the connected Claude folder, pinned attachments", () => {
  const session = fakeSession();
  const delivery = { closed: false, close() { this.closed = true; },
    snapshot: () => ({ submissions: [{ state: "pending", attachments: [{ id: "pinned" }] }, { state: "accepted", attachments: [{ id: "sent" }] }] }) };
  const { client } = createInProcessCompanion({ session, delivery });
  assert.equal(client.hasDelivery, true);
  assert.equal(client.snapshot().connected, true);
  assert.equal(client.activeClaudePath(), "C:\\work-companion");
  session.set({ connected: false });
  assert.equal(client.snapshot().connected, false);
  assert.equal(client.activeClaudePath(), null);
  assert.equal(client.attachmentPinned("pinned"), true);
  assert.equal(client.attachmentPinned("sent"), false);
});

test("a projection-only client starts from the ready snapshot and follows pushed changes", () => {
  const session = fakeSession();
  const { client } = createInProcessCompanion({ session, projectionOnly: true });
  assert.equal(client.snapshot().phase, "idle");
  session.set({ phase: "working" });
  assert.equal(client.snapshot().phase, "idle", "a projection changes only with a pushed change");
  session.emit("change", { phase: "working" });
  assert.equal(client.snapshot().phase, "working");
  assert.equal(client.activeClaudePath(), "C:\\work-companion", "the connected Claude folder travels with the snapshot");
});

// Step 4: the two queries that had no pushed form. Across a cloning boundary the client answers them from the last
// pushed snapshot: the connected Claude folder (identifies its hooks) and the attachments pinned by a pending or
// uncertain submission.
test("the pushed snapshot carries the connected Claude folder and the pinned attachments", async () => {
  const session = fakeSession();
  let submissions = [{ state: "pending", attachments: [{ id: "pinned" }] }, { state: "accepted", attachments: [{ id: "sent" }] }];
  const delivery = { close() {}, snapshot: () => ({ submissions }) };
  const { client } = createInProcessCompanion({ session, delivery, projectionOnly: true, createPorts: createClonedPorts });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.activeClaudePath(), "C:\\work-companion");
  assert.equal(client.attachmentPinned("pinned"), true);
  assert.equal(client.attachmentPinned("sent"), false);
  session.set({ connected: false });
  submissions = [];
  session.emit("change", session.getSnapshot());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.activeClaudePath(), null);
  assert.equal(client.attachmentPinned("pinned"), false);
});

test("send runs inside the companion: images are selected, submitted and marked sent only on acceptance", async () => {
  let outcome = { state: "outcomeUnknown", reason: "response lost" };
  const session = fakeSession({ submit: async (submission) => { session.calls.push(["submit", submission]); return { id: submission.id, ...outcome }; } });
  const marked = [];
  const attachments = { list: () => [{ id: "image-a" }], select: (ids) => ids.map((id) => ({ id, path: `C:\\img\\${id}.png` })),
    markSent: (ids) => marked.push(...ids) };
  const { client } = createInProcessCompanion({ session, attachments, projectionOnly: true, createPorts: createClonedPorts });
  const uncertain = await client.send({ submissionId: "s-1", text: "look", attachmentIds: ["image-a"], draftRevision: 3 });
  assert.equal(uncertain.state, "outcomeUnknown");
  assert.deepEqual(marked, [], "an uncertain outcome keeps the images");
  assert.deepEqual(session.calls[0][1].attachments, [{ id: "image-a", path: "C:\\img\\image-a.png" }]);
  assert.equal(session.calls[0][1].draftRevision, 3);
  outcome = { state: "accepted", turnId: "t-2" };
  assert.equal((await client.send({ submissionId: "s-2", text: "again", attachmentIds: ["image-a"] })).state, "accepted");
  assert.deepEqual(marked, ["image-a"]);
  assert.deepEqual(client.snapshot().attachments, [{ id: "image-a" }], "the attachment list travels with the snapshot");
});

test("a companion that went away shows offline with the reason, refuses requests, and works again once reattached", async () => {
  const session = fakeSession();
  const { client } = createInProcessCompanion({ session, projectionOnly: true, createPorts: createClonedPorts });
  await new Promise((resolve) => setImmediate(resolve));
  const statuses = [];
  client.on("status", (status) => statuses.push(status));
  client.detach("exited (1)", { crashed: true });
  assert.equal(client.status, "crashed");
  const offline = client.snapshot();
  assert.equal(offline.connected, false);
  assert.equal(offline.phase, "offline");
  assert.equal(offline.process, "crashed");
  assert.match(offline.error, /stopped/);
  assert.equal(client.activeClaudePath(), null, "no Claude folder while the companion is gone");
  await assert.rejects(client.write("x"), (error) => error.code === "companion_crashed");
  assert.deepEqual(statuses, ["crashed"]);
  const again = createInProcessCompanion({ session, projectionOnly: true, createPorts: createClonedPorts, client });
  await again.ready;
  assert.equal(client.status, "ready");
  assert.equal(client.snapshot().process, undefined);
  await client.write("y");
  assert.deepEqual(session.calls.at(-1), ["write", "y"]);
});

// Review 2026-11-05 (P2): a watcher change (paused, retrying) changes the session snapshot, but nothing else does; a
// client that cannot peek must get the new snapshot with the watcher event, across a cloning, asynchronous transport.
test("a watcher change carries the session snapshot to a projection-only client across a cloning boundary", async () => {
  const session = fakeSession();
  session.watcher = new EventEmitter();
  const { client } = createInProcessCompanion({ session, projectionOnly: true, createPorts: createClonedPorts });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.snapshot().watcher, undefined);
  const seen = [];
  client.on("watcher-change", (snapshot) => seen.push(snapshot));
  session.set({ watcher: { state: "retrying", attempt: 2 } });
  session.watcher.emit("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.snapshot().watcher, { state: "retrying", attempt: 2 });
  assert.deepEqual(seen.map((snapshot) => snapshot.watcher.state), ["retrying"]);
});

test("dispose stops the session once, detaches it and closes the delivery store", async () => {
  const session = fakeSession({ dispose: async () => { session.calls.push(["dispose"]); } });
  const delivery = { closed: 0, close() { this.closed++; }, snapshot: () => ({ submissions: [] }) };
  const { client } = createInProcessCompanion({ session, delivery });
  let changes = 0;
  client.on("change", () => changes++);
  await client.dispose();
  await client.dispose();
  session.emit("change", {});
  assert.deepEqual(session.calls, [["dispose"]]);
  assert.equal(delivery.closed, 1);
  assert.equal(changes, 0);
});
