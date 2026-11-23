import { EventEmitter } from "node:events";

// CCF settings across the process boundary (process-split plan, step 3). The core owns settings.json: it is the only
// writer, reads from memory, and notices edits made outside CCF (scripts and the hook relay read and write the file).
// Main keeps a mirror: synchronous reads, patches applied at once and sent to the core, pushes from the core when the
// value changes. Patches set keys; `notifications` and `hotkeys` merge one level deep, as the shell always merged them.

export function mergeSettingsPatch(current = {}, patch = {}) {
  const next = { ...current, ...patch };
  if (current.notifications || patch.notifications) {
    next.notifications = { ...(current.notifications ?? {}), ...(patch.notifications ?? {}) };
  }
  if (current.hotkeys || patch.hotkeys) next.hotkeys = { ...(current.hotkeys ?? {}), ...(patch.hotkeys ?? {}) };
  return next;
}

// The keys whose values differ, as a patch from `before` to `after` (keys are never removed).
export function settingsPatchBetween(before = {}, after = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  return patch;
}

const RETRY_DELAYS_MS = [1000, 3000, 10000];

export class SettingsAuthority extends EventEmitter {
  // store: load() from memory, save(value, {patch}) possibly asynchronous, optional watch(everyMs, onChange).
  // WorkerSettingsStore (the core since step 6: the storage worker merges the patch onto the file's current content,
  // with rename retries that block no event loop) or FileSettingsStore (tests: a synchronous file, revalidated on write).
  constructor({ store, logger = null, timers = globalThis, watchMs = 0, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
    super();
    this.store = store;
    this.logger = logger;
    this.timers = timers;
    this.watchMs = watchMs;
    this.retryDelaysMs = retryDelaysMs;
    this.unsaved = null;        // patches accepted but not written yet (a held file, or waiting for the write in flight)
    this.writing = null;        // the patch being written now
    this.flushing = null;
    this.appliedSeq = 0;
    this.lastWriteError = null;
    this.lastErrorKey = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.watchTimer = null;
    this.watching = false;
    this.published = null;
    this.closed = false;
  }

  // Reads include every accepted patch, written or not.
  load(options) {
    let value = this.store.load(options);
    if (this.writing) value = mergeSettingsPatch(value, this.writing);
    if (this.unsaved) value = mergeSettingsPatch(value, this.unsaved);
    return value;
  }

  status() {
    return { pending: this.unsaved !== null || this.writing !== null, lastWriteError: this.lastWriteError,
      appliedSeq: this.appliedSeq, watching: this.watchTimer !== null || this.watching };
  }

  // seq: the mirror's sequence number, acknowledged in the push so main can drop the patch. Resolves once the patch is
  // written (saved: true) or the write failed (saved: false; it stays in memory and is retried after 1, 3, 10 s).
  async update(patch, { seq = null } = {}) {
    if (Number.isFinite(seq)) this.appliedSeq = Math.max(this.appliedSeq, seq);
    this.unsaved = mergeSettingsPatch(this.unsaved ?? {}, patch ?? {});
    const saved = await this.#flush();
    const value = this.load();
    this.#publish(value, { force: true });
    return { saved, seq: this.appliedSeq, value, error: saved ? null : this.lastWriteError };
  }

  // Outside edits: the store's own watch (the storage worker stats the file), else a stat per tick here (no open), a
  // reread only when mtime or size changed, a push only when the value did.
  watch() {
    if (!this.watchMs || this.watchTimer !== null || this.watching || this.closed) return;
    this.published ??= JSON.stringify(this.load());
    if (typeof this.store.watch === "function") {
      this.watching = true;
      Promise.resolve(this.store.watch(this.watchMs, () => { if (!this.closed) this.#publish(this.load()); }))
        .catch((error) => this.#warn("Settings cannot be watched for outside edits", error));
      return;
    }
    this.watchTimer = setInterval(() => {
      try { this.#publish(this.load({ revalidate: true })); }
      catch (error) { this.#warn("Settings could not be reread", error); }
    }, this.watchMs);
    this.watchTimer.unref?.();
  }

  // The final write of whatever is still unsaved. Resolves true when nothing is left unsaved.
  async close() {
    this.closed = true;
    if (this.watchTimer !== null) clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.unsaved || this.flushing) await this.#flush();
    return this.unsaved === null && this.writing === null;
  }

  // change(value, seq, saved): saved is false while a patch waits for its retry.
  #publish(value, { force = false } = {}) {
    const json = JSON.stringify(value);
    if (!force && json === this.published) return;
    this.published = json;
    this.emit("change", value, this.appliedSeq, this.unsaved === null && this.writing === null);
  }

  // One write at a time; patches accepted meanwhile go with the next. Resolves false at the first failed write.
  #flush() {
    // A patch accepted after the running write's last check goes with a write of its own.
    if (this.flushing) return this.flushing.then((ok) => (ok && this.unsaved ? this.#flush() : ok));
    const run = async () => {
      while (this.unsaved) {
        const patch = this.unsaved;
        this.unsaved = null;
        this.writing = patch;
        try {
          const value = mergeSettingsPatch(this.store.load({ revalidate: true }), patch);
          await this.store.save(value, { patch });
          this.writing = null;
          this.#succeeded();
        } catch (error) {
          this.writing = null;
          this.unsaved = mergeSettingsPatch(patch, this.unsaved ?? {});
          this.#failed(error);
          return false;
        }
      }
      return true;
    };
    // Cleared in a later turn: with a synchronous store the run can finish before this assignment.
    const flushing = run();
    this.flushing = flushing;
    flushing.finally(() => { if (this.flushing === flushing) this.flushing = null; }).catch(() => {});
    return flushing;
  }

  async #retry() {
    this.retryTimer = null;
    if (!this.unsaved) return;
    // The value is unchanged, but main's mirror still reports the failed write until it hears it landed.
    if (await this.#flush() && !this.closed) this.#publish(this.load(), { force: true });
  }

  #succeeded() {
    if (this.lastWriteError) this.logger?.info?.("settings", "Settings saved after a write failure");
    this.lastWriteError = null;
    this.lastErrorKey = null;
    this.retryAttempt = 0;
  }

  #failed(error) {
    const message = String(error?.message ?? error).slice(0, 1024);
    const key = error?.code ? `${error.code}:${error.syscall ?? ""}` : message;
    this.lastWriteError = message;
    if (key !== this.lastErrorKey) {
      this.lastErrorKey = key;
      this.#warn("Settings could not be saved; keeping them in memory and retrying", error);
    }
    if (this.closed || this.retryTimer !== null || this.retryAttempt >= this.retryDelaysMs.length) return;
    this.retryTimer = this.timers.setTimeout(() => this.#retry(), this.retryDelaysMs[this.retryAttempt++]);
    this.retryTimer?.unref?.();
  }

  #warn(message, error) {
    try { this.logger?.warn?.("settings", message, { error: String(error?.message ?? error) }); } catch { /* diagnostics */ }
  }
}

// Main's copy. load() is synchronous; update() shows a patch at once and resolves with the core's answer; an older push
// never undoes a pending patch. reset() after a core (re)boot sends patches the old core never acknowledged.
export class SettingsMirror {
  constructor({ client, peek = null, logger = null, initial = {} }) {
    this.client = client;
    this.peek = peek;
    this.logger = logger;
    this.base = initial ?? {};
    this.pending = [];
    this.seq = 0;
    this.inflight = new Set();
    this.lastError = null;
    this.lastErrorUnsaved = false;   // the core has the patch but not on disk yet: a later "saved" push clears it
    client.on("settings", ({ value, seq, saved }) => this.#receive(value, seq, saved));
  }

  load() {
    if (this.peek) return this.peek();
    return structuredClone(this.pending.reduce((value, entry) => mergeSettingsPatch(value, entry.patch), this.base));
  }

  reset(value) {
    if (value) this.base = value;
    const unacknowledged = this.pending.splice(0);
    for (const { patch } of unacknowledged) this.update(patch);
  }

  update(patch) {
    const entry = { seq: ++this.seq, patch };
    this.pending.push(entry);
    const request = this.client.request("settings.update", { patch, seq: entry.seq }).then((result) => {
      this.#receive(result?.value, result?.seq ?? entry.seq);
      this.pending = this.pending.filter((item) => item !== entry);
      if (result?.saved === false) {
        this.lastError = result.error ?? "Settings were not saved.";
        this.lastErrorUnsaved = true;
      } else if (this.lastErrorUnsaved) {
        this.lastError = null;
        this.lastErrorUnsaved = false;
      }
      return result;
    }, (error) => {
      // A core that went away keeps the patch for reset(); any other failure drops it.
      if (error?.code !== "service_closed" && error?.code !== "core_recovering") {
        this.pending = this.pending.filter((item) => item !== entry);
        this.lastError = String(error?.message ?? error);
        this.lastErrorUnsaved = false;
        try { this.logger?.warn?.("settings", "Settings update failed", { error: this.lastError }); } catch { /* reporting */ }
      }
      throw error;
    });
    // Most callers do not wait (a drag, a menu click): their failure is logged above, never an unhandled rejection.
    request.catch(() => {});
    this.inflight.add(request);
    request.finally(() => this.inflight.delete(request)).catch(() => {});
    return request;
  }

  // Full-value writers (ShellUiState) become patches of what they changed.
  save(value) {
    const patch = settingsPatchBetween(this.load(), value);
    return Object.keys(patch).length ? this.update(patch) : Promise.resolve(null);
  }

  // The only failure is a patch the core accepted but could not write yet: its final flush on quit may still save it.
  get heldByCore() { return this.lastError !== null && this.lastErrorUnsaved; }

  // Resolves true when every update so far reached the file.
  async drain() {
    await Promise.allSettled([...this.inflight]);
    return this.lastError === null;
  }

  #receive(value, ackSeq, saved) {
    if (value) this.base = value;
    if (Number.isFinite(ackSeq)) this.pending = this.pending.filter((entry) => entry.seq > ackSeq);
    if (saved === true && this.lastErrorUnsaved) {
      this.lastError = null;
      this.lastErrorUnsaved = false;
    }
  }
}
