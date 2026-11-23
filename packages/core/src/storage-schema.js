// The SQLite schema of CCF's persistent state (process-split plan, step 6). Used by the storage worker (the only
// writer, inside the core process) and by the export command (read-only, CCF running or not). Rows hold one entity
// each as JSON; `pos` keeps each collection's order. Core state is newest first (highest pos first); companion
// delivery collections keep their array order (lowest pos first).
//
// node:sqlite ships with Electron 36's Node (22.19, SQLite 3.50.4) and with Node 24 (tests): no native module to build
// or unpack. Loaded lazily, with Node's experimental warning for it silenced.

export const SCHEMA_VERSION = 1;

export const STATE_TABLES = Object.freeze({ events: "events", notifications: "notifications", sessions: "sessions" });
export const DELIVERY_TABLES = Object.freeze({ submissions: "delivery_submissions", inbox: "delivery_inbox",
  conversations: "delivery_conversations", closedGenerations: "delivery_closed_generations" });
export const TABLE_ORDER = Object.freeze({
  events: "DESC", notifications: "DESC", sessions: "DESC",
  delivery_submissions: "ASC", delivery_inbox: "ASC", delivery_conversations: "ASC", delivery_closed_generations: "ASC"
});
const ALL_TABLES = Object.keys(TABLE_ORDER);

// Retention the core keeps in memory (core-controller.js); the worker enforces the counts as a safety net.
export const RETAINED = Object.freeze({ events: 200, notifications: 200 });

const MIGRATIONS = [
  // 1: core state and companion delivery as rows; meta for imports and markers.
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   ${ALL_TABLES.map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, json TEXT NOT NULL);
   CREATE INDEX ${table}_pos ON ${table} (pos);`).join("\n")}`
];

let sqlite = null;
export async function loadSqlite() {
  if (sqlite) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function filtered(warning, ...args) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return undefined;
    return emitWarning.call(this, warning, ...args);
  };
  try { sqlite = await import("node:sqlite"); }
  finally { process.emitWarning = emitWarning; }
  return sqlite;
}

// Opens (creating) the database with CCF's pragmas. readOnly: the export command next to a running CCF.
export async function openDatabase(filePath, { readOnly = false, timeoutMs = 5000 } = {}) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(filePath, { readOnly, timeout: timeoutMs });
  try {
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
    }
  } catch (error) {
    db.close();   // a file that is not a database fails here; it must not stay open (Windows would keep it locked)
    throw error;
  }
  return db;
}

export function schemaVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

// Each migration in its own transaction; a database from a newer CCF is refused rather than changed.
export function migrate(db) {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) {
    throw Object.assign(new Error(`ccf.sqlite has schema ${from}; this CCF knows ${SCHEMA_VERSION}. Use the newer CCF or restore an export.`),
      { code: "schema_newer" });
  }
  for (let version = from; version < SCHEMA_VERSION; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return { from, to: SCHEMA_VERSION };
}

export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction may already be gone */ }
    throw error;
  }
}

export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

export function setMeta(db, key, value) {
  if (value === null || value === undefined) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

function assertTable(table) {
  if (!Object.hasOwn(TABLE_ORDER, table)) throw new Error(`Unknown table ${table}.`);
}

// [{id, pos, json}] in the collection's order.
export function readRows(db, table) {
  assertTable(table);
  return db.prepare(`SELECT id, pos, json FROM ${table} ORDER BY pos ${TABLE_ORDER[table]}`).all()
    .map((row) => ({ id: row.id, pos: Number(row.pos), json: row.json }));
}

export function readCollection(db, table) {
  return readRows(db, table).map((row) => JSON.parse(row.json));
}

export function countRows(db, table) {
  assertTable(table);
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

// changes: { [table]: { upsert: [{id, pos, json}], reposition: [{id, pos}], remove: [id] } }. Call inside a transaction.
export function applyChanges(db, changes = {}) {
  let rows = 0;
  for (const [table, change] of Object.entries(changes)) {
    assertTable(table);
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    const upsert = db.prepare(`INSERT INTO ${table} (id, pos, json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, json = excluded.json`);
    const reposition = db.prepare(`UPDATE ${table} SET pos = ? WHERE id = ?`);
    for (const id of change.remove ?? []) { remove.run(String(id)); rows++; }
    for (const row of change.upsert ?? []) { upsert.run(String(row.id), row.pos, row.json); rows++; }
    for (const row of change.reposition ?? []) { reposition.run(row.pos, String(row.id)); rows++; }
  }
  return rows;
}

// Count retention for events and notifications (the controller prunes first; this keeps a bug from growing the file).
export function enforceRetention(db) {
  let removed = 0;
  for (const [table, limit] of Object.entries(RETAINED)) {
    removed += Number(db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY pos DESC LIMIT -1 OFFSET ?)`)
      .run(limit).changes);
  }
  return removed;
}

export function readState(db) {
  return Object.fromEntries(Object.entries(STATE_TABLES).map(([name, table]) => [name, readCollection(db, table)]));
}

export function readDelivery(db) {
  const state = { schemaVersion: 1 };
  for (const [name, table] of Object.entries(DELIVERY_TABLES)) state[name] = readCollection(db, table);
  return state;
}

// The files a CCF from before step 6 reads: state.json's shape (events, notifications, sessions, settings) and
// companion-delivery.json's. The rollback path once SQLite has accepted writes (the imported JSON is stale by then).
export function exportFiles(db, { settings = {} } = {}) {
  const state = readState(db);
  return {
    state: { events: state.events, notifications: state.notifications, sessions: state.sessions, settings },
    delivery: readDelivery(db)
  };
}
