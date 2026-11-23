import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";
import { fakeView, until } from "../test-support/fake-view.js";
import { OVERLAY_TOPICS, composeOverlayState } from "../renderer/overlay-state.js";

// 2026-11-05 (FreezeWatch + ETW): each hook event made the main thread open settings.json ~100 times (once per
// retained session) and publish the full ~0.7 MB state to the overlay twice; with an endpoint scanner holding
// every open, the cat's window hung 0.15-1.1 s per event. These tests pin the per-event cost.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-hook-cost-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_TEST_TOKEN: "hook-cost-test" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  const headers = { "content-type": "application/json", "x-ccf-token": started.settings.hookToken };
  async function post(body) {
    const response = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, {
      method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    await response.text();
  }
  async function settle(count) {
    const deadline = Date.now() + 3000;
    while (runtime.snapshot().state.events.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(runtime.snapshot().state.events.length, count);
  }
  return { electron, runtime, post, settle, settingsPath: path.join(root, "chaos-cat-familiar", "settings.json") };
}

function overlayWindow() {
  return [...FakeBrowserWindow.windowsByWebContents.values()].find((w) => /overlay\.html$/.test(w.loadedFile ?? "") && !w.destroyed);
}

test("a hook event neither rereads settings per session nor publishes the state twice", async (t) => {
  const { electron, post, settle, settingsPath } = await fixture(t);
  for (let i = 0; i < 40; i++) await post({ hook_event_name: "SessionStart", session_id: `s-${i}`, cwd: "C:/fixture" });
  await settle(40);
  const overlay = overlayWindow();
  assert.ok(overlay, "the overlay window exists");
  const realRead = fs.readFileSync;
  let settingsReads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === "string" && path.resolve(file) === path.resolve(settingsPath)) settingsReads++;
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });
  // The overlay's own port (process-split plan, step 7): one frame per event, never two; main sends it no state.
  const view = await fakeView(electron, overlay, { topics: OVERLAY_TOPICS });
  t.after(() => view.close());
  await until(() => view.state()?.summary?.eventCount === 40, "the overlay's projection");
  const sentBefore = view.states.length;
  for (let i = 0; i < 5; i++) {
    await post({ hook_event_name: "PreToolUse", session_id: "s-3", cwd: "C:/fixture", tool_name: "Bash",
      tool_input: { command: `echo ${"x".repeat(2000)} ${i}` } });
  }
  await settle(45);
  fs.readFileSync = realRead;
  assert.equal(settingsReads, 0, "settings come from memory");
  await until(() => view.state()?.summary?.eventCount === 45, "the five events on the overlay's port");
  const states = view.states.slice(sentBefore);
  assert.ok(states.length >= 1 && states.length <= 5, `at most one frame per event: ${states.length}`);
  assert.equal(overlay.webContents.sent.filter((m) => m.channel === "ccf:state").length, 0, "main sends the overlay no state");
  const last = composeOverlayState(view.state(), null, view.mirror);
  assert.deepEqual(last.events, [], "the overlay does not get the event history");
  assert.equal(last.meta.eventCount, 45);
  assert.deepEqual(last.logs, []);
});
