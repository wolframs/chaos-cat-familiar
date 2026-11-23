// The replay core in a forked child (the utility-process stand-in): controller, HookServer and effects behind the
// same endpoint as in-process, but every message crosses a process boundary as a structured clone.
import { CcfCoreController, EffectOutbox, ServiceEndpoint, childSidePort, serveCore } from "../../src/index.js";

const endpoint = new ServiceEndpoint({ port: childSidePort(), name: "core",
  onClose: () => setImmediate(() => process.exit(0)) });
const effects = new EffectOutbox();
const controller = new CcfCoreController({ overlay: effects.overlay, notifier: effects.notifier,
  settings: { load: () => ({}) } });
const service = serveCore({ endpoint, controller, effects });
process.on("disconnect", () => process.exit(0));
endpoint.markReady({ state: service.projection(), revision: 0 });
