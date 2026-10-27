const RETRY_DELAYS = [250, 1000, 3000];
const TRANSIENT_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

// Placement is best effort. A locked settings file must never terminate a drag.
// Keep one latest patch while retrying; ordinary preferences still save explicitly.
export class OverlayPlacementPersistence {
  constructor({ save, logger, timers = globalThis }) {
    this.write = save;
    this.logger = logger;
    this.timers = timers;
    this.pending = null;
    this.timer = null;
    this.attempts = 0;
    this.lastWriteError = null;
    this.lastErrorKey = null;
    this.closed = false;
    this.dragging = false;
  }

  status() {
    return { pending: this.pending !== null, dragging: this.dragging, retryScheduled: this.timer !== null,
      attempts: this.attempts, lastWriteError: this.lastWriteError };
  }

  save(patch) {
    if (this.closed) return false;
    this.pending = { overlayBounds: { ...patch.overlayBounds }, overlayDisplayId: patch.overlayDisplayId };
    if (this.dragging || this.timer !== null) return false;
    this.attempts = 0;
    return this.flush();
  }

  beginDrag() {
    if (this.closed) return;
    this.dragging = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  endDrag() {
    this.dragging = false;
    this.attempts = 0;
    return this.flush();
  }

  flush({ retry = true, force = false } = {}) {
    if (this.dragging && !force) return false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return true;
    try {
      // The callback rereads settings at each attempt to preserve external edits.
      this.write(this.pending);
      this.pending = null;
      if (this.lastWriteError) this.logger?.info("placement", "Mascot position saved after a settings write failure");
      this.lastWriteError = null;
      this.lastErrorKey = null;
      this.attempts = 0;
      return true;
    } catch (error) {
      this.attempts++;
      this.lastWriteError = String(error?.message ?? error).slice(0, 1024);
      const key = error?.code ? `${error.code}:${error.syscall ?? ""}` : this.lastWriteError;
      if (key !== this.lastErrorKey) {
        this.lastErrorKey = key;
        this.logger?.warn("placement", "Mascot position could not be saved; keeping the latest position in memory", {
          error: this.lastWriteError
        });
      }
      if (retry && !this.closed && TRANSIENT_ERRORS.has(error?.code) && this.attempts <= RETRY_DELAYS.length) {
        this.timer = this.timers.setTimeout(() => this.flush(), RETRY_DELAYS[this.attempts - 1]);
        this.timer?.unref?.();
      }
      return false;
    }
  }

  close() {
    this.closed = true;
    this.dragging = false;
    return this.flush({ retry: false });
  }
}
