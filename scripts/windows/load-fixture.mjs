#!/usr/bin/env node
// The load fixture in real time (process-split plan, step 1): `npm run load:windows-shell` runs 200 heavy hook
// events at 60/min with 10x bursts (~3 minutes) against the runtime with fake Electron and temp data, and writes the
// result as JSON. `npm test` runs the same fixture compressed. Options: --speedup N, --events N, --sessions N,
// --file-delay-ms N, --core process|in-process (default process: the core in a forked child, as since step 3),
// --companion process|in-process (default process on Windows: the companion in a forked child with real node-pty and the
// PowerShell fixture, as since step 4), --stall-ms N (how long the diagnostics stand-in stops, default 3000),
// --out file.json (default: a file in the temp folder). Never touches the real profile and never starts Claude or Codex.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLoadFixture } from "../../apps/windows-shell/test-support/load-fixture.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const number = (name, fallback) => {
  const value = Number(option(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number`);
  return value;
};

const result = await runLoadFixture({
  speedup: number("speedup", 1),
  events: number("events", 200),
  sessions: number("sessions", 91),
  fileDelayMs: number("file-delay-ms", 25),
  coreMode: option("core", "process"),
  stallMs: number("stall-ms", 3000),
  ...(option("companion", null) ? { companionMode: option("companion", null) } : {}),
  onProgress: (done, total) => { if (done % 20 === 0 || done === total) process.stderr.write(`load: ${done}/${total} events\n`); }
});
// The runtime logger mirrors to the console, so the result goes to a file.
const out = option("out", path.join(os.tmpdir(), `ccf-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stderr.write(`\nload: ${result.posted} events in ${result.durationMs} ms, lost ${result.lost.length}; main event-loop p99 `
  + `${result.eventLoop.p99Ms.toFixed(1)} ms, max ${result.eventLoop.maxMs.toFixed(1)} ms; hook-to-visible p99 `
  + `${result.hookToVisible.p99Ms} ms; approvals ${result.approvals.allowed}/${result.approvals.requested}; delayed file calls `
  + `main ${result.files.main.delayedCalls}, core ${result.files.core?.delayedCalls ?? "n/a"}, storage worker `
  + `${result.files.storage?.delayedCalls ?? "n/a"} (${result.files.storage?.commits ?? "n/a"} commits), companion `
  + `${result.files.companion?.delayedCalls ?? "n/a"} (core: ${result.options.coreMode}, companion: ${result.options.companionMode}); `
  + `companion frames on the port ${result.companion.frames} (${result.companion.framesPerSecond}/s), relayed by main `
  + `${result.companion.relayedByMain}, scrollback ${result.companion.scrollbackRows} rows; stalled renderer `
  + `${result.stalledRenderer?.stallMs ?? "n/a"} ms: ${result.stalledRenderer?.framesDuringStall ?? "n/a"} frames meanwhile, `
  + `${result.stalledRenderer?.coalesced ?? "n/a"} coalesced, caught up ${result.stalledRenderer?.caughtUp ?? "n/a"}`
  + `\nresult: ${out}\n`);
