import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";

const hookInstaller = {
  async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true }, registeredEvents: [] }; },
  async install() { return { ok: true, action: "install" }; },
  async repair() { return { ok: true, action: "repair" }; }
};
const mascotLibrary = { list() { return { mascots: [] }; }, async warmBundledAssets() {} };

function fakeSession() {
  let connected = false;
  return {
    getSnapshot: () => ({ connected, phase: connected ? "idle" : "offline", title: "Work companion", messages: [], terminal: {} }),
    on() {}, off() {},
    async start() { connected = true; },
    async stop() { connected = false; }
  };
}

function capturingTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    intervals,
    setTimeout, clearTimeout,
    setInterval(callback, ms) { const id = next++; intervals.set(id, { callback, ms }); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
}

function clusterOf() {
  const windows = [...FakeBrowserWindow.windowsByWebContents.values()];
  const find = (file) => windows.find((window) => String(window.loadedFile).endsWith(path.join("renderer", file)));
  return { cat: find("overlay.html"), conversation: find("companion-conversation.html"), status: find("companion-status.html") };
}

function setAlwaysOnTopCalls(window) {
  return window.zOrderCalls.filter((entry) => entry.call === "setAlwaysOnTop");
}

test("companion cluster stays topmost at one explicit level and repairs a lost topmost bit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-cluster-zorder-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const timers = capturingTimers();
  const runtime = createWindowsShellRuntime({
    electron, timers,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_APP_MODE_OVERRIDE: "mascot", CCF_TEST_TOKEN: "fixture" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: { companionSession: fakeSession(), hookInstaller, mascotLibrary }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const started = await runtime.start();
  const preview = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/companion-preview`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-test-token": "fixture" },
    body: JSON.stringify({ connected: true, phase: "idle", messages: [], terminal: {} })
  });
  assert.equal(preview.status, 200);
  const { cat, conversation, status } = clusterOf();
  assert.ok(conversation?.isVisible() && status?.isVisible() && cat?.isVisible());

  for (const window of [cat, conversation, status]) {
    assert.equal(window.isAlwaysOnTop(), true, `${window.getTitle()} is topmost`);
    assert.equal(window.alwaysOnTopLevel, "pop-up-menu",
      `${window.getTitle()} avoids Electron's behind-the-taskbar "floating" level`);
  }
  assert.equal(timers.intervals.size, 1, "a topmost watchdog runs while the panels are shown");

  // A blur while everything is still topmost must not restack the cluster above
  // other windows the user just raised (e.g. the dashboard).
  const before = [cat, conversation, status].map((window) => setAlwaysOnTopCalls(window).length);
  conversation.emit("blur");
  assert.deepEqual([cat, conversation, status].map((window) => setAlwaysOnTopCalls(window).length), before);

  // Windows strips WS_EX_TOPMOST: blur and the watchdog both restore it.
  status.alwaysOnTop = false;
  conversation.emit("blur");
  assert.equal(status.isAlwaysOnTop(), true);
  assert.equal(status.alwaysOnTopLevel, "pop-up-menu");
  conversation.alwaysOnTop = false;
  [...timers.intervals.values()][0].callback();
  assert.equal(conversation.isAlwaysOnTop(), true);
  const log = fs.readFileSync(path.join(root, "chaos-cat-familiar", "logs", "chaos-cat-familiar.log"), "utf8");
  assert.match(log, /lost always-on-top/);

  // Clicking the cat raises the whole cluster, cat last so it ends on top.
  for (const window of [cat, conversation, status]) window.zOrderCalls.length = 0;
  const order = [];
  for (const window of [cat, conversation, status]) {
    const original = window.setAlwaysOnTop.bind(window);
    window.setAlwaysOnTop = (...args) => { order.push(window); return original(...args); };
  }
  cat.emit("focus");
  assert.deepEqual(order, [status, conversation, cat]);

  await electron.ipcMain.invoke("ccf:update-settings", { overlayVisible: false });
  cat.hide();
  cat.emit("hide");
  assert.equal(conversation.isVisible(), false);
  assert.equal(timers.intervals.size, 0, "the watchdog stops with the panels");
});

test("toggle hotkey summons a buried companion before it hides it, and the tray can raise it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-cluster-hotkey-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron, timers: capturingTimers(),
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_APP_MODE_OVERRIDE: "mascot" },
      argv: ["node", "main.js"], defaultApp: true, execPath: process.execPath, pid: process.pid },
    services: { companionSession: fakeSession(), hookInstaller, mascotLibrary }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const started = await runtime.start();
  const opened = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/open`, {
    method: "POST", headers: { "x-ccf-token": started.settings.hookToken }
  });
  assert.equal(opened.status, 200);
  const { cat, conversation, status } = clusterOf();
  assert.ok(conversation.isVisible());
  const toggle = electron.globalShortcut.bindings.find(({ accelerator }) => accelerator === started.settings.hotkeys.toggleOverlay);
  assert.ok(toggle, "no new global shortcut is needed: the existing toggle summons");

  // Buried: the user works in another app, nothing of the cluster has focus.
  conversation.focused = false;
  cat.focused = false;
  conversation.zOrderCalls.length = 0;
  status.alwaysOnTop = false;
  toggle.handler();
  assert.equal(cat.isVisible(), true, "first press brings the cluster back instead of hiding it");
  assert.equal(status.isAlwaysOnTop(), true);
  assert.ok(conversation.zOrderCalls.some((entry) => entry.call === "focus"), "the composer takes focus");

  // Focused: the same key hides it as before.
  toggle.handler();
  assert.equal(cat.isVisible(), false);
  toggle.handler();
  assert.equal(cat.isVisible(), true);

  const item = electron.Menu.lastTemplate.find((entry) => entry.label === "Bring Companion to Front");
  assert.ok(item, "tray menu offers the escape hatch");
  conversation.focused = false;
  conversation.alwaysOnTop = false;
  item.click();
  assert.equal(conversation.isAlwaysOnTop(), true);
  assert.equal(conversation.isFocused(), true);
});
