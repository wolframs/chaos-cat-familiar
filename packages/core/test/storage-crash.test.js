// Process-split plan, step 6: kills around SQLite commits and around a companion send's transmission, with real
// processes (forked Node children holding the database or the delivery store; TerminateProcess on Windows).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { CompanionDeliveryStore } from "../src/companion-delivery.js";
import { createStorage } from "../src/storage-worker.js";
import { openDatabase, readCollection } from "../src/storage-schema.js";

const STORAGE_CHILD = new URL("./support/storage-child.mjs", import.meta.url);
const DELIVERY_CHILD = new URL("./support/delivery-child.mjs", import.meta.url);
const target = { backend: "codex", conversationId: "thread-k", generation: "day-k" };

// Removed once every test's processes are gone (a live one keeps the database files locked on Windows).
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function dataDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-storage-crash-"));
  roots.push(root);
  return root;
}

// A child process with requests ({id, method, params}) and events; every request still open fails when it dies.
async function spawn(t, moduleUrl, { onRequest = null } = {}) {
  const child = fork(moduleUrl, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const pending = new Map();
  const events = [];
  const waiters = [];
  let sequence = 0;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    for (const { reject } of pending.values()) reject(Object.assign(new Error("The storage process is gone."), { code: "storage_unavailable" }));
    pending.clear();
    resolve({ code, signal });
  }));
  child.on("message", async (message) => {
    if (message?.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error?.message), { code: message.error?.code }));
    } else if (message?.method && onRequest) {
      try { child.send({ id: message.id, ok: true, result: await onRequest(message.method, message.params) }); }
      catch (error) { child.send({ id: message.id, ok: false, error: { message: error.message, code: error.code ?? null } }); }
    } else {
      events.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const next = async (predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = events.findIndex(predicate);
      if (index >= 0) return events.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error("timed out waiting for the child");
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  await next((message) => message?.ready);
  return {
    child, exited, next,
    request(method, params = null) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(Object.assign(new Error("gone"), { code: "storage_unavailable" }));
      const id = `parent-${++sequence}`;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, method, params }); });
    },
    async kill() { child.kill(); return exited; }
  };
}

async function openReadOnly(root) {
  const db = await openDatabase(path.join(root, "ccf.sqlite"), { readOnly: true });
  return db;
}

test("a process killed while it commits: the database stays consistent and keeps every acknowledged commit", { timeout: 120000 }, async (t) => {
  const root = dataDir();
  for (const killAfter of [50, 400, 1200]) {
    const storage = await spawn(t, STORAGE_CHILD);
    await storage.request("open", { dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json") });
    let acked = 0;
    storage.child.on("message", (message) => { if (message?.acked) acked = Math.max(acked, message.acked); });
    storage.request("loop", { count: 100000, prefix: `kill${killAfter}` }).catch(() => {});
    while (acked < killAfter) await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.kill();
    const db = await openReadOnly(root);
    try {
      assert.equal(Object.values(db.prepare("PRAGMA quick_check").get())[0], "ok", `after a kill at ${acked}`);
      const ids = new Set(readCollection(db, "sessions").map((row) => row.id));
      for (let n = 1; n <= acked; n++) assert.ok(ids.has(`kill${killAfter}-${n}`), `acknowledged commit ${n} of ${acked} survived`);
    } finally { db.close(); }
  }
});

test("the companion killed during a send's transmission: the send comes back uncertain and is never resent", { timeout: 60000 }, async (t) => {
  const root = dataDir();
  const storage = createStorage();
  await storage.open({ dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json"),
    deliveryPath: path.join(root, "companion-delivery.json") });
  t.after(() => storage.close());
  const relay = async (method, params) => (method === "delivery.load" ? storage.loadDelivery() : storage.commitDelivery(params.changes));
  const companion = await spawn(t, DELIVERY_CHILD, { onRequest: relay });
  companion.child.send({ command: "open" });
  await companion.next((message) => message.event === "opened");
  companion.child.send({ command: "submit", input: { ...target, id: "send-1", text: "was this sent?", attachments: [{ id: "img-1", path: "/x.png" }] } });
  await companion.next((message) => message.event === "transmitting");
  const stored = (await storage.loadDelivery()).rows.delivery_submissions.map((row) => JSON.parse(row.json));
  assert.deepEqual(stored.map((record) => [record.id, record.state]), [["send-1", "pending"]], "durable before transmission");
  await companion.kill();

  // Started again (the user's Start): the interrupted send is uncertain, with its images, and nothing transmits.
  const restarted = await spawn(t, DELIVERY_CHILD, { onRequest: relay });
  restarted.child.send({ command: "open" });
  const opened = await restarted.next((message) => message.event === "opened");
  assert.equal(opened.snapshot.submissions[0].state, "outcomeUnknown");
  assert.deepEqual(opened.snapshot.submissions[0].attachments.map((image) => image.id), ["img-1"]);
  assert.equal(JSON.parse((await storage.loadDelivery()).rows.delivery_submissions[0].json).state, "outcomeUnknown", "and so is the database");
  restarted.child.send({ command: "submit", input: { ...target, id: "send-2", text: "another" } });
  const refused = await restarted.next((message) => message.event === "submitFailed" || message.event === "transmitting");
  assert.equal(refused.event, "submitFailed");
  assert.match(refused.error, /Reconcile/);
});

test("the storage process killed during a send's pending commit: nothing is transmitted, sends block until resumed", { timeout: 60000 }, async (t) => {
  const root = dataDir();
  const config = { dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json"), deliveryPath: path.join(root, "companion-delivery.json") };
  let storage = await spawn(t, STORAGE_CHILD);
  await storage.request("open", config);
  const store = new CompanionDeliveryStore({ repository: {
    load: () => storage.request("delivery.load"),
    commit: (changes) => storage.request("delivery.commit", { changes })
  } });
  await store.open();
  await storage.request("delayCommits", { ms: 2000 });
  let transmitted = 0;
  const sending = store.submit({ ...target, id: "send-1", text: "hello" }, async () => { transmitted += 1; return { state: "accepted", turnId: "t" }; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await storage.kill();   // the core dies while the pending record is being committed
  await assert.rejects(sending, /blocked until the companion is started again/);
  assert.equal(transmitted, 0, "never transmitted without an acknowledged pending record");
  assert.equal(store.status().blocked.code, "storage_unavailable");

  storage = await spawn(t, STORAGE_CHILD);   // the restarted core
  await storage.request("open", config);
  await assert.rejects(store.begin({ ...target, id: "send-2", text: "x" }), /blocked/, "a restarted core does not lift the block");
  await store.resume();
  assert.deepEqual(store.snapshot().submissions, [], "the interrupted commit never landed");
  const result = await store.submit({ ...target, id: "send-3", text: "after resume" }, async () => { transmitted += 1; return { state: "accepted", turnId: "t" }; });
  assert.equal(result.state, "accepted");
  assert.equal(transmitted, 1);
});
