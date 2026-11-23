// Process-split plan, step 6: the core's storage worker (SQLite, imports, settings, log, run marker) and the row diff.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RowShadow } from "../src/row-shadow.js";
import { createStorage } from "../src/storage-worker.js";
import { SqliteStateStore, StorageClient, WorkerSettingsStore } from "../src/storage-client.js";
import { exportFiles, getMeta, openDatabase, readCollection, readRows } from "../src/storage-schema.js";
import { CcfCoreController } from "../src/core-controller.js";
import { normalizeEvent } from "../src/models.js";

// Storages opened in a test close before its folders go (an open database keeps its files locked on Windows).
const closers = new WeakMap();
function closeLater(t, close) {
  if (!closers.has(t)) {
    closers.set(t, []);
    t.after(async () => { for (const closer of closers.get(t).reverse()) await closer().catch(() => {}); });
  }
  closers.get(t).push(close);
}

function dataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-storage-"));
  closeLater(t, async () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function configFor(root, extra = {}) {
  return { dbPath: path.join(root, "ccf.sqlite"), statePath: path.join(root, "state.json"),
    deliveryPath: path.join(root, "companion-delivery.json"), settingsPath: path.join(root, "settings.json"),
    settingsDefaults: { port: 49152 }, logPath: path.join(root, "logs", "ccf.log"), markerPath: path.join(root, "run-marker.json"),
    runId: "run-1", pid: 1, ...extra };
}

async function opened(t, root, extra) {
  const storage = createStorage();
  const result = await storage.open(configFor(root, extra));
  closeLater(t, () => storage.close());
  return { storage, result };
}

async function rowsOf(root, table) {
  const db = await openDatabase(path.join(root, "ccf.sqlite"), { readOnly: true });
  try { return readCollection(db, table); } finally { db.close(); }
}

const legacyState = (events = 3) => ({
  events: Array.from({ length: events }, (_, i) => ({ id: `e-${i}`, hookEventName: "PreToolUse", sessionId: "s-1",
    receivedAt: new Date(Date.UTC(2026, 10, 5, 12, 0, events - i)).toISOString() })),
  notifications: [{ id: "n-1", title: "Done", isRead: false }],
  sessions: [
    { id: "s-1", status: "active", phase: "running", terminalPid: 4242, toolsInFlight: ["t-1"], assistantSource: "x",
      lastEventAt: "2026-11-05T12:00:00.000Z" },
    ...Array.from({ length: 205 }, (_, i) => ({ id: `ended-${i}`, status: "ended", phase: "idle",
      lastEventAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }))
  ],
  settings: { port: 1 }
});

test("RowShadow: new rows on the growing end keep every other row's position; removals and changes only", () => {
  const shadow = new RowShadow({ direction: "desc" });
  const a = { id: "a", v: 1 }; const b = { id: "b", v: 1 };
  let diff = shadow.diff([b, a]);
  assert.deepEqual(diff.change.upsert.map((row) => [row.id, row.pos]), [["b", 2], ["a", 1]]);
  diff.commit();
  assert.equal(shadow.diff([b, a]).change, null, "nothing changed");
  const c = { id: "c", v: 1 };
  b.v = 2;
  diff = shadow.diff([c, b]);
  assert.deepEqual(diff.change.upsert.map((row) => [row.id, row.pos]), [["c", 3], ["b", 2]]);
  assert.deepEqual(diff.change.remove, ["a"]);
  assert.deepEqual(diff.change.reposition, []);
  diff.commit();
  // An order that the positions cannot express renumbers the table.
  diff = shadow.diff([b, c]);
  assert.deepEqual(diff.change.reposition.map((row) => [row.id, row.pos]), [["c", 1]], "b keeps its position 2");
  // Immutable rows are compared by identity: an unchanged event is not serialized again.
  const events = new RowShadow({ direction: "desc", immutable: true });
  const event = { id: "e", toJSON() { throw new Error("serialized again"); } };
  events.reset([{ id: "e", pos: 7, json: "{}" }], [event]);
  assert.equal(events.diff([event]).change, null);
  // Ascending collections (companion delivery) grow at the end.
  const asc = new RowShadow({ direction: "asc", key: (item) => item.backend });
  diff = asc.diff([{ backend: "claude" }, { backend: "codex" }]);
  assert.deepEqual(diff.change.upsert.map((row) => [row.id, row.pos]), [["claude", 1], ["codex", 2]]);
});

test("the first open imports state.json once, with retention and restart resets, and moves it aside with a note", async (t) => {
  const root = dataDir(t);
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(legacyState(250)));
  const { storage, result } = await opened(t, root);
  assert.equal(result.imports.state.status, "imported");
  assert.deepEqual(result.imports.state.counts, { events: 200, notifications: 1, sessions: 201 });
  assert.equal(fs.existsSync(path.join(root, "state.json")), false, "the source moved aside");
  const backup = result.imports.state.backup;
  assert.match(path.basename(backup), /^state\.json\.imported-\d{8}T\d{6}Z$/);
  assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).events.length, 250, "the source is kept unchanged");
  const readme = fs.readFileSync(`${backup}.README.txt`, "utf8");
  for (const word of ["WHERE", "WHY kept", "WHEN to delete", "storage-export.mjs"]) assert.match(readme, new RegExp(word));
  const rows = result.stateRows;
  assert.equal(rows.events.length, 200);
  assert.equal(JSON.parse(rows.events[0].json).id, "e-0", "newest first");
  const session = JSON.parse(rows.sessions.find((row) => row.id === "s-1").json);
  assert.equal(session.terminalPid, null, "restart resets");
  assert.deepEqual(session.toolsInFlight, []);
  assert.equal("assistantSource" in session, false);
  assert.equal(rows.sessions.filter((row) => JSON.parse(row.json).status === "ended").length, 200, "200 ended sessions kept");
  assert.equal(rows.sessions.some((row) => row.id === "ended-0"), false, "the oldest ended ones go");
  await storage.close();

  // Opened again: nothing is imported twice.
  const again = await opened(t, root);
  assert.equal(again.result.imports.state.status, "imported");
  assert.equal(again.result.stateRows.events.length, 200);
});

test("a crash between the import's commit and the move finishes the move; a later state.json is never imported", async (t) => {
  const root = dataDir(t);
  const statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(legacyState(5)));
  const first = await opened(t, root);
  await first.storage.close();
  // As if the process died right after the commit: the source is still there and meta has no backup yet.
  fs.copyFileSync(first.result.imports.state.backup, statePath);
  fs.rmSync(first.result.imports.state.backup);
  {
    const db = await openDatabase(path.join(root, "ccf.sqlite"));
    const record = getMeta(db, "state_import");
    delete record.backup;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'state_import'").run(JSON.stringify(record));
    db.close();
  }
  const second = await opened(t, root);
  assert.equal(fs.existsSync(statePath), false);
  assert.ok(fs.existsSync(second.result.imports.state.backup));
  assert.equal(second.result.stateRows.events.length, 5, "imported once");
  // SQLite takes writes; then an older CCF writes a state.json (a rollback). It is moved aside, not imported.
  await second.storage.commitState({ events: { upsert: [{ id: "new", pos: 99, json: JSON.stringify({ id: "new" }) }] } });
  await second.storage.close();
  fs.writeFileSync(statePath, JSON.stringify({ events: [{ id: "old-build" }], notifications: [], sessions: [] }));
  const third = await opened(t, root);
  assert.equal(fs.existsSync(statePath), false);
  const ignored = fs.readdirSync(root).find((name) => /^state\.json\.not-imported-/.test(name) && !name.endsWith(".txt"));
  assert.ok(ignored, "kept as not-imported");
  assert.match(fs.readFileSync(path.join(root, `${ignored}.README.txt`), "utf8"), /was not imported/);
  assert.deepEqual(third.result.stateRows.events.map((row) => row.id), ["new", "e-0", "e-1", "e-2", "e-3", "e-4"]);
});

test("the state store commits only what changed, and a reload keeps the order with new rows on top", async (t) => {
  const root = dataDir(t);
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(legacyState(3)));
  const commits = [];
  let { storage, result } = await opened(t, root);
  const proxy = { request: async (method, params) => { commits.push(params.changes); return storage.commitState(params.changes); } };
  let store = new SqliteStateStore({ storage: proxy, rows: result.stateRows, flushDelayMs: 5 });
  let controller = new CcfCoreController({ overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} },
    stateStore: store });
  await controller.ingestEvent(normalizeEvent({ hook_event_name: "PreToolUse", session_id: "s-1", tool_name: "Read", event_id: "fresh-1" }));
  await store.flush();
  const first = commits.at(-1);
  assert.deepEqual(first.events.upsert.map((row) => row.id), ["fresh-1"], "one new event, nothing else re-sent");
  assert.deepEqual(first.events.remove, []);
  assert.ok(first.sessions.upsert.some((row) => row.id === "s-1"), "the session it changed");
  assert.equal(first.sessions.upsert.length < 10, true, "not every session");
  await controller.ingestEvent(normalizeEvent({ hook_event_name: "PreToolUse", session_id: "s-1", tool_name: "Read", event_id: "fresh-2" }));
  assert.equal(await store.close(), true);
  await storage.close();

  ({ storage, result } = await opened(t, root));
  store = new SqliteStateStore({ storage: { request: (m, p) => storage.commitState(p.changes) }, rows: result.stateRows, flushDelayMs: 5 });
  controller = new CcfCoreController({ overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} }, stateStore: store });
  assert.deepEqual(controller.events.map((event) => event.id), ["fresh-2", "fresh-1", "e-0", "e-1", "e-2"]);
  await controller.ingestEvent(normalizeEvent({ hook_event_name: "Stop", session_id: "s-1", event_id: "fresh-3" }));
  await store.close();
  assert.deepEqual((await rowsOf(root, "events")).map((event) => event.id).slice(0, 3), ["fresh-3", "fresh-2", "fresh-1"]);
});

test("a database that SQLite cannot read is moved aside with a note, and a fresh one starts", async (t) => {
  const root = dataDir(t);
  fs.writeFileSync(path.join(root, "ccf.sqlite"), "this is not a database, just bytes ".repeat(200));
  const { result } = await opened(t, root);
  assert.ok(result.quarantine);
  assert.ok(fs.existsSync(result.quarantine));
  assert.match(fs.readFileSync(`${result.quarantine}.README.txt`, "utf8"), /WHEN to delete/);
  assert.equal(result.schema.version, 1);
});

// Review of step 6 (P1): the fresh database served empty delivery records as healthy, so uncertain submissions and the
// images they pin vanished and Codex sends were allowed again. Delivery stays blocked, across restarts, until the user
// dealt with the quarantined file (deleted or moved it).
test("after a quarantine, delivery records stay blocked until the quarantined database is dealt with", async (t) => {
  const root = dataDir(t);
  fs.writeFileSync(path.join(root, "ccf.sqlite"), "this is not a database, just bytes ".repeat(200));
  const { storage, result } = await opened(t, root);
  assert.match(fs.readFileSync(`${result.quarantine}.README.txt`, "utf8"), /Codex sends stay blocked/);
  await assert.rejects(async () => storage.loadDelivery(), (error) => error.code === "delivery_unreadable"
    && error.message.includes(result.quarantine));
  await storage.close();
  const again = await opened(t, root);
  assert.equal(again.result.quarantine, null, "the fresh database opens normally");
  await assert.rejects(async () => again.storage.loadDelivery(), (error) => error.code === "delivery_unreadable",
    "still blocked after a restart");
  fs.renameSync(result.quarantine, `${result.quarantine}.recovered`);
  const loaded = await again.storage.loadDelivery();
  assert.deepEqual(loaded.rows.delivery_submissions, []);
  await again.storage.close();
  const later = await opened(t, root);
  assert.ok(await later.storage.loadDelivery(), "resolved for good");
});

// Final review (P2): the corrupt database was renamed before the delivery block was committed, so a crash or a failed
// README write in between left no trace, and the next start served empty delivery records as healthy. The intent is
// persisted before anything moves; each interruption below ends, on the next start, with delivery blocked.
const corruptDb = (root) => fs.writeFileSync(path.join(root, "ccf.sqlite"), "this is not a database, just bytes ".repeat(200));
// A promises file system whose call `name` fails once with EIO where `match(...args)` holds (a crash at that point).
function failingOnce(name, match) {
  let failed = false;
  const wrapped = Object.create(fs.promises);
  wrapped[name] = async (file, ...args) => {
    if (!failed && match(String(file), ...args.map(String))) {
      failed = true;
      throw Object.assign(new Error(`EIO: injected ${name} failure on ${file}`), { code: "EIO" });
    }
    return fs.promises[name](file, ...args);
  };
  return wrapped;
}
async function expectBlocked(t, root) {
  const { storage, result } = await opened(t, root);
  await assert.rejects(async () => storage.loadDelivery(), (error) => error.code === "delivery_unreadable",
    "delivery stays blocked");
  const quarantine = getMeta(await openDatabase(path.join(root, "ccf.sqlite"), { readOnly: true }).then((db) => {
    closeLater(t, async () => db.close());
    return db;
  }), "delivery_recovery").quarantine;
  assert.ok(fs.existsSync(quarantine), "the quarantined database exists");
  assert.equal(fs.readFileSync(quarantine, "utf8").startsWith("this is not a database"), true, "it is the corrupt one");
  assert.match(fs.readFileSync(`${quarantine}.README.txt`, "utf8"), /Codex sends stay blocked/);
  assert.equal(fs.existsSync(path.join(root, "ccf.sqlite.quarantine.json")), false, "the intent is done");
  assert.equal(fs.readdirSync(root).filter((name) => /\.corrupt-\d{8}T\d{6}Z$/.test(name)).length, 1, "moved aside once");
  return { storage, result, quarantine };
}

test("quarantine interrupted before the database moved: the next start quarantines it and blocks delivery", async (t) => {
  const root = dataDir(t);
  corruptDb(root);
  const storage = createStorage({ fsImpl: failingOnce("rename", (source, destination) => /\.corrupt-\d{8}T\d{6}Z$/.test(destination)) });
  // The first rename into a quarantine name fails (crash before anything moved).
  await assert.rejects(storage.open(configFor(root)));
  await storage.close();
  assert.ok(fs.existsSync(path.join(root, "ccf.sqlite")), "nothing moved yet");
  await expectBlocked(t, root);
});

test("quarantine interrupted between moving the database and its -wal: the next start finishes the move and blocks", async (t) => {
  const root = dataDir(t);
  corruptDb(root);
  const fsImpl = failingOnce("rename", (source, destination) => /\.corrupt-.*-wal$/.test(destination));
  const rename = fsImpl.rename;
  fsImpl.rename = async (source, destination) => {
    const result = await rename(source, destination);
    // SQLite deletes a garbage -wal when it opens the database, so the -wal that a real corrupt database may keep
    // appears here, once the database itself moved.
    if (/\.corrupt-\d{8}T\d{6}Z$/.test(destination)) fs.writeFileSync(`${source}-wal`, "wal bytes of the corrupt database");
    return result;
  };
  const storage = createStorage({ fsImpl });
  await assert.rejects(storage.open(configFor(root)));
  await storage.close();
  assert.equal(fs.existsSync(path.join(root, "ccf.sqlite")), false, "the database moved");
  assert.ok(fs.existsSync(path.join(root, "ccf.sqlite-wal")), "its -wal did not");
  const { quarantine } = await expectBlocked(t, root);
  assert.equal(fs.readFileSync(`${quarantine}-wal`, "utf8"), "wal bytes of the corrupt database", "the -wal followed its database");
});

test("quarantine interrupted after the fresh database was created, before the block was committed: still blocked", async (t) => {
  const root = dataDir(t);
  corruptDb(root);
  // As if the process died right after creating the fresh database: everything moved, the fresh file exists, no meta.
  const quarantine = path.join(root, "ccf.sqlite.corrupt-20261106T120000Z");
  fs.writeFileSync(path.join(root, "ccf.sqlite.quarantine.json"), JSON.stringify({ quarantine, error: "file is not a database",
    at: "2026-11-06T12:00:00.000Z" }));
  fs.renameSync(path.join(root, "ccf.sqlite"), quarantine);
  (await openDatabase(path.join(root, "ccf.sqlite"))).close();
  const { quarantine: recorded } = await expectBlocked(t, root);
  assert.equal(recorded, quarantine);
});

test("quarantine: a failed README write keeps the block, and the next start writes the README", async (t) => {
  const root = dataDir(t);
  corruptDb(root);
  const storage = createStorage({ fsImpl: failingOnce("writeFile", (file) => file.endsWith(".README.txt")) });
  const result = await storage.open(configFor(root));
  assert.ok(result.quarantine);
  await assert.rejects(async () => storage.loadDelivery(), (error) => error.code === "delivery_unreadable");
  assert.equal(fs.existsSync(`${result.quarantine}.README.txt`), false);
  await storage.close();
  await expectBlocked(t, root);
});

test("quarantine: an intent left behind after the block was committed changes nothing on the next start", async (t) => {
  const root = dataDir(t);
  corruptDb(root);
  const storage = createStorage({ fsImpl: failingOnce("rm", (file) => file.endsWith("ccf.sqlite.quarantine.json")) });
  const result = await storage.open(configFor(root));
  await storage.close();
  const { quarantine } = await expectBlocked(t, root);
  assert.equal(quarantine, result.quarantine);
});

test("settings: a patch lands on the file's current content, outside edits are reported, the file stays plain JSON", async (t) => {
  const root = dataDir(t);
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ port: 5, hookToken: "t" }));
  const { storage, result } = await opened(t, root);
  assert.deepEqual(result.settings.value, { port: 5, hookToken: "t" });
  fs.writeFileSync(settingsPath, JSON.stringify({ port: 5, hookToken: "t", hookRelayPort: 49151 }));   // a script's edit
  const written = await storage.writeSettings({ debugLogging: true });
  assert.deepEqual(written.value, { port: 5, hookToken: "t", hookRelayPort: 49151, debugLogging: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), written.value);
  const changes = [];
  storage.watchSettings(20, (value) => changes.push(value.value));
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(settingsPath, JSON.stringify({ ...written.value, port: 7 }));
  for (let i = 0; i < 50 && !changes.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(changes.at(-1)?.port, 7);
  await storage.close();
  // A file that does not parse is kept as evidence; defaults load.
  fs.writeFileSync(settingsPath, "{ broken");
  const fresh = await opened(t, dataDir(t), { settingsPath });
  assert.deepEqual(fresh.result.settings.value, { port: 49152 });
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("settings.json.corrupt-")));
});

// Review of step 6 (P2): the stamp was taken after the read (and after the write), so an outside edit in between paired
// the older content with the newer stamp: the watch never reported the edit and the next patch wrote over it.
test("settings: an outside edit between a read and its stamp is neither missed nor overwritten", async (t) => {
  const root = dataDir(t);
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ port: 5, hookToken: "t" }));
  let edits = [JSON.stringify({ port: 5, hookToken: "t", hookRelayPort: 49151 })];
  const fsImpl = Object.create(fs.promises);
  fsImpl.readFile = async (file, ...args) => {
    const text = await fs.promises.readFile(file, ...args);
    if (file === settingsPath && edits.length) fs.writeFileSync(settingsPath, edits.shift());   // a script's edit, right after
    return text;
  };
  const storage = createStorage({ fsImpl });
  closeLater(t, () => storage.close());
  const result = await storage.open(configFor(root));
  assert.equal(result.settings.value.hookRelayPort, 49151, "the read that raced the edit was repeated");
  await storage.writeSettings({ debugLogging: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { port: 5, hookToken: "t", hookRelayPort: 49151, debugLogging: true });

  // The same race right after CCF's own write: the watch reports the outside edit.
  const changes = [];
  storage.watchSettings(20, (value) => changes.push(value.value));
  edits = [JSON.stringify({ port: 8, hookToken: "t", hookRelayPort: 49151, debugLogging: true })];
  await storage.writeSettings({ debugLogging: false });
  for (let i = 0; i < 50 && !changes.some((value) => value.port === 8); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(changes.at(-1)?.port, 8, "the edit made right after CCF's write is reported");
});

test("the log is appended and rotated in the worker; the run marker spans core restarts within one run", async (t) => {
  const root = dataDir(t);
  const { storage, result } = await opened(t, root, { logMaxBytes: 100 });
  assert.deepEqual({ unclean: result.recovery.previousUncleanExit, active: result.recovery.active }, { unclean: false, active: true });
  for (let i = 0; i < 5; i++) await storage.appendLog(`${"x".repeat(30)} ${i}\n`);
  const log = path.join(root, "logs", "ccf.log");
  assert.ok(fs.statSync(log).size <= 100);
  assert.ok(fs.existsSync(`${log}.1`), "rotated once");
  await storage.close();
  // A restarted core in the same run: not an unclean exit.
  const restarted = await opened(t, root);
  assert.equal(restarted.result.recovery.sameRun, true);
  assert.equal(restarted.result.recovery.previousUncleanExit, false);
  await restarted.storage.close();
  // The next run finds the marker: the previous one ended uncleanly.
  const next = await opened(t, root, { runId: "run-2" });
  assert.equal(next.result.recovery.previousUncleanExit, true);
  assert.equal(next.result.recovery.previousRun.runId, "run-1");
  assert.deepEqual(await next.storage.cleanMarker("run-1"), { ok: false, error: "Run marker belongs to another runtime or was changed" });
  assert.deepEqual(await next.storage.cleanMarker("run-2"), { ok: true });
  assert.equal(fs.existsSync(path.join(root, "run-marker.json")), false);
});

test("companion delivery: a valid file is imported; an unreadable one stays as evidence and loading it fails", async (t) => {
  const root = dataDir(t);
  const deliveryPath = path.join(root, "companion-delivery.json");
  const state = { schemaVersion: 1, submissions: [{ id: "sub-1", backend: "codex", conversationId: "c", state: "outcomeUnknown" }],
    inbox: [], closedGenerations: ["g-0"], conversations: [{ backend: "codex", conversationId: "c", generation: "g-1" }] };
  fs.writeFileSync(deliveryPath, JSON.stringify(state));
  const { storage } = await opened(t, root);
  const loaded = (await storage.loadDelivery()).rows;
  assert.deepEqual(loaded.delivery_submissions.map((row) => JSON.parse(row.json)), state.submissions);
  assert.deepEqual(loaded.delivery_closed_generations.map((row) => [row.id, row.pos]), [["g-0", 1]]);
  assert.deepEqual(loaded.delivery_conversations.map((row) => row.id), ["codex"]);
  assert.equal(fs.existsSync(deliveryPath), false);
  await storage.close();

  const other = dataDir(t);
  fs.writeFileSync(path.join(other, "companion-delivery.json"), "{ not json");
  const broken = await opened(t, other);
  assert.equal(broken.result.imports.delivery.status, "unreadable");
  await assert.rejects(async () => broken.storage.loadDelivery(), (error) => error.code === "delivery_unreadable" && /evidence preserved/.test(error.message));
  assert.equal(fs.readFileSync(path.join(other, "companion-delivery.json"), "utf8"), "{ not json", "evidence untouched");
});

test("export writes the shapes an older CCF reads", async (t) => {
  const root = dataDir(t);
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(legacyState(4)));
  const { storage } = await opened(t, root);
  await storage.close();
  const db = await openDatabase(path.join(root, "ccf.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const files = exportFiles(db, { settings: { port: 1 } });
  assert.deepEqual(files.state.events.map((event) => event.id), ["e-0", "e-1", "e-2", "e-3"]);
  assert.equal(files.state.sessions.length, 201);
  assert.deepEqual(files.state.settings, { port: 1 });
  assert.deepEqual(files.delivery, { schemaVersion: 1, submissions: [], inbox: [], closedGenerations: [], conversations: [] });
  assert.equal(readRows(db, "events").length, 4);
});

test("through the real worker thread: open, commit, settings and log requests, close", async (t) => {
  const root = dataDir(t);
  const storage = new StorageClient();
  closeLater(t, () => storage.close().finally(() => storage.terminate()));
  const result = await storage.open(configFor(root));
  const state = new SqliteStateStore({ storage, rows: result.stateRows, flushDelayMs: 1 });
  state.save({ events: [{ id: "w-1" }], notifications: [], sessions: [] });
  assert.equal(await state.flush(), true);
  const settings = new WorkerSettingsStore({ storage, initial: result.settings.value });
  assert.equal((await settings.save(null, { patch: { hookToken: "abc" } })).hookToken, "abc");
  assert.equal(settings.load().hookToken, "abc");
  assert.equal(await storage.request("log.append", { text: "line\n" }), true);
  const status = await storage.request("status");
  assert.equal(status.counts.events, 1);
  assert.equal(await storage.close(), true);
  assert.deepEqual((await rowsOf(root, "events")).map((event) => event.id), ["w-1"]);
});

// Process-split plan, step 6: rename retries no longer block any event loop. While settings.json is held by another
// process (a real lock), the worker's write retries asynchronously and its loop keeps serving commits.
test("a held settings.json fails the write after async retries, and the loop stays free meanwhile", { skip: process.platform !== "win32" }, async (t) => {
  const { holdFileExclusively } = await import("../../../apps/windows-shell/test-support/file-lock.js");
  const root = dataDir(t);
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ port: 1 }));
  const { storage } = await opened(t, root);
  const lock = await holdFileExclusively(settingsPath);
  let lag = 0;
  let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 5); last = now; }, 5);
  try {
    const writing = storage.writeSettings({ port: 2 }).then(() => "written", (error) => error.code);
    const started = performance.now();
    await storage.commitState({ events: { upsert: [{ id: "during", pos: 1, json: "{}" }] } });
    assert.ok(performance.now() - started < 200, "a commit is not held up by the settings write");
    assert.match(await writing, /EPERM|EBUSY|EACCES/);
  } finally {
    clearInterval(ticker);
    await lock.release();
  }
  assert.ok(lag < 100, `event loop lag while retrying: ${Math.round(lag)} ms`);
  assert.equal((await storage.writeSettings({ port: 2 })).value.port, 2, "written once the file is free");
});

// Process-split plan, step 6: no rename retry blocks an event loop. The synchronous writer (and FileSettingsStore, its
// only user) remain for unit tests; production code writes with the asynchronous one or through the storage worker.
test("production code uses no blocking rename retry", () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../..");
  const folders = ["packages/core/src", "apps/windows-shell/core", "apps/windows-shell/companion", "apps/windows-shell/runtime",
    "apps/windows-shell/services"];
  const allowed = new Set(["atomic-json.js", "file-settings-store.js", "index.js"]);
  const offenders = [];
  for (const folder of folders) {
    for (const name of fs.readdirSync(path.join(repo, folder)).filter((file) => file.endsWith(".js") && !allowed.has(file))) {
      const code = fs.readFileSync(path.join(repo, folder, name), "utf8").replace(/^\s*\/\/.*$/gm, "");
      if (/\bwriteJsonAtomic\b(?!Async)|\brenameWithRetry\b(?!Async)|\bFileSettingsStore\b/.test(code)) offenders.push(`${folder}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
