// The whole runtime with its companion in a real child process (process-split plan, step 4): fake Electron windows,
// the Node stand-in for Electron's utilityProcess, the production companion entrypoint and composition with real
// node-pty, and the PowerShell fixture in place of Claude (CCF_TEST_COMPANION_FIXTURE; test mode starts nothing else).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, FakeTray, nodeUtilityProcess } from "../test-support/fake-electron.js";
import { fakeView } from "../test-support/fake-view.js";
import { createCompanionFixture, isAlive, waitUntil } from "../test-support/companion-fixture.js";

async function fixture(t, { withFixture = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-companion-"));
  const companionFixture = createCompanionFixture(root);
  const electron = createFakeElectron({ home: root, appData: root });
  electron.utilityProcess = nodeUtilityProcess();
  let tray = null;
  electron.Tray = class extends FakeTray { constructor(icon) { super(icon); tray = this; } };
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot", ...(withFixture ? { CCF_TEST_COMPANION_FIXTURE: companionFixture.dir } : {}) },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      coreInProcess: true,
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, registeredEvents: [] }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} },
      coreLogToConsole: false
    }
  });
  t.after(async () => {
    await Promise.race([runtime.stop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10000))]);
    for (const child of electron.utilityProcess.children) child.kill();
    const pids = companionFixture.ptyPids();
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    // A dying process can hold its working folder for a moment.
    await waitUntil(() => pids.every((pid) => !isAlive(pid)), "the fixtures gone", 10000).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp folder */ }
  });
  await runtime.start();
  // The tray's "show companion": the cat's cluster with its conversation window.
  const showCompanion = async () => {
    const item = tray.menu.template.flatMap((entry) => [entry, ...(entry.submenu ?? [])]).find((entry) => entry.id === "show-companion");
    await item.click();
    return [...FakeBrowserWindow.windowsByWebContents.values()].find((window) => !window.destroyed
      && String(window.loadedFile ?? "").endsWith("companion-conversation.html"));
  };
  return { root, electron, runtime, companionFixture, showCompanion };
}

const companionState = (runtime) => runtime.snapshot().runtime.companion;
const action = (electron, payload) => electron.ipcMain.invoke("ccf:companion-action", payload);

test("the companion process starts when first needed, crashes alone, comes back only on Start, and quit ends its tree",
  { skip: process.platform !== "win32", timeout: 120000 }, async (t) => {
    const { electron, runtime, companionFixture } = await fixture(t);
    assert.deepEqual(companionState(runtime), { mode: "utility", pid: null, status: "idle" }, "not started with CCF");
    assert.equal(electron.utilityProcess.children.size, 0);

    // The conversation window's first read starts the process, never the fixture.
    const first = await electron.ipcMain.invoke("ccf:get-companion");
    assert.equal(first.connected, false);
    assert.equal(companionState(runtime).status, "ready");
    const [firstChild] = electron.utilityProcess.children;
    assert.equal(companionFixture.ptyPids().length, 0, "the process alone starts nothing");

    assert.deepEqual(await action(electron, { action: "start" }), { ok: true });
    const tree = await waitUntil(() => companionFixture.ptyPids().length === 2 && companionFixture.ptyPids(),
      "the PowerShell fixture and its grandchild", 30000);
    assert.equal((await electron.ipcMain.invoke("ccf:get-companion")).connected, true);
    assert.deepEqual(await action(electron, { action: "raw-input", text: "hi\r" }), { ok: true });

    // A crash: the core and the windows stay, the fixture's tree ends, nothing restarts on its own.
    const corePid = runtime.snapshot().runtime.core.pid;
    process.kill(companionState(runtime).pid);
    await waitUntil(() => companionState(runtime).status === "crashed", "the crash noticed");
    await waitUntil(() => tree.every((pid) => !isAlive(pid)), "the fixture's tree gone", 10000);
    assert.equal(runtime.snapshot().runtime.core.pid, corePid);
    const offline = await electron.ipcMain.invoke("ccf:get-companion");
    assert.equal(offline.connected, false);
    assert.equal(offline.process, "crashed");
    await assert.rejects(action(electron, { action: "raw-input", text: "lost?\r" }), /Press Start/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(companionState(runtime).pid, null, "no automatic restart");
    assert.ok(firstChild.exitCode !== null || firstChild.signalCode !== null);

    // Start is the explicit restart.
    assert.deepEqual(await action(electron, { action: "start" }), { ok: true });
    const second = await waitUntil(() => {
      const pids = companionFixture.ptyPids().filter((pid) => !tree.includes(pid));
      return pids.length === 2 && pids;
    }, "the fixture after the restart", 30000);
    assert.equal(companionState(runtime).status, "ready");

    // Quit ends the companion and the fixture's tree.
    const children = [...electron.utilityProcess.children];
    await runtime.stop();
    await waitUntil(() => second.every((pid) => !isAlive(pid)), "the fixture's tree gone after quit", 10000);
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null), "the companion process exited");
  });

test("test mode without the fixture still refuses Start, and starts no process for it",
  { timeout: 60000 }, async (t) => {
    const { electron, runtime } = await fixture(t, { withFixture: false });
    await assert.rejects(action(electron, { action: "start" }), /disabled in test mode/);
    assert.equal(companionState(runtime).pid, null);
    assert.equal(electron.utilityProcess.children.size, 0);
  });

// Process-split plan, step 5: the terminal's frames go from the companion process to the conversation window on a port
// of their own; main keeps a slim snapshot and still sends the offline view after a crash.
test("terminal frames reach the conversation window on its own port; main keeps a slim snapshot; a crash and Start reconnect",
  { skip: process.platform !== "win32", timeout: 120000 }, async (t) => {
    const { electron, runtime, companionFixture, showCompanion } = await fixture(t);
    const conversation = await showCompanion();
    assert.ok(conversation, "the conversation window");
    await electron.ipcMain.invoke("ccf:get-companion");
    const view = await fakeView(electron, conversation, { service: "companion" });
    t.after(() => view.close());
    await waitUntil(() => view.frames.length, "the first frame on the port");
    const relayedBefore = conversation.webContents.sent.filter((message) => message.channel === "ccf:companion").length;
    assert.deepEqual(await action(electron, { action: "start" }), { ok: true });
    await waitUntil(() => view.frames.at(-1)?.frame?.terminal?.lines?.some((line) => line.some((run) => run.text.includes("CCF fixture ready"))),
      "the fixture's output in a frame", 30000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const relayed = conversation.webContents.sent.filter((message) => message.channel === "ccf:companion").slice(relayedBefore);
    assert.ok(relayed.every((message) => !message.payload?.terminal?.lines?.length), "main relays no terminal screen to it");
    const mainSnapshot = await electron.ipcMain.invoke("ccf:get-companion");
    assert.equal(mainSnapshot.connected, true);
    assert.equal(mainSnapshot.terminal.slim, true, "main's own snapshot is slim");
    assert.equal(mainSnapshot.terminal.lines, undefined);

    const tree = await waitUntil(() => companionFixture.ptyPids().length === 2 && companionFixture.ptyPids(), "the fixture's tree", 30000);
    process.kill(companionState(runtime).pid);
    await waitUntil(() => companionState(runtime).status === "crashed", "the crash noticed");
    await waitUntil(() => conversation.webContents.sent.filter((message) => message.channel === "ccf:companion").at(-1)?.payload?.process === "crashed",
      "main sent the offline view");
    await waitUntil(() => tree.every((pid) => !isAlive(pid)), "the fixture's tree gone", 10000);
    const portsBefore = view.ports;
    assert.deepEqual(await action(electron, { action: "start" }), { ok: true });
    await waitUntil(() => view.ports > portsBefore, "a new frames port after Start", 30000);
    await waitUntil(() => view.frames.at(-1)?.frame?.connected === true, "frames from the restarted companion", 30000);
  });
