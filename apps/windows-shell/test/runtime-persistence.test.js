import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron } from "../test-support/fake-electron.js";

async function fixture(t, { previousRun, initialState, companionSession, stateFileBlocked = false,
  testMode = true, dialog } = {}) {
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
      if (delay !== 250) return setTimeout(callback, delay);
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
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  if (stateFileBlocked) fs.mkdirSync(path.join(data, "state.json"));
  return { runtime, electron, data, pendingTimers, started };
}

test("runtime batches hook persistence and flushes state/logs before removing its clean-run marker", async (t) => {
  const { runtime, electron, data, pendingTimers, started } = await fixture(t);
  const status = await electron.ipcMain.invoke("ccf:get-log-metadata");
  assert.equal(status.persistence.flushDelayMs, 250);
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
  assert.equal(runtime.snapshot().state.events.length, 8, "live state is immediately available");
  assert.equal(fs.existsSync(path.join(data, "state.json")), false, "no disk save for individual hooks");
  assert.equal((await electron.ipcMain.invoke("ccf:get-log-metadata")).persistence.pending, true);
  await runtime.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "state.json"))).events.length, 8);
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

test("failed final state write retains the recovery marker and cancels buffered timers", async (t) => {
  const { runtime, data, pendingTimers } = await fixture(t, { stateFileBlocked: true });
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
