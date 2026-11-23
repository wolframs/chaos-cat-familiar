// The core's side of its storage worker (process-split plan, step 6). The core thread keeps everything in memory and
// hands the worker what changed: state rows (batched for a short moment), settings patches, log text. Nothing here
// touches a file. If the worker dies the core cannot persist any more: StorageClient emits "failed" and the core
// process exits, so main restarts it.
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { ServiceEndpoint, ServiceError } from "./service-rpc.js";
import { RowShadow } from "./row-shadow.js";
import { STATE_TABLES } from "./storage-schema.js";

export const STORAGE_WORKER_URL = new URL("./storage-worker.js", import.meta.url);

export class StorageClient extends EventEmitter {
  // log: { logPath, logMaxBytes }, so the worker can append lines before open() is done.
  constructor({ workerUrl = STORAGE_WORKER_URL, onError = () => {}, log = null } = {}) {
    super();
    this.onError = onError;
    this.closing = false;
    this.failed = null;
    this.worker = new Worker(workerUrl, { workerData: { log } });
    this.worker.unref();   // never what keeps a process alive (the core's channel to main does)
    this.worker.on("error", (error) => this.#fail(error));
    this.worker.on("exit", (code) => { if (!this.closing) this.#fail(new Error(`The storage worker exited (${code}).`)); });
    this.endpoint = new ServiceEndpoint({ name: "core-storage", onError,
      port: { postMessage: (message) => this.worker.postMessage(message), onMessage: (listener) => this.worker.on("message", listener) } });
    this.endpoint.on("settings.changed", (value) => this.emit("settings.changed", value));
    this.endpoint.on("warning", (payload) => this.emit("warning", payload));
    this.endpoint.markReady();
  }

  #fail(error) {
    if (this.failed) return;
    this.failed = error;
    this.endpoint.close(`storage worker failed: ${error?.message ?? error}`);
    this.emit("failed", error);
  }

  request(method, params = null, options) {
    if (this.failed) return Promise.reject(new ServiceError(`The storage worker failed (${this.failed.message}).`, "storage_failed"));
    return this.endpoint.request(method, params, options);
  }

  // Opens the database (migrations, imports), reads settings and starts the run marker. Resolves with what was loaded.
  open(config) { return this.request("open", config); }

  // Closes the database (WAL checkpointed) after the settings and log writes in flight. The worker stays for the run
  // marker, which main removes only after it decided the quit was clean; terminate() ends it.
  async close({ timeoutMs = 5000 } = {}) {
    if (this.failed) return false;
    try { return await this.request("close", null, { timeoutMs }) === true; }
    catch (error) { this.onError(error, { method: "close" }); return false; }
  }

  async terminate() {
    if (this.closing) return;
    this.closing = true;
    this.endpoint.close("storage closed");
    await this.worker.terminate().catch(() => {});
  }
}

// The controller's state store (same interface as the JSON checkpoint it replaces): load() returns what open() read,
// save() keeps a reference to the newest state and commits what changed after flushDelayMs, one commit at a time.
// rows: what the worker's open() read, {table: [{id, pos, json}]} newest first; they are parsed here, once, at boot.
export class SqliteStateStore {
  constructor({ storage, rows = {}, flushDelayMs = 100, timers = globalThis, onError = () => {} }) {
    Object.assign(this, { storage, flushDelayMs, timers, onError });
    this.shadows = {
      events: new RowShadow({ direction: "desc", immutable: true }),
      notifications: new RowShadow({ direction: "desc" }),
      sessions: new RowShadow({ direction: "desc" })
    };
    this.loaded = {};
    // The shadows start from the stored rows (positions and JSON), so an unchanged entity is never written again.
    for (const [name, table] of Object.entries(STATE_TABLES)) {
      const stored = rows[table] ?? [];
      this.loaded[name] = stored.map((row) => JSON.parse(row.json));
      this.shadows[name].reset(stored, this.loaded[name]);
    }
    this.pending = null;
    this.hasPending = false;
    this.timer = null;
    this.inflight = null;
    this.closed = false;
    this.lastWriteError = null;
    this.stats = { commits: 0, rows: 0, lastCommitMs: null, maxDiffMs: 0 };
  }

  // The entities themselves, once: the controller takes them over (an event keeps its identity for the next diff).
  load() {
    const loaded = this.loaded;
    this.loaded = { events: [], notifications: [], sessions: [] };
    return loaded;
  }

  save(value) {
    if (this.closed) throw new Error("State store is closed");
    this.pending = value;
    this.hasPending = true;
    this.#schedule();
  }

  status() {
    return { backend: "sqlite", pending: this.hasPending || this.inflight !== null, lastWriteError: this.lastWriteError,
      closed: this.closed, flushDelayMs: this.flushDelayMs, ...this.stats };
  }

  #schedule() {
    if (this.timer !== null || this.inflight || this.closed || this.closing) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.flushDelayMs);
    this.timer?.unref?.();
  }

  // Commits the newest state now (after a commit still in flight). Resolves true when it landed.
  async flush() {
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    while (this.inflight) await this.inflight;
    if (!this.hasPending) return this.lastWriteError === null;
    const value = this.pending;
    this.pending = null;
    this.hasPending = false;
    const started = performance.now();
    const diffs = Object.fromEntries(Object.entries(this.shadows).map(([name, shadow]) => [name, shadow.diff(value[name] ?? [])]));
    this.stats.maxDiffMs = Math.max(this.stats.maxDiffMs, performance.now() - started);
    const changes = {};
    for (const [name, diff] of Object.entries(diffs)) if (diff.change) changes[STATE_TABLES[name]] = diff.change;
    if (!Object.keys(changes).length) return true;
    this.inflight = (async () => {
      try {
        const result = await this.storage.request("state.commit", { changes });
        for (const diff of Object.values(diffs)) diff.commit();
        this.stats.commits += 1;
        this.stats.rows += result?.rows ?? 0;
        this.stats.lastCommitMs = result?.ms ?? null;
        this.lastWriteError = null;
        return true;
      } catch (error) {
        // The shadows did not move: the next commit carries these changes again (with whatever came since).
        if (!this.hasPending) { this.pending = value; this.hasPending = true; }
        const message = String(error?.message ?? error).slice(0, 1024);
        if (message !== this.lastWriteError) { try { this.onError(error); } catch { /* reporting */ } }
        this.lastWriteError = message;
        return false;
      } finally {
        this.inflight = null;
        if (this.hasPending && !this.closed) this.#schedule();
      }
    })();
    return this.inflight;
  }

  flushInBackground() { return this.flush(); }

  // The final commit; a failure leaves no retry behind (the run then counts as unclean).
  async close() {
    this.closing = true;
    const saved = await this.flush();
    this.closed = true;
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    return saved && !this.hasPending;
  }
}

// SettingsAuthority's store when the worker writes settings.json: reads come from memory, a save hands the worker the
// patches (it merges them onto the file's current content), watch() reports edits made outside CCF.
export class WorkerSettingsStore {
  constructor({ storage, initial = {} }) {
    this.storage = storage;
    this.value = structuredClone(initial);
  }

  load() { return structuredClone(this.value); }

  async save(_value, { patch = {} } = {}) {
    const written = await this.storage.request("settings.write", { patch }, { timeoutMs: 30000 });
    this.value = written.value;
    return structuredClone(written.value);
  }

  watch(everyMs, onChange) {
    this.storage.on("settings.changed", ({ value }) => {
      this.value = value;
      onChange(structuredClone(value));
    });
    return this.storage.request("settings.watch", { everyMs });
  }
}

// RuntimeLogger's file sink: batched lines go to the worker, which appends and rotates.
export function workerLogSink(storage) {
  return { append: (text) => storage.request("log.append", { text }, { timeoutMs: 30000 }).then(() => true) };
}

