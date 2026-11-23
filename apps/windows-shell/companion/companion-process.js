// The CCF companion process (process-split plan, step 4): started by main as an Electron utility process when the
// companion is first needed (or, where Electron is not available, as a Node child forked with structured-clone
// serialization). Main sends "boot" with paths and settings; the reply carries the first snapshot. The process ends
// when main closes the channel (after "dispose"), or when a forked child loses its parent. On Windows it first joins a
// kill-on-close job, so its children end with it, crash included (process-tree.js).
import { ServiceEndpoint } from "../../../packages/core/src/service-rpc.js";
import { childSidePort } from "../../../packages/core/src/process-ports.js";
import { composeCompanion } from "./companion-composition.js";

let companion = null;
let exiting = false;

function exit(code) {
  if (exiting) return;
  exiting = true;
  setImmediate(() => process.exit(code));
}

function report(message, error) {
  const details = { error: String(error?.stack ?? error?.message ?? error) };
  try {
    if (companion) companion.logger.error("companion-process", message, details);
    else console.error(`[ccf companion] ${message}`, details.error);
  } catch { /* reporting must not throw */ }
}

// The conversation window's frames port (process-split plan, step 5), handed over by main once the companion runs.
const onPort = (info, port) => {
  if (!companion) { port.close(); return; }
  try { companion.attachPort(info, port); } catch (error) { report("A view port could not be attached", error); port.close(); }
};

const endpoint = new ServiceEndpoint({
  port: childSidePort(process, { onSendError: (error) => report("Message to main failed", error), onPort }),
  name: "companion",
  onError: (error, context) => report(`Service listener failed (${context?.topic ?? context?.method ?? "?"})`, error),
  onClose: () => exit(0)
});

endpoint.handle("boot", async (config) => {
  if (companion) throw new Error("The companion has booted already.");
  companion = await composeCompanion({ endpoint, config });
  return companion.readiness;
});

process.on("uncaughtException", (error) => { report("uncaughtException", error); exit(1); });
process.on("unhandledRejection", (error) => { report("unhandledRejection", error); exit(1); });
// A forked child whose parent died: nobody will close the channel any more.
if (!process.parentPort && typeof process.send === "function") process.on("disconnect", () => exit(0));

endpoint.markReady({ booted: false, pid: process.pid });
