// The CCF core process (process-split plan, step 3): started by main as an Electron utility process (or, where
// Electron is not available, as a Node child forked with structured-clone serialization). Main sends "boot" with the
// paths and settings defaults; the reply reports the hook server's port once it answered an authenticated probe.
// The process ends when main closes the channel (after "shutdown"), or when a forked child loses its parent.
import { ServiceEndpoint } from "../../../packages/core/src/service-rpc.js";
import { childSidePort } from "../../../packages/core/src/process-ports.js";
import { composeCore } from "./core-composition.js";

let core = null;
let exiting = false;

// The storage worker still runs: the newest state gets a moment to be committed (never long: main may be waiting).
async function exit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await Promise.race([core?.flushAsync?.(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  } catch { /* exiting anyway */ }
  setImmediate(() => process.exit(code));
}

function report(message, error) {
  const details = { error: String(error?.stack ?? error?.message ?? error) };
  try {
    if (core) core.logger.error("core-process", message, details);
    else console.error(`[ccf core] ${message}`, details.error);
  } catch { /* reporting must not throw */ }
}

// A window's own state port (process-split plan, step 5), handed over by main once the core is ready.
const onPort = (info, port) => {
  if (!core) { port.close(); return; }
  try { core.attachPort(info, port); } catch (error) { report("A view port could not be attached", error); port.close(); }
};

const endpoint = new ServiceEndpoint({
  port: childSidePort(process, { onSendError: (error) => report("Message to main failed", error), onPort }),
  name: "core",
  onError: (error, context) => report(`Service listener failed (${context?.topic ?? context?.method ?? "?"})`, error),
  onClose: () => exit(0)
});

endpoint.handle("boot", async (config) => {
  if (core) throw new Error("The core has booted already.");
  // Without its storage worker the core cannot persist anything: it exits and main restarts it.
  core = await composeCore({ endpoint, config, onStorageFailed: (error) => { report("The storage worker failed", error); exit(1); } });
  return core.readiness;
});

process.on("uncaughtException", (error) => { report("uncaughtException", error); exit(1); });
process.on("unhandledRejection", (error) => { report("unhandledRejection", error); exit(1); });
// A forked child whose parent died: nobody will close the channel any more.
if (!process.parentPort && typeof process.send === "function") process.on("disconnect", () => exit(0));

endpoint.markReady({ booted: false, pid: process.pid });
