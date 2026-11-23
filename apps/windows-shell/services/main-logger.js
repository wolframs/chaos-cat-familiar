import fs from "node:fs/promises";
import path from "node:path";
import { formatLine, normalizeContext } from "./log-format.js";

const MAX_QUEUED = 1000;

// Main's log (process-split plan, step 3): the core process owns the log file, main forwards its entries there (window
// events, hotkeys, renderer console, shutdown). Entries keep their own time. While the core is not there (starting,
// restarting) they wait in a bounded queue; whatever never reached it is appended by main once, at the very end.
export class MainLogger {
  constructor({ filePath = null, maxQueued = MAX_QUEUED, stderr = console.error } = {}) {
    this.filePath = filePath;
    this.maxQueued = maxQueued;
    this.stderr = stderr;
    this.sink = null;
    this.queue = [];
    this.droppedLines = 0;
    this.debugLogging = false;
  }

  // sink(entries) delivers or returns false (core not ready); entries then stay queued.
  attach(sink) {
    this.sink = sink;
    this.flushQueue();
  }

  detach() { this.sink = null; }

  configure({ debugLogging } = {}) {
    if (typeof debugLogging === "boolean") this.debugLogging = debugLogging;
  }

  status() {
    return { filePath: this.filePath, debugLogging: this.debugLogging, queued: this.queue.length,
      droppedLines: this.droppedLines };
  }

  log(level, category, message, context = {}) {
    if (level === "debug" && !this.debugLogging) return;
    let entry;
    try {
      entry = { timestamp: new Date(), level: String(level), category: String(category), message: String(message),
        context: normalizeContext(context) };
    } catch { return; }   // a log line must never break the caller
    if (this.queue.length || !this.#deliver([entry])) this.#enqueue(entry);
  }

  info(category, message, context) { this.log("info", category, message, context); }
  warn(category, message, context) { this.log("warn", category, message, context); }
  error(category, message, context) { this.log("error", category, message, context); }
  debug(category, message, context) { this.log("debug", category, message, context); }

  flushQueue() {
    if (!this.queue.length || !this.sink) return true;
    const entries = this.queue.splice(0);
    if (this.#deliver(entries)) return true;
    this.queue.unshift(...entries);
    return false;
  }

  // Shutdown, after the core closed its log: the remaining lines go to the file directly (and to the console, which the
  // core would have done), asynchronously: main's event loop never waits on the disk (process-split plan, step 7).
  // Resolves with whether nothing was lost.
  async writeQueuedToFile() {
    if (!this.queue.length) return this.droppedLines === 0;
    const lines = this.queue.splice(0).map((entry) => formatLine(entry));
    try { this.stderr(lines.join("\n")); } catch { /* a broken console must not stop the write */ }
    if (!this.filePath) return false;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
      return this.droppedLines === 0;
    } catch {
      return false;
    }
  }

  // The process is exiting (no asynchronous work can finish): what is left goes to the console only.
  writeQueuedToConsole() {
    if (!this.queue.length) return;
    const lines = this.queue.splice(0).map((entry) => formatLine(entry));
    try { this.stderr(lines.join("\n")); } catch { /* exiting */ }
  }

  #deliver(entries) {
    if (!this.sink) return false;
    try { return this.sink(entries) !== false; } catch { return false; }
  }

  #enqueue(entry) {
    this.queue.push(entry);
    while (this.queue.length > this.maxQueued) {
      this.queue.shift();
      this.droppedLines++;
    }
  }
}
