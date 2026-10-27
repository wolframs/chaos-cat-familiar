import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";
import { placeCompanionCluster } from "../services/companion-cluster-layout.js";

test("drag frames avoid settings I/O and clamp the HUD cluster before one native cat move", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-placement-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_TEST_TOKEN: "drag" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  const response = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/companion-preview`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-test-token": "drag" },
    body: JSON.stringify({ connected: true, messages: [], terminal: {} })
  });
  assert.equal(response.status, 200);
  await response.text();
  const cat = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) =>
    String(window.loadedFile).endsWith(path.join("renderer", "overlay.html")));
  let redundantShows = 0;
  for (const window of FakeBrowserWindow.windowsByWebContents.values()) {
    if (window === cat) continue;
    const show = window.showInactive.bind(window);
    window.showInactive = () => { redundantShows++; show(); };
  }
  const settingsPath = path.join(root, "chaos-cat-familiar", "settings.json");
  let reads = 0;
  let writes = 0;
  const read = fs.readFileSync;
  const rename = fs.renameSync;
  t.mock.method(fs, "readFileSync", (filename, ...args) => { if (filename === settingsPath) reads++; return read(filename, ...args); });
  t.mock.method(fs, "renameSync", (source, destination) => { if (destination === settingsPath) writes++; return rename(source, destination); });
  const nativeMoves = [];
  const setBounds = cat.setBounds.bind(cat);
  cat.setBounds = (bounds) => { nativeMoves.push({ ...bounds }); setBounds(bounds); cat.emit("move"); };
  const start = { ...cat.getBounds(), x: 200, y: 700 };
  for (let i = 0; i < 100; i++) {
    electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...start, x: 200 + i, dragging: true });
    cat.emit("move"); // Delayed native notification after the IPC handler returns.
  }
  assert.equal(writes, 0, "no settings writes while the pointer is held");
  assert.equal(reads, 1, "read preferences once when the drag begins, never per frame");
  assert.equal(redundantShows, 0, "visible HUDs are not shown again for every move");
  nativeMoves.length = 0;
  const outside = { ...start, x: -100, y: 20 };
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...outside, dragging: true });
  const expected = placeCompanionCluster({ cat: outside, workArea: electron.screen.primaryDisplay.workArea }).cat;
  assert.deepEqual(nativeMoves, [expected], "never move out then back during a frame");
  const external = JSON.parse(read(settingsPath, "utf8"));
  external.externalPreference = "keep during drag";
  fs.writeFileSync(settingsPath, JSON.stringify(external));
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...outside, dragging: false });
  assert.equal(writes, 1, "one position is persisted on release");
  const saved = JSON.parse(read(settingsPath, "utf8"));
  assert.deepEqual(saved.overlayBounds, expected, "persist the actual clamped position");
  assert.equal(saved.externalPreference, external.externalPreference);
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...start, x: 500, dragging: true });
  assert.equal((await electron.ipcMain.invoke("ccf:get-log-metadata")).placement.dragging, true);
  cat.webContents.emit("did-start-loading");
  assert.equal(writes, 2, "renderer reload commits a held position instead of leaving persistence suspended");
  assert.equal((await electron.ipcMain.invoke("ccf:get-log-metadata")).placement.dragging, false);
});

test("placement persists once across native move and IPC, preserving external settings edits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-placement-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
      argv: [], execPath: process.execPath, pid: process.pid
    },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const cat = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) =>
    String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay.html")));
  assert.ok(cat);
  const settingsPath = path.join(root, "chaos-cat-familiar", "settings.json");
  let writes = 0;
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === settingsPath) writes++;
    return rename(source, destination);
  });
  let settingsReads = 0;
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (filename, ...args) => {
    if (filename === settingsPath) settingsReads++;
    return readFile(filename, ...args);
  });
  let moves = 0;
  const setBounds = cat.setBounds.bind(cat);
  cat.setBounds = (bounds) => {
    moves++;
    setBounds(bounds);
    // Electron emits move for programmatic bounds changes; the basic fake does not.
    cat.emit("move");
  };
  const next = { ...cat.getBounds(), x: 300, y: 300 };
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, next);
  assert.equal(writes, 1, "native move and the IPC completion share one persisted placement");
  settingsReads = 0;
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, next);
  assert.equal(settingsReads, 2, "one fresh placement read and one HUD read; mascot mode reuses the HUD settings");
  cat.emit("resize");
  assert.equal(writes, 1, "unchanged bounds do not create atomic settings writes");
  assert.equal(moves, 1, "unchanged IPC bounds do not call Electron setBounds");

  const external = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  external.overlayOpacity = 0.6;
  external.externalPreference = "keep";
  fs.writeFileSync(settingsPath, JSON.stringify(external));
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...next, x: 350 });
  assert.equal(writes, 2);
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(saved.overlayBounds.x, 350);
  assert.equal(saved.overlayOpacity, 0.6);
  assert.equal(saved.externalPreference, "keep");
  assert.equal((await electron.ipcMain.invoke("ccf:get-settings")).overlayOpacity, 0.6);

  let locked = true;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === settingsPath && locked) {
      throw Object.assign(new Error("EPERM: temporary settings lock"), { code: "EPERM", syscall: "rename" });
    }
    return rename(source, destination);
  });
  assert.doesNotThrow(() => electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...next, x: 390 }),
    "a native move settings lock must never escape into uncaughtException");
  assert.equal(electron.app.exitCalls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayBounds.x, 350,
    "the last good settings remain readable after a failed rename");
  locked = false;
  await runtime.stop();
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayBounds.x, 390,
    "shutdown flushes the latest placement after the lock clears");
});
