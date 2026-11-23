import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { ServiceEndpoint, createInProcessPorts } from "../../../packages/core/src/service-rpc.js";
import { nextEpoch, portAdapter } from "../../../packages/core/src/state-sync.js";
import { composeCore } from "./core-composition.js";
import { markCleanAfter, withDeadline } from "./core-host.js";

// Tests with fake Electron: the composition in this process, joined by synchronous in-process ports, fakes injected.
export class InProcessCoreHost extends EventEmitter {
  constructor({ client, config, overrides = {}, timers = globalThis, onError = () => {} }) {
    super();
    Object.assign(this, { client, config, overrides, timers, onError });
    this.mode = "in-process";
    this.core = null;
    this.endpoint = null;
  }

  get pid() { return process.pid; }

  async start() {
    const [corePort, mainPort] = createInProcessPorts();
    const coreEndpoint = new ServiceEndpoint({ port: corePort, name: "core", onError: this.onError });
    this.endpoint = new ServiceEndpoint({ port: mainPort, name: "main", onError: this.onError });
    coreEndpoint.handle("boot", async (config) => {
      this.core = await composeCore({ endpoint: coreEndpoint, config, overrides: this.overrides, timers: this.timers });
      return this.core.readiness;
    });
    coreEndpoint.markReady({ booted: false });
    this.client.attach(this.endpoint, { peek: () => this.core?.controller.snapshot() ?? null });
    const info = await this.endpoint.request("boot", { ...this.config, epoch: nextEpoch() });
    this.client.setReady(info);
    this.emit("started", info);
    return info;
  }

  // Live reads in-process, as before the split.
  peekSettings() { return this.core?.settings.load() ?? null; }

  // A window's own state port (step 5). In-process the channel is a worker_threads MessageChannel: the same
  // asynchronous, structured-clone MessagePort a renderer gets, both ends in this process.
  async openViewPort(kind, options) {
    if (!this.core) throw new Error("The core is not running.");
    const { port1, port2 } = new MessageChannel();
    port1.unref?.();
    port2.unref?.();
    this.core.attachPort({ type: "port", kind, options }, portAdapter(port1));
    return port2;
  }

  // finalize(result): main's verdict on the whole quit (see markCleanAfter); true removes the run marker.
  async stop({ deadlineMs = 5000, finalize = null } = {}) {
    let result = null;
    if (this.core) {
      result = await withDeadline(this.client.request("shutdown"), deadlineMs).catch(() => null);
    }
    result = await markCleanAfter(this.client, result, finalize, this.core !== null);
    this.client.markStopped();   // the core's log is closed: main keeps later lines itself
    this.endpoint?.close("runtime stopped");
    await this.core?.dispose?.();
    return result;
  }

  flushSync() { this.core?.flushSync(); }
}
