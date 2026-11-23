import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { ServiceEndpoint, ServiceError, createInProcessPorts } from "../../../packages/core/src/service-rpc.js";
import { nextEpoch, portAdapter } from "../../../packages/core/src/state-sync.js";
import { TIMED_OUT, serveMain, withDeadline } from "./companion-host.js";

// Tests with fake Electron, and fakes that cannot cross a process: the composition in this process, joined by
// synchronous in-process ports, live reads (peek).
export class InProcessCompanionHost extends EventEmitter {
  constructor({ client, getConfig, overrides = {}, logger = null, onSettingsPatch = null, onDelivery = null, onError = () => {} }) {
    super();
    Object.assign(this, { client, getConfig, overrides, logger, onSettingsPatch, onDelivery, onError });
    this.mode = "in-process";
    this.children = new Map();
    this.job = null;
    this.booting = null;
    this.composed = null;
  }

  get pid() { return process.pid; }

  status() {
    return { mode: this.mode, pid: this.pid, status: this.client.status, job: this.job,
      children: [...this.children.values()] };
  }

  ensure() {
    if (this.composed) return Promise.resolve(this.composed.readiness);
    this.booting ??= this.#boot().finally(() => { this.booting = null; });
    return this.booting;
  }

  async #boot() {
    // Loaded on demand: the backend (xterm, node-pty) is not main's to load in production.
    const { composeCompanion } = await import("./companion-composition.js");
    const [companionPort, mainPort] = createInProcessPorts();
    const companionEndpoint = new ServiceEndpoint({ port: companionPort, name: "companion", onError: this.onError });
    const mainEndpoint = new ServiceEndpoint({ port: mainPort, name: "main", onError: this.onError });
    serveMain(mainEndpoint, this);
    this.endpoint = mainEndpoint;
    const config = { ...this.getConfig(), killOnCloseJob: false, epoch: nextEpoch() };
    const composed = await composeCompanion({ endpoint: companionEndpoint, config, overrides: this.overrides });
    this.client.attach(mainEndpoint, { peek: { snapshot: composed.served.snapshot } });
    companionEndpoint.markReady({ booted: true });
    this.composed = composed;
    this.client.setReady(composed.readiness);
    this.emit("started", composed.readiness);
    return composed.readiness;
  }

  // The conversation window's frames port (step 5); never starts the companion.
  async openViewPort(kind, options) {
    if (!this.composed || this.client.status !== "ready") throw new ServiceError("The companion is not running.", "companion_unavailable");
    const { port1, port2 } = new MessageChannel();
    port1.unref?.();
    port2.unref?.();
    this.composed.attachPort({ type: "port", kind, options }, portAdapter(port1));
    return port2;
  }

  async stop({ deadlineMs = 5000 } = {}) {
    if (this.booting) await withDeadline(this.booting.catch(() => {}), deadlineMs);
    if (this.composed) {
      const result = await withDeadline(this.client.dispose().catch((error) => {
        this.logger?.warn?.("companion", "The companion did not stop cleanly", { error: String(error?.message ?? error) });
      }), deadlineMs);
      if (result === TIMED_OUT) this.logger?.warn?.("companion", "The companion did not stop in time");
    }
    this.client.detach("stopped", { crashed: false });
    this.endpoint?.close("runtime stopped");
    this.composed = null;
  }
}
