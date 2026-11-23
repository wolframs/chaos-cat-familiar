// A forked child for process-port tests: answers echo/date/crash, pushes an event, exits when the parent closes.
import { ServiceEndpoint } from "../../src/service-rpc.js";
import { childSidePort } from "../../src/process-ports.js";

// A port handed over by the parent (a socket in this stand-in) echoes what it gets, with the info it came with.
const onPort = (info, port) => port.onMessage((message) => port.postMessage({ echo: message, info }));
const endpoint = new ServiceEndpoint({ port: childSidePort(process, { onPort }), name: "child", onClose: () => setImmediate(() => process.exit(0)) });
endpoint
  .handle("echo", (params) => params)
  .handle("date", () => new Date(Date.UTC(2026, 10, 5)))
  .handle("push", ({ topic, payload }) => { endpoint.emit(topic, payload); return true; })
  .handle("pid", () => process.pid)
  .handle("crash", () => { setImmediate(() => process.exit(3)); return true; });
endpoint.markReady({ pid: process.pid });
