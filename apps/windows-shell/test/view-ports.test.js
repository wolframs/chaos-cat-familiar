// A window's own state port (process-split plan, step 5): main sets it up, the state travels from the core to the
// window without main, and main posts a new port after a core restart. In-process with fake Electron (a worker_threads
// MessageChannel) and with the core in a forked child (one end of a loopback socket pair handed to the child).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { sanitizeSubscription } from "../runtime/view-subscriptions.js";
import { createFakeElectron, FakeBrowserWindow, nodeUtilityProcess } from "../test-support/fake-electron.js";
import { fakeView, until } from "../test-support/fake-view.js";

async function fixture(t, { forked = false, restartDelaysMs = [50] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-view-ports-"));
  const electron = createFakeElectron({ home: root, appData: root });
  if (forked) electron.utilityProcess = nodeUtilityProcess();
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession: { getSnapshot() { return { connected: false, terminal: {} }; }, on() {}, async stop() {} },
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} },
      coreLogToConsole: false,
      coreProcess: { restartDelaysMs }
    }
  });
  t.after(async () => {
    await Promise.race([runtime.stop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    for (const child of electron.utilityProcess?.children ?? []) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = await runtime.start();
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${runtime.snapshot().runtime.hookPort}/hook`, { method: "POST",
      headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken }, body: JSON.stringify(body) });
    await response.text();
  };
  return { electron, runtime, started, post };
}

function window(file) {
  return [...FakeBrowserWindow.windowsByWebContents.values()].find((item) => !item.destroyed
    && String(item.loadedFile ?? "").endsWith(file));
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function assertMatchesCore(view, full, eventLimit) {
  const state = plain(view.state());
  const reference = plain(full);
  for (const name of ["sessions", "approvals", "notifications"]) assert.deepEqual(state[name], reference[name], name);
  assert.deepEqual(state.events, reference.events.slice(0, eventLimit), "the event window");
  assert.equal(state.summary.eventCount, reference.events.length);
}

test("subscriptions are sanitized: known services and topics, bounded limits, an id", () => {
  assert.deepEqual(sanitizeSubscription({ id: "a", service: "core", topics: ["events", "secrets", "events"], eventLimit: 9000, logLimit: -1, window: 99 }),
    { id: "a", service: "core", options: { id: "a", topics: ["events"], eventLimit: 200, window: 2 } });
  assert.throws(() => sanitizeSubscription({ service: "core" }), /needs an id/);
  assert.throws(() => sanitizeSubscription({ id: "b", service: "shell" }), /Unknown subscription service/);
});

test("a window's state arrives on its own port as deltas and equals the core's state", { timeout: 30000 }, async (t) => {
  const { electron, runtime, post } = await fixture(t);
  await electron.ipcMain.invoke("ccf:open-dashboard");
  const dashboard = window("dashboard.html");
  const view = await fakeView(electron, dashboard, { topics: ["base", "events"], eventLimit: 10 });
  t.after(() => view.close());
  await until(() => view.states.length, "the projection");
  assert.equal(view.states[0].info.kind, "projection");
  for (let i = 0; i < 25; i++) {
    await post({ hook_event_name: i % 5 ? "PreToolUse" : "SessionStart", session_id: `vp-${i % 4}`, cwd: `C:/vp/${i % 4}`,
      tool_name: "Bash", tool_use_id: `vp-${i}`, tool_input: { command: "x".repeat(1000) } });
  }
  await until(() => view.state()?.summary.eventCount === 25, "all 25 events counted");
  assertMatchesCore(view, (await runtime.fullSnapshot()).state, 10);
  assert.ok(view.states.slice(1).every(({ info }) => info.kind === "delta"), "deltas after the projection");
  const history = await view.query("history", { search: "vp-3" });
  assert.ok(history.result.events.length >= 1, "history on demand through the same port");
  assert.equal(runtime.snapshot().runtime.core.mode, "in-process");
});

test("with the core in a child process, the port runs from the child to the window and a core restart brings a new one", { timeout: 60000 }, async (t) => {
  const { electron, runtime, post } = await fixture(t, { forked: true });
  await electron.ipcMain.invoke("ccf:open-diagnostics");
  const diagnostics = window("diagnostics.html");
  const view = await fakeView(electron, diagnostics, { topics: ["base", "events"], eventLimit: 5 });
  t.after(() => view.close());
  await until(() => view.states.length, "the projection");
  await post({ hook_event_name: "SessionStart", session_id: "before-restart", cwd: "C:/vp" });
  await until(() => view.state().sessions.some((session) => session.id === "before-restart"), "a session before the restart");
  const firstEpoch = view.mirror.epoch;

  process.kill(runtime.snapshot().runtime.core.pid);
  await until(() => runtime.snapshot().runtime.core.status === "recovering", "recovering");
  await until(() => runtime.snapshot().runtime.core.status === "ready", "the restarted core", 20000);
  await until(() => view.ports === 2, "a new port after the restart");
  await until(() => view.mirror.epoch > firstEpoch && view.states.length, "the new core's projection");
  await post({ hook_event_name: "SessionStart", session_id: "after-restart", cwd: "C:/vp" });
  await until(() => view.state()?.sessions.some((session) => session.id === "after-restart"), "a session after the restart");
  assertMatchesCore(view, (await runtime.fullSnapshot()).state, 5);
});

test("a window that reloads is forgotten: no port is reopened for its old page", { timeout: 60000 }, async (t) => {
  const { electron, runtime } = await fixture(t, { forked: true });
  await electron.ipcMain.invoke("ccf:open-dashboard");
  const dashboard = window("dashboard.html");
  const view = await fakeView(electron, dashboard);
  t.after(() => view.close());
  await until(() => view.states.length, "the projection");
  dashboard.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  process.kill(runtime.snapshot().runtime.core.pid);
  await until(() => runtime.snapshot().runtime.core.status === "ready" && runtime.snapshot().runtime.core.pid, "restarted", 20000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(view.ports, 1, "the reloaded page's subscription was not reopened");
});

test("a subscribed window gets no state from main, only main's part; together they equal main's own payload", { timeout: 30000 }, async (t) => {
  const { electron, runtime, post } = await fixture(t);
  await electron.ipcMain.invoke("ccf:open-dashboard");
  const dashboard = window("dashboard.html");
  const legacySends = () => dashboard.webContents.sent.filter((message) => message.channel === "ccf:state").length;
  const view = await fakeView(electron, dashboard, { topics: ["base", "events"], eventLimit: 50 });
  t.after(() => view.close());
  await until(() => view.states.length, "the projection");
  for (let i = 0; i < 6; i++) await post({ hook_event_name: "SessionStart", session_id: `legacy-${i}`, cwd: `C:/legacy/${i}` });
  await post({ hook_event_name: "Notification", session_id: "legacy-1", notification_type: "idle_prompt", message: "waiting" });
  await until(() => view.state()?.summary.eventCount === 7, "the events on the port");
  assert.equal(legacySends(), 0, "main sends no window ccf:state");
  const shell = dashboard.webContents.sent.filter((message) => message.channel === "ccf:shell-state").at(-1)?.payload
    ?? await electron.ipcMain.invokeFrom(dashboard.webContents, "ccf:get-shell-state");
  const { composeLegacyState } = await import("../renderer/legacy-state.js");
  const reconstructed = plain(composeLegacyState(view.state(), shell, view.mirror));
  const reference = plain((await runtime.fullSnapshot()).state);
  delete reference.logs;
  delete reconstructed.logs;
  assert.deepEqual(reconstructed.meta, reference.meta);
  assert.deepEqual(reconstructed.ui, reference.ui);
  assert.deepEqual(reconstructed, { ...reference, summary: reconstructed.summary }, "the same payload main would have sent");
});

test("a window that subscribes before its service runs gets its port once the service is ready", async () => {
  const { ViewSubscriptions } = await import("../runtime/view-subscriptions.js");
  const { EventEmitter } = await import("node:events");
  let running = false;
  const errors = [];
  const subscriptions = new ViewSubscriptions({ onError: (error, context) => errors.push(context),
    open: async () => { if (!running) throw new Error("The companion is not running."); return { close() {} }; } });
  const contents = Object.assign(new EventEmitter(), { posted: [], postMessage(channel, message, ports) { this.posted.push({ channel, message, ports }); } });
  assert.deepEqual(await subscriptions.subscribe(contents, { id: "conv-1", service: "companion" }), { id: "conv-1", service: "companion", pending: true });
  assert.equal(subscriptions.has(contents, "companion"), true, "the window takes its frames itself from now on");
  assert.deepEqual(errors, [{ id: "conv-1", service: "companion", pending: true }]);
  running = true;
  await subscriptions.reopen("companion");
  assert.deepEqual(contents.posted.map((entry) => entry.message), [{ id: "conv-1", service: "companion" }]);
});
