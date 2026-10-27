import { loadJsonWithRecovery, writeJsonAtomic } from "./atomic-json.js";

export class FileJsonStateStore {
  constructor(filePath, defaults = {}, options = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.options = options;
    this.flushDelayMs = Number.isFinite(options.flushDelayMs) && options.flushDelayMs > 0 ? options.flushDelayMs : 0;
    this.timers = options.timers ?? globalThis;
    this.pending = null;
    this.hasPending = false;
    this.timer = null;
    this.closed = false;
    this.lastWriteError = null;
    this.lastWriteErrorKey = null;
  }

  load() {
    return loadJsonWithRecovery(this.filePath, this.defaults, this.options);
  }

  save(value) {
    if (this.closed) throw new Error("State store is closed");
    if (!this.flushDelayMs) return writeJsonAtomic(this.filePath, value, this.options);
    // Retain one latest snapshot reference, never a queue or serialized copy.
    // The controller owns these objects and passes a fresh root after each change.
    this.pending = value;
    this.hasPending = true;
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => this.flush(), this.flushDelayMs);
      this.timer?.unref?.();
    }
  }

  status() {
    return { pending: this.hasPending, lastWriteError: this.lastWriteError, closed: this.closed,
      flushDelayMs: this.flushDelayMs };
  }

  flush() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.hasPending) return true;
    try {
      writeJsonAtomic(this.filePath, this.pending, this.options);
      this.pending = null;
      this.hasPending = false;
      this.lastWriteError = null;
      this.lastWriteErrorKey = null;
      return true;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 1024);
      // Native messages contain a new UUID temporary path on every attempt.
      // Identify the failure by its stable code and operation instead.
      const errorKey = error?.code
        ? `${String(error.code).slice(0, 128)}:${String(error.syscall ?? "").slice(0, 128)}` : message;
      const changed = this.lastWriteErrorKey !== errorKey;
      this.lastWriteError = message;
      this.lastWriteErrorKey = errorKey;
      if (changed) {
        try { this.options.onError?.(error); } catch { /* Diagnostics must not break hooks. */ }
      }
      // New activity or an explicit flush may retry; a failure never starts a retry loop.
      return false;
    }
  }

  close() {
    this.closed = true;
    return this.flush();
  }
}

export class InMemoryStateStore {
  constructor(initialValue = {}) {
    this.value = structuredClone(initialValue);
  }

  load() {
    return structuredClone(this.value);
  }

  save(value) {
    this.value = structuredClone(value);
  }
}
