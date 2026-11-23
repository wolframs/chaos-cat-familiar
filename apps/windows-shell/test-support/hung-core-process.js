// A core that boots like the real one (same composition, real hook server) and then stops answering: hook-file work,
// settings writes, stopIntake, shutdown and status never settle. Stands in for a core stuck on a held file or in a
// busy loop, to prove that main's quit still reaches its kill deadline. Test use only.
import { ServiceEndpoint } from "../../../packages/core/src/service-rpc.js";
import { childSidePort } from "../../../packages/core/src/process-ports.js";
import { composeCore } from "../core/core-composition.js";

const never = () => new Promise(() => {});
const endpoint = new ServiceEndpoint({ port: childSidePort(process), name: "core",
  onClose: () => setImmediate(() => process.exit(0)) });
endpoint.handle("boot", async (config) => {
  const core = await composeCore({ endpoint, config });
  for (const method of ["hooks", "settings.update", "stopIntake", "shutdown", "status"]) endpoint.handle(method, never);
  return core.readiness;
});
if (typeof process.send === "function") process.on("disconnect", () => process.exit(0));
endpoint.markReady({ booted: false, pid: process.pid });
