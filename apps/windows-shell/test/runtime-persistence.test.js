import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";
import { StorageClient } from "../../../packages/core/src/index.js";
import { storedState } from "../test-support/stored-state.js";
import { holdFileExclusively } from "../test-support/file-lock.js";

async function fixture(t, { previousRun, initialState, companionSession, coreStorage = undefined,
  testMode = true, dialog, heldDelays = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-persistence-"));
  const data = path.join(root, "chaos-cat-familiar");
  fs.mkdirSync(data);
  if (previousRun) fs.writeFileSync(path.join(data, "run-marker.json"), JSON.stringify(previousRun));
  if (initialState) fs.writeFileSync(path.join(data, "state.json"), JSON.stringify(initialState));
  const electron = createFakeElectron({ home: root, appData: root });
  electron.dialog = dialog;
  const pendingTimers = new Set();
  const timers = {
    setTimeout(callback, delay) {
      // State commits batch at 100 ms, the log at 250 ms: hold both until stop.
      if (delay !== 100 && delay !== 250 && !heldDelays.includes(delay)) return setTimeout(callback, delay);
      const handle = { callback, unref() {} };
      pendingTimers.add(handle);
      return handle;
    },
    clearTimeout(handle) { if (!pendingTimers.delete(handle)) clearTimeout(handle); },
    setInterval, clearInterval
  };
  const runtime = createWindowsShellRuntime({ electron, timers,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: testMode ? "1" : "0", CCF_TEST_TOKEN: "persistence-test" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession,
      coreStorage,
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  return { runtime, electron, data, pendingTimers, started };
}

test("runtime batches hook persistence and flushes state/logs before removing its clean-run marker", async (t) => {
  const { runtime, electron, data, pendingTimers, started } = await fixture(t);
  const status = await electron.ipcMain.invoke("ccf:get-log-metadata");
  assert.equal(status.persistence.flushDelayMs, 100);
  assert.equal(status.persistence.backend, "sqlite");
  assert.equal(status.recovery.previousUncleanExit, false);
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
  const headers = { "content-type": "application/json", "x-ccf-token": started.settings.hookToken };
  for (let i = 0; i < 8; i++) {
    const response = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, {
      method: "POST", headers, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: `batch-${i}`, cwd: "C:/fixture" })
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  // The hook server answers before it ingests; live state follows within a tick, not a disk write.
  const deadline = Date.now() + 1000;
  while (runtime.snapshot().state.events.length < 8 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().state.events.length, 8, "live state is available without a checkpoint");
  assert.equal((await storedState(data)).state.events.length, 0, "nothing committed per hook");
  assert.equal((await electron.ipcMain.invoke("ccf:get-log-metadata")).persistence.pending, true);
  await runtime.stop();
  assert.equal((await storedState(data)).state.events.length, 8, "committed on quit");
  assert.match(fs.readFileSync(path.join(data, "logs", "chaos-cat-familiar.log"), "utf8"), /Stopping Windows shell runtime/);
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), false);
  assert.equal(pendingTimers.size, 0);
});

test("runtime reports a previous unclean run and leaves a marker after fatal shutdown", async (t) => {
  const { runtime, electron, data } = await fixture(t, {
    previousRun: { runId: "previous", pid: 123, startedAt: "2026-10-27T12:00:00Z" },
    initialState: { events: [{ id: "saved-checkpoint-event", timestamp: "2026-10-27T12:00:00Z" }] }
  });
  const status = await electron.ipcMain.invoke("ccf:get-log-metadata");
  assert.equal(status.recovery.previousUncleanExit, true);
  assert.equal(status.recovery.previousRun.runId, "previous");
  assert.equal(runtime.snapshot().state.events[0].id, "saved-checkpoint-event", "loads the last valid atomic checkpoint");
  await runtime.stop("uncaughtException");
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
  assert.match(fs.readFileSync(path.join(data, "logs", "chaos-cat-familiar.log"), "utf8"), /unclean/i);
});

// A database that refuses commits (a full disk, a broken file): the quit is not clean.
class RefusingStorage extends StorageClient {
  request(method, params, options) {
    if (method === "state.commit") return Promise.reject(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" }));
    return super.request(method, params, options);
  }
}

test("failed final state write retains the recovery marker and cancels buffered timers", async (t) => {
  const { runtime, data, pendingTimers, started } = await fixture(t, { coreStorage: new RefusingStorage() });
  await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, { method: "POST", body: JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "refused" }), headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken } }).then((response) => response.text());
  await runtime.stop();
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
  assert.equal(pendingTimers.size, 0);
});

test("bootstrap failure is never marked as a clean run", async (t) => {
  const { runtime, data } = await fixture(t);
  await runtime.stop("bootstrap-failure");
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
});

for (const event of ["uncaughtException", "unhandledRejection"]) {
  test(`${event} shows a fatal error before shutdown and retains its crash marker`, async (t) => {
    const dialogs = [];
    const previous = new Set(process.listeners(event));
    const { runtime, electron, data } = await fixture(t, { testMode: false,
      dialog: { showErrorBox: (...args) => dialogs.push(args) } });
    const handler = process.listeners(event).find((listener) => !previous.has(listener));
    assert.ok(handler);
    const exited = new Promise((resolve) => electron.app.once("exit", resolve));
    handler(new Error("fixture fatal error"));
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0][1], /chaos-cat-familiar\.log/);
    assert.equal(await exited, 1);
    await runtime.stop();
    assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
  });
}

test("exit flush listener survives asynchronous shutdown and is removed after finalization", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const companionSession = Object.assign(new EventEmitter(), {
    getSnapshot() { return { connected: false }; },
    stop() { return gate; }
  });
  const previous = new Set(process.listeners("exit"));
  const { runtime } = await fixture(t, { companionSession });
  const exitFlush = process.listeners("exit").find((listener) => !previous.has(listener));
  assert.ok(exitFlush);
  const stopping = runtime.stop();
  try {
    assert.ok(process.listeners("exit").includes(exitFlush), "crash flush remains installed during async shutdown");
  } finally {
    release();
    await stopping;
  }
  assert.equal(process.listeners("exit").includes(exitFlush), false);
});

// Review of step 4 (2026-11-05, P2): main counted settings as unsent when the core still held a patch it could not
// write, although the core's final close() retries and may save it. 73be056 covered retries before quit, not this one.
// Since step 6 a real lock: settings.json is written by the core's storage worker on its own thread.
test("a settings patch the core saves in its final flush keeps the quit clean", async (t) => {
  // The core's retry timers (1/3/10 s) never fire here: only the final close() retries.
  const { runtime, electron, data } = await fixture(t, { heldDelays: [1000, 3000, 10000] });
  const lock = await holdFileExclusively(path.join(data, "settings.json"));
  try {
    const result = await electron.ipcMain.invoke("ccf:update-settings", { overlayOpacity: 0.5 });
    assert.ok(result, "the action itself does not fail on a held file");
  } finally {
    await lock.release();
  }
  await runtime.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8")).overlayOpacity, 0.5, "saved on close");
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), false, "the quit is clean");
});

test("a settings patch that is still unsaved after the core's final flush keeps the marker", async (t) => {
  const { runtime, electron, data } = await fixture(t, { heldDelays: [1000, 3000, 10000] });
  const lock = await holdFileExclusively(path.join(data, "settings.json"));
  try {
    await electron.ipcMain.invoke("ccf:update-settings", { overlayOpacity: 0.5 });
    await runtime.stop();
  } finally {
    await lock.release();
  }
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true);
});

// Found by the smoke run (2026-11-05, step 4): quit removed every app listener first, then destroyed the windows. With no
// "window-all-closed" listener Electron quits on its own when the last window goes, which ends the utility processes:
// the core died before its final flush, so every quit stayed unclean. The listener now stays until the core flushed.
test("quit keeps Electron from closing CCF on its own until the core has flushed", async (t) => {
  const { runtime, electron } = await fixture(t);
  const seen = [];
  const original = FakeBrowserWindow.prototype.destroy;
  FakeBrowserWindow.prototype.destroy = function destroy() {
    seen.push(electron.app.listenerCount("window-all-closed"));
    return original.call(this);
  };
  t.after(() => { FakeBrowserWindow.prototype.destroy = original; });
  await runtime.stop();
  assert.ok(seen.length, "quit destroys the windows");
  assert.ok(seen.every((count) => count > 0), `window-all-closed listeners while windows go: ${seen.join(",")}`);
  assert.equal(electron.app.listenerCount("window-all-closed"), 0, "and none left once quit is done");
});

// Process-split plan, step 6: the history lives in the core's database, which its worker keeps open. "Clear local data"
// used to delete state.json while the same state stayed in memory (the next checkpoint wrote it back).
test("clear local data empties the history in memory and in the database", async (t) => {
  const { runtime, electron, data, started } = await fixture(t, { initialState: { events: [{ id: "old-event" }],
    notifications: [{ id: "old-note", title: "x" }], sessions: [{ id: "old-session", status: "ended" }] } });
  assert.equal(runtime.snapshot().state.events[0].id, "old-event", "imported from state.json");
  await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, { method: "POST", body: JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "s-live" }), headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken } }).then((response) => response.text());
  await electron.ipcMain.invoke("ccf:cleanup-action", { action: "clear-local-data" });
  const state = runtime.snapshot().state;
  assert.deepEqual([state.events.length, state.notifications.length, state.sessions.length], [0, 0, 0]);
  await runtime.stop();
  const stored = (await storedState(data)).state;
  assert.deepEqual([stored.events.length, stored.notifications.length, stored.sessions.length], [0, 0, 0]);
});
