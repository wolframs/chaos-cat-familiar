// The core's storage worker (process-split plan, step 6): a worker thread inside the core process that does all of
// the core's file work, so the core's own event loop never waits on a disk or a virus scanner. It owns the one SQLite
// connection (WAL, synchronous=FULL; core state and companion delivery as rows), migrations and retention, the imports
// of state.json and companion-delivery.json, settings.json writes (read-modify-write against edits made outside CCF,
// async rename retries) and the watch for outside edits, the log file with its rotation, and the run marker.
// SQLite calls are synchronous here, in this thread; everything else is asynchronous.
//
// Requests (ServiceEndpoint): open, state.commit, delivery.load, delivery.commit, settings.write, settings.watch,
// log.append, marker.clean, status, close. Event: settings.changed.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ServiceEndpoint, ServiceError } from "./service-rpc.js";
import { loadJsonWithRecoveryAsync, renameWithRetryAsync, writeJsonAtomicAsync } from "./atomic-json.js";
import { mergeSettingsPatch } from "./settings-authority.js";
import { SessionStore } from "./session-store.js";
import { validateDeliveryState } from "./companion-delivery.js";
import { DELIVERY_TABLES, STATE_TABLES, RETAINED, applyChanges, countRows, enforceRetention, getMeta, migrate,
  openDatabase, readRows, schemaVersion, setMeta, transaction } from "./storage-schema.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DELIVERY_RECOVERY = "delivery_recovery";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const stampOf = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// Test-only fault injection (the load fixture): every file call under `root` waits delayMs, renames there fail with
// EPERM every lockEvery-th time, and each SQLite commit blocks this thread for delayMs (the scanner holding the WAL).
function faultyFiles(options) {
  const fsp = fs.promises;
  if (!options?.root) return { fsp, stats: null, commitDelay: () => {} };
  const prefix = path.resolve(options.root).toLowerCase();
  const under = (file) => typeof file === "string" && path.resolve(file).toLowerCase().startsWith(prefix);
  const delayMs = options.delayMs ?? 25;
  const lockEvery = options.lockEvery ?? 2;
  const stats = { delayedCalls: 0, delayedMs: 0, renameLocks: 0, commits: 0 };
  let renames = 0;
  const delayed = (name) => async (file, ...args) => {
    if (under(file)) { stats.delayedCalls++; stats.delayedMs += delayMs; await sleep(delayMs); }
    return fsp[name](file, ...args);
  };
  const wrapped = Object.create(fsp);
  for (const name of ["readFile", "writeFile", "appendFile", "stat", "open", "rm", "mkdir"]) wrapped[name] = delayed(name);
  wrapped.rename = async (source, destination) => {
    if (under(destination)) {
      stats.delayedCalls++; stats.delayedMs += delayMs;
      await sleep(delayMs);
      if (renames++ % lockEvery === 0) {
        stats.renameLocks++;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), { code: "EPERM" });
      }
    }
    return fsp.rename(source, destination);
  };
  const cell = new Int32Array(new SharedArrayBuffer(4));
  return { fsp: wrapped, stats, commitDelay: () => { stats.commits++; stats.delayedMs += delayMs; Atomics.wait(cell, 0, 0, delayMs); } };
}

// log: { logPath, logMaxBytes } known before open(), so the core's first lines are not held back by the database.
// fsImpl: a promises file system in place of node's (tests that race a file edit against a read).
export function createStorage({ faults = null, logger = null, log = null, fsImpl = null } = {}) {
  const faulty = faultyFiles(faults);
  const { stats: faultStats, commitDelay } = faulty;
  const fsp = fsImpl ?? faulty.fsp;
  let db = null;
  let config = null;
  let logConfig = log;
  let settingsKnown = { value: {}, stamp: null };
  let settingsChain = Promise.resolve();
  let logChain = Promise.resolve();
  let logBytes = null;
  let watchTimer = null;
  let closed = false;
  const stats = { commits: 0, rows: 0, lastCommitMs: null, maxCommitMs: 0, retentionRemoved: 0, settingsWrites: 0,
    logAppends: 0, logBytes: 0 };
  const warn = (message, context) => { try { logger?.(message, context); } catch { /* reporting */ } };

  const serialize = (chain, work) => {
    const result = chain.then(work, work);
    return { result, chain: result.catch(() => {}) };
  };
  const onSettings = (work) => { const next = serialize(settingsChain, work); settingsChain = next.chain; return next.result; };
  const onLog = (work) => { const next = serialize(logChain, work); logChain = next.chain; return next.result; };

  async function stamp(filePath) {
    try {
      const stat = await fsp.stat(filePath, { bigint: true });
      return `${stat.mtimeNs}:${stat.size}`;
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }

  async function readText(filePath) {
    try { return await fsp.readFile(filePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function note(filePath, lines) {
    await fsp.writeFile(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  // --- database --------------------------------------------------------------------------------------------------

  async function exists(filePath) {
    try { await fsp.stat(filePath); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  // A quarantine is a sequence of file moves and a commit to a database that does not exist yet, so its intent is
  // written first, next to the database (final review, P2: a crash or a failed README write between the move and the
  // block's commit left no trace, and the next start served empty delivery records as healthy). Steps: intent, move
  // the database, then its -wal and -shm, create the fresh database, commit the block, write the README, drop the
  // intent. A start that finds the intent resumes at the first step not done; each step can be repeated.
  const intentPathOf = (dbPath) => `${dbPath}.quarantine.json`;

  async function readIntent(dbPath) {
    const text = await readText(intentPathOf(dbPath));
    if (text === null) return null;
    try {
      const intent = JSON.parse(text);
      if (typeof intent?.quarantine === "string" && intent.quarantine.startsWith(`${dbPath}.corrupt-`)) return intent;
    } catch { /* below */ }
    warn("A quarantine intent that does not parse was ignored", { file: intentPathOf(dbPath) });
    return null;
  }

  async function openDb(dbPath) {
    let intent = await readIntent(dbPath);
    if (intent && !(await exists(intent.quarantine))) {
      // Stopped before the database moved: nothing happened yet, and the check below decides again.
      await fsp.rm(intentPathOf(dbPath), { force: true });
      intent = null;
    }
    if (!intent) {
      try {
        const opened = await openDatabase(dbPath);
        try {
          const check = opened.prepare("PRAGMA quick_check").get();
          if (Object.values(check)[0] !== "ok") throw Object.assign(new Error(`quick_check: ${JSON.stringify(check)}`), { errcode: 11 });
          return { db: opened, migrated: migrate(opened), quarantine: null };
        } catch (error) {
          opened.close();
          throw error;
        }
      } catch (error) {
        if (![11, 26].includes(error?.errcode)) throw error;   // SQLITE_CORRUPT, SQLITE_NOTADB
        // Kept, never repaired in place: the history may still be recoverable with sqlite tools.
        intent = { quarantine: `${dbPath}.corrupt-${stampOf()}`, error: String(error.message), at: new Date().toISOString() };
        await writeJsonAtomicAsync(intentPathOf(dbPath), intent, { fsp });
      }
    }
    return quarantineDb(dbPath, intent);
  }

  async function quarantineDb(dbPath, intent) {
    const { quarantine } = intent;
    // The fresh database's file appears only after the corrupt one moved; once it exists, whatever sits at the -wal
    // and -shm names is its own.
    const movedMain = await exists(quarantine);
    if (!(movedMain && await exists(dbPath))) {
      for (const suffix of movedMain ? ["-wal", "-shm"] : ["", "-wal", "-shm"]) {
        await renameWithRetryAsync(dbPath + suffix, quarantine + suffix, { fsp }).catch((renameError) => {
          if (renameError.code !== "ENOENT") throw renameError;
        });
      }
    }
    const fresh = await openDatabase(dbPath);
    let migrated;
    try {
      migrated = migrate(fresh);
      // The fresh database knows no delivery records, which is not the same as there being none (review of step 6, P1).
      if (getMeta(fresh, DELIVERY_RECOVERY)?.quarantine !== quarantine) {
        transaction(fresh, () => setMeta(fresh, DELIVERY_RECOVERY, { status: "quarantined", quarantine,
          error: intent.error, at: intent.at }));
      }
    } catch (error) {
      fresh.close();
      throw error;
    }
    warn("The state database was unreadable; moved aside and started fresh", { quarantine, error: intent.error });
    // The block holds from here on; a README that cannot be written now is written by the next start.
    try {
      if (!(await exists(`${quarantine}.README.txt`))) {
        await note(`${quarantine}.README.txt`, [
          `CCF could not read ${dbPath} (${intent.error}) and started a new database.`,
          `WHERE: ${quarantine} (with -wal/-shm if they existed).`,
          "WHY: the session history, notifications and companion delivery records in it may be recoverable",
          "(sqlite3 .recover, or `node scripts/windows/storage-export.mjs --db <this file>`).",
          "Codex sends stay blocked while this file is here: its delivery records may hold sends whose outcome is unknown",
          "(and the images they pin). Recover them first if they matter; deleting or moving this file lifts the block",
          "(press Start in the companion afterwards).",
          "WHEN to delete: once its data was recovered or judged not worth recovering."
        ]);
      }
      await fsp.rm(intentPathOf(dbPath), { force: true });
    } catch (error) {
      warn("The quarantine's note could not be finished; the next start finishes it", { quarantine,
        error: String(error?.message ?? error) });
    }
    return { db: fresh, migrated, quarantine };
  }

  // Delivery records lost with a quarantined database block delivery until the quarantined file is gone (the user
  // recovered what mattered, or decided it does not). Returns the blocking record, or null.
  async function deliveryRecoveryBlock() {
    const recovery = getMeta(db, DELIVERY_RECOVERY);
    if (recovery?.status !== "quarantined") return null;
    try {
      await fsp.stat(recovery.quarantine);
      return recovery;
    } catch (error) {
      if (error.code !== "ENOENT") return recovery;
      transaction(db, () => setMeta(db, DELIVERY_RECOVERY, { ...recovery, status: "resolved", resolvedAt: new Date().toISOString() }));
      warn("The quarantined database is gone; companion delivery records start empty", { quarantine: recovery.quarantine });
      return null;
    }
  }

  // Moves an imported (or ignored) JSON source aside with a note saying where it is, why it is kept, when it may go.
  async function moveAside(sourcePath, kind, metaKey, record) {
    const backup = `${sourcePath}.${kind}-${stampOf()}`;
    try {
      await renameWithRetryAsync(sourcePath, backup, { fsp });
    } catch (error) {
      warn("A JSON file SQLite took over could not be moved aside; the next start tries again", {
        file: sourcePath, error: String(error?.message ?? error) });
      return null;
    }
    const name = path.basename(sourcePath);
    await note(`${backup}.README.txt`, kind === "imported" ? [
      `${name} as it was when CCF moved its contents into ccf.sqlite (${new Date().toISOString()}).`,
      `WHERE: ${backup}. The data now lives in ${config.dbPath}.`,
      "WHY kept: to redo the import (stop CCF, delete ccf.sqlite, ccf.sqlite-wal and ccf.sqlite-shm, rename this file back",
      `to ${name}, start CCF) if the SQLite build misbehaves. It goes stale as soon as CCF writes to ccf.sqlite: to go back`,
      "to a CCF from before SQLite, export the current state instead: node scripts/windows/storage-export.mjs --to-json.",
      "WHEN to delete: once the process split's step 7 is done and CCF has run on SQLite without a rollback since this",
      "date (docs/PLAN-process-split.md, step 6, has the recovery steps)."
    ] : kind === "corrupt" ? [
      `${name} could not be read as JSON when CCF moved its state into ccf.sqlite (${new Date().toISOString()}).`,
      `WHERE: ${backup}. CCF started without the history in it.`,
      `WHY kept: the history may be recoverable by hand (${record.error ?? "parse error"}).`,
      "WHEN to delete: once its data was recovered or judged not worth recovering."
    ] : [
      `${name} appeared after CCF already kept its state in ccf.sqlite, so it was not imported (${new Date().toISOString()}).`,
      `WHERE: ${backup}. Probably written by an older CCF after a rollback.`,
      "WHY kept: it may hold history the database lacks. To use it instead of the database: stop CCF, move ccf.sqlite,",
      `ccf.sqlite-wal and ccf.sqlite-shm away, rename this file back to ${name}, start CCF (it imports it).`,
      "WHEN to delete: once you know you will not need that history."
    ]).catch((error) => warn("The note next to a moved JSON file could not be written", { error: String(error?.message ?? error) }));
    transaction(db, () => setMeta(db, metaKey, { ...record, backup, movedAt: new Date().toISOString() }));
    return backup;
  }

  function stateRows(parsed) {
    const withIds = (list, prefix) => (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item === "object")
      .map((item, index) => (item.id ? item : { ...item, id: `${prefix}-${index}` }));
    // The same retention and restart resets a load applies (core-controller.js, session-store.js).
    const lists = {
      events: withIds(parsed.events, "imported-event").slice(0, RETAINED.events),
      notifications: withIds(parsed.notifications, "imported-notification").slice(0, RETAINED.notifications),
      sessions: new SessionStore(withIds(parsed.sessions, "imported-session")).sessions
    };
    const changes = {};
    for (const [name, list] of Object.entries(lists)) {
      const seen = new Set();
      const unique = list.filter((item) => !seen.has(String(item.id)) && seen.add(String(item.id)));
      changes[STATE_TABLES[name]] = { upsert: unique.map((item, index) => ({ id: String(item.id), pos: unique.length - index,
        json: JSON.stringify(item) })) };
    }
    return { changes, counts: Object.fromEntries(Object.entries(changes).map(([table, change]) => [table, change.upsert.length])) };
  }

  function deliveryRows(state) {
    const keys = { submissions: (item) => item.id, inbox: (item) => item.id, conversations: (item) => item.backend,
      closedGenerations: (item) => item };
    const changes = {};
    for (const [name, table] of Object.entries(DELIVERY_TABLES)) {
      const seen = new Set();
      const unique = (state[name] ?? []).filter((item) => { const id = String(keys[name](item)); return !seen.has(id) && seen.add(id); });
      changes[table] = { upsert: unique.map((item, index) => ({ id: String(keys[name](item)), pos: index + 1, json: JSON.stringify(item) })) };
    }
    return changes;
  }

  // Imports a JSON source once per database, in one transaction with its record in meta; then moves it aside. Ran
  // again (a crash between the commit and the move, a file written by an older CCF later) it imports nothing twice.
  async function importJson({ sourcePath, metaKey, tables, rows, validate = (value) => value, keepUnreadable = false }) {
    const recorded = getMeta(db, metaKey);
    const raw = await readText(sourcePath);
    // Only into tables that hold nothing yet: once SQLite accepted writes, a JSON file is never imported over them.
    const empty = tables.every((table) => countRows(db, table) === 0);
    const retry = empty && recorded?.status !== "imported";
    if (!retry) {
      if (raw === null) return recorded;
      const digest = sha256(raw);
      if (recorded?.status === "imported" && recorded.sha256 === digest && !recorded.backup) {
        await moveAside(sourcePath, "imported", metaKey, recorded);
        return { ...getMeta(db, metaKey), movedNow: true };
      }
      if (recorded?.status === "imported" && recorded.sha256 === digest) return recorded;
      // Kept apart from the import's own record (which keeps pointing at the imported copy).
      const ignoredBackup = await moveAside(sourcePath, "not-imported", `${metaKey}:ignored`, { sha256: digest });
      return { ...(recorded ?? { status: "none" }), ignoredNow: ignoredBackup };
    }
    if (raw === null) {
      const none = { status: "none", at: new Date().toISOString() };
      transaction(db, () => setMeta(db, metaKey, none));
      return none;
    }
    const digest = sha256(raw);
    let parsed;
    try { parsed = validate(JSON.parse(raw)); }
    catch (error) {
      const unreadable = { status: "unreadable", source: sourcePath, sha256: digest, error: String(error?.message ?? error),
        at: new Date().toISOString() };
      transaction(db, () => setMeta(db, metaKey, unreadable));
      // Kept where it is when its consumer must refuse to work without it (companion delivery: evidence, retried on the
      // next start); otherwise moved aside as before SQLite, and CCF starts without it.
      if (keepUnreadable) return unreadable;
      await moveAside(sourcePath, "corrupt", metaKey, unreadable);
      return { ...getMeta(db, metaKey), movedNow: true };
    }
    const { changes, counts } = rows(parsed);
    const record = { status: "imported", source: sourcePath, sha256: digest, bytes: Buffer.byteLength(raw), counts,
      importedAt: new Date().toISOString() };
    transaction(db, () => {
      applyChanges(db, changes);
      setMeta(db, metaKey, record);
    });
    await moveAside(sourcePath, "imported", metaKey, record);
    return { ...getMeta(db, metaKey), ran: true };
  }

  // --- settings ---------------------------------------------------------------------------------------------------

  // The stamp is taken before the read and checked after it: an edit made outside CCF in between would otherwise pair the
  // older content with the newer stamp, and neither the watch nor the next patch would see the edit (review of step 6,
  // P2). A file that keeps changing gets no stamp, so the next poll or patch reads it again.
  async function readSettings() {
    const load = () => loadJsonWithRecoveryAsync(config.settingsPath, config.settingsDefaults ?? {}, { fsp,
      logger: { warn: (category, message, context) => warn(message, context) } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await stamp(config.settingsPath);
      const value = await load();
      if (await stamp(config.settingsPath) === before) return { value, stamp: before };
    }
    return { value: await load(), stamp: null };
  }

  // Read-modify-write: a patch lands on the file's current content, so an edit made outside CCF a moment ago survives.
  // Read back after the write: an edit made right after it is reported by the watch, not taken for CCF's own content.
  function writeSettings(patch) {
    return onSettings(async () => {
      const current = await stamp(config.settingsPath);
      const base = current !== null && current === settingsKnown.stamp ? settingsKnown.value : (await readSettings()).value;
      const value = mergeSettingsPatch(base, patch ?? {});
      await writeJsonAtomicAsync(config.settingsPath, value, { fsp });
      stats.settingsWrites++;
      const written = { ...structuredClone(config.settingsDefaults ?? {}), ...value };
      const after = await readSettings();
      settingsKnown = JSON.stringify(after.value) === JSON.stringify(written) ? after : { ...after, stamp: null };
      return { value: written, stamp: settingsKnown.stamp };
    });
  }

  function watchSettings(everyMs, emit) {
    if (watchTimer || !everyMs) return false;
    let busy = false;
    watchTimer = setInterval(() => {
      if (busy || closed) return;
      busy = true;
      onSettings(async () => {
        const current = await stamp(config.settingsPath);
        if (current === settingsKnown.stamp) return;
        settingsKnown = await readSettings();
        emit(settingsKnown);
      }).catch((error) => warn("Settings could not be reread", { error: String(error?.message ?? error) }))
        .finally(() => { busy = false; });
    }, everyMs);
    watchTimer.unref?.();
    return true;
  }

  // --- log --------------------------------------------------------------------------------------------------------

  function appendLog(text) {
    return onLog(async () => {
      const file = logConfig?.logPath ?? config?.logPath;
      if (!file) throw new Error("No log file is configured.");
      const max = logConfig?.logMaxBytes ?? config?.logMaxBytes ?? 2 * 1024 * 1024;
      const sizeOf = async (filePath) => {
        try { return (await fsp.stat(filePath)).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
      };
      if (logBytes === null) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        if (await sizeOf(`${file}.1`) > max) await fsp.rm(`${file}.1`, { force: true });
        logBytes = await sizeOf(file);
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (logBytes > 0 && logBytes + bytes > max) {
        await fsp.rm(`${file}.1`, { force: true });
        if (logBytes > max) await fsp.rm(file, { force: true });
        else await renameWithRetryAsync(file, `${file}.1`, { fsp });
        logBytes = 0;
      }
      try { await fsp.appendFile(file, text, "utf8"); }
      catch (error) {
        logBytes = null;
        if (error.code !== "ENOENT") throw error;
        // "Clear cache and logs" may have removed the folder: once more from the start.
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, text, "utf8");
        logBytes = 0;
      }
      logBytes += bytes;
      stats.logAppends++;
      stats.logBytes += bytes;
      return true;
    });
  }

  // --- run marker -------------------------------------------------------------------------------------------------

  async function readMarker() {
    const stat = await fsp.stat(config.markerPath);
    if (stat.size > 4096) return null;
    try {
      const value = JSON.parse(await fsp.readFile(config.markerPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return { runId: typeof value.runId === "string" ? value.runId.slice(0, 128) : null,
        pid: Number.isSafeInteger(value.pid) ? value.pid : null,
        startedAt: typeof value.startedAt === "string" ? value.startedAt.slice(0, 128) : null };
    } catch { return null; }
  }

  // One write when a CCF run starts (a core restart within the run keeps it), one removal after a clean quit.
  async function startMarker() {
    const status = { previousUncleanExit: false, previousRun: null, lastError: null, active: false, sameRun: false };
    if (!config.markerPath || !config.runId) return status;
    try {
      try {
        const previous = await readMarker();
        if (previous?.runId === config.runId) status.sameRun = true;
        else { status.previousRun = previous; status.previousUncleanExit = true; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!status.sameRun) {
        await writeJsonAtomicAsync(config.markerPath, { runId: config.runId, pid: config.pid ?? null,
          startedAt: new Date().toISOString() }, { fsp });
      }
      status.active = true;
    } catch (error) {
      status.lastError = String(error?.message ?? error).slice(0, 1024);
    }
    return status;
  }

  async function cleanMarker(runId) {
    try {
      if ((await readMarker())?.runId !== runId) return { ok: false, error: "Run marker belongs to another runtime or was changed" };
      await fsp.rm(config.markerPath);
      return { ok: true };
    } catch (error) {
      if (error.code === "ENOENT") return { ok: true };
      return { ok: false, error: String(error?.message ?? error).slice(0, 1024) };
    }
  }

  // --- requests ---------------------------------------------------------------------------------------------------

  function requireDb() {
    if (!db) throw new ServiceError("The state database is not open.", "storage_closed");
    return db;
  }

  function commit(changes) {
    requireDb();
    const started = performance.now();
    commitDelay();
    const result = transaction(db, () => {
      const rows = applyChanges(db, changes);
      const removed = enforceRetention(db);
      return { rows, removed };
    });
    const ms = performance.now() - started;
    stats.commits++;
    stats.rows += result.rows;
    stats.retentionRemoved += result.removed;
    stats.lastCommitMs = Math.round(ms * 100) / 100;
    stats.maxCommitMs = Math.max(stats.maxCommitMs, stats.lastCommitMs);
    return { ...result, ms: stats.lastCommitMs };
  }

  return {
    async open(options) {
      if (db) throw new Error("The state database is open already.");
      config = options;
      logConfig ??= options.logPath ? { logPath: options.logPath, logMaxBytes: options.logMaxBytes } : null;
      await fsp.mkdir(path.dirname(config.dbPath), { recursive: true });
      const opened = await openDb(config.dbPath);
      db = opened.db;
      const stateImport = await importJson({ sourcePath: config.statePath, metaKey: "state_import",
        tables: Object.values(STATE_TABLES), rows: stateRows });
      const deliveryImport = config.deliveryPath
        ? await importJson({ sourcePath: config.deliveryPath, metaKey: "delivery_import", tables: Object.values(DELIVERY_TABLES),
          rows: (state) => ({ changes: deliveryRows(state), counts: Object.fromEntries(Object.entries(DELIVERY_TABLES)
            .map(([name]) => [name, state[name]?.length ?? 0])) }),
          validate: (state) => validateDeliveryState(state), keepUnreadable: true })
        : null;
      settingsKnown = config.settingsPath ? await readSettings() : { value: {}, stamp: null };
      const recovery = await startMarker();
      const loadedRows = Object.fromEntries(Object.values(STATE_TABLES).map((table) => [table, readRows(db, table)]));
      return { stateRows: loadedRows, settings: settingsKnown, imports: { state: stateImport, delivery: deliveryImport },
        recovery, schema: { ...opened.migrated, version: schemaVersion(db) }, quarantine: opened.quarantine,
        dbPath: config.dbPath };
    },
    commitState: (changes) => commit(changes),
    async loadDelivery() {
      requireDb();
      const imported = getMeta(db, "delivery_import");
      if (imported?.status === "unreadable") {
        throw new ServiceError(`Companion delivery state needs recovery; evidence preserved in ${imported.source} (${imported.error})`,
          "delivery_unreadable");
      }
      const quarantined = await deliveryRecoveryBlock();
      if (quarantined) {
        throw new ServiceError("Companion delivery records were in a database CCF could not read; it was moved aside to "
          + `${quarantined.quarantine}. Codex sends stay blocked: recover what you need from it, then delete or move that file `
          + "and press Start.", "delivery_unreadable");
      }
      // Rows with their positions: the companion's store diffs against them (retention leaves gaps).
      return { rows: Object.fromEntries(Object.values(DELIVERY_TABLES).map((table) => [table, readRows(db, table)])) };
    },
    commitDelivery: (changes) => commit(changes),
    writeSettings,
    watchSettings,
    appendLog,
    cleanMarker,
    status() {
      return { ...stats, dbPath: config?.dbPath ?? null, schemaVersion: db ? schemaVersion(db) : null, open: Boolean(db),
        counts: db ? Object.fromEntries([...Object.values(STATE_TABLES), ...Object.values(DELIVERY_TABLES)]
          .map((table) => [table, countRows(db, table)])) : null,
        faults: faultStats };
    },
    async close() {
      closed = true;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      await Promise.all([settingsChain, logChain]);
      if (db) {
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (error) { warn("WAL checkpoint failed", { error: String(error?.message ?? error) }); }
        db.close();
        db = null;
      }
      if (faultStats && faults.statsPath) {
        await fs.promises.writeFile(faults.statsPath, JSON.stringify(faultStats)).catch(() => {});
      }
      return true;
    }
  };
}

// The worker thread's side: one storage behind a ServiceEndpoint on the parent port.
if (!isMainThread && parentPort) {
  const faults = (() => {
    try {
      const options = JSON.parse(process.env.CCF_TEST_FILE_DELAYS ?? "null");
      return options?.root ? { ...options, statsPath: options.statsPath?.replace(/\.json$/, "-storage-worker.json") } : null;
    } catch { return null; }
  })();
  let endpoint = null;
  const storage = createStorage({ faults, log: workerData?.log ?? null,
    logger: (message, context) => endpoint?.emit("warning", { message, context }) });
  endpoint = new ServiceEndpoint({ name: "storage",
    port: { postMessage: (message) => parentPort.postMessage(message), onMessage: (listener) => parentPort.on("message", listener) } });
  endpoint
    .handle("open", (options) => storage.open(options))
    .handle("state.commit", ({ changes }) => storage.commitState(changes))
    .handle("delivery.load", () => storage.loadDelivery())
    .handle("delivery.commit", ({ changes }) => storage.commitDelivery(changes))
    .handle("settings.write", ({ patch }) => storage.writeSettings(patch))
    .handle("settings.watch", ({ everyMs }) => storage.watchSettings(everyMs, (value) => endpoint.emit("settings.changed", value)))
    .handle("log.append", ({ text }) => storage.appendLog(text))
    .handle("marker.clean", ({ runId }) => storage.cleanMarker(runId))
    .handle("status", () => storage.status())
    .handle("close", () => storage.close());
  endpoint.markReady({ pid: process.pid });
}
