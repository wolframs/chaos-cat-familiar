// The companion backend in a real second process (process-split plan, step 4). Electron's utilityProcess is not
// available under node:test, so the stand-in is a Node child forked with structured-clone serialization running the
// same entrypoint (companion/companion-process.js) and composition, with real node-pty and real ConPTY. Every child is
// a harmless PowerShell fixture (test-support/companion-fixture), never Claude or Codex. What this proves: node-pty
// loads outside main; terminal frames, raw input and resize cross the boundary; a crash ends the companion's whole
// child tree (PTY and stdio children with their own grandchildren) and nothing restarts until asked; a graceful stop
// ends them too. What it does not: Electron's own utility-process launch (smoke test).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FrameMirror } from "../../../packages/core/src/state-mirror.js";
import { portAdapter } from "../../../packages/core/src/state-sync.js";
import { CompanionClient } from "../services/companion-client.js";
import { CompanionProcessHost } from "../companion/companion-host.js";
import { joinKillOnCloseJob } from "../companion/process-tree.js";
import { nodeUtilityProcess } from "../test-support/fake-electron.js";
import { createCompanionFixture, isAlive, waitUntil } from "../test-support/companion-fixture.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 90000 };

async function startCompanion(t, { load = null, testJobShells = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-companion-process-"));
  const fixture = createCompanionFixture(root, { load });
  const utility = nodeUtilityProcess();
  const client = new CompanionClient();
  const logs = [];
  const patches = [];
  const config = { paths: { home: root, root: path.join(root, "chaos-cat-familiar") },
    settings: { companionBackend: "claude", companionRepoPath: fixture.dir }, testMode: true, killOnCloseJob: true,
    testFixtures: true, ...(testJobShells ? { testJobShells } : {}) };
  const host = new CompanionProcessHost({ client, getConfig: () => config, exitDeadlineMs: 3000,
    logger: { log: (...args) => logs.push(args) }, onSettingsPatch: (patch) => { patches.push(patch); return true; },
    fork: (modulePath, args, options) => utility.fork(modulePath, args, options) });
  t.after(async () => {
    await host.stop({ deadlineMs: 3000 }).catch(() => {});
    for (const child of utility.children) child.kill();
    const pids = [...fixture.ptyPids(), ...fixture.stdioPids()];
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    // A dying process can hold its working folder for a moment.
    await waitUntil(() => pids.every((pid) => !isAlive(pid)), "the fixtures gone", 10000).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp folder */ }
  });
  return { root, fixture, host, client, logs, patches, utility };
}

// The terminal's frames as the conversation window takes them: on a port of their own (main keeps a slim snapshot
// without the screen; process-split plan, step 7).
async function framesOf(t, host) {
  const port = portAdapter(await host.openViewPort("frames", { id: `test-frames-${Date.now()}`, window: 2 }));
  const view = { latest: null, times: [] };
  const mirror = new FrameMirror({ post: (message) => { try { port.postMessage(message); } catch { /* closed */ } },
    onFrame: (frame, info) => { view.latest = frame; view.times.push(Date.now()); mirror.ack(info.revision); } });
  port.onMessage((message) => mirror.receive(message));
  t.after(() => port.close());
  return view;
}

const screenText = (snapshot) => [...(snapshot?.terminal?.history ?? []), ...(snapshot?.terminal?.lines ?? [])]
  .map((line) => line.map((run) => run.text).join("")).join("\n");

test("the kill-on-close job helper refuses gracefully off Windows and reports a joined job on Windows", async () => {
  assert.deepEqual(await joinKillOnCloseJob({ platform: "linux" }), { joined: false, reason: "not Windows" });
  const missing = await joinKillOnCloseJob({ platform: "win32", shells: ["ccf-no-such-shell.exe"] });
  assert.equal(missing.joined, false);
  assert.match(missing.reason, /ENOENT/);
});

test("node-pty loads in the companion process: the PowerShell fixture runs in its PTY, frames, input and resize cross", windowsOnly, async (t) => {
  const { host, client, fixture } = await startCompanion(t);
  assert.equal(client.status, "idle", "nothing starts before it is needed");
  const info = await host.ensure();
  assert.notEqual(info.pid, process.pid, "a second process");
  assert.equal(client.status, "ready");
  assert.equal(client.snapshot().connected, false, "the process alone starts no PTY");
  await client.start({ userInitiated: true, cwd: fixture.dir });
  await waitUntil(() => host.job, "the job report");
  assert.equal(host.job.joined, true, `the companion joined its kill-on-close job: ${JSON.stringify(host.job)}`);
  assert.equal(client.snapshot().connected, true);
  assert.equal(client.activeClaudePath()?.toLowerCase(), path.win32.resolve(fixture.dir).toLowerCase(),
    "the connected Claude folder is pushed with the snapshot");
  const view = await framesOf(t, host);
  await waitUntil(() => screenText(view.latest).includes("CCF fixture ready"), "the fixture's first output");
  assert.equal(client.snapshot().terminal?.lines, undefined, "main's own snapshot carries no screen");
  // Raw input in order, every request answered after its PTY write.
  for (const text of ["al", "pha", "\r", "beta\r"]) assert.equal(await client.write(text), true);
  await waitUntil(() => /echo: alpha[\s\S]*echo: beta/.test(screenText(view.latest)), "the echoed input, in order");
  assert.equal(await client.resize(90, 30), true);
  await client.write("size\r");
  await waitUntil(() => screenText(view.latest).includes("size: 90x30"), "the PTY's new size");
  const frames = view.times;
  const gaps = frames.slice(1).map((at, index) => at - frames[index]);
  assert.ok(gaps.every((gap) => gap >= 15), `frames stay coalesced (~33 ms): ${gaps.join(",")}`);
  assert.ok([...host.children.values()].some((child) => child.kind === "claude"), "the PTY child is reported to main");
});

test("a companion crash ends its whole child tree, and nothing restarts until asked", windowsOnly, async (t) => {
  const { host, client, fixture } = await startCompanion(t);
  await host.ensure();
  await client.start({ userInitiated: true, cwd: fixture.dir });
  for (const kind of ["codex", "watcher"]) {
    await client.request("fixture.spawnStdio", { kind, executable: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-File", fixture.stdioScript], cwd: fixture.dir });
  }
  const tree = await waitUntil(() => {
    const pids = [...fixture.ptyPids(), ...fixture.stdioPids()];
    return pids.length === 6 && pids;
  }, "the PTY fixture, two stdio fixtures and their hidden grandchildren", 30000);
  assert.ok(tree.every(isAlive));
  assert.deepEqual([...host.children.values()].map((child) => child.kind).sort(), ["claude", "codex", "watcher"]);
  const crashed = new Promise((resolve) => host.once("crashed", resolve));
  process.kill(host.pid);   // TerminateProcess: no dispose, no cleanup code runs in the companion
  await crashed;
  await waitUntil(() => tree.every((pid) => !isAlive(pid)), "the whole tree gone", 10000);

  assert.equal(client.status, "crashed");
  const offline = client.snapshot();
  assert.equal(offline.connected, false);
  assert.equal(offline.process, "crashed");
  assert.match(offline.error, /Start it again/);
  await assert.rejects(client.write("x"), (error) => error.code === "companion_crashed", "input is refused, never queued for replay");
  await assert.rejects(host.ensure(), (error) => error.code === "companion_crashed", "no restart without an explicit action");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(host.pid, null, "and none on its own");

  const again = await host.ensure({ restart: true });
  assert.equal(client.status, "ready");
  assert.equal(client.snapshot().connected, false, "the restarted companion starts no PTY by itself");
  assert.notEqual(again.pid, tree[0]);
  await client.start({ userInitiated: true, cwd: fixture.dir });
  const view = await framesOf(t, host);
  await waitUntil(() => screenText(view.latest).includes("CCF fixture ready"), "the fixture after an explicit restart");
});

// Review of step 4 (2026-11-05, P2): without the job, main's fallback ends only the roots it was told about, so a
// grandchild whose root had exited, or a child started just before a crash, would outlive the companion.
test("a companion that could not join its kill-on-close job starts no child and says so", windowsOnly, async (t) => {
  const { host, client, fixture, logs } = await startCompanion(t, { testJobShells: ["ccf-no-such-shell.exe"] });
  await host.ensure();
  await assert.rejects(client.start({ userInitiated: true, cwd: fixture.dir }), /could not bind its children[\s\S]*nothing was started/);
  await assert.rejects(client.request("fixture.spawnStdio", { kind: "watcher", executable: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-File", fixture.stdioScript], cwd: fixture.dir }), /could not bind its children/);
  await waitUntil(() => host.job, "the job report");
  assert.equal(host.job.joined, false);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual([...fixture.ptyPids(), ...fixture.stdioPids()], [], "no fixture process ever started");
  assert.deepEqual([...host.children.values()], []);
  assert.equal(client.status, "ready", "the companion process itself stays up and answers");
  assert.ok(logs.some(([level, category, message]) => level === "error" && category === "companion"
    && /cannot be bound/.test(message)), "the reason is logged as an error");
});

test("a graceful stop ends the fixture's tree and the companion process", windowsOnly, async (t) => {
  const { host, client, fixture, utility } = await startCompanion(t);
  await host.ensure();
  await client.start({ userInitiated: true, cwd: fixture.dir });
  const tree = await waitUntil(() => fixture.ptyPids().length === 2 && fixture.ptyPids(), "the PTY fixture and its grandchild", 30000);
  const [child] = utility.children;
  await host.stop({ deadlineMs: 5000 });
  assert.equal(client.status, "stopped");
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, "the companion process gone", 5000);
  await waitUntil(() => tree.every((pid) => !isAlive(pid)), "the fixture's tree gone", 10000);
});

// Review of step 5 (P2): supervision must not rely on the platform's exit event alone. A child that answers its boot and
// then vanishes without an exit event is a crash within the liveness interval.
test("a companion process that is gone without an exit event counts as crashed", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { ServiceEndpoint } = await import("../../../packages/core/src/index.js");
  let alive = true;
  const child = new EventEmitter();
  Object.assign(child, { pid: 4242, connected: true, kill() {} });
  const toChild = new EventEmitter();
  child.send = (message, callback) => { setImmediate(() => toChild.emit("message", message)); callback?.(null); return true; };
  const companionSide = new ServiceEndpoint({ name: "companion", port: {
    postMessage: (message) => setImmediate(() => child.emit("message", message)),
    onMessage: (listener) => toChild.on("message", listener) } });
  companionSide.handle("boot", () => ({ snapshot: null, delivery: false, pid: 4242 }));
  companionSide.markReady({ booted: false });
  const client = new CompanionClient();
  const host = new CompanionProcessHost({ client, getConfig: () => ({}), fork: () => child, livenessMs: 20,
    isAlive: () => alive });
  t.after(() => host.stop({ deadlineMs: 100 }).catch(() => {}));
  await host.ensure();
  assert.equal(client.status, "ready");
  alive = false;
  await waitUntil(() => client.status === "crashed", "the crash", 2000);
  assert.equal(host.lastExit.code, null);
});
