import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectFileDelays, runLoadFixture } from "../test-support/load-fixture.js";

test("injected file delays block synchronous calls under the data folder and lock each rename once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-load-delays-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-load-outside-"));
  const files = injectFileDelays({ root, delayMs: 15 });
  try {
    const started = performance.now();
    fs.writeFileSync(path.join(root, "a.json"), "{}");
    assert.ok(performance.now() - started >= 14, "a write under the root is held");
    fs.writeFileSync(path.join(outside, "b.json"), "{}");
    assert.equal(files.stats.delayedCalls, 1, "other folders are untouched");
    assert.throws(() => fs.renameSync(path.join(root, "a.json"), path.join(root, "c.json")), { code: "EPERM" });
    fs.renameSync(path.join(root, "a.json"), path.join(root, "c.json"));
    assert.throws(() => fs.renameSync(path.join(root, "c.json"), path.join(root, "d.json")), { code: "EPERM" });
    fs.renameSync(path.join(root, "c.json"), path.join(root, "d.json"));
    assert.equal(files.stats.renameLocks, 2);
  } finally {
    files.restore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(fs.writeFileSync.name, "writeFileSync", "restore puts the real functions back");
});

// The compressed default run: the whole load in a few seconds. No thresholds on delay (timing in npm test runs next to
// other test processes); it pins correctness under load: no lost events, every approval answered as decided. Since
// step 3 the core runs in a forked child with the file delays inside it, and main makes no synchronous file call
// under CCF's data folder while hooks arrive. Since step 4 the companion does too (on Windows: real node-pty with the
// PowerShell fixture), and quit leaves none of its processes behind. Since step 5 the dashboard, diagnostics and
// conversation stand-ins run on threads of their own with their own ports, and the diagnostics one really stops.
test("load fixture: 91 sessions, 200 heavy events with bursts, file delays, companion output, stalled renderer", { timeout: 90000 }, async () => {
  const result = await runLoadFixture({ speedup: 300, stallMs: 1500 });
  assert.deepEqual(result.lost, [], "every event reaches the dashboard's own port");
  assert.equal(result.visible, result.posted);
  assert.equal(result.approvals.requested, 8);
  assert.equal(result.approvals.decidedInApp, 8);
  assert.equal(result.approvals.allowed, 8, "each held permission request gets the decision made in the app");
  assert.ok(result.sessions >= 91);
  assert.ok(result.companion.scrollbackRows >= 900, `scrollback fills up (${result.companion.scrollbackRows} rows)`);
  assert.ok(result.companion.frames > 0, "terminal frames reach the conversation window's own port");
  assert.equal(result.companion.relayedTerminalRows, 0, "main relays no terminal screen");
  if (result.options.companionMode === "process") {
    assert.equal(result.companion.process.mode, "utility");
    assert.equal(result.companion.leftAfterQuit, 0, "quit ends the companion's fixture tree");
  }
  // Step 6: the core's file work (state commits, settings, log) is its storage worker's, delays and locks included; the
  // core's own thread renames nothing (its few calls left read hook files when hooks are installed).
  assert.ok(result.files.storage.delayedCalls > 0 && result.files.storage.renameLocks > 0 && result.files.storage.commits > 0,
    JSON.stringify(result.files));
  assert.equal(result.files.core.renameLocks, 0, `no rename on the core's thread: ${JSON.stringify(result.files.core)}`);
  assert.equal(result.files.main.delayedCalls, 0, `main stays off the data folder: ${JSON.stringify(result.files.main)}`);
  const stalled = result.stalledRenderer;
  assert.ok(stalled.stallMs >= 1400, `the diagnostics stand-in really stopped: ${JSON.stringify(stalled)}`);
  assert.ok(stalled.framesDuringStall !== null && stalled.framesDuringStall <= stalled.creditWindow,
    `no backlog for a stopped renderer: ${JSON.stringify(stalled)}`);
  assert.ok(stalled.coalesced > 0, "changes coalesced while it stood still");
  assert.equal(stalled.caughtUp, true, "and one catch-up frame brought it to the current state");
  assert.equal(stalled.sentByMain, 0, "main sent it nothing");
  assert.ok(result.eventLoop.count > 0 && Number.isFinite(result.eventLoop.maxMs));
  assert.ok(result.hookToVisible.count === result.posted);
});
