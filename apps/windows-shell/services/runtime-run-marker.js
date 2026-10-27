import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../../../packages/core/src/atomic-json.js";

// One write at startup, one removal after clean shutdown. No periodic disk heartbeat.
export class RuntimeRunMarker {
  constructor({ filePath, pid = process.pid, fsImpl = fs } = {}) {
    this.filePath = filePath;
    this.pid = pid;
    this.fs = fsImpl;
    this.runId = randomUUID();
    this.started = false;
    this.active = false;
    this.previousUncleanExit = false;
    this.previousRun = null;
    this.lastError = null;
  }

  status() {
    return { previousUncleanExit: this.previousUncleanExit, previousRun: this.previousRun,
      lastError: this.lastError, active: this.active };
  }

  readMarker() {
    // A marker should be a few hundred bytes. Do not load arbitrary legacy content.
    if (this.fs.statSync(this.filePath).size > 4096) return null;
    const raw = this.fs.readFileSync(this.filePath, "utf8");
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return { runId: typeof value.runId === "string" ? value.runId.slice(0, 128) : null,
        pid: Number.isSafeInteger(value.pid) ? value.pid : null,
        startedAt: typeof value.startedAt === "string" ? value.startedAt.slice(0, 128) : null };
    } catch { return null; }
  }

  start() {
    if (this.started) return this.status();
    this.started = true;
    try {
      try {
        this.previousRun = this.readMarker();
        this.previousUncleanExit = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      writeJsonAtomic(this.filePath, { runId: this.runId, pid: this.pid, startedAt: new Date().toISOString() },
        { fsImpl: this.fs });
      this.active = true;
    } catch (error) {
      // Preserve unreadable markers; diagnostics failure must not prevent CCF startup.
      this.lastError = String(error?.message ?? error).slice(0, 1024);
    }
    return this.status();
  }

  markClean() {
    if (!this.active) return this.lastError === null;
    try {
      if (this.readMarker()?.runId !== this.runId) {
        this.lastError = "Run marker belongs to another runtime or was changed";
        return false;
      }
      this.fs.unlinkSync(this.filePath);
      this.active = false;
      this.lastError = null;
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.active = false;
        this.lastError = null;
        return true;
      }
      this.lastError = String(error?.message ?? error).slice(0, 1024);
      return false;
    }
  }
}
