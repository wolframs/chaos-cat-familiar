// A process that owns a CCF database the way the core's storage worker does (process-split plan, step 6), for tests
// that kill it: requests over Node IPC ({id, method, params} -> {id, ok, result | error}).
//   open(config), state.commit({changes}), delivery.load(), delivery.commit({changes}), status()
//   loop({count, prefix}): commits one session row per transaction and reports each commit as it is acknowledged ({acked: n}).
//   delayCommits({ms}): each later commit waits ms before it starts (so a test can kill the process mid-request).
import { createStorage } from "../../src/storage-worker.js";

const storage = createStorage();
let delayMs = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(method, params) {
  switch (method) {
    case "open": return storage.open(params);
    case "state.commit": if (delayMs) await sleep(delayMs); return storage.commitState(params.changes);
    case "delivery.load": return storage.loadDelivery();
    case "delivery.commit": if (delayMs) await sleep(delayMs); return storage.commitDelivery(params.changes);
    case "delayCommits": delayMs = params.ms; return true;
    case "status": return storage.status();
    case "loop": {
      // Sessions: a table without count retention, so every committed row stays.
      const prefix = params.prefix ?? "loop";
      for (let n = 1; n <= params.count; n++) {
        const json = JSON.stringify({ id: `${prefix}-${n}`, payload: "x".repeat(2000) });
        storage.commitState({ sessions: { upsert: [{ id: `${prefix}-${n}`, pos: n, json }] } });
        process.send({ acked: n });
        if (n % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      return params.count;
    }
    default: throw new Error(`Unknown method ${method}.`);
  }
}

process.on("message", async ({ id, method, params } = {}) => {
  try { process.send({ id, ok: true, result: await handle(method, params) }); }
  catch (error) { process.send({ id, ok: false, error: { message: String(error?.message ?? error), code: error?.code ?? null } }); }
});
process.on("disconnect", () => process.exit(0));
process.send({ ready: true, pid: process.pid });
