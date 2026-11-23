// The rollback path of the process split's step 6: CCF's current state as the JSON files an older CCF reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStorage } from "../../packages/core/src/storage-worker.js";
import { openDatabase } from "../../packages/core/src/storage-schema.js";
import { exportStorage } from "./storage-export.mjs";

test("storage-export writes state.json and companion-delivery.json from ccf.sqlite, and guards the rollback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ events: [{ id: "e-1" }], notifications: [],
    sessions: [{ id: "s-1", status: "active" }] }));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ port: 49152 }));
  const storage = createStorage();
  await storage.open({ dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json") });
  await storage.commitState({ events: { upsert: [{ id: "e-2", pos: 2, json: JSON.stringify({ id: "e-2" }) }] } });

  // While CCF runs (the database open in its worker): an export to a folder of its own works.
  const out = path.join(root, "out");
  const exported = await exportStorage({ root, out });
  assert.deepEqual(JSON.parse(fs.readFileSync(exported.files.state, "utf8")).events.map((event) => event.id), ["e-2", "e-1"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(exported.files.state, "utf8")).settings, { port: 49152 });
  assert.equal(JSON.parse(fs.readFileSync(exported.files.delivery, "utf8")).schemaVersion, 1);
  // The rollback into the data folder refuses while CCF looks alive.
  fs.writeFileSync(path.join(root, "runtime.json"), "{}");
  await assert.rejects(exportStorage({ root, toJson: true }), /running/);
  fs.rmSync(path.join(root, "runtime.json"));
  await storage.close();
  const rolledBack = await exportStorage({ root, toJson: true });
  assert.equal(rolledBack.files.state, path.join(root, "state.json"));
  assert.equal(rolledBack.counts.events, 2);
  await assert.rejects(exportStorage({ root, toJson: true }), /Refusing to overwrite/);
});

// Review of step 6 (P2): the tables were read one by one, so a live export could mix a commit's rows with the state
// before it; and right after CCF was hard-killed the first attempt once failed with "disk I/O error" (the WAL still
// settling), which a retry a moment later did not.
test("storage-export reads one snapshot, retries a transient SQLite error and names it when it persists", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-export-"));
  const storage = createStorage();
  t.after(async () => {
    await storage.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await storage.open({ dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json") });
  storage.commitState({ events: { upsert: [{ id: "e-1", pos: 1, json: JSON.stringify({ id: "e-1" }) }] } });

  // A commit (an event and a submission together) lands while the export is between its tables.
  const row = (id) => ({ id, pos: 2, json: JSON.stringify({ id, backend: "codex", conversationId: "c", state: "pending" }) });
  const racing = (db) => new Proxy(db, { get(target, key) {
    if (key !== "prepare") {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql) => {
      if (/delivery_submissions/.test(sql) && !racing.done) {
        racing.done = true;
        storage.commitDelivery({ events: { upsert: [{ id: "e-2", pos: 2, json: JSON.stringify({ id: "e-2" }) }] },
          delivery_submissions: { upsert: [row("sub-1")] } });
      }
      return target.prepare(sql);
    };
  } });
  const consistent = await exportStorage({ root, out: path.join(root, "a"), open: async (...args) => racing(await openDatabase(...args)) });
  const events = JSON.parse(fs.readFileSync(consistent.files.state, "utf8")).events.map((event) => event.id);
  const submissions = JSON.parse(fs.readFileSync(consistent.files.delivery, "utf8")).submissions.map((item) => item.id);
  assert.ok(racing.done, "the commit raced the export");
  assert.deepEqual({ events, submissions }, { events: ["e-1"], submissions: [] }, "the export is the state before the commit");

  // A transient error (SQLITE_IOERR_SHORT_READ) on the first attempt: retried.
  const tries = [];
  const flaky = async (...args) => {
    tries.push(Date.now());
    if (tries.length === 1) throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 522, errstr: "disk I/O error" });
    return openDatabase(...args);
  };
  const retried = await exportStorage({ root, out: path.join(root, "b"), open: flaky, sleep: async () => {} });
  assert.equal(tries.length, 2);
  assert.equal(retried.counts.events, 2);
  assert.equal(retried.retries, 1);

  // One that persists: a clear message with SQLite's extended code; a non-transient error is not retried.
  const broken = async () => { throw Object.assign(new Error("disk I/O error"), { errcode: 522, errstr: "disk I/O error" }); };
  await assert.rejects(exportStorage({ root, out: path.join(root, "c"), open: broken, sleep: async () => {} }),
    /could not be read.*extended code 522.*wait a few seconds/s);
  let notADb = 0;
  await assert.rejects(exportStorage({ root, out: path.join(root, "d"), sleep: async () => {},
    open: async () => { notADb++; throw Object.assign(new Error("file is not a database"), { errcode: 26 }); } }), /extended code 26/);
  assert.equal(notADb, 1);
});
