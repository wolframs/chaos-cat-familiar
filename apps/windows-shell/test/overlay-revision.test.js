// The cat's overlay on its own port (process-split plan, step 7; on main's adapter in step 5): the core's sessions and
// approvals come straight from the core, main's part as ccf:shell-state, and the page reports the revision it drew;
// "show the overlay" waits for that report. A fake page stands in for overlay.js: it subscribes as the page does and
// composes what it would draw with the page's own composeOverlayState.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, FakeTray } from "../test-support/fake-electron.js";
import { flattenMenu } from "../services/companion-menu.js";
import { fakeView, until } from "../test-support/fake-view.js";
import { OVERLAY_TOPICS, composeOverlayState } from "../renderer/overlay-state.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-overlay-revision-"));
  const electron = createFakeElectron({ home: root, appData: root });
  let tray = null;
  electron.Tray = class extends FakeTray { constructor(icon) { super(icon); tray = this; } };
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession: { getSnapshot() { return { connected: false, terminal: {} }; }, on() {}, async stop() {} },
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop().catch(() => {}); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const started = await runtime.start();
  const overlay = [...FakeBrowserWindow.windowsByWebContents.values()].find((item) => String(item.loadedFile ?? "").endsWith("overlay.html"));
  const view = await fakeView(electron, overlay, { topics: OVERLAY_TOPICS });
  t.after(() => view.close());
  const initialShell = await electron.ipcMain.invokeFrom(overlay.webContents, "ccf:get-shell-state");
  const shell = () => overlay.webContents.sent.filter((message) => message.channel === "ccf:shell-state").at(-1)?.payload ?? initialShell;
  const drawn = () => (view.state() ? composeOverlayState(view.state(), shell(), view.mirror) : null);
  const post = async (body) => fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, { method: "POST",
    headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken }, body: JSON.stringify(body) });
  const report = (payload) => electron.ipcMain.emit("ccf:view-revision", { sender: overlay.webContents }, payload);
  const trayItem = (id) => flattenMenu(tray.menu.template).find((entry) => entry.id === id);
  return { electron, runtime, overlay, view, post, report, drawn, trayItem };
}

test("the overlay's port carries sessions and approvals; it draws live sessions and counts, main sends no ccf:state", async (t) => {
  const { overlay, view, post, drawn } = await fixture(t);
  for (let i = 0; i < 4; i++) await (await post({ hook_event_name: "SessionStart", session_id: `o-${i}`, cwd: `C:/o/${i}` })).text();
  await (await post({ hook_event_name: "SessionEnd", session_id: "o-0", cwd: "C:/o/0" })).text();
  await (await post({ hook_event_name: "SessionEnd", session_id: "o-1", cwd: "C:/o/1" })).text();
  await (await post({ hook_event_name: "Notification", session_id: "o-2", notification_type: "idle_prompt", message: "waiting" })).text();
  const state = await until(() => drawn()?.meta?.eventCount === 7 && drawn()?.ui?.overlay?.toast?.sessionId === "o-1" && drawn(),
    "all seven events and the toast");
  assert.deepEqual(view.state().notifications, [], "no notification list on the port");
  assert.deepEqual(view.state().events, [], "no event history on the port");
  assert.ok(state.meta.unreadNotificationCount >= 1, "notifications are counted");
  assert.deepEqual(state.sessions.map((session) => session.id).sort(), ["o-1", "o-2", "o-3"],
    "an ended session is left out unless the toast or an approval names it");
  assert.equal(state.meta.sessionCount, 4);
  assert.ok(Number.isInteger(state.meta.revision) && state.meta.revision > 0, "the state names its revision");
  assert.equal(overlay.webContents.sent.filter((message) => message.channel === "ccf:state").length, 0, "main sent no ccf:state");
});

test("showing the overlay waits until the overlay reported drawing the approval's revision", async (t) => {
  const { overlay, post, report, drawn } = await fixture(t);
  await (await post({ hook_event_name: "SessionStart", session_id: "w-1", cwd: "C:/w" })).text();
  const first = await until(() => drawn()?.meta?.revision > 0 && drawn(), "a state");
  report({ view: "overlay", revision: first.meta.revision, epoch: first.meta.epoch });
  overlay.hide();
  const held = post({ hook_event_name: "PermissionRequest", session_id: "w-1", cwd: "C:/w", tool_name: "Bash", tool_input: { command: "x" } });
  const withApproval = await until(() => drawn()?.approvals?.length === 1 && drawn(), "the approval on the overlay's port");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(overlay.isVisible(), false, "not shown before the overlay drew it");
  report({ view: "overlay", revision: withApproval.meta.revision, epoch: withApproval.meta.epoch });
  assert.equal(overlay.isVisible(), true, "shown once it reported that revision");
  held.catch(() => {});
});

test("Minimize to Tray while a show waits for the overlay's report: the held show does not bring the cat back", async (t) => {
  const { runtime, overlay, post, report, drawn, trayItem } = await fixture(t);
  await (await post({ hook_event_name: "SessionStart", session_id: "m-1", cwd: "C:/m" })).text();
  const first = await until(() => drawn()?.meta?.revision > 0 && drawn(), "a state");
  report({ view: "overlay", revision: first.meta.revision, epoch: first.meta.epoch });
  if (!overlay.isVisible()) await trayItem("show-companion").click();
  assert.equal(overlay.isVisible(), true);
  const held = post({ hook_event_name: "PermissionRequest", session_id: "m-1", cwd: "C:/m", tool_name: "Bash", tool_input: { command: "x" } });
  await until(() => drawn()?.approvals?.length === 1, "the approval on the overlay's port");
  await trayItem("minimize-to-tray").click();
  assert.equal(overlay.isVisible(), false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(overlay.isVisible(), false, "the show held for the report ran out after the minimize and stayed hidden");
  assert.equal(runtime.snapshot().settings.overlayVisible, false);
  held.catch(() => {});
});

test("an overlay that does not report in time is shown anyway, and one that never reported is not waited for", async (t) => {
  const { overlay, post, report, drawn } = await fixture(t);
  await (await post({ hook_event_name: "SessionStart", session_id: "x-1", cwd: "C:/x" })).text();
  overlay.hide();
  const unreported = post({ hook_event_name: "PermissionRequest", session_id: "x-1", cwd: "C:/x", tool_name: "Bash", tool_input: { command: "a" } });
  await until(() => overlay.isVisible(), "shown at once: this overlay never reported", 2000);
  const state = await until(() => drawn()?.approvals?.length === 1 && drawn(), "the first approval");
  report({ view: "overlay", revision: state.meta.revision, epoch: state.meta.epoch });
  overlay.hide();
  const late = post({ hook_event_name: "PermissionRequest", session_id: "x-1", cwd: "C:/x", tool_name: "Edit", tool_input: { file_path: "b" } });
  await until(() => drawn()?.approvals?.length === 2, "the second approval");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(overlay.isVisible(), false, "held for the report");
  await until(() => overlay.isVisible(), "shown after the wait ran out", 2000);
  unreported.catch(() => {});
  late.catch(() => {});
});

test("composeOverlayState: counts from the core's summary, live sessions, the hosted companion's session kept", () => {
  const core = { sessions: [{ id: "a", status: "active" }, { id: "b", status: "ended" }, { id: "h", status: "ended" }],
    approvals: [], notifications: [], events: [], logs: [],
    notificationSummary: { unreadCount: 3, pendingApprovalHistoryCount: 2 }, summary: { eventCount: 12 } };
  const shell = { meta: { overlayMode: "mascot" }, ui: { overlay: {} }, hostedCompanion: { sessionId: "h" },
    hostedSession: { id: "h", status: "ended" } };
  const state = composeOverlayState(core, shell, { revision: 5, epoch: 9 });
  assert.deepEqual(state.sessions.map((session) => session.id), ["h", "a"]);
  assert.deepEqual({ unread: state.meta.unreadNotificationCount, history: state.meta.approvalHistoryCount,
    events: state.meta.eventCount, revision: state.meta.revision, epoch: state.meta.epoch, mode: state.meta.overlayMode },
  { unread: 3, history: 2, events: 12, revision: 5, epoch: 9, mode: "mascot" });
});
