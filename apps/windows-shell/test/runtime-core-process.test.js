// The whole runtime with its core in a real child process (fake Electron windows, the Node stand-in for Electron's
// utilityProcess, the production core entrypoint and composition, real hook files in a temp home).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, nodeUtilityProcess } from "../test-support/fake-electron.js";
import { fakeView, until } from "../test-support/fake-view.js";
import { OVERLAY_TOPICS, composeOverlayState } from "../renderer/overlay-state.js";

// wrapChild(child): what the host gets instead of the forked child (a test can hide its exit event).
async function fixture(t, { port = "0", restartDelaysMs = [50], coreProcess = {}, quitDeadlinesMs = undefined,
  wrapChild = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-core-process-"));
  const electron = createFakeElectron({ home: root, appData: root });
  electron.utilityProcess = nodeUtilityProcess();
  if (wrapChild) {
    const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    electron.utilityProcess.fork = (...args) => wrapChild(fork(...args));
  }
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: port, CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession: { getSnapshot() { return { connected: false, terminal: {} }; }, on() {}, async stop() {} },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} },
      coreLogToConsole: false,
      coreProcess: { restartDelaysMs, ...coreProcess },
      ...(quitDeadlinesMs ? { quitDeadlinesMs } : {})
    }
  });
  t.after(async () => {
    // Bounded: a failing quit test must not hang the file.
    await Promise.race([runtime.stop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    for (const child of electron.utilityProcess.children) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = await runtime.start();
  const data = path.join(root, "chaos-cat-familiar");
  return { root, data, electron, runtime, started, claudeSettings: path.join(root, ".claude", "settings.json") };
}

async function waitFor(read, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function hookUrl(claudeSettingsPath) {
  try { return JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")).hooks?.Stop?.[0]?.hooks?.[0] ?? null; } catch { return null; }
}

function window(file) {
  return [...FakeBrowserWindow.windowsByWebContents.values()].find((item) => !item.destroyed
    && String(item.loadedFile ?? "").endsWith(file));
}

function hold(port, token, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/hook",
      headers: { "content-type": "application/json", "x-ccf-token": token, "content-length": Buffer.byteLength(payload) } },
    (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode })); });
    request.on("error", (error) => resolve({ status: "disconnected", error: error.code }));
    request.end(payload);
  });
}

test("startup order: the core reports its authenticated port first, then main has hooks installed for exactly that port", { timeout: 60000 }, async (t) => {
  const { started, claudeSettings, data, runtime } = await fixture(t);
  assert.equal(started.runtime.core.mode, "utility");
  assert.notEqual(started.runtime.core.pid, process.pid);
  const hook = await waitFor(() => hookUrl(claudeSettings), "hook installation");
  assert.equal(hook.url, `http://127.0.0.1:${started.runtime.hookPort}/hook`);
  assert.equal(hook.headers["X-Ccf-Token"], started.settings.hookToken);
  await runtime.stop();
  const log = fs.readFileSync(path.join(data, "logs", "chaos-cat-familiar.log"), "utf8");
  const listening = log.indexOf("Hook server listening");
  const installed = log.indexOf("Claude hooks installed or updated");
  assert.ok(listening >= 0 && installed > listening, "hooks were written only after the server listened and was probed");
  assert.match(log, /Chaos Cat Familiar starting/, "main's lines reach the core's log file");
  assert.match(log, /Stopping Windows shell runtime/);
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), false, "a clean quit");
  assert.equal(fs.existsSync(path.join(data, "runtime.json")), false);
});

test("a core crash under the runtime: approvals pause, the windows drop them, and hooks follow a port change", { timeout: 60000 }, async (t) => {
  // The restart waits long enough for the test to take the port first.
  const { started, electron, runtime, claudeSettings } = await fixture(t, { restartDelaysMs: [600] });
  await waitFor(() => hookUrl(claudeSettings), "hook installation");
  await electron.ipcMain.invoke("ccf:open-dashboard");
  const dashboard = window("dashboard.html");
  const overlay = window("overlay.html");
  // What the overlay page draws: the core's part on its own port, main's part as ccf:shell-state (step 7).
  const overlayView = await fakeView(electron, overlay, { topics: OVERLAY_TOPICS });
  t.after(() => overlayView.close());
  const overlayShell = () => overlay.webContents.sent.filter((message) => message.channel === "ccf:shell-state").at(-1)?.payload;
  const overlayDrawn = () => composeOverlayState(overlayView.state() ?? {}, overlayShell(), overlayView.mirror);
  const token = started.settings.hookToken;
  const port = started.runtime.hookPort;
  const held = hold(port, token, { hook_event_name: "PermissionRequest", session_id: "rc-1", cwd: "C:/rc", tool_name: "Bash",
    tool_input: { command: "echo held" } });
  const approval = await waitFor(() => runtime.snapshot().state.approvals[0], "the approval");
  // The dashboard's page takes the core's state on its own port; main sends it none (step 7).
  const dashboardView = await fakeView(electron, dashboard, { topics: ["base", "events"], eventLimit: 50 });
  t.after(() => dashboardView.close());
  const firstEpoch = await until(() => dashboardView.mirror?.epoch, "the dashboard's projection");

  // Another program takes the port while the core is down: the restarted core falls back and main repairs hooks.
  const blocker = http.createServer((_req, res) => res.end("other"));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  process.kill(started.runtime.core.pid);
  assert.equal((await held).status, "disconnected");
  await waitFor(() => runtime.snapshot().runtime.core.status === "recovering", "recovering");
  await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(port, "127.0.0.1", resolve); });
  await assert.rejects(electron.ipcMain.invoke("ccf:approval-action", { id: approval.id, action: "allow" }),
    /restarting/, "a stale approval cannot be clicked");
  const drawn = await until(() => overlayShell()?.meta?.coreStatus === "recovering" && overlayDrawn(), "the overlay told of the restart");
  assert.ok(overlayView.state()?.approvals?.length, "the overlay's last state from the old core still holds the approval");
  assert.deepEqual(drawn.approvals, [], "the overlay drops it while the core recovers");

  await waitFor(() => runtime.snapshot().runtime.core.status === "ready" && runtime.snapshot().runtime.hookPort !== port,
    "the restarted core on a new port");
  const newPort = runtime.snapshot().runtime.hookPort;
  const hook = await waitFor(() => { const value = hookUrl(claudeSettings); return value?.url.includes(`:${newPort}/`) && value; },
    "hooks repaired for the new port");
  assert.equal(hook.headers["X-Ccf-Token"], token, "same token");
  assert.equal(JSON.parse(fs.readFileSync(path.join(started.runtime.metadataPath), "utf8")).hookPort, newPort);
  await until(() => dashboardView.ports === 2 && dashboardView.mirror.epoch > firstEpoch, "the dashboard's port from the restarted core");
  assert.equal(dashboard.webContents.sent.filter((message) => message.channel === "ccf:state").length, 0, "main sent the dashboard no state");
});

// The child process as a host would see it if the platform never reported its exit (review of step 5, P2: once, a core
// killed during the dashboard's first hook diagnosis went unnoticed by main for over 20 s under Electron).
function withoutExitEvents(child) {
  return new Proxy(child, {
    get(target, key) {
      if (key === "on" || key === "once") {
        return (event, listener) => (event === "exit" ? target : target[key](event, listener));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("a core killed during its first hook diagnosis is noticed without an exit event, and restarted", { timeout: 60000 }, async (t) => {
  const { started, electron, runtime } = await fixture(t, { wrapChild: withoutExitEvents,
    coreProcess: { livenessMs: 200 } });
  const pid = started.runtime.core.pid;
  // The detailed diagnosis starts PowerShell children in the core.
  const diagnosis = electron.ipcMain.invoke("ccf:diagnose-hooks").catch((error) => error);
  await waitFor(async () => (await runtime.diagnosticsSummary()).pendingHookOperations > 0, "the diagnosis running");
  await new Promise((resolve) => setTimeout(resolve, 300));   // its PowerShell children have started
  process.kill(pid);
  const killedAt = Date.now();
  await waitFor(() => runtime.snapshot().runtime.core.status === "recovering", "main notices the dead core", 5000);
  assert.ok(Date.now() - killedAt < 3000, `noticed after ${Date.now() - killedAt} ms`);
  await diagnosis;
  await waitFor(() => runtime.snapshot().runtime.core.status === "ready" && runtime.snapshot().runtime.core.pid !== pid,
    "the restarted core");
});

test("settings: a patch from main is written by the core; an edit outside CCF shows in main", { timeout: 60000 }, async (t) => {
  const { electron, runtime, data } = await fixture(t);
  const updated = await electron.ipcMain.invoke("ccf:update-settings", { overlayOpacity: 0.6, notifications: { minPriority: "urgent" } });
  assert.equal(updated.overlayOpacity, 0.6);
  assert.deepEqual(updated.notifications, { enabled: true, minPriority: "urgent" });
  const settingsPath = path.join(data, "settings.json");
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(onDisk.overlayOpacity, 0.6);
  fs.writeFileSync(settingsPath, JSON.stringify({ ...onDisk, hookRelayPort: 49151 }));
  await waitFor(() => runtime.snapshot().settings.hookRelayPort === 49151, "the outside edit in main's mirror");
});

// Review 2026-11-05 (P1): quit waited for hook-file work and for settings answers without a deadline, so a hung core
// kept quit from ever reaching the core host's own shutdown deadline and kill.
test("quit reaches the kill deadline when the core stops answering", { timeout: 60000 }, async (t) => {
  const hung = new URL("../test-support/hung-core-process.js", import.meta.url);
  const { electron, runtime, data } = await fixture(t, {
    coreProcess: { modulePath: fileURLToPath(hung), exitDeadlineMs: 100 },
    quitDeadlinesMs: { hooks: 200, intake: 200, companion: 200, settings: 200, core: 200 } });
  const [child] = electron.utilityProcess.children;
  // The startup hook check is stuck in the core; so is a settings write.
  electron.ipcMain.invoke("ccf:update-settings", { overlayOpacity: 0.4 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  const stopped = await Promise.race([runtime.stop().then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 8000))]);
  assert.equal(stopped, "stopped", "quit must not wait on a core that never answers");
  assert.ok(Date.now() - started < 8000);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, "the hung core is gone");
  assert.equal(fs.existsSync(path.join(data, "run-marker.json")), true, "an unconfirmed flush is not a clean quit");
});
