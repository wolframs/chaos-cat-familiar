import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { InMemoryLogger } from "../../../packages/core/src/logger.js";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SENSITIVE_KEY = /token|auth|password|passwd|secret|toolinput|toolresponse|prompt|answers/;

function boundedText(value, maxLength = 2048) {
  try {
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return "[Unreadable]";
  }
}

// Copy only bounded, plain data. Never retain caller objects or invoke custom inspectors.
function normalizeContext(context) {
  const seen = new WeakSet();
  let remaining = 8192;
  let nodes = 150;
  function copy(value, depth) {
    if (--nodes < 0 || remaining <= 0) return "[Truncated]";
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") {
      const text = boundedText(value, Math.min(1024, remaining));
      remaining -= text.length;
      return text;
    }
    if (seen.has(value)) return "[Circular]";
    if (depth >= 4) return "[Truncated]";
    seen.add(value);
    const result = Array.isArray(value) ? [] : Object.create(null);
    let count = 0;
    try {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (count++ >= 40 || nodes <= 0 || remaining <= 0) break;
        const safeKey = boundedText(key, 128);
        remaining -= safeKey.length;
        let item;
        if (SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ""))) {
          item = "[REDACTED]";
        } else {
          try { item = copy(value[key], depth + 1); } catch { item = "[Unreadable]"; }
        }
        if (Array.isArray(result)) result.push(item);
        else result[safeKey] = item;
      }
    } catch {
      return "[Unreadable]";
    }
    return result;
  }
  return context && typeof context === "object" ? copy(context, 0) : {};
}

function boundedFileLine(line, maxBytes) {
  const budget = maxBytes - 1;
  let text = Buffer.byteLength(line, "utf8") > budget
    ? Buffer.from(line, "utf8").subarray(0, budget).toString("utf8")
    : line;
  while (Buffer.byteLength(text, "utf8") > budget) text = text.slice(0, -1);
  return `${text}\n`;
}

function formatLine(entry) {
  const context = Object.keys(entry.context ?? {}).length > 0
    ? ` ${util.inspect(entry.context, { depth: 4, breakLength: 120, compact: true })}`
    : "";
  return `${entry.timestamp.toISOString()} [${entry.level}] [${entry.category}] ${entry.message}${context}`;
}

export class RuntimeLogger extends InMemoryLogger {
  constructor({ limit = 1000, filePath, stdout = console.log, stderr = console.error, maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    flushDelayMs = 0, maxBufferedBytes = 64 * 1024, timers = globalThis } = {}) {
    super(limit);
    this.filePath = filePath;
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
      bufferedBytes: this.bufferedBytes, droppedLines: this.droppedLines, closed: this.closed, flushDelayMs: this.flushDelayMs };
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

  log(level, category, message, context = {}) {
    if (level === "debug" && !this.debugLogging) return;
    super.log(boundedText(level, 32), boundedText(category, 128), boundedText(message), normalizeContext(context));
    const entry = this.entries[0];
    if (!entry) return;
    const line = formatLine(entry);

    try {
      if (level === "error") this.stderr(line);
      else this.stdout(line);
    } catch { /* A broken console must not interrupt app behavior or file logging. */ }

    if (!this.filePath || this.closed) {
      return;
    }

    try {
      const fileLine = boundedFileLine(line, this.flushDelayMs
        ? Math.min(this.maxFileBytes, this.maxBufferedBytes) : this.maxFileBytes);
      if (this.flushDelayMs) {
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
