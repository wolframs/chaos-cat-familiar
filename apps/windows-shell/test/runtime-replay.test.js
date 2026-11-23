import test from "node:test";
import { loadRuntimeReplayFixtures, runRuntimeReplay } from "../test-support/runtime-replay.js";

// Runtime behaviour replay (process-split plan, step 1): companion identity and lifecycle, notification IPC.
for (const fixture of loadRuntimeReplayFixtures()) {
  test(`runtime replay ${fixture.file}: ${fixture.name}`, { timeout: 20000 }, async () => {
    await runRuntimeReplay(fixture);
  });
  // Step 3: the same fixtures with the core in a child process (the utility-process stand-in).
  test(`runtime replay ${fixture.file} [core in a child process]: ${fixture.name}`, { timeout: 30000 }, async () => {
    await runRuntimeReplay(fixture, { coreProcess: true });
  });
}
