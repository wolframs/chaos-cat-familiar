import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeTray, FakeBrowserWindow } from "../test-support/fake-electron.js";

async function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-tray-"));
  const settingsPath = path.join(root, "chaos-cat-familiar/settings.json");
  fs.mkdirSync(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const electron = createFakeElectron({ home: root, appData: root });
  let tray;
  let starts = 0;
  let stops = 0;
  const dialogs = [];
  electron.Tray = class extends FakeTray { constructor(icon) { super(icon); tray = this; } };
  electron.dialog = { showErrorBox: (...args) => dialogs.push(args) };
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      companionSession: { getSnapshot() { return { connected: false, terminal: {} }; }, on() {}, async start() { starts++; }, async stop() { stops++; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const flatten = (items) => items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
  const item = (id) => flatten(tray.menu.template).find((entry) => entry.id === id);
  return { runtime, electron, root, settingsPath, tray, item, dialogs, starts: () => starts, stops: () => stops,
    windows: () => [...FakeBrowserWindow.windowsByWebContents.values()] };
}

test("tray uses a real Windows ICO and puts developer tools under Advanced", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.tray.icon, "string", "use the native Windows ICO path, not an unsupported SVG NativeImage");
  assert.equal(fs.readFileSync(f.tray.icon).subarray(0, 4).toString("hex"), "00000100");
  assert.ok(f.item("settings"));
  assert.ok(f.item("advanced").submenu.some((item) => item.id === "diagnostics"));
  assert.equal(f.tray.menu.template.some((item) => /Install|Repair|Developer|Preview/.test(item.label ?? "")), false);
});

test("tray can reveal a snoozed companion and hide it without starting or stopping Claude", async (t) => {
  const f = await fixture(t, { snoozeUntil: "manual", overlayVisible: false });
  await f.item("show-companion").click();
  assert.equal(f.runtime.snapshot().settings.snoozeUntil, null);
  const companionWindows = f.windows().filter((window) => /Overlay|Companion Conversation|Companion Status/.test(window.getTitle()));
  assert.equal(companionWindows.length, 3);
  assert.equal(companionWindows.every((window) => window.isVisible()), true);
  assert.equal(f.starts(), 0, "showing the input UI must not launch Claude");
  await f.item("hide-companion").click();
  assert.equal(companionWindows.some((window) => window.isVisible()), false);
  assert.equal(f.starts(), 0);
  assert.equal(f.stops(), 0, "hiding the UI cannot terminate a running companion");
  f.tray.emit("click");
  assert.equal(companionWindows.every((window) => window.isVisible()), true, "left click restores the entire cluster immediately");
});

test("explicit tray and settings mode choices override the launch-mode preference", async (t) => {
  const f = await fixture(t);
  assert.equal(f.item("mascot-mode").checked, true);
  await f.electron.ipcMain.invoke("ccf:update-settings", { appShellMode: "developer" });
  assert.equal(f.runtime.snapshot().settings.appShellMode, "developer", "settings takes precedence over the launch default too");
  await f.item("mascot-mode").click();
  await f.item("developer-mode").click();
  assert.equal(f.runtime.snapshot().settings.appShellMode, "developer");
  assert.equal(f.item("developer-mode").checked, true);
  await f.electron.ipcMain.invoke("ccf:update-settings", { appShellMode: "mascot" });
  assert.equal(f.runtime.snapshot().settings.appShellMode, "mascot");
  assert.equal(f.item("mascot-mode").checked, true);
});

test("tray Quit flushes persistence and removes its clean-run marker", async (t) => {
  const f = await fixture(t);
  await f.item("quit").click();
  assert.equal(f.electron.app.quitCalled, true);
  assert.equal(fs.existsSync(path.join(f.root, "chaos-cat-familiar/run-marker.json")), false);
  assert.equal(f.stops(), 1);
});

test("settings opens the correct dashboard section and tray failures are reported without killing CCF", async (t) => {
  const f = await fixture(t);
  await f.item("settings").click();
  const dashboard = f.windows().find((window) => window.getTitle().endsWith("Dashboard"));
  assert.ok(dashboard.isVisible());
  assert.deepEqual(dashboard.webContents.sent.find((message) => message.channel === "ccf:dashboard-section"),
    { channel: "ccf:dashboard-section", payload: "settings" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.settingsPath) throw Object.assign(new Error("settings file locked"), { code: "EPERM" });
    return rename(source, destination);
  });
  await assert.doesNotReject(f.item("developer-mode").click());
  assert.equal(f.electron.app.exitCalls.length, 0);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0][1], /could not|failed/i);
});
