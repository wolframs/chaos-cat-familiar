import fsPromises from "node:fs/promises";
import path from "node:path";
import { normalizePanel } from "../renderer/companion-panel-model.js";

// Where the side panel's file is: the setting sidePanelFile (absolute), else <companion data or repo folder>/state/
// panel.json. null: not configured (a relative path, no folder).
export function sidePanelPath(settings = {}, home = null) {
  if (typeof settings.sidePanelFile === "string" && settings.sidePanelFile.trim()) {
    const file = settings.sidePanelFile.trim();
    return path.isAbsolute(file) ? file : null;
  }
  const folder = settings.companionDataPath ?? settings.companionRepoPath
    ?? (home ? path.join(home, "repos", "work-companion") : null);
  return typeof folder === "string" && path.isAbsolute(folder) ? path.join(folder, "state", "panel.json") : null;
}

const YOUNG_MS = 2000;

// Main's reader of the side panel's file (docs/ARCHITECTURE.md, "The side panel and the cluster menu"): a stat every
// intervalMs while started, a read only when mtime or size changed, never a synchronous call. One poll in flight at a
// time (a slow stat under an endpoint scanner never stacks). onUpdate gets the snapshot whenever it changed.
//
// Statuses: unconfigured (no absolute path), missing (ENOENT), ok, invalid (too big, not JSON, not a panel). After an
// ok, missing and invalid keep the last good panel in the snapshot. A file that fails to parse while its mtime is under
// 2 s old is read again at the next poll before it counts as invalid (a writer caught mid-replace). Only content that
// was read and found malformed stays invalid until the file changes; a failed stat or read is retried at every poll.
export class SidePanelFeed {
  constructor({ resolvePath, fsp = fsPromises, timers = { setTimeout, clearTimeout }, now = Date.now,
    onUpdate = () => {}, logger = null, intervalMs = 2000, maxBytes = 65536 }) {
    this.resolvePath = resolvePath;
    this.fsp = fsp;
    this.timers = timers;
    this.now = now;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.maxBytes = maxBytes;
    this.running = false;
    this.timer = null;
    this.inFlight = null;
    this.file = undefined;
    this.signature = null;
    this.retrySignature = null;
    this.lastLogged = null;
    this.current = { status: "unconfigured", panel: null, dropped: 0, error: null, file: null, checkedAt: null, changedAt: null };
    this.key = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  snapshot() {
    return this.current;
  }

  // Settings changed: resolve the path again (not per poll). A new file starts without the old one's content.
  setPath() {
    const file = this.resolve();
    if (file === this.file) return;
    this.file = file;
    this.signature = null;
    this.retrySignature = null;
    this.current = { ...this.current, panel: null, dropped: 0 };
    if (this.running) {
      if (this.timer !== null) this.timers.clearTimeout(this.timer);
      this.timer = null;
      void this.poll();
    }
  }

  // The poll that is running, for tests and for stop() callers that want to wait.
  idle() {
    return this.inFlight ?? Promise.resolve();
  }

  resolve() {
    try { return this.resolvePath() ?? null; }
    catch { return null; }
  }

  poll() {
    if (this.inFlight) return this.inFlight;
    this.timer = null;
    this.inFlight = this.check().catch((error) => this.logOnce("Side panel poll failed", error))
      .finally(() => {
        this.inFlight = null;
        if (this.running && this.timer === null) {
          this.timer = this.timers.setTimeout(() => { void this.poll(); }, this.intervalMs);
          this.timer?.unref?.();
        }
      });
    return this.inFlight;
  }

  async check() {
    if (this.file === undefined) this.file = this.resolve();
    const file = this.file;
    if (!file) return this.publish({ status: "unconfigured", panel: null, dropped: 0, error: null, file: null });
    let stat;
    try {
      stat = await this.fsp.stat(file);
    } catch (error) {
      if (file !== this.file) return;
      this.signature = null;
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return this.publish({ status: "missing", error: null, file });
      this.logOnce("Side panel file could not be checked", error);
      return this.publish({ status: "invalid", error: shortError(error), file });
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature === this.signature) return this.touch();
    if (stat.size > this.maxBytes) {
      this.signature = signature;
      return this.publish({ status: "invalid", error: `larger than ${Math.round(this.maxBytes / 1024)} KiB`, file });
    }
    let text;
    try {
      text = await this.fsp.readFile(file, "utf8");
    } catch (error) {
      if (file !== this.file) return;
      // An I/O failure (a scanner's lock, EBUSY, EPERM) says nothing about the content: the signature stays unset, so
      // the next poll reads the same file again instead of keeping it invalid until it changes.
      this.signature = null;
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return this.publish({ status: "missing", error: null, file });
      this.logOnce("Side panel file could not be read", error);
      return this.publish({ status: "invalid", error: shortError(error), file });
    }
    if (file !== this.file) return;
    let parsed;
    try {
      if (Buffer.byteLength(text) > this.maxBytes) throw new Error(`larger than ${Math.round(this.maxBytes / 1024)} KiB`);
      parsed = normalizePanel(JSON.parse(text.replace(/^﻿/, "")));
    } catch (error) {
      // Content read in full and malformed: cached as invalid until the file changes.
      if (this.now() - stat.mtimeMs < YOUNG_MS && this.retrySignature !== signature) {
        this.retrySignature = signature;   // read again at the next poll
        return this.touch();
      }
      this.signature = signature;
      this.logOnce("Side panel file is unreadable", error);
      return this.publish({ status: "invalid", error: shortError(error), file });
    }
    this.signature = signature;
    this.retrySignature = null;
    return this.publish({ status: "ok", panel: parsed.panel, dropped: parsed.dropped, error: null, file });
  }

  touch() {
    this.current = { ...this.current, checkedAt: this.now() };
  }

  publish(patch) {
    const next = { ...this.current, ...patch, checkedAt: this.now() };
    const key = JSON.stringify([next.status, next.panel, next.dropped, next.error, next.file]);
    if (key === this.key) { this.current = next; return; }
    this.key = key;
    this.current = { ...next, changedAt: this.now() };
    try { this.onUpdate(this.current); }
    catch (error) { this.logOnce("Side panel update failed", error); }
  }

  logOnce(message, error) {
    const text = `${message}: ${String(error?.message ?? error)}`;
    if (text === this.lastLogged) return;
    this.lastLogged = text;
    this.logger?.warn?.("side-panel", message, { error: String(error?.message ?? error) });
  }
}

function shortError(error) {
  const text = String(error?.reason ?? error?.message ?? error).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
