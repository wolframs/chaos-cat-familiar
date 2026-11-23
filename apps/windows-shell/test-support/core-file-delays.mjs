// Preloaded into the forked core and companion processes by the load fixture (node --import): the same synchronous file
// delays and rename locks the fixture puts on main, inside the core (settings, state checkpoints and the log since
// step 3) and the companion (delivery state, attachments since step 4). The counters go to a file per process kind
// (statsPath with -core-process / -companion-process before .json) when the process exits.
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { injectFileDelays } from "./file-delays.js";

const options = JSON.parse(process.env.CCF_TEST_FILE_DELAYS ?? "null");
// Main threads only: the core's storage worker injects its own delays (asynchronous ones, and a blocking one per SQLite
// commit) and counts them in a file of its own (-storage-worker.json).
if (options?.root && isMainThread) {
  const { stats } = injectFileDelays(options);
  const kind = path.basename(process.argv[1] ?? "process", ".js");
  const statsPath = options.statsPath.replace(/\.json$/, `-${kind}.json`);
  process.on("exit", () => {
    try { fs.writeFileSync(statsPath, JSON.stringify(stats)); } catch { /* the fixture reports missing stats */ }
  });
}
