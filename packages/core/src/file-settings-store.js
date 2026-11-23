import fs from "node:fs";
import { loadJsonWithRecovery, writeJsonAtomic } from "./atomic-json.js";

const REVALIDATE_MS = 1000;

// Settings are read from memory. The shell asks for them many times per hook event, and on a machine with an
// endpoint scanner every open of settings.json cost 1.5-25 ms on the Electron main thread (2026-11-05: ~100
// opens per event, 0.15-1.1 s window hangs). Edits made outside CCF are still picked up: at most once per
// second a load compares the file's mtime and size (a stat, no open) and rereads only when they changed.
export class FileSettingsStore {
  constructor(filePath, defaults = {}, options = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.options = options;
    this.fsImpl = options.fsImpl ?? fs;
    this.now = options.now ?? Date.now;
    this.cache = null;   // { value, stamp, checkedAt }
  }

  // revalidate: check the file now instead of within the next second. Read-modify-write callers pass it, so
  // a save never overwrites an edit made outside CCF a moment earlier.
  load({ revalidate = false } = {}) {
    const now = this.now();
    if (this.cache && !revalidate && now - this.cache.checkedAt < REVALIDATE_MS) return structuredClone(this.cache.value);
    const stamp = this.#stamp();
    if (this.cache && stamp === this.cache.stamp) {
      this.cache.checkedAt = now;
      return structuredClone(this.cache.value);
    }
    const value = loadJsonWithRecovery(this.filePath, this.defaults, this.options);
    // Stamped before the read: a change in between (or a corrupt file moved away by recovery) only costs one
    // extra reread at the next revalidation.
    this.cache = { value, stamp, checkedAt: now };
    return structuredClone(value);
  }

  save(value) {
    writeJsonAtomic(this.filePath, value, this.options);
    this.cache = { value: { ...structuredClone(this.defaults), ...structuredClone(value) }, stamp: this.#stamp(), checkedAt: this.now() };
  }

  #stamp() {
    try {
      const stat = this.fsImpl.statSync(this.filePath, { bigint: true });
      return `${stat.mtimeNs}:${stat.size}`;
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }
}
