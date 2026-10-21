import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";

test("mascot mode registers only companion hotkeys and developer actions require overlay focus", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-hotkeys-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0" },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() { return { hookExists: true, drift: { healthy: true }, registeredEvents: [] }; },
        async install() { return { ok: true, action: "install" }; },
        async repair() { return { ok: true, action: "repair" }; }
      },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await runtime.start();
  const accelerators = () => electron.globalShortcut.bindings.map(({ accelerator }) => accelerator);
  const settings = runtime.snapshot().settings;
  const companionHotkeys = [settings.hotkeys.toggleOverlay, settings.hotkeys.openDiagnostics, settings.hotkeys.openDashboard];
  assert.deepEqual(accelerators().sort(), companionHotkeys.slice().sort());
  assert.equal(accelerators().some((accelerator) => accelerator === "CommandOrControl+Tab"), false);
  assert.equal(accelerators().some((accelerator) => accelerator === "CommandOrControl+1"), false);

  await electron.ipcMain.invoke("ccf:update-settings", { appShellMode: "developer" });
  assert.deepEqual(accelerators().sort(), companionHotkeys.slice().sort());
  const overlay = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) => window.getTitle() === "Chaos Cat Familiar Overlay");
  overlay.isFocused = () => true;
  overlay.emit("focus");
  assert.ok(accelerators().includes(settings.hotkeys.sessionSwitcherNext));
  assert.ok(accelerators().includes("CommandOrControl+1"));
  assert.ok(accelerators().includes(settings.hotkeys.approveTop));

  overlay.isFocused = () => false;
  overlay.emit("blur");
  assert.deepEqual(accelerators().sort(), companionHotkeys.slice().sort());
  await electron.ipcMain.invoke("ccf:update-settings", { appShellMode: "mascot" });
  assert.deepEqual(accelerators().sort(), companionHotkeys.slice().sort());
});
