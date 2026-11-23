// Main's part in a window's own subscription (process-split plan, step 5): a window asks (ccf:subscribe), main opens a
// channel to the service process and posts the window its end ("ccf:port"). From then on the state (or the frames)
// travel from the service straight to the renderer; main only remembers who asked, so it can open a new port after
// the service restarted, and forgets a window when its page goes (the old ports die with it).

const SERVICES = new Set(["core", "companion"]);
const TOPICS = new Set(["base", "sessions", "approvals", "events", "logs"]);

function limit(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 200) : undefined;
}

// Only known fields with bounded values cross into the service process.
export function sanitizeSubscription(request) {
  const id = typeof request?.id === "string" && request.id.length > 0 && request.id.length <= 80 ? request.id : null;
  if (!id) throw new Error("A subscription needs an id.");
  const service = SERVICES.has(request.service) ? request.service : null;
  if (!service) throw new Error(`Unknown subscription service ${request?.service}.`);
  const options = { id };
  if (service === "core") {
    const topics = Array.isArray(request.topics) ? request.topics.filter((topic) => TOPICS.has(topic)) : [];
    options.topics = topics.length ? [...new Set(topics)] : ["base"];
    const eventLimit = limit(request.eventLimit);
    const logLimit = limit(request.logLimit);
    if (eventLimit !== undefined) options.eventLimit = eventLimit;
    if (logLimit !== undefined) options.logLimit = logLimit;
  }
  options.window = Number.isInteger(request.window) && request.window >= 1 && request.window <= 4 ? request.window : 2;
  return { id, service, options };
}

export class ViewSubscriptions {
  // open(service, kind, options) resolves with the renderer's end of a new channel. onChange() runs when a window
  // became able to subscribe or went away (main then stops or resumes sending it the state itself).
  constructor({ open, onError = () => {}, onChange = () => {} }) {
    this.open = open;
    this.onError = onError;
    this.onChange = onChange;
    this.byContents = new Map();   // webContents -> Map(id -> {service, options})
    this.capable = new Map();      // webContents -> Set(service): it subscribes itself (also while paused)
    this.stats = { opened: 0, reopened: 0, failed: 0 };
  }

  async subscribe(webContents, request) {
    if (!webContents) throw new Error("No window to subscribe.");
    const { id, service, options } = sanitizeSubscription(request);
    let records = this.byContents.get(webContents);
    if (!records) {
      records = new Map();
      this.byContents.set(webContents, records);
      const forget = () => this.forget(webContents);
      webContents.once?.("destroyed", forget);
      // A reload or navigation of the main frame ends the page and its ports.
      webContents.on?.("did-start-navigation", (...args) => {
        const details = args[0];
        const isMainFrame = typeof details === "object" && details !== null ? details.isMainFrame : args[3];
        const sameDocument = typeof details === "object" && details !== null ? details.isSameDocument : args[2];
        if (isMainFrame !== false && !sameDocument) forget();
      });
    }
    const record = { service, options };
    records.set(id, record);
    const services = this.capable.get(webContents) ?? new Set();
    const added = !services.has(service);
    services.add(service);
    this.capable.set(webContents, services);
    if (added) this.onChange();
    try {
      await this.#post(webContents, id, record);
    } catch (error) {
      // The service is not running yet (the companion starts lazily) or is restarting: the window keeps its
      // subscription and gets its port from reopen() once the service is ready.
      this.stats.failed += 1;
      this.onError(error, { id, service, pending: true });
      return { id, service, pending: true };
    }
    this.stats.opened += 1;
    return { id, service };
  }

  unsubscribe(webContents, id) {
    const records = this.byContents.get(webContents);
    return Boolean(records?.delete(id));
  }

  // What main knows of each window's subscriptions (diagnostics).
  list() {
    return [...this.byContents.values()].flatMap((records) => [...records].map(([id, record]) => ({ id, service: record.service })));
  }

  forget(webContents) {
    this.byContents.delete(webContents);
    if (this.capable.delete(webContents)) this.onChange();
  }

  // The window takes this service's state from its own port (also while it paused its subscription, hidden).
  has(webContents, service) {
    return Boolean(webContents && this.capable.get(webContents)?.has(service));
  }

  // After a service restart: every window that still wants it gets a new port under the same id.
  async reopen(service) {
    const work = [];
    for (const [webContents, records] of this.byContents) {
      if (webContents.isDestroyed?.()) { this.forget(webContents); continue; }
      for (const [id, record] of records) {
        if (record.service !== service) continue;
        work.push(this.#post(webContents, id, record).then(() => { this.stats.reopened += 1; }, (error) => {
          this.stats.failed += 1;
          this.onError(error, { id, service });
        }));
      }
    }
    await Promise.all(work);
  }

  async #post(webContents, id, record) {
    const port = await this.open(record.service, record.service === "core" ? "state" : "frames", record.options);
    if (webContents.isDestroyed?.() || !this.byContents.get(webContents)?.has(id)) {
      try { port.close?.(); } catch { /* gone */ }
      return;
    }
    webContents.postMessage("ccf:port", { id, service: record.service }, [port]);
  }
}
