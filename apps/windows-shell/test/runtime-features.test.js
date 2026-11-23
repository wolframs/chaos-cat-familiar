// What a user sees of mascots, settings, onboarding, cleanup and the native side (activation, toasts), through the
// whole runtime with fake Electron. Process-split plan, step 7: written before main's transitional adapters went, and
// kept to the paths that stay (IPC requests and main's own channels), so they hold before and after.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, FakeNotification } from "../test-support/fake-electron.js";
import { until } from "../test-support/fake-view.js";

async function fixture(t, { testMode = true, services = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-features-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const toasts = [];
  electron.Notification = class extends FakeNotification {
    show() { toasts.push(this.payload); }
  };
  const activations = [];
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_APP_MODE_OVERRIDE: "mascot", ...(testMode ? { CCF_TEST_MODE: "1" } : {}) },
    argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession: { getSnapshot() { return { connected: false, terminal: {} }; }, on() {}, async stop() {} },
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, registeredEvents: [] }; } },
      activation: {
        async activateTerminal(payload) { activations.push(["terminal", payload]); return { ok: true, mode: "foreground" }; },
        async activateEditor(payload) { activations.push(["editor", payload]); return { ok: true, mode: "uri" }; }
      },
      ...services
    }
  });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = await runtime.start();
  const windowOf = (file) => [...FakeBrowserWindow.windowsByWebContents.values()]
    .find((item) => !item.destroyed && String(item.loadedFile ?? "").endsWith(file));
  const lastSent = (window, channel) => window.webContents.sent.filter((message) => message.channel === channel).at(-1)?.payload;
  const post = async (body) => (await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, { method: "POST",
    headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken }, body: JSON.stringify(body) })).text();
  return { root, electron, runtime, started, windowOf, lastSent, post, toasts, activations,
    invoke: (channel, ...args) => electron.ipcMain.invoke(channel, ...args) };
}

test("mascots: the library loads, and a selection is saved and reaches the open windows", async (t) => {
  const { root, invoke, windowOf, lastSent } = await fixture(t);
  const library = await invoke("ccf:get-mascot-library");
  assert.equal(library.currentMascotId, "bundled:chaos-cat");
  assert.ok(library.mascots.some((item) => item.id === "bundled:masko"));
  await invoke("ccf:open-dashboard");
  const result = await invoke("ccf:select-mascot", "bundled:masko");
  assert.equal(result.ok, true);
  for (const file of ["overlay.html", "dashboard.html"]) {
    assert.equal(lastSent(windowOf(file), "ccf:mascot-library")?.currentMascotId, "bundled:masko", file);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(root, "chaos-cat-familiar", "mascots.json"), "utf8"));
  assert.equal(saved.currentMascotId, "bundled:masko");
  assert.equal((await invoke("ccf:delete-mascot", "bundled:masko")).error, "bundled_mascot_cannot_be_removed");
});

test("settings: a change is saved, reaches the windows, and shows in main's part of their state", async (t) => {
  const { invoke, windowOf, lastSent } = await fixture(t);
  const saved = await invoke("ccf:update-settings", { overlayOpacity: 0.5 });
  assert.equal(saved.overlayOpacity, 0.5);
  assert.equal(lastSent(windowOf("overlay.html"), "ccf:settings")?.overlayOpacity, 0.5);
  assert.equal((await invoke("ccf:get-settings")).overlayOpacity, 0.5);
  assert.equal((await invoke("ccf:get-shell-state")).meta.overlayOpacity, 0.5);
});

test("onboarding: completing and resetting it shows in main's part of the windows' state", async (t) => {
  const { invoke } = await fixture(t);
  assert.equal((await invoke("ccf:get-shell-state")).ui.onboarding.required, true);
  await invoke("ccf:dispatch-command", { command: "complete-onboarding", payload: {} });
  assert.equal((await invoke("ccf:get-shell-state")).ui.onboarding.required, false);
  assert.ok((await invoke("ccf:get-settings")).onboardingCompletedAt, "completion is saved");
  await invoke("ccf:cleanup-action", { action: "reset-onboarding" });
  assert.equal((await invoke("ccf:get-shell-state")).ui.onboarding.required, true);
});

test("cleanup: clearing cache and logs removes them and keeps runtime.json for the running CCF", async (t) => {
  const { root, invoke } = await fixture(t);
  const data = path.join(root, "chaos-cat-familiar");
  fs.mkdirSync(path.join(data, "mascot-assets"), { recursive: true });
  fs.writeFileSync(path.join(data, "mascot-assets", "0123456789ab.png"), "x");
  const result = await invoke("ccf:cleanup-action", { action: "clear-cache-logs" });
  assert.ok(result.removed.some((item) => item.endsWith("mascot-assets")));
  assert.equal(fs.existsSync(path.join(data, "mascot-assets")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "runtime.json"), "utf8")).pid, process.pid);
  const ide = await invoke("ccf:cleanup-action", { action: "remove-ide-integration" });
  assert.equal(ide.skipped, true);
});

test("native: terminal and editor activation reach the activation service", async (t) => {
  const { invoke, activations } = await fixture(t);
  assert.equal((await invoke("ccf:activate-terminal", { projectDir: "C:/p", shellPid: 7 })).ok, true);
  assert.equal((await invoke("ccf:activate-editor", { editor: "vscode", shellPid: 7 })).mode, "uri");
  assert.deepEqual(activations.map(([kind, payload]) => [kind, payload.shellPid]), [["terminal", 7], ["editor", 7]]);
});

test("native: a hook that asks for the user becomes a Windows toast (toasts are off in test mode)", async (t) => {
  const { post, toasts } = await fixture(t, { testMode: false, services: {
    eventLoopMonitor: { start() {}, stop() {}, snapshot() { return null; } },
    mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
  } });
  await post({ hook_event_name: "SessionStart", session_id: "n-1", cwd: "C:/n" });
  await post({ hook_event_name: "Notification", session_id: "n-1", cwd: "C:/n", notification_type: "permission_prompt",
    message: "Claude needs your permission" });
  await until(() => toasts.length > 0, "a toast");
  assert.match(JSON.stringify(toasts[0]), /permission/i);
});
