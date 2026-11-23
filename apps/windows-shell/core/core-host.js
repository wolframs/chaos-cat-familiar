import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { ServiceEndpoint } from "../../../packages/core/src/service-rpc.js";
import { createSocketChannel, parentSidePort, processAlive, transferPort, watchLiveness } from "../../../packages/core/src/process-ports.js";
import { nextEpoch } from "../../../packages/core/src/state-sync.js";

export const CORE_MODULE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "core-process.js");

const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const RESTART_DELAYS_MS = [250, 1000, 3000, 10000];
// A restarted core asks for its previous port again; the dead process's listener is normally gone at once.
const REBIND_RETRY_MS = [100, 250, 500];


// Main's handle on the core (process-split plan, step 3). Both hosts boot the same composition and hand main the same
// CoreClient; the utility-process host also supervises: restart with backoff after a crash (same token from
// settings.json, same port if it can be had), graceful shutdown with deadlines. The in-process host (tests with fake
// Electron) lives in core-in-process.js and is handed to createCoreHost by the fakes: main never loads the core's
// composition (step 7, main-boundary.test.js).

// Production: an Electron utility process (fork = utilityProcess.fork), or a Node child forked with structured-clone
// serialization where Electron is not available (tests, the load fixture).
export class CoreProcessHost extends EventEmitter {
  constructor({ client, config, fork, modulePath = CORE_MODULE_PATH, forkOptions = {}, logger = null,
    restartDelaysMs = RESTART_DELAYS_MS, maxRestarts = 5, restartWindowMs = 120000, bootTimeoutMs = 30000,
    exitDeadlineMs = 2000, onError = () => {}, MessageChannelMain = null, viewChannel = null, livenessMs = 1000,
    isAlive = processAlive }) {
    super();
    Object.assign(this, { client, config, fork, modulePath, forkOptions, logger, restartDelaysMs, maxRestarts,
      restartWindowMs, bootTimeoutMs, exitDeadlineMs, onError, MessageChannelMain, viewChannel, livenessMs, isAlive });
    this.stopWatching = null;
    this.mode = "utility";
    this.child = null;
    this.endpoint = null;
    this.exited = null;
    this.lastPort = null;
    this.crashes = [];
    this.restartTimer = null;
    this.stopping = false;
    this.failed = false;
    this.starting = false;
    this.exitHandled = new WeakSet();
  }

  // Electron reports a utility process's pid only once it spawned and not after it exited: the core's own report wins.
  get pid() { return this.corePid ?? this.child?.pid ?? null; }

  async start() {
    this.starting = true;
    try { return await this.#boot({ restart: false }); }
    finally { this.starting = false; }
  }

  async #boot({ restart }) {
    let child;
    try {
      child = this.fork(this.modulePath, [], { serviceName: "Chaos Cat Familiar Core", ...this.forkOptions });
    } catch (error) {
      // No process means no exit event to schedule the next attempt: count it as a crash (review 2026-11-05, P2).
      if (restart && !this.stopping) {
        try { this.logger?.error("core", "Core process could not be started", { error: String(error?.message ?? error) }); } catch {}
        this.#scheduleRestart();
      }
      throw error;
    }
    this.child = child;
    this.corePid = null;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? null)));
    child.once("exit", (code) => this.#onExit(child, code));
    // Electron's FatalError (and a Node child that failed to spawn): an "error" without a listener would throw into
    // main's fatal handler and close CCF instead of restarting the core (review 2026-11-05, P1).
    child.on("error", (...details) => this.#onChildError(child, details));
    // A core that died without an exit event (review of step 5, P2) is a crash all the same, within livenessMs.
    this.stopWatching?.();
    this.stopWatching = watchLiveness({ everyMs: this.livenessMs, isAlive: this.isAlive,
      pid: () => (this.child === child ? this.corePid ?? child.pid ?? null : null),
      onGone: (pid) => {
        if (this.child !== child || this.exitHandled.has(child)) return;
        try { this.logger?.warn("core", "The core process is gone but no exit was reported; handling it as a crash", { pid }); } catch {}
        this.#kill(child);
        this.#onExit(child, null);
      } });
    const endpoint = new ServiceEndpoint({ name: "main", onError: this.onError,
      port: parentSidePort(child, { onSendError: (error) => this.onError(error, { topic: "send" }) }) });
    this.endpoint = endpoint;
    this.client.attach(endpoint, { peek: null });
    const config = { ...this.config, epoch: nextEpoch(),
      preferredPort: restart && this.lastPort !== null ? this.lastPort : this.config.preferredPort,
      retryPortMs: restart ? REBIND_RETRY_MS : [] };
    try {
      const info = await endpoint.request("boot", config, { timeoutMs: this.bootTimeoutMs });
      if (this.child !== child) throw new Error("The core process was replaced while it booted.");
      const previousPort = this.lastPort;
      this.lastPort = info.port;
      this.corePid = info.pid ?? null;
      this.client.setReady(info);
      this.emit(restart ? "restarted" : "started", { ...info, previousPort });
      return info;
    } catch (error) {
      // A boot that failed or hung: the process goes; a restart is scheduled by its exit unless this was the start.
      if (this.child === child) this.#kill(child);
      throw error;
    }
  }

  #kill(child) {
    try { child.kill(); } catch { /* already gone */ }
  }

  #onChildError(child, details) {
    try {
      this.logger?.error("core", "Core process reported an error", {
        error: details.map((item) => String(item?.stack ?? item?.message ?? item)).join(" | ").slice(0, 2000) });
    } catch {}
    // Electron exits the process after a FatalError; a Node child that never spawned emits no exit at all.
    if (child.pid === undefined && child.exitCode == null) this.#onExit(child, null);
  }

  #onExit(child, code) {
    if (child !== this.child || this.exitHandled.has(child)) return;
    this.exitHandled.add(child);
    this.stopWatching?.();
    this.stopWatching = null;
    this.endpoint?.close(`core exited (${code})`);
    if (this.stopping) return;
    this.client.detach(`core exited (${code})`);
    if (this.starting) return;   // start() reports the failure; there is nothing to restart yet
    try { this.logger?.error("core", "Core process exited unexpectedly", { code, pid: this.corePid }); } catch {}
    this.emit("crashed", { code });
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    const now = Date.now();
    this.crashes = this.crashes.filter((at) => now - at < this.restartWindowMs);
    this.crashes.push(now);
    if (this.crashes.length > this.maxRestarts) {
      this.failed = true;
      try {
        this.logger?.error("core", "Core process keeps exiting; not restarting it again", {
          restarts: this.crashes.length - 1, windowMs: this.restartWindowMs });
      } catch {}
      this.emit("failed", { restarts: this.crashes.length - 1 });
      return;
    }
    const delay = this.restartDelaysMs[Math.min(this.crashes.length - 1, this.restartDelaysMs.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.#boot({ restart: true }).catch((error) => {
        try { this.logger?.error("core", "Core restart failed", { error: String(error?.message ?? error) }); } catch {}
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  // Graceful quit: the core stops intake, releases pending permission requests without a decision, drains, flushes
  // state and log, and answers; main then closes the channel and the process exits. Past a deadline it is killed.
  async stop({ deadlineMs = 5000, finalize = null } = {}) {
    this.stopping = true;
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    let result = null;
    const ready = this.client.status === "ready";
    if (ready) {
      result = await this.client.request("shutdown", null, { timeoutMs: deadlineMs }).catch((error) => {
        try { this.logger?.warn("core", "Core did not shut down within its deadline; stopping it", { error: String(error?.message ?? error) }); } catch {}
        return null;
      });
    }
    result = await markCleanAfter(this.client, result, finalize, ready);
    this.client.markStopped();   // the core's log is closed: main keeps later lines itself
    this.endpoint?.close("runtime stopped");
    const child = this.child;
    if (child) {
      const exited = await Promise.race([this.exited, sleep(this.exitDeadlineMs).then(() => "timeout")]);
      if (exited === "timeout") {
        this.#kill(child);
        await Promise.race([this.exited, sleep(1000)]);
      }
    }
    return result;
  }

  flushSync() { /* the core process flushes on its own exit */ }

  // A window's own state port (step 5): one end goes to the core process, main returns the other for the renderer.
  // Electron transfers a MessagePortMain; the Node stand-in hands over one end of a loopback socket pair; viewChannel
  // (the load fixture) supplies its own pair.
  async openViewPort(kind, options) {
    const child = this.child;
    if (!child || this.client.status !== "ready") throw new Error("The core is not running.");
    const info = { type: "port", kind, options };
    let channel;
    if (this.viewChannel) channel = await this.viewChannel({ kind, options });
    else if (typeof child.postMessage === "function") {
      // An Electron utility process takes only MessagePortMain ends.
      if (!this.MessageChannelMain) throw new Error("MessageChannelMain is not available to open a view port.");
      const { port1, port2 } = new this.MessageChannelMain();
      channel = { servicePort: port1, rendererPort: port2 };
    } else channel = await createSocketChannel();
    if (this.child !== child) throw new Error("The core process was replaced while its port opened.");
    transferPort(child, info, channel.servicePort);
    return channel.rendererPort;
  }
}

// The run marker (written by the core's storage worker) goes only when main judges the whole quit clean: the core's
// final state, settings and log, and main's own placement, settings and leftover log lines. finalize(result) runs even
// without a core, so main can write its leftovers; a marker the core could not remove keeps the run unclean.
export async function markCleanAfter(client, result, finalize, coreAnswered) {
  if (!finalize) return result;
  let clean = false;
  try { clean = await finalize(result); } catch { clean = false; }
  if (!clean || !coreAnswered || !result) return result ? { ...result, markedClean: false } : result;
  const marked = await client.request("markClean", null, { timeoutMs: 5000 }).catch(() => null);
  return { ...result, markedClean: marked?.ok === true };
}

export function withDeadline(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`No answer within ${ms} ms.`); })]);
}

export function createCoreHost({ electron, client, config, services = {}, timers, logger, onError }) {
  if (electron.utilityProcess && !services.coreInProcess) {
    return new CoreProcessHost({ client, config, logger, onError, MessageChannelMain: electron.MessageChannelMain ?? null,
      viewChannel: services.viewChannel ?? null, ...(services.coreProcess ?? {}),
      fork: (modulePath, args, options) => electron.utilityProcess.fork(modulePath, args, options) });
  }
  const InProcessCoreHost = services.inProcessHosts?.core ?? electron.inProcessHosts?.core;
  if (!InProcessCoreHost) throw new Error("No utility process to run the core in, and no in-process host was given.");
  // In-process reads are live (peek), so the settings file needs no watching.
  return new InProcessCoreHost({ client, config: { ...config, watchSettingsMs: 0 }, timers, onError, overrides: {
    storage: services.coreStorage,
    hookInstaller: services.hookInstaller,
    hasPendingBackgroundWork: services.hasPendingBackgroundWork,
    liveClaudeSessionIds: services.liveClaudeSessionIds
  } });
}
