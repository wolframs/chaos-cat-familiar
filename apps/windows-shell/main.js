import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  clipboard,
  dialog,
  shell,
  screen,
  globalShortcut,
  Notification
} from "electron";
import { createWindowsShellRuntime } from "./runtime/windows-shell-runtime.js";
import fs from "node:fs";
import path from "node:path";

// Keep test Chromium data and the single-instance lock outside the live profile.
if (process.env.CCF_TEST_MODE === "1") {
  if (!process.env.CCF_APPDATA_OVERRIDE || !process.env.CCF_HOME_OVERRIDE) {
    throw new Error("Test mode requires isolated home and app-data overrides");
  }
  const testUserData = path.join(process.env.CCF_APPDATA_OVERRIDE, "electron-user-data");
  fs.mkdirSync(testUserData, { recursive: true });
  app.setPath("userData", testUserData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const runtime = createWindowsShellRuntime({
    electron: {
      app,
      BrowserWindow,
      Tray,
      Menu,
      ipcMain,
      nativeImage,
      clipboard,
      dialog,
      shell,
      screen,
      globalShortcut,
      Notification
    }
  });

  app.whenReady().then(async () => {
    try {
      await runtime.start();
    } catch (error) {
      console.error("[ccf] bootstrap failed", error);
      await runtime.stop("bootstrap-failure").catch(() => {});
      app.exit(1);
    }
  });
}
