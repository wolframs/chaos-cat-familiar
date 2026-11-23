import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";
import { PANEL, placeCompanionCluster } from "../services/companion-cluster-layout.js";
import { holdFileExclusively } from "../test-support/file-lock.js";

// Settings are written by the core's storage worker (process-split plan, step 6), on its own thread: the tests count the
// worker's writes instead of renames on this thread, and wait for them.
function settingsWrites(runtime) {
  const count = async () => (await runtime.diagnosticsSummary()).storage?.settingsWrites ?? 0;
  return {
    count,
    // Startup writes (token, port, window state) land asynchronously: the count to start from once they stopped.
    async quiet() {
      let last = await count();
      for (let still = 0; still < 3;) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const now = await count();
        still = now === last ? still + 1 : 0;
        last = now;
      }
      return last;
    },
    async settle(expected, message) {
      const deadline = Date.now() + 5000;
      let seen = await count();
      while (seen < expected && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 20)); seen = await count(); }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await count(), expected, message);
    }
  };
}

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
  const read = fs.readFileSync;
  const writes = settingsWrites(runtime);
  const base = await writes.quiet();
  t.mock.method(fs, "readFileSync", (filename, ...args) => { if (filename === settingsPath) reads++; return read(filename, ...args); });
  const nativeMoves = [];
  const setBounds = cat.setBounds.bind(cat);
  cat.setBounds = (bounds) => { nativeMoves.push({ ...bounds }); setBounds(bounds); cat.emit("move"); };
  const start = { ...cat.getBounds(), x: 200, y: 700 };
  for (let i = 0; i < 100; i++) {
    electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...start, x: 200 + i, dragging: true });
    cat.emit("move"); // Delayed native notification after the IPC handler returns.
  }
  await writes.settle(base, "no settings writes while the pointer is held");
  assert.ok(reads <= 1, "at most one preferences read when the drag begins (memory since 2026-11-05), never per frame");
  assert.equal(redundantShows, 0, "visible HUDs are not shown again for every move");
  nativeMoves.length = 0;
  const outside = { ...start, x: -100, y: 20 };
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...outside, dragging: true });
  // The side panel is on by default: the cat keeps its width clear at the left edge.
  const expected = placeCompanionCluster({ cat: outside, workArea: electron.screen.primaryDisplay.workArea, panel: PANEL }).cat;
  assert.deepEqual(nativeMoves, [expected], "never move out then back during a frame");
  const external = JSON.parse(read(settingsPath, "utf8"));
  external.externalPreference = "keep during drag";
  fs.writeFileSync(settingsPath, JSON.stringify(external));
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...outside, dragging: false });
  await writes.settle(base + 1, "one position is persisted on release");
  const saved = JSON.parse(read(settingsPath, "utf8"));
  assert.deepEqual(saved.overlayBounds, expected, "persist the actual clamped position");
  assert.equal(saved.externalPreference, external.externalPreference);
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...start, x: 500, dragging: true });
  assert.equal((await electron.ipcMain.invoke("ccf:get-log-metadata")).placement.dragging, true);
  cat.webContents.emit("did-start-loading");
  await writes.settle(base + 2, "renderer reload commits a held position instead of leaving persistence suspended");
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
  const writes = settingsWrites(runtime);
  const base = await writes.quiet();
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
  await writes.settle(base + 1, "native move and the IPC completion share one persisted placement");
  settingsReads = 0;
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, next);
  assert.equal(settingsReads, 0, "settings come from memory; the placement write only stats the file for external edits");
  cat.emit("resize");
  await writes.settle(base + 1, "unchanged bounds do not create atomic settings writes");
  assert.equal(moves, 1, "unchanged IPC bounds do not call Electron setBounds");

  const external = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  external.overlayOpacity = 0.6;
  external.externalPreference = "keep";
  fs.writeFileSync(settingsPath, JSON.stringify(external));
  electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...next, x: 350 });
  await writes.settle(base + 2);
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(saved.overlayBounds.x, 350);
  assert.equal(saved.overlayOpacity, 0.6);
  assert.equal(saved.externalPreference, "keep");
  assert.equal((await electron.ipcMain.invoke("ccf:get-settings")).overlayOpacity, 0.6);

  // Another process holds settings.json without sharing (a reader, the scanner): the worker's write fails, nothing escapes.
  const lock = await holdFileExclusively(settingsPath);
  try {
    assert.doesNotThrow(() => electron.ipcMain.emit("ccf:set-overlay-bounds", {}, { ...next, x: 390 }),
      "a native move settings lock must never escape into uncaughtException");
    const deadline = Date.now() + 5000;
    while (!(await runtime.diagnosticsSummary()).settingsWrites?.lastWriteError && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok((await runtime.diagnosticsSummary()).settingsWrites?.lastWriteError, "the held file failed the write");
    assert.equal(electron.app.exitCalls.length, 0);
  } finally {
    await lock.release();
  }
  assert.ok([350, 390].includes(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayBounds.x),
    "the file is always a whole, readable settings file");
  await runtime.stop();
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayBounds.x, 390,
    "shutdown flushes the latest placement after the lock clears");
});

// Final review, item 5 (measured under real Electron at 110 %): every state broadcast set the bounds of the cat and both
// HUD windows again and saved the cat's position, because the bounds read back rounded never equalled the target; the
// cat crept a pixel left per pass. A window that reads back what it read right after its target was set is at its
// target, and the layout starts from the cat's target.
test("at a fractional display scale the HUD layout settles: no repeated native moves or settings writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-placement-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_TEST_TOKEN: "scale" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  FakeBrowserWindow.readBack = (bounds) => ({ x: bounds.x - 1, y: bounds.y - 1, width: bounds.width + 2, height: bounds.height + 2 });
  t.after(async () => { FakeBrowserWindow.readBack = null; await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  const preview = async () => {
    const response = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/companion-preview`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-test-token": "scale" },
      body: JSON.stringify({ connected: true, messages: [], terminal: {} })
    });
    assert.equal(response.status, 200);
    await response.text();
  };
  await preview();
  await preview();
  const writes = settingsWrites(runtime);
  const base = await writes.quiet();
  let moves = 0;
  for (const window of FakeBrowserWindow.windowsByWebContents.values()) {
    const setBounds = window.setBounds.bind(window);
    window.setBounds = (bounds) => { moves++; setBounds(bounds); };
  }
  const cat = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) =>
    String(window.loadedFile).endsWith(path.join("renderer", "overlay.html")));
  const catBefore = cat.getBounds();
  for (let i = 0; i < 20; i++) await preview();
  assert.equal(moves, 0, "no window is moved again once the cluster stands");
  assert.deepEqual(cat.getBounds(), catBefore, "the cat does not creep");
  await writes.settle(base, "no settings write per layout pass");
});
