// The companion process's composition (process-split plan, step 4), in-process over cloning ports: what the companion
// owns since it left main (delivery state, staged attachments, backend choice) and the guarantees that moved with it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceEndpoint, createClonedPorts } from "../../../packages/core/src/index.js";
import { composeCompanion } from "../companion/companion-composition.js";
import { CompanionClient } from "../services/companion-client.js";
import { createStorage } from "../../../packages/core/src/storage-worker.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VVcAAAAASUVORK5CYII=";

async function compose(t, { setup = () => {}, settings = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-companion-composition-"));
  const data = path.join(root, "chaos-cat-familiar");
  fs.mkdirSync(data, { recursive: true });
  setup(data);
  const [companionPort, mainPort] = createClonedPorts();
  const companionEndpoint = new ServiceEndpoint({ port: companionPort, name: "companion" });
  const mainEndpoint = new ServiceEndpoint({ port: mainPort, name: "main" });
  const logs = [];
  const patches = [];
  mainEndpoint.on("log", (entries) => logs.push(...entries));
  mainEndpoint.handle("settings.patch", ({ patch }) => { patches.push(patch); return true; });
  // Delivery records: main relays them to the core's storage (process-split step 6), here the storage itself.
  const storage = createStorage();
  await storage.open({ dbPath: path.join(data, "ccf.sqlite"), statePath: path.join(data, "state.json"),
    deliveryPath: path.join(data, "companion-delivery.json") });
  mainEndpoint.handle("delivery.load", () => storage.loadDelivery());
  mainEndpoint.handle("delivery.commit", ({ changes }) => storage.commitDelivery(changes));
  mainEndpoint.markReady();
  const composed = await composeCompanion({ endpoint: companionEndpoint, config: { paths: { home: root, root: data },
    settings: { companionBackend: "claude", companionRepoPath: path.join(root, "work-companion"), ...settings },
    testMode: true, killOnCloseJob: false } });
  const client = new CompanionClient();
  client.attach(mainEndpoint);
  companionEndpoint.markReady({ booted: true });
  client.setReady(structuredClone(composed.readiness));
  // In this order: the database keeps its files locked until closed.
  t.after(async () => {
    await client.dispose().catch(() => {});
    await storage.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, data, composed, client, logs, patches, storage };
}

test("unreadable delivery state keeps the companion up, says so, leaves the evidence, and blocks Codex sends visibly", async (t) => {
  const { data, composed, client, logs } = await compose(t, { settings: { companionBackend: "codex" },
    setup: (dir) => fs.writeFileSync(path.join(dir, "companion-delivery.json"), "{ not json") });
  assert.equal(composed.readiness.delivery, false);
  assert.equal(client.hasDelivery, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((entry) => entry.level === "error" && /delivery records are unavailable/.test(entry.message)));
  assert.equal(fs.readFileSync(path.join(data, "companion-delivery.json"), "utf8"), "{ not json", "evidence untouched");
  assert.equal(client.snapshot().backend, "codex");
  assert.match(client.snapshot().error, /Conversation records are unavailable.*needs recovery/);
  await assert.rejects(client.send({ submissionId: "s-1", text: "hello" }), /blocked until the companion is started again/);
  assert.equal(composed.delivery.status().blocked.code, "delivery_unreadable");
});

test("an uncertain Codex send is never replayed: it comes back as outcomeUnknown with its images staged again", async (t) => {
  let imagePath;
  const { client, composed, storage } = await compose(t, { settings: { companionBackend: "codex" }, setup: (dir) => {
    const images = path.join(dir, "companion-attachments");
    fs.mkdirSync(images, { recursive: true });
    const id = "0b0c4f3e-1d4a-4d0c-9a51-3c1f7d2b9e10";
    imagePath = path.join(images, `${id}.png`);
    fs.writeFileSync(imagePath, Buffer.from(PNG, "base64"));
    fs.writeFileSync(path.join(dir, "companion-delivery.json"), JSON.stringify({ schemaVersion: 1, inbox: [], closedGenerations: [],
      conversations: [{ schemaVersion: 1, backend: "codex", conversationId: "thread-1", generation: "g-1", updatedAt: new Date().toISOString() }],
      submissions: [{ schemaVersion: 1, id: "s-pending", backend: "codex", conversationId: "thread-1", generation: "g-1", state: "pending",
        text: "was it sent?", attachments: [{ id, name: "Screenshot.png", path: imagePath }], createdAt: new Date().toISOString() }] }));
  } });
  const snapshot = client.snapshot();
  assert.equal(snapshot.submission.state, "outcomeUnknown", "a pending record from before the restart may have been sent");
  assert.deepEqual(snapshot.attachments.map((image) => image.path), [imagePath], "its images are staged again");
  assert.deepEqual(snapshot.pinnedAttachmentIds, [snapshot.attachments[0].id]);
  await assert.rejects(client.removeAttachment(snapshot.attachments[0].id), /pending or uncertain submission/);
  assert.ok(fs.existsSync(imagePath));
  assert.equal(composed.delivery.snapshot().submissions[0].state, "outcomeUnknown");
  assert.equal((await storage.loadDelivery()).rows.delivery_submissions.map((row) => JSON.parse(row.json).state)[0], "outcomeUnknown",
    "the recovery is committed to the core's database");
});

test("a backend choice is a settings patch to main; main's settings are pushed back in", async (t) => {
  const { client, patches, composed } = await compose(t);
  await client.selectBackend("codex");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(patches, [{ companionBackend: "codex" }]);
  assert.equal(client.snapshot().backend, "codex");
  client.pushSettings({ companionBackend: "codex", companionRepoPath: "C:/elsewhere", codexModel: "m-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(composed.getSettings().codexModel, "m-1");
});

test("images staged through the companion land in its folder and travel with the snapshot", async (t) => {
  const { client, data } = await compose(t);
  await client.addAttachment({ name: "Screenshot.png", dataUrl: `data:image/png;base64,${PNG}` });
  await new Promise((resolve) => setImmediate(resolve));
  const [image] = client.snapshot().attachments;
  assert.ok(image.path.startsWith(path.join(data, "companion-attachments")));
  assert.equal(await client.removeAttachment(image.id), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.snapshot().attachments, []);
  assert.equal(fs.existsSync(image.path), false);
});
