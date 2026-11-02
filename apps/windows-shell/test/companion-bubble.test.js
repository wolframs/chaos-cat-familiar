import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";
import { BUBBLE_TAIL_TIP } from "../services/companion-bubble-layout.js";

const hookInstaller = { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } };
const mascotLibrary = { list() { return { mascots: [] }; }, async warmBundledAssets() {} };
const companionSession = { getSnapshot: () => ({ connected: false, phase: "offline", messages: [], terminal: {} }),
  on() {}, off() {}, async start() {}, async stop() {} };

function windowFor(file) {
  return [...FakeBrowserWindow.windowsByWebContents.values()]
    .find((window) => String(window.loadedFile).endsWith(path.join("renderer", file))) ?? null;
}

test("companion bubbles stack above the cat until each is clicked away", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-bubble-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: { hookInstaller, mascotLibrary, companionSession, random: () => 0.5 }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const started = await runtime.start();
  const { hookToken } = JSON.parse(fs.readFileSync(path.join(root, "chaos-cat-familiar", "settings.json"), "utf8"));
  const post = (body) => fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/bubble`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-token": hookToken }, body: JSON.stringify(body) });

  const cat = windowFor("overlay.html");
  cat.setBounds({ x: 100, y: 800, width: 168, height: 144 });
  cat.show();
  assert.equal(windowFor("companion-bubble.html"), null, "no bubble window until there is a bubble");

  const first = await post({ text: "Meow! api-1 is like \"dude, i can haz input plx?!\"", style: "plum" });
  assert.deepEqual(await first.json(), { ok: true, shown: true });
  await post({ text: "Meow! Your agents are like \"dude, i can haz input plx?!\"", special: true });
  const bubble = windowFor("companion-bubble.html");
  assert.ok(bubble?.isVisible());
  assert.equal(bubble.options.focusable, false, "a bubble never steals focus");
  assert.equal(bubble.isAlwaysOnTop(), true);
  assert.equal(bubble.ignoresMouseEvents, true, "empty space around the bubbles is click-through");
  const catBounds = cat.getBounds();
  const tip = { x: bubble.getBounds().x + BUBBLE_TAIL_TIP.x, y: bubble.getBounds().y + BUBBLE_TAIL_TIP.y };
  assert.ok(tip.x > catBounds.x && tip.x < catBounds.x + catBounds.width && tip.y >= catBounds.y);

  const stack = await electron.ipcMain.invoke("ccf:get-companion-bubbles");
  assert.deepEqual(stack.map(({ style, special }) => ({ style, special })),
    [{ style: "plum", special: false }, { style: "comic", special: true }]);
  assert.deepEqual(bubble.webContents.sent.at(-1), { channel: "ccf:companion-bubbles", payload: stack });

  electron.ipcMain.emit("ccf:companion-bubble-pointer", { sender: bubble.webContents }, true);
  assert.equal(bubble.ignoresMouseEvents, false);

  // Hiding the cat hides the stack; it comes back with the cat.
  cat.hide(); cat.emit("hide");
  assert.equal(bubble.isVisible(), false);
  cat.show(); cat.emit("show");
  assert.equal(bubble.isVisible(), true);

  electron.ipcMain.emit("ccf:companion-bubble-dismiss", { sender: bubble.webContents }, stack[0].id);
  assert.deepEqual((await electron.ipcMain.invoke("ccf:get-companion-bubbles")).map((item) => item.id), [stack[1].id]);
  assert.equal(bubble.isDestroyed(), false);
  electron.ipcMain.emit("ccf:companion-bubble-dismiss", { sender: bubble.webContents }, stack[1].id);
  assert.equal(bubble.isDestroyed(), true, "the last click releases the window");
  assert.equal(windowFor("companion-bubble.html"), null);
});

test("an event bubble gets its line from the cat's catalog; free text still works", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-bubble-event-"));
  const electron = createFakeElectron({ home: root, appData: root });
  let roll = 0.5;
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: { hookInstaller, mascotLibrary, companionSession, random: () => roll,
      now: () => new Date(2026, 10, 2, 14, 0).getTime() }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const started = await runtime.start();
  const { hookToken } = JSON.parse(fs.readFileSync(path.join(root, "chaos-cat-familiar", "settings.json"), "utf8"));
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/bubble`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-token": hookToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const cat = windowFor("overlay.html");
  cat.setBounds({ x: 100, y: 800, width: 168, height: 144 });
  cat.show();

  // 0.5 everywhere: no lore, a common line, the middle one; style and 1-in-7 roll as before.
  assert.deepEqual(await post({ event: "task_done", placeholders: { agent: "api-1 and temp" } }),
    { status: 200, body: { ok: true, shown: true, tier: "common", kind: "event", text: "Task complete. I supervised. Very closely." } });
  roll = 0.995;
  assert.deepEqual((await post({ event: "task_done", placeholders: { agent: "temp" } })).body.text,
    "temp finished on the first try. The prophecy is fulfilled.");
  roll = 0.5;
  assert.equal((await post({ text: "Guten Morgen. Montag, 08:12." })).status, 200, "the companion's own greeting is free text");
  assert.equal((await post({ event: "nap_time", text: "Meow! temp is like \"dude, i can haz input plx?!\"" })).status, 200,
    "an event the catalog lacks falls back to the text sent along");
  assert.deepEqual(await post({ event: "nap_time" }), { status: 400, body: { error: "unknown_bubble_event" } });

  const stack = await electron.ipcMain.invoke("ccf:get-companion-bubbles");
  assert.deepEqual(stack.map(({ text, special }) => ({ text, special })), [
    { text: "Task complete. I supervised. Very closely.", special: false },
    { text: "temp finished on the first try. The prophecy is fulfilled.", special: true },
    { text: "Guten Morgen. Montag, 08:12.", special: false },
    { text: "Meow! temp is like \"dude, i can haz input plx?!\"", special: false }
  ]);
});
