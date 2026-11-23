// The companion's side of delivery in a process of its own (process-split plan, step 6), for tests that kill it: a
// CompanionDeliveryStore whose repository asks the parent over Node IPC ({id, method, params}), the way the companion
// asks main, which asks the core. Commands from the parent: {command: "open"}, {command: "submit", input}; the
// transmission reports {event: "transmitting"} and then never answers (the process is killed meanwhile).
import { CompanionDeliveryStore } from "../../src/companion-delivery.js";

const pending = new Map();
let sequence = 0;
const request = (method, params = null) => new Promise((resolve, reject) => {
  const id = `child-${++sequence}`;
  pending.set(id, { resolve, reject });
  process.send({ id, method, params });
});
const store = new CompanionDeliveryStore({ repository: {
  load: () => request("delivery.load"),
  commit: (changes) => request("delivery.commit", { changes })
} });
let transmissions = 0;

process.on("message", async (message) => {
  if (message?.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) resolve(message.result);
    else reject(Object.assign(new Error(message.error?.message ?? "failed"), { code: message.error?.code ?? null }));
    return;
  }
  if (message?.command === "open") {
    try { await store.open(); process.send({ event: "opened", snapshot: store.snapshot() }); }
    catch (error) { process.send({ event: "opened", error: error.message, blocked: store.status().blocked }); }
  } else if (message?.command === "submit") {
    store.submit(message.input, async () => {
      transmissions += 1;
      process.send({ event: "transmitting", transmissions });
      return new Promise(() => {});
    }).then((result) => process.send({ event: "submitted", result }), (error) => process.send({ event: "submitFailed", error: error.message }));
  }
});
process.on("disconnect", () => process.exit(0));
process.send({ ready: true, pid: process.pid });
