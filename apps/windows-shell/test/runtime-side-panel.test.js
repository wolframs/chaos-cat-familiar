import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsShellRuntime, refusedFileReason } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, FakeTray } from "../test-support/fake-electron.js";
import { flattenMenu } from "../services/companion-menu.js";
import { PANEL_SCHEMA } from "../renderer/companion-panel-model.js";

const hookInstaller = {
  async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true }, registeredEvents: [] }; },
  async install() { return { ok: true, action: "install" }; },
  async repair() { return { ok: true, action: "repair" }; }
};
const mascotLibrary = { list() { return { mascots: [] }; }, async warmBundledAssets() {} };
const fakeSession = () => ({ getSnapshot: () => ({ connected: false, phase: "offline", messages: [], terminal: {} }),
  on() {}, off() {}, async start() {}, async stop() {} });

function capturingTimers() {
  const intervals = new Map();
  let next = 1;
  return { intervals, setTimeout, clearTimeout,
    setInterval(callback, ms) { const id = next++; intervals.set(id, { callback, ms }); return id; },
    clearInterval(id) { intervals.delete(id); } };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function panelJson(text) {
  return JSON.stringify({ schema: PANEL_SCHEMA, generatedAt: new Date().toISOString(), staleAfterSec: 420, title: "companion",
    sections: [{ id: "tickets", title: "Tickets", items: [{ id: "t1", text, link: "https://example.invalid/123", copy: "#123" }] }] });
}

async function fixture(t, { settings = {}, mode = "mascot", panel = "#123 Example ticket", services = {}, state = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-side-panel-"));
  const panelFile = path.join(root, "repos", "work-companion", "state", "panel.json");
  fs.mkdirSync(path.dirname(panelFile), { recursive: true });
  if (panel) fs.writeFileSync(panelFile, panelJson(panel));
  fs.mkdirSync(path.join(root, "chaos-cat-familiar"), { recursive: true });
  fs.writeFileSync(path.join(root, "chaos-cat-familiar", "settings.json"), JSON.stringify(settings));
  if (state) fs.writeFileSync(path.join(root, "chaos-cat-familiar", "state.json"), JSON.stringify(state(root)));
  const electron = createFakeElectron({ home: root, appData: root });
  let tray;
  electron.Tray = class extends FakeTray { constructor(icon) { super(icon); tray = this; } };
  electron.dialog = { showErrorBox() {} };
  // The core's client, to change a setting the way an edit outside main does (the core pushes it to main).
  let coreClient = null;
  const CoreHost = electron.inProcessHosts.core;
  electron.inProcessHosts = { ...electron.inProcessHosts,
    core: class extends CoreHost { constructor(options) { super(options); coreClient = options.client; } } };
  const timers = capturingTimers();
  const activations = [];
  const activationResult = { value: { ok: true } };
  const runtime = createWindowsShellRuntime({ electron, timers,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: mode, CCF_TEST_TOKEN: "fixture" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: { companionSession: fakeSession(), hookInstaller, mascotLibrary,
      activation: { async activateTerminal(payload) { activations.push(payload); return activationResult.value; },
        async activateEditor() { return { ok: true }; } }, ...services }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const started = await runtime.start();
  const control = (route, body) => fetch(`http://127.0.0.1:${started.runtime.controlPort}${route}`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-test-token": "fixture" }, body: JSON.stringify(body) });
  const hook = (route, body) => fetch(`http://127.0.0.1:${started.runtime.hookPort}${route}`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken }, body: JSON.stringify(body) });
  const windows = () => [...FakeBrowserWindow.windowsByWebContents.values()];
  const find = (file) => windows().find((window) => String(window.loadedFile).endsWith(path.join("renderer", file)));
  const cluster = () => ({ cat: find("overlay.html"), conversation: find("companion-conversation.html"),
    status: find("companion-status.html"), panel: find("companion-panel.html"), bubble: find("companion-bubble.html") });
  const trayItem = (id) => flattenMenu(tray.menu.template).find((entry) => entry.id === id);
  const activate = async () => { assert.equal((await control("/companion-preview", null)).status, 200); return cluster(); };
  return { root, panelFile, electron, runtime, started, timers, activations, activationResult, control, hook, cluster, trayItem, activate,
    tray: () => tray, settings: () => runtime.snapshot().settings, coreClient: () => coreClient };
}

test("the side panel shows with the cluster, left of the conversation, and its feed pushes file changes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.cluster().panel, undefined, "no panel window before the cluster shows");
  const { panel, conversation } = await f.activate();
  assert.ok(panel?.isVisible());
  assert.equal(panel.options.focusable, false, "a click on the panel must not take keyboard focus");
  assert.equal(panel.getTitle(), "Chaos Cat Familiar Companion Panel");
  assert.equal(panel.getBounds().x + panel.getBounds().width, conversation.getBounds().x);
  assert.equal(panel.getBounds().y, conversation.getBounds().y);
  assert.equal(panel.getBounds().height, conversation.getBounds().height);
  const first = await until(async () => (await f.electron.ipcMain.invoke("ccf:get-side-panel"))?.status === "ok"
    && f.electron.ipcMain.invoke("ccf:get-side-panel"), "the first read");
  assert.equal(first.panel.sections[0].items[0].text, "#123 Example ticket");

  fs.writeFileSync(f.panelFile, panelJson("#456 Changed ticket"));
  const pushed = await until(() => panel.webContents.sent.find((message) => message.channel === "ccf:side-panel"
    && message.payload?.panel?.sections[0].items[0].text === "#456 Changed ticket"), "the change pushed to the panel", 6000);
  assert.equal(pushed.payload.status, "ok");

  // The menu's Side Panel checkbox hides it and stops the feed; on again shows it.
  await f.trayItem("side-panel").click();
  assert.equal(f.settings().sidePanelVisible, false);
  assert.equal(panel.isVisible(), false);
  const sends = panel.webContents.sent.length;
  fs.rmSync(f.panelFile);
  await delay(2600);
  assert.equal(panel.webContents.sent.length, sends, "no feed while the panel is off");
  await f.trayItem("side-panel").click();
  assert.equal(panel.isVisible(), true);
  await until(() => panel.webContents.sent.some((message) => message.channel === "ccf:side-panel" && message.payload?.status === "missing"),
    "the feed running again (the file is gone)");
});

test("side panel actions: links open (programs refused), text copies, sessions focus their terminal", async (t) => {
  const f = await fixture(t);
  await f.activate();
  const act = (payload) => f.electron.ipcMain.invoke("ccf:side-panel-action", payload);
  assert.deepEqual(await act({ action: "open-link", url: "https://dev.example.invalid/item/123" }), { ok: true });
  assert.deepEqual(f.electron.shell.openExternalCalls, ["https://dev.example.invalid/item/123"]);
  const note = path.join(f.root, "pinned notes.md");
  fs.writeFileSync(note, "# pinned");
  assert.deepEqual(await act({ action: "open-link", url: pathToFileURL(note).href }), { ok: true });
  assert.deepEqual(f.electron.shell.openPathCalls, [note]);
  const folder = path.join(f.root, "a folder");
  fs.mkdirSync(folder);
  assert.deepEqual(await act({ action: "open-link", url: pathToFileURL(folder).href }), { ok: true });
  assert.deepEqual(f.electron.shell.openPathCalls, [note, folder]);
  // Only document types and folders open: an existing script of a type nobody listed (.pyw runs through pyw.exe) is
  // refused as well as the classic program types.
  for (const name of ["run.ps1", "tool.js", "app.exe", "start.CMD", "tool.py", "gui.pyw", "noextension", "x.psd1",
    "trick.ps1.", "data.txt:stream"]) {
    const file = path.join(f.root, name.replace(/[.:]+$/, ""));
    if (!/[:.]$|:/.test(name)) fs.writeFileSync(file, "print('ran')");
    const result = await act({ action: "open-link", url: `${pathToFileURL(path.join(f.root, "x")).href.slice(0, -1)}${encodeURIComponent(name)}` });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /Refused/, name);
    assert.ok(!f.electron.shell.openPathCalls.includes(file), name);
  }
  const special = path.join(f.root, "panel.{21EC2020-3AEA-1069-A2DD-08002B30309D}");
  fs.mkdirSync(special);
  assert.match((await act({ action: "open-link", url: pathToFileURL(special).href })).reason, /Refused/);
  assert.equal(f.electron.shell.openPathCalls.length, 2);
  for (const name of ["notes.md", "report.PDF", "shot.png", "page.html", "data.json", "sheet.xlsx"]) {
    assert.equal(refusedFileReason(`C:\\x\\${name}`), null, name);
  }
  for (const name of ["macro.xlsm", "legacy.doc", "script.py", "gui.pyw", "x.vbs"]) {
    assert.match(refusedFileReason(`C:\\x\\${name}`), /Refused/, name);
  }
  // The conversation's links go the same way.
  await assert.rejects(f.electron.ipcMain.invoke("ccf:companion-action", { action: "open-link",
    url: pathToFileURL(path.join(f.root, "evil.ps1")).href }), /Refused/);
  assert.deepEqual(await act({ action: "open-link", url: "javascript:alert(1)" }), { ok: false, reason: "Only web and file links open." });

  assert.deepEqual(await act({ action: "copy", text: "L-239" }), { ok: true });
  assert.equal(f.electron.clipboard.text, "L-239");
  assert.equal((await act({ action: "copy", text: "x".repeat(201) })).ok, false);

  assert.deepEqual(await act({ action: "focus-session", sessionId: "not-a-known-session" }), { ok: false, reason: "unknown_session" });
  assert.equal((await f.control("/inject-event", { kind: "hook", payload: { hook_event_name: "SessionStart",
    session_id: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b", cwd: "C:/repos/project", shell_pid: 4242, source: "startup" } })).status, 202);
  await until(() => f.runtime.snapshot().state.sessions.some((session) => session.id === "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b"), "the session");
  assert.deepEqual(await act({ action: "focus-session", sessionId: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b" }),
    { ok: true, exact: false }, "the page says 'window raised': the tab was not confirmed");
  assert.equal(f.activations.length, 1);
  assert.equal(f.activations[0].shellPid, 4242);
  assert.equal(f.activations[0].launchFallback, false, "a row click never opens a new terminal");
  assert.match(f.activations[0].projectDir, /project/);
  f.activationResult.value = { ok: false, reason: "no_terminal_window" };
  assert.deepEqual(await act({ action: "focus-session", sessionId: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b" }),
    { ok: false, reason: "no_terminal_window" });
  assert.equal((await f.control("/inject-event", { kind: "hook", payload: { hook_event_name: "SessionEnd",
    session_id: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b", cwd: "C:/repos/project" } })).status, 202);
  await until(() => f.runtime.snapshot().state.sessions.some((session) => session.status === "ended"), "the end");
  assert.deepEqual(await act({ action: "focus-session", sessionId: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b" }),
    { ok: false, reason: "session_ended" });
  assert.equal(f.activations.length, 2, "an ended session's row raises nothing");
});

test("side panel mark-done: one JSON line next to the panel file, the key handed back verbatim", async (t) => {
  const f = await fixture(t);
  await f.activate();
  const act = (payload) => f.electron.ipcMain.invoke("ccf:side-panel-action", payload);
  const log = path.join(path.dirname(f.panelFile), "panel-done.jsonl");
  assert.deepEqual(await act({ action: "mark-done", key: "codex:01a1f433@2026-11-19T15:45:58+01:00", text: "codex · project-2" }),
    { ok: true });
  assert.deepEqual(await act({ action: "mark-done", key: "a8bd68be-d097@2026-11-19T16:00:00+01:00" }), { ok: true });
  assert.deepEqual(await act({ action: "mark-done", key: "../evil path" }), { ok: false, reason: "no_done_key" });
  assert.deepEqual(await act({ action: "mark-done" }), { ok: false, reason: "no_done_key" });
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].key, "codex:01a1f433@2026-11-19T15:45:58+01:00");
  assert.equal(lines[0].text, "codex · project-2");
  assert.equal(lines[1].text, null);
  assert.ok(Number.isFinite(Date.parse(lines[0].at)));
});

test("the core sweeps Claude Code's session registry at start (dead sessions end; assessment 2026-11-17)", async (t) => {
  const calls = [];
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const session = (id, transcriptPath) => ({ id, status: "active", phase: "idle", backend: "claude", eventCount: 2,
    startedAt: old, lastEventAt: old, transcriptPath });
  const f = await fixture(t, {
    state: (home) => ({ events: [], notifications: [], settings: {}, sessions: [
      session("dead", path.join(home, ".claude", "projects", "p", "dead.jsonl")),
      // Review 2, finding 1: a WSL session (another registry) and one without a known transcript are never swept.
      session("wsl", "/home/dev/.claude/projects/p/wsl.jsonl"),
      session("unknown", null)] }),
    services: { liveClaudeSessionIds: async (candidates) => { calls.push([...candidates]); return new Set(); } } });
  for (let i = 0; i < 50 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [["dead"]], "the registry is asked about in-scope candidates only");
  const status = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${f.started.runtime.hookPort}/state`,
      { headers: { "x-ccf-token": f.started.settings.hookToken } });
    const sessions = (await response.json()).sessions ?? [];
    return sessions.find((s) => s.id === "dead")?.status === "ended" ? sessions : null;
  }, "the dead session to end");
  assert.deepEqual(Object.fromEntries(status.map((s) => [s.id, s.status])), { dead: "ended", wsl: "active", unknown: "active" });
});

test("Always on Top off: no window on top, no watchdog, no repair; a cat click raises with moveTop; on again restores", async (t) => {
  const f = await fixture(t);
  const { cat, conversation, status, panel } = await f.activate();
  const all = [status, panel, conversation, cat];
  assert.ok(all.every((window) => window.alwaysOnTopLevel === "pop-up-menu"));
  assert.equal(f.timers.intervals.size, 1);
  assert.equal(f.trayItem("always-on-top").checked, true);

  await f.trayItem("always-on-top").click();
  assert.equal(f.settings().clusterAlwaysOnTop, false);
  assert.ok(all.every((window) => window.isAlwaysOnTop() === false), "every cluster window leaves the topmost band");
  assert.equal(f.timers.intervals.size, 0, "the watchdog would undo the choice within 2 s");
  assert.equal(f.trayItem("always-on-top").checked, false);
  for (const window of all) window.zOrderCalls.length = 0;
  conversation.emit("blur");
  cat.emit("blur");
  await delay(50);
  assert.ok(all.every((window) => !window.zOrderCalls.some((call) => call.call === "setAlwaysOnTop" && call.flag)),
    "blur repairs nothing while off");
  const order = [];
  for (const window of all) {
    const original = window.moveTop.bind(window);
    window.moveTop = () => { order.push(window); return original(); };
  }
  cat.emit("focus");
  assert.deepEqual(order, [status, panel, conversation, cat], "a click on the cat brings the cluster up in stack order");

  await f.trayItem("always-on-top").click();
  assert.equal(f.settings().clusterAlwaysOnTop, true);
  assert.ok(all.every((window) => window.isAlwaysOnTop() && window.alwaysOnTopLevel === "pop-up-menu"));
  assert.equal(f.timers.intervals.size, 1, "the watchdog runs again");
});

test("Always on Top follows the setting from every path: the settings window's update and the core's settings push", async (t) => {
  const f = await fixture(t);
  const { cat, conversation, status, panel } = await f.activate();
  const all = [status, panel, conversation, cat];
  await f.electron.ipcMain.invoke("ccf:update-settings", { clusterAlwaysOnTop: false });
  assert.ok(all.every((window) => window.isAlwaysOnTop() === false), "ccf:update-settings takes the windows off the top");
  assert.equal(f.timers.intervals.size, 0, "and stops the watchdog");
  assert.equal(f.trayItem("always-on-top").checked, false);

  // An edit of settings.json outside CCF reaches main only as the core's settings push (the in-process core of these
  // tests does not watch the file, so the change goes to the core directly, past main).
  await f.coreClient().request("settings.update", { patch: { clusterAlwaysOnTop: true } });
  await until(() => all.every((window) => window.isAlwaysOnTop() && window.alwaysOnTopLevel === "pop-up-menu"),
    "the pushed setting puts the cluster back on top");
  assert.equal(f.timers.intervals.size, 1, "the watchdog runs again");
  assert.equal(f.trayItem("always-on-top").checked, true);
});

test("a runtime started with clusterAlwaysOnTop off creates its windows not on top", async (t) => {
  const f = await fixture(t, { settings: { clusterAlwaysOnTop: false } });
  const { cat, conversation, status, panel } = await f.activate();
  for (const window of [cat, conversation, status, panel]) assert.equal(window.isAlwaysOnTop(), false, window.getTitle());
  assert.equal(f.timers.intervals.size, 0);
  // A new bubble brings the cat and the bubbles up once instead.
  cat.zOrderCalls.length = 0;
  assert.equal((await f.hook("/companion/bubble", { text: "Meow! temp is waiting" })).status, 200);
  const { bubble } = f.cluster();
  assert.ok(bubble?.isVisible());
  assert.equal(bubble.isAlwaysOnTop(), false);
  assert.ok(cat.zOrderCalls.some((call) => call.call === "moveTop"));
  assert.ok(bubble.zOrderCalls.some((call) => call.call === "moveTop"));
});

test("Minimize to Tray hides the whole cluster; approvals and bubbles do not bring it back in mascot mode", async (t) => {
  const f = await fixture(t);
  await f.activate();
  assert.equal((await f.hook("/companion/bubble", { text: "Meow! one" })).status, 200);
  const { cat, conversation, status, panel, bubble } = f.cluster();
  assert.ok([cat, conversation, status, panel, bubble].every((window) => window.isVisible()));
  await f.trayItem("minimize-to-tray").click();
  assert.ok([cat, conversation, status, panel, bubble].every((window) => !window.isVisible()), "everything hidden");
  assert.equal(f.settings().overlayVisible, false);
  assert.equal(f.trayItem("minimize-to-tray").enabled, false);
  assert.equal(f.tray().toolTip, "Chaos Cat Familiar · 1 waiting");

  assert.equal((await f.control("/inject-event", { kind: "hook", payload: { hook_event_name: "PermissionRequest",
    session_id: "approval-session", cwd: "C:/repos/project", tool_name: "Edit", tool_input: { file_path: "C:/repos/project/a.js" } } })).status, 202);
  await until(() => f.runtime.snapshot().state.approvals.length === 1, "the approval");
  assert.equal((await f.hook("/companion/bubble", { text: "Meow! two" })).status, 200);
  await delay(400);
  assert.equal(cat.isVisible(), false, "an approval does not bring the cat back");
  assert.equal(f.cluster().bubble.isVisible(), false, "new bubbles stack hidden");
  await until(() => f.tray().toolTip === "Chaos Cat Familiar · 1 approval · 2 waiting", "the tooltip counting both");
  assert.equal(f.trayItem("show-companion").label, "Show Companion · 3 waiting");

  f.tray().emit("click");
  await delay(10);
  assert.ok([cat, conversation, status, panel, f.cluster().bubble].every((window) => window.isVisible()),
    "a tray click restores everything, bubbles included");
  assert.equal(f.tray().toolTip, "Chaos Cat Familiar");
  assert.equal(f.settings().overlayVisible, true);
});

test("in developer mode an approval still shows the hidden overlay", async (t) => {
  const f = await fixture(t, { mode: "developer", settings: { overlayVisible: false } });
  const { cat } = f.cluster();
  assert.equal(cat.isVisible(), false);
  assert.equal((await f.control("/inject-event", { kind: "hook", payload: { hook_event_name: "PermissionRequest",
    session_id: "approval-session", cwd: "C:/repos/project", tool_name: "Edit", tool_input: { file_path: "C:/repos/project/a.js" } } })).status, 202);
  await until(() => cat.isVisible(), "the overlay shown for the approval");
});

test("the cat's right-click pops the cat menu on the overlay window; its items run the tray's actions", async (t) => {
  const f = await fixture(t);
  const { cat, panel } = await f.activate();
  assert.equal(await f.electron.ipcMain.invoke("ccf:show-companion-menu"), true);
  const popup = f.electron.Menu.popupCalls.at(-1);
  assert.equal(popup.window, cat);
  assert.deepEqual(popup.template.map((item) => item.id ?? item.type), ["show-companion", "always-on-top", "side-panel",
    "minimize-to-tray", "separator", "dashboard", "settings"]);
  await popup.template.find((item) => item.id === "side-panel").click();
  assert.equal(panel.isVisible(), false);
  assert.equal(f.settings().sidePanelVisible, false);
  const menuClick = await f.control("/menu-click", { surface: "cat", id: "minimize-to-tray" });
  assert.equal(menuClick.status, 200);
  assert.equal(cat.isVisible(), false);
  assert.equal((await f.control("/menu-click", { surface: "cat", id: "quit" })).status, 400, "no Quit on the cat");
});
