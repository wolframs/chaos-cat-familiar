import test from "node:test";
import { clientTarget, directTarget, loadReplayFixtures, processTarget, runReplay } from "./support/replay.js";

// Behaviour replay fixtures (process-split plan, step 1). Each scenario in fixtures/replay runs against every
// target: today's direct controller + HookServer, and every boundary that must behave the same.
const TARGETS = {
  direct: directTarget,
  client: () => clientTarget(),
  "client, projections only": () => clientTarget({ projectionOnly: true }),
  "core in a child process": () => processTarget()
};

for (const fixture of loadReplayFixtures()) {
  for (const [targetName, createTarget] of Object.entries(TARGETS)) {
    test(`replay ${fixture.file} [${targetName}]: ${fixture.name}`, { timeout: 15000 }, async () => {
      await runReplay(fixture, createTarget());
    });
  }
}
