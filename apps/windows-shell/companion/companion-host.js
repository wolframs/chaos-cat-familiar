import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ServiceEndpoint, ServiceError } from "../../../packages/core/src/service-rpc.js";
import { createSocketChannel, parentSidePort, processAlive, transferPort, watchLiveness } from "../../../packages/core/src/process-ports.js";
import { nextEpoch } from "../../../packages/core/src/state-sync.js";

export const COMPANION_MODULE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "companion-process.js");

const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
export const TIMED_OUT = Symbol("timed out");
export const withDeadline = (promise, ms) => Promise.race([promise, sleep(ms).then(() => TIMED_OUT)]);

// Fallback when the companion could not join its kill-on-close job: end the trees of the children it reported.
export function killTrees(pids, { platform = process.platform, execFileProcess = execFile } = {}) {
  return Promise.all([...pids].map((pid) => new Promise((resolve) => {
    if (platform !== "win32") { try { process.kill(pid); } catch {} resolve(); return; }
    execFileProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, () => resolve());
  })));
}

// Main's side of what the companion asks or reports: backend choices (settings writes), log lines, its children.
export function serveMain(endpoint, host) {
  endpoint.handle("settings.patch", ({ patch } = {}) => host.onSettingsPatch?.(patch ?? {}) ?? null);
  // Delivery records (process-split step 6): relayed to the core's storage worker; refused when there is none.
  const delivery = (op) => (params) => (host.onDelivery ? host.onDelivery(op, params)
    : Promise.reject(new ServiceError("No delivery storage is attached.", "storage_unavailable")));
  endpoint.handle("delivery.load", delivery("load")).handle("delivery.commit", delivery("commit"));
  endpoint.on("log", (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      try { host.logger?.log?.(entry.level, entry.category, entry.message, entry.context ?? {}); } catch { /* reporting */ }
    }
  });
  endpoint.on("children", ({ op, kind, pid } = {}) => {
    if (op === "add") host.children.set(pid, { kind, pid });
    else host.children.delete(pid);
  });
  endpoint.on("job", (result) => { host.job = result; });
  endpoint.markReady();
}

// Main's handle on the companion backend (process-split plan, step 4). Both hosts compose the same backend and hand
// main the same CompanionClient. ensure() starts it; restart: true is how an explicit user action (Start, the
// launcher's /companion/open) brings a crashed companion back: there is no automatic restart, and a crash never
// resends input or starts Claude/Codex.

// Production: an Electron utility process (fork = utilityProcess.fork), or a Node child forked with structured-clone
// serialization where Electron is not available (tests, the load fixture). Started lazily by ensure().
export class CompanionProcessHost extends EventEmitter {
  constructor({ client, getConfig, fork, modulePath = COMPANION_MODULE_PATH, forkOptions = {}, logger = null,
    onSettingsPatch = null, onDelivery = null, bootTimeoutMs = 30000, exitDeadlineMs = 2000, onError = () => {}, killChildTrees = killTrees,
    MessageChannelMain = null, viewChannel = null, livenessMs = 1000, isAlive = processAlive }) {
    super();
    Object.assign(this, { client, getConfig, fork, modulePath, forkOptions, logger, onSettingsPatch, onDelivery, bootTimeoutMs,
      exitDeadlineMs, onError, killChildTrees, MessageChannelMain, viewChannel, livenessMs, isAlive });
    this.stopWatching = null;
    this.mode = "utility";
    this.child = null;
    this.endpoint = null;
    this.exited = null;
    this.booting = null;
    this.stopping = false;
    this.companionPid = null;
    this.children = new Map();
    this.job = null;
    this.exitHandled = new WeakSet();
    this.lastExit = null;
  }

  get pid() { return this.child ? this.companionPid ?? this.child.pid ?? null : null; }

  status() {
    return { mode: this.mode, pid: this.pid, status: this.client.status, job: this.job,
      children: [...this.children.values()], lastExit: this.lastExit };
  }

  // restart: an explicit user action may bring back a crashed companion; anything else gets an error to show.
  ensure({ restart = false } = {}) {
    if (this.stopping) return Promise.reject(new ServiceError("CCF is quitting.", "companion_unavailable"));
    if (this.booting) return this.booting;
    if (this.child && this.client.status === "ready") return Promise.resolve(this.info);
    if (this.client.status === "crashed" && !restart) {
      return Promise.reject(new ServiceError("The companion process stopped. Press Start to restart it.", "companion_crashed"));
    }
    this.booting = this.#boot().finally(() => { this.booting = null; });
    return this.booting;
  }

  async #boot() {
    const child = this.fork(this.modulePath, [], { serviceName: "Chaos Cat Familiar Companion", ...this.forkOptions });
    this.child = child;
    this.companionPid = null;
    this.children = new Map();
    this.job = null;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? null)));
    child.once("exit", (code) => this.#onExit(child, code));
    child.on("error", (...details) => {
      try {
        this.logger?.error?.("companion", "Companion process reported an error", {
          error: details.map((item) => String(item?.stack ?? item?.message ?? item)).join(" | ").slice(0, 2000) });
      } catch {}
      if (child.pid === undefined && child.exitCode == null) this.#onExit(child, null);
    });
    // A companion that died without an exit event is a crash all the same, within livenessMs (as for the core).
    this.stopWatching?.();
    this.stopWatching = watchLiveness({ everyMs: this.livenessMs, isAlive: this.isAlive,
      pid: () => (this.child === child ? this.companionPid ?? child.pid ?? null : null),
      onGone: (pid) => {
        if (this.child !== child || this.exitHandled.has(child)) return;
        try { this.logger?.warn?.("companion", "The companion process is gone but no exit was reported; handling it as a crash", { pid }); } catch {}
        try { child.kill(); } catch { /* already gone */ }
        this.#onExit(child, null);
      } });
    const endpoint = new ServiceEndpoint({ name: "main", onError: this.onError,
      port: parentSidePort(child, { onSendError: (error) => this.onError(error, { topic: "send" }) }) });
    this.endpoint = endpoint;
    serveMain(endpoint, this);
    this.client.attach(endpoint);
    try {
      const info = await endpoint.request("boot", { ...this.getConfig(), epoch: nextEpoch() }, { timeoutMs: this.bootTimeoutMs });
      if (this.child !== child) throw new Error("The companion process was replaced while it booted.");
      this.companionPid = info.pid ?? null;
      this.info = info;
      this.client.setReady(info);
      this.emit("started", info);
      return info;
    } catch (error) {
      if (this.child === child) { try { child.kill(); } catch { /* already gone */ } }
      throw error;
    }
  }

  #onExit(child, code) {
    if (this.exitHandled.has(child)) return;
    this.exitHandled.add(child);
    if (child === this.child) {
      this.stopWatching?.();
      this.stopWatching = null;
    }
    if (child !== this.child) return;
    const pid = this.companionPid ?? null;
    this.child = null;
    this.lastExit = { code, pid, at: new Date().toISOString(), stopping: this.stopping };
    this.endpoint?.close(`companion exited (${code})`);
    // The job ended the children with the process; without it, end what it reported.
    const leftovers = [...this.children.keys()];
    if (leftovers.length && !this.job?.joined) {
      void this.killChildTrees(leftovers).catch(() => {});
    }
    if (this.stopping) {
      this.client.detach("stopped", { crashed: false });
      return;
    }
    this.client.detach(`exit code ${code ?? "unknown"}`, { crashed: true });
    try {
      this.logger?.error?.("companion", "Companion process exited unexpectedly; it starts again only when you press Start",
        { code, pid, children: leftovers.length });
    } catch {}
    this.emit("crashed", { code, pid });
  }

  // The conversation window's frames port (step 5): one end to the companion process, the other for the renderer.
  // Never starts the companion: a window that asks before it runs gets its port when it is ready.
  async openViewPort(kind, options) {
    const child = this.child;
    if (!child || this.client.status !== "ready") throw new ServiceError("The companion is not running.", "companion_unavailable");
    const info = { type: "port", kind, options };
    let channel;
    if (this.viewChannel) channel = await this.viewChannel({ kind, options, service: "companion" });
    else if (typeof child.postMessage === "function") {
      // An Electron utility process takes only MessagePortMain ends.
      if (!this.MessageChannelMain) throw new Error("MessageChannelMain is not available to open a view port.");
      const { port1, port2 } = new this.MessageChannelMain();
      channel = { servicePort: port1, rendererPort: port2 };
    } else channel = await createSocketChannel();
    if (this.child !== child) throw new ServiceError("The companion process was replaced while its port opened.", "companion_unavailable");
    transferPort(child, info, channel.servicePort);
    return channel.rendererPort;
  }

  // Graceful quit: the companion stops its sessions (watcher, Codex, habitat, the PTY), answers, and exits when main
  // closes the channel; past the deadline it is killed (its job then ends whatever it still had running).
  async stop({ deadlineMs = 5000 } = {}) {
    this.stopping = true;
    if (this.booting) await withDeadline(this.booting.catch(() => {}), deadlineMs);
    if (this.child && this.client.status === "ready") {
      const result = await this.client.dispose({ timeoutMs: deadlineMs }).catch((error) => {
        try { this.logger?.warn?.("companion", "The companion did not stop its sessions in time", { error: String(error?.message ?? error) }); } catch {}
        return null;
      });
      if (result === null) { /* logged */ }
    }
    this.endpoint?.close("runtime stopped");
    const child = this.child;
    if (child) {
      const exited = await withDeadline(this.exited, this.exitDeadlineMs);
      if (exited === TIMED_OUT) {
        try { child.kill(); } catch { /* already gone */ }
        await withDeadline(this.exited, 1000);
      }
    }
    if (this.client.status !== "stopped") this.client.detach("stopped", { crashed: false });
  }
}

export function createCompanionHost({ electron, client, getConfig, services = {}, logger, onSettingsPatch, onDelivery, onError }) {
  const fakes = services.companionSession ?? null;
  if (electron.utilityProcess && !fakes && !services.companionInProcess) {
    return new CompanionProcessHost({ client, getConfig, logger, onSettingsPatch, onDelivery, onError,
      MessageChannelMain: electron.MessageChannelMain ?? null, viewChannel: services.viewChannel ?? null,
      ...(services.companionProcess ?? {}),
      fork: (modulePath, args, options) => electron.utilityProcess.fork(modulePath, args, options) });
  }
  // Tests: companion-in-process.js, handed over by the fakes (main never loads the companion's backend).
  const InProcessCompanionHost = services.inProcessHosts?.companion ?? electron.inProcessHosts?.companion;
  if (!InProcessCompanionHost) throw new Error("No utility process to run the companion in, and no in-process host was given.");
  return new InProcessCompanionHost({ client, getConfig, logger, onSettingsPatch, onDelivery, onError, overrides: {
    session: services.companionSession, delivery: services.companionDelivery ?? null,
    attachments: services.companionAttachments, codexCompanionSession: services.codexCompanionSession,
    companionHabitat: services.companionHabitat
  } });
}
