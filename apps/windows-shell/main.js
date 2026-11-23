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
  Notification,
  utilityProcess,
  MessageChannelMain
} from "electron";
import { createWindowsShellRuntime } from "./runtime/windows-shell-runtime.js";
import path from "node:path";

// Keep test Chromium data and the single-instance lock outside the live profile. Electron takes only an existing folder
// and main does no file work of its own (process-split plan, step 7): the smoke scripts create electron-user-data under
// the app-data override; without it, the override itself holds Chromium's data.
if (process.env.CCF_TEST_MODE === "1") {
  if (!process.env.CCF_APPDATA_OVERRIDE || !process.env.CCF_HOME_OVERRIDE) {
    throw new Error("Test mode requires isolated home and app-data overrides");
  }
  try { app.setPath("userData", path.join(process.env.CCF_APPDATA_OVERRIDE, "electron-user-data")); }
  catch { app.setPath("userData", process.env.CCF_APPDATA_OVERRIDE); }
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
      Notification,
      // The core (hook server, approvals, settings, state, log) runs in a utility process (process-split plan, step 3).
      utilityProcess,
      // A window's own state or frames port straight from a utility process (step 5).
      MessageChannelMain
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
