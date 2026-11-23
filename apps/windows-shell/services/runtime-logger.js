import fs from "node:fs";
import path from "node:path";
import { InMemoryLogger } from "../../../packages/core/src/logger.js";
import { boundedText, formatLine, normalizeContext } from "./log-format.js";

export { formatLine, normalizeContext };

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

function boundedFileLine(line, maxBytes) {
  const budget = maxBytes - 1;
  let text = Buffer.byteLength(line, "utf8") > budget
    ? Buffer.from(line, "utf8").subarray(0, budget).toString("utf8")
    : line;
  while (Buffer.byteLength(text, "utf8") > budget) text = text.slice(0, -1);
  return `${text}\n`;
}

export class RuntimeLogger extends InMemoryLogger {
  // sink: { append(text) -> Promise } takes the batched lines instead of this thread writing the file (the core's storage
  // worker since process-split step 6 appends and rotates them); filePath then only names the file in status().
  constructor({ limit = 1000, filePath, stdout = console.log, stderr = console.error, maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    flushDelayMs = 0, maxBufferedBytes = 64 * 1024, timers = globalThis, sink = null } = {}) {
    super(limit);
    this.filePath = filePath;
    this.sink = sink;
    this.sinkWrites = Promise.resolve();
    this.stdout = stdout;
    this.stderr = stderr;
    this.maxFileBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes >= 2 ? maxFileBytes : DEFAULT_MAX_FILE_BYTES;
    this.debugLogging = false;
    this.lastWriteError = null;
    this.fileReady = false;
    this.currentBytes = 0;
    this.flushDelayMs = Number.isFinite(flushDelayMs) && flushDelayMs > 0 ? flushDelayMs : 0;
    this.maxBufferedBytes = Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes >= 2 ? maxBufferedBytes : 64 * 1024;
    this.timers = timers;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.droppedLines = 0;
    this.flushTimer = null;
    this.closed = false;
  }

  configure({ debugLogging } = {}) {
    if (typeof debugLogging === "boolean") this.debugLogging = debugLogging;
  }

  status() {
    return { filePath: this.filePath ?? null, debugLogging: this.debugLogging, lastWriteError: this.lastWriteError,
      bufferedBytes: this.bufferedBytes, droppedLines: this.droppedLines, closed: this.closed, flushDelayMs: this.flushDelayMs,
      writer: this.sink ? "storage-worker" : "this-thread" };
  }

  initializeFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fileSize = (filePath) => {
      try { return fs.statSync(filePath).size; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return 0;
      }
    };
    if (fileSize(`${this.filePath}.1`) > this.maxFileBytes) fs.rmSync(`${this.filePath}.1`);
    this.currentBytes = fileSize(this.filePath);
    this.fileReady = true;
  }

  appendLine(fileLine) {
    if (!this.fileReady) this.initializeFile();
    const bytes = Buffer.byteLength(fileLine, "utf8");
    if (this.currentBytes + bytes > this.maxFileBytes) {
      // Discard oversized legacy logs instead of retaining an unbounded previous file.
      fs.rmSync(`${this.filePath}.1`, { force: true });
      if (this.currentBytes > this.maxFileBytes) fs.rmSync(this.filePath);
      else fs.renameSync(this.filePath, `${this.filePath}.1`);
      this.currentBytes = 0;
    }
    fs.appendFileSync(this.filePath, fileLine, "utf8");
    this.currentBytes += bytes;
  }

  appendSafely(fileLine) {
    try {
      this.appendLine(fileLine);
    } catch (error) {
      this.fileReady = false;
      // Cleanup may remove the directory or file between entries. Reinitialize once.
      if (error.code !== "ENOENT") throw error;
      this.appendLine(fileLine);
    }
  }

  flush() {
    if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.sink) return this.#flushToSink();
    try {
      while (this.buffer.length) {
        if (!this.fileReady) this.initializeFile();
        // Fill the current file before rotating, without splitting a UTF-8 log line.
        const remaining = this.maxFileBytes - this.currentBytes;
        const budget = this.buffer[0].bytes > remaining ? this.maxFileBytes : remaining;
        let count = 0;
        let bytes = 0;
        while (count < this.buffer.length && bytes + this.buffer[count].bytes <= budget) {
          bytes += this.buffer[count++].bytes;
        }
        this.appendSafely(this.buffer.slice(0, count).map((item) => item.line).join(""));
        this.buffer.splice(0, count);
        this.bufferedBytes -= bytes;
      }
      this.lastWriteError = null;
      return true;
    } catch (error) {
      this.fileReady = false;
      this.lastWriteError = boundedText(error?.message ?? error, 1024);
      // Keep unwritten lines bounded; only new activity or an explicit flush retries.
      return false;
    }
  }

  close() {
    this.closed = true;
    return this.flush();
  }

  // Lines handed to the sink in order, one batch at a time; a failed batch is counted as dropped.
  #flushToSink() {
    if (!this.buffer.length) return this.lastWriteError === null;
    const text = this.buffer.map((item) => item.line).join("");
    const lines = this.buffer.length;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.sinkWrites = this.sinkWrites.then(() => this.sink.append(text)).then(() => { this.lastWriteError = null; }, (error) => {
      this.lastWriteError = boundedText(error?.message ?? error, 1024);
      this.droppedLines += lines;
    });
    return true;
  }

  // Resolves once every line logged so far was written (true) or a write failed (false).
  async drain() {
    this.flush();
    await this.sinkWrites;
    return this.lastWriteError === null;
  }

  async closeAsync() {
    this.closed = true;
    return this.drain();
  }

  enqueueLine(line, urgent) {
    const bytes = Buffer.byteLength(line, "utf8");
    // After an I/O failure, overflow must not retry the disk for every new entry.
    // A single next-activity timer (or urgent/explicit flush) attempts recovery.
    if (this.bufferedBytes + bytes > this.maxBufferedBytes && this.lastWriteError === null) this.flush();
    while (this.bufferedBytes + bytes > this.maxBufferedBytes && this.buffer.length) {
      this.bufferedBytes -= this.buffer.shift().bytes;
      this.droppedLines++;
    }
    this.buffer.push({ line, bytes });
    this.bufferedBytes += bytes;
    if (urgent) return this.flush();
    if (this.flushTimer === null) {
      this.flushTimer = this.timers.setTimeout(() => this.flush(), this.flushDelayMs);
      this.flushTimer?.unref?.();
    }
  }

  log(level, category, message, context = {}, timestamp = null) {
    if (level === "debug" && !this.debugLogging) return;
    super.log(boundedText(level, 32), boundedText(category, 128), boundedText(message), normalizeContext(context), timestamp);
    const entry = this.entries[0];
    if (!entry) return;
    const line = formatLine(entry);

    try {
      if (level === "error") this.stderr(line);
      else this.stdout(line);
    } catch { /* A broken console must not interrupt app behavior or file logging. */ }

    if ((!this.filePath && !this.sink) || this.closed) {
      return;
    }

    try {
      const fileLine = boundedFileLine(line, this.flushDelayMs
        ? Math.min(this.maxFileBytes, this.maxBufferedBytes) : this.maxFileBytes);
      if (this.flushDelayMs || this.sink) {
        this.enqueueLine(fileLine, level === "warn" || level === "error");
        return;
      }
      this.appendSafely(fileLine);
      this.lastWriteError = null;
    } catch (error) {
      this.fileReady = false;
      this.lastWriteError = boundedText(error?.message ?? error, 1024);
    }
  }

  debug(category, message, context = {}) {
    this.log("debug", category, message, context);
  }
}
