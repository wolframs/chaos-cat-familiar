import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createWindowsShellRuntime
} from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow } from "../test-support/fake-electron.js";

const tempRoots = [];
after(() => { for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
function makeTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-test-"));
  tempRoots.push(root);
  return root;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("default startup keeps the mascot alone and utility windows are released on demand", async (t) => {
  const root = makeTempDir();
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  assert.equal(started.settings.appShellMode, "mascot");
  electron.app.getAppMetrics = () => [];
  assert.equal(started.settings.debugLogging, false);
  assert.equal(started.settings.performanceProfiling, false);
  await electron.ipcMain.invoke("ccf:update-settings", { debugLogging: true, performanceProfiling: true });
  let logStatus = await electron.ipcMain.invoke("ccf:get-log-metadata");
  assert.equal(logStatus.debugLogging, true);
  assert.equal(logStatus.performance.enabled, true);
  assert.equal(logStatus.performance.samples.length, 1);
  await electron.ipcMain.invoke("ccf:update-settings", { debugLogging: false, performanceProfiling: false });
  logStatus = await electron.ipcMain.invoke("ccf:get-log-metadata");
  assert.equal(logStatus.debugLogging, false);
  assert.equal(logStatus.performance.enabled, false);

  const windows = () => [...FakeBrowserWindow.windowsByWebContents.values()];
  assert.equal(windows().length, 1, "only the cat exists before work-companion activation");
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await electron.ipcMain.invoke("ccf:open-dashboard");
    const dashboard = windows().find((window) => window.getTitle().endsWith("Dashboard"));
    assert.ok(dashboard?.isVisible());
    dashboard.close();
    assert.ok(dashboard.isDestroyed());
    assert.equal(windows().length, 1);
  }
});

for (const duplicateBy of ["toolUseId", "signature"]) {
  test(`HTTP approval disconnects preserve duplicate waiters (${duplicateBy}) and refresh the shell`, async (t) => {
    const root = makeTempDir();
    const home = path.join(root, "home");
    const appData = path.join(root, "appdata");
    const electron = createFakeElectron({ home, appData });
    const runtime = createWindowsShellRuntime({
      electron,
      processLike: {
        env: { CCF_HOME_OVERRIDE: home, CCF_APPDATA_OVERRIDE: appData, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
        argv: ["node", "main.js"], defaultApp: true, execPath: process.execPath, pid: process.pid
      },
      services: {
        hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } },
        mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
      }
    });
    const requests = [];
    t.after(async () => {
      for (const request of requests) request.destroy();
      await runtime.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const started = await runtime.start();
    const overlay = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay.html"))
    );
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 2000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(predicate(), "expected approval state before deadline");
    };
    const sendPermission = () => {
      let responded = false;
      const request = http.request({ host: "127.0.0.1", port: started.runtime.hookPort, method: "POST", path: "/hook",
        headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken } });
      const response = new Promise((resolve) => {
        request.on("response", (res) => {
          responded = true;
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        request.on("error", (error) => resolve({ error }));
      });
      request.setTimeout(2000, () => request.destroy(new Error("approval_response_timeout")));
      const payload = { hook_event_name: "PermissionRequest", session_id: "disconnect-test", tool_name: "Bash",
        tool_input: { command: duplicateBy === "toolUseId" ? `echo ${requests.length}` : "echo test" },
        ...(duplicateBy === "toolUseId" ? { tool_use_id: "tool-1" } : {}) };
      request.end(JSON.stringify(payload));
      requests.push(request);
      return { request, response, responded: () => responded };
    };
    const first = sendPermission();
    await waitFor(() => runtime.snapshot().state.approvals.length === 1);
    const id = runtime.snapshot().state.approvals[0].id;
    const stateMessages = () => overlay.webContents.sent.filter((message) => message.channel === "ccf:state");
    const beforeDuplicate = stateMessages().length;
    const second = sendPermission();
    await waitFor(() => stateMessages().length > beforeDuplicate);
    const beforeDisconnect = stateMessages().length;
    first.request.destroy();
    await waitFor(() => stateMessages().length > beforeDisconnect);
    assert.equal(runtime.snapshot().state.approvals[0]?.id, id);
    assert.equal(second.responded(), false);
    const resolved = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/approvals/${id}/allow`, { method: "POST", headers: { "x-ccf-token": started.settings.hookToken } });
    assert.equal(resolved.status, 200);
    const response = await second.response;
    assert.equal(response.status, 200);
    assert.equal(response.body.hookSpecificOutput.decision.behavior, "allow");
    const last = sendPermission();
    await waitFor(() => runtime.snapshot().state.approvals.length === 1);
    last.request.destroy();
    await waitFor(() => runtime.snapshot().state.approvals.length === 0);
    await waitFor(() => stateMessages().at(-1)?.payload.approvals.length === 0);
  });
}

test("runtime start writes metadata, exposes control plane, and shuts down cleanly", async (t) => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const electron = createFakeElectron({ home, appData });
  electron.app.loginItemSettings.openAtLogin = true;
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0",
        CCF_TEST_MODE: "1",
        CCF_TEST_TOKEN: "token-1"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      }
    }
  });

  t.after(() => runtime.stop());
  const started = await runtime.start();
  assert.equal(started.runtime.hookPort > 0, true);
  assert.equal(started.runtime.controlPort > 0, true);
  assert.equal(started.state.ui.onboarding.required, true);
  assert.deepEqual(electron.app.protocolRegistrations, []);
  assert.equal(electron.app.loginItemSettings.openAtLogin, true);
  assert.deepEqual(electron.globalShortcut.bindings, []);

  const metadata = readJson(started.runtime.metadataPath);
  assert.equal(metadata.hookPort, started.runtime.hookPort);
  assert.equal(metadata.controlPort, started.runtime.controlPort);

  const readyResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/ready`, {
    headers: { "x-ccf-test-token": "token-1" }
  });
  assert.equal(readyResponse.status, 200);

  const injectResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/inject-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-1"
    },
    body: JSON.stringify({
      kind: "hook",
      payload: {
        hook_event_name: "SessionStart",
        session_id: "runtime-test-session",
        cwd: "C:/repo",
        source: "startup"
      }
    })
  });
  assert.equal(injectResponse.status, 202);

  const awaitStateResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/await-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-1"
    },
    body: JSON.stringify({
      type: "session",
      match: {
        id: "runtime-test-session",
        assistantLabel: "Claude"
      }
    })
  });
  assert.equal(awaitStateResponse.status, 200);

  const diagnosticsResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/diagnostics-summary`, {
    headers: { "x-ccf-test-token": "token-1" }
  });
  assert.equal(diagnosticsResponse.status, 200);
  const diagnosticsSummary = await diagnosticsResponse.json();
  assert.equal(diagnosticsSummary.activeSessionCount, 1);

  const resetOnboardingResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/dispatch-command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-1"
    },
    body: JSON.stringify({
      command: "complete-onboarding"
    })
  });
  assert.equal(resetOnboardingResponse.status, 200);

  const snapshotResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/snapshot`, {
    headers: { "x-ccf-test-token": "token-1" }
  });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.state.ui.onboarding.completed, true);

  const shutdownResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/shutdown`, {
    method: "POST",
    headers: { "x-ccf-test-token": "token-1" }
  });
  assert.equal(shutdownResponse.status, 202);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(electron.globalShortcut.unregisterAllCalls > 0, true);
  assert.equal(fs.existsSync(started.runtime.metadataPath), false);
});

test("runtime falls back to an ephemeral port when the preferred port is busy", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const server = await import("node:http").then(({ createServer }) => {
    const instance = createServer((_req, res) => {
      res.writeHead(200);
      res.end("busy");
    });
    return new Promise((resolve) => {
      instance.listen(0, "127.0.0.1", () => resolve(instance));
    });
  });
  const busyPort = server.address().port;

  const electron = createFakeElectron({ home, appData });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: String(busyPort)
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      }
    }
  });

  const started = await runtime.start();
  assert.notEqual(started.runtime.hookPort, busyPort);
  assert.equal(started.settings.port, started.runtime.hookPort);

  await runtime.stop();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("runtime opens the dashboard window and queues a Claude approval through the control plane", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const electron = createFakeElectron({ home, appData });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0",
        CCF_TEST_MODE: "1",
        CCF_TEST_TOKEN: "token-2"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      }
    }
  });

  const started = await runtime.start();

  const openDashboard = await electron.ipcMain.invoke("ccf:open-dashboard");
  assert.equal(openDashboard, true);
  const dashboardWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
    String(window.loadedFile ?? "").endsWith(path.join("renderer", "dashboard.html"))
  );
  assert.equal(Boolean(dashboardWindow?.isVisible()), true);

  const injectResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/inject-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-2"
    },
    body: JSON.stringify({
      kind: "hook",
      payload: {
        hook_event_name: "PermissionRequest",
        session_id: "claude-session",
        cwd: "C:/repo/app",
        tool_name: "Edit",
        tool_input: { file_path: "C:/repo/app/app.js" }
      }
    })
  });
  assert.equal(injectResponse.status, 202);

  const awaitApprovalResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/await-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-2"
    },
    body: JSON.stringify({
      type: "approval",
      match: {
        assistantLabel: "Claude"
      }
    })
  });
  assert.equal(awaitApprovalResponse.status, 200);

  const secondSessionResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/inject-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-2"
    },
    body: JSON.stringify({
      kind: "hook",
      payload: {
        hook_event_name: "SessionStart",
        session_id: "second-session",
        cwd: "C:/repo/other"
      }
    })
  });
  assert.equal(secondSessionResponse.status, 202);

  const openSwitcherResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/dispatch-command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-2"
    },
    body: JSON.stringify({
      command: "open-session-switcher"
    })
  });
  assert.equal(openSwitcherResponse.status, 200);

  const switcherSnapshot = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/snapshot`, {
    headers: { "x-ccf-test-token": "token-2" }
  }).then((response) => response.json());
  assert.equal(switcherSnapshot.state.ui.overlay.sessionSwitcher.isOpen, true);
  assert.equal(switcherSnapshot.state.ui.overlay.sessionSwitcher.sessions.length >= 2, true);

  await runtime.stop();
});

test("mascot app-mode override starts with the compact overlay and does not auto-open the dashboard", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const electron = createFakeElectron({ home, appData });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0",
        CCF_APP_MODE_OVERRIDE: "mascot"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      }
    }
  });

  try {
    const started = await runtime.start();
    const overlayWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay.html"))
    );
    const dashboardWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "dashboard.html"))
    );
    let overlayContextWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay-context.html"))
    );
    const overlayStatsWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay-stats.html"))
    );

    assert.equal(started.settings.appShellMode, "mascot");
    assert.equal(started.state.ui.onboarding.required, true);
    assert.equal(overlayWindow?.getBounds().width, 168);
    assert.equal(overlayWindow?.getBounds().height, 144);
    assert.equal(Boolean(overlayWindow?.isVisible()), true);
    assert.equal(Boolean(dashboardWindow?.isVisible()), false);
    assert.equal(Boolean(overlayContextWindow), false);
    assert.equal(Boolean(overlayStatsWindow), false);
    assert.equal(Boolean(overlayContextWindow?.isVisible()), false);

    await electron.ipcMain.invoke("ccf:dispatch-command", {
      command: "open-context-menu",
      payload: { mode: "main" }
    });
    overlayContextWindow = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) => window.getTitle().endsWith("Context"));
    assert.equal(Boolean(overlayContextWindow?.isVisible()), false, "the retired cat popup must not be created");

    await electron.ipcMain.invoke("ccf:dispatch-command", {
      command: "close-context-menu",
      payload: {}
    });
    assert.equal(Boolean(overlayContextWindow?.isVisible()), false);
  } finally {
    await runtime.stop();
  }
});

test("companion HUDs anchor to the cat and test mode cannot start Claude", async () => {
  const root = makeTempDir();
  const electron = createFakeElectron({ home: root, appData: root });
  let starts = 0;
  let connected = false;
  const sizes = [];
  const replies = [];
  const sent = [];
  let failSend = false;
  const companionSession = {
    getSnapshot: () => ({ connected, phase: connected ? "idle" : "offline", title: "Work companion", messages: [], terminal: {} }),
    on() {},
    recordAssistantMessage: (text, options) => replies.push({ text, options }),
    async start() { starts += 1; },
    resize(cols, rows) { sizes.push({ cols, rows }); },
    send(text) { if (failSend) throw new Error("Simulated PTY failure"); sent.push(text); }
  };
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_APP_MODE_OVERRIDE: "mascot", CCF_TEST_TOKEN: "fixture" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession,
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  try {
    const started = await runtime.start();
    assert.equal([...FakeBrowserWindow.windowsByWebContents.values()].some((window) =>
      String(window.loadedFile).endsWith(path.join("renderer", "companion-conversation.html"))), false);
    const previewResponse = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/companion-preview`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-test-token": "fixture" },
      body: JSON.stringify({ connected: true, phase: "idle", messages: [], terminal: {} })
    });
    assert.equal(previewResponse.status, 200);
    const windows = [...FakeBrowserWindow.windowsByWebContents.values()];
    const cat = windows.find((window) => String(window.loadedFile).endsWith(path.join("renderer", "overlay.html")));
    const conversation = windows.find((window) => String(window.loadedFile).endsWith(path.join("renderer", "companion-conversation.html")));
    const status = windows.find((window) => String(window.loadedFile).endsWith(path.join("renderer", "companion-status.html")));
    assert.ok(conversation?.isVisible());
    assert.ok(status?.isVisible());
    assert.equal(status.ignoresMouseEvents, true);
    assert.ok(conversation.getBounds().y + conversation.getBounds().height < cat.getBounds().y);
    assert.ok(status.getBounds().x >= cat.getBounds().x + cat.getBounds().width);
    assert.ok(status.getBounds().y >= cat.getBounds().y);
    assert.ok(status.getBounds().y + status.getBounds().height <= cat.getBounds().y + cat.getBounds().height);
    cat.setBounds({ width: 271, height: 312 });
    await electron.ipcMain.invoke("ccf:update-settings", { overlayVisible: true });
    assert.equal(cat.getBounds().width, 168, "old or DPI-inflated bounds cannot skew the visible alignment");
    assert.equal(cat.getBounds().height, 144);
    let prevented = false;
    conversation.webContents.emit("before-input-event", { preventDefault() { prevented = true; } },
      { type: "keyDown", control: true, code: "NumpadAdd", key: "+" });
    assert.equal(prevented, true, "text sizing intercepts Electron's page zoom accelerator");
    assert.deepEqual(conversation.webContents.sent.at(-1), { channel: "ccf:companion-text-size", payload: 1 });
    connected = true;
    await electron.ipcMain.invoke("ccf:companion-action", { action: "resize", cols: 72, rows: 18 });
    assert.deepEqual(sizes, [{ cols: 72, rows: 18 }], "text size reflows the hosted terminal through the existing PTY");
    connected = false;
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VVcAAAAASUVORK5CYII=";
    await electron.ipcMain.invoke("ccf:companion-action", { action: "attach-image", name: "Screenshot.png", dataUrl: png });
    const queued = (await electron.ipcMain.invoke("ccf:get-companion")).attachments[0];
    assert.ok(queued.path.startsWith(root));
    assert.ok(fs.existsSync(queued.path));
    failSend = true;
    await assert.rejects(electron.ipcMain.invoke("ccf:companion-action", { action: "send", text: "Look at this", attachmentIds: [queued.id] }), /PTY failure/);
    assert.equal((await electron.ipcMain.invoke("ccf:get-companion")).attachments.length, 1, "failed send retains the image");
    failSend = false;
    await electron.ipcMain.invoke("ccf:companion-action", { action: "send", text: "Look at this", attachmentIds: [queued.id] });
    assert.ok(sent[0].includes(queued.path), "the PTY receives a supported image file reference");
    assert.equal((await electron.ipcMain.invoke("ccf:get-companion")).attachments.length, 0);
    assert.ok(fs.existsSync(queued.path), "sent image remains available to the session");
    assert.equal(starts, 0);
    const statusPayload = { session_id: "fixture-session", cwd: path.join(root, "repos", "work-companion"),
      context_window: { used_percentage: 27 } };
    const statusResponse = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/status`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken },
      body: JSON.stringify(statusPayload)
    });
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await electron.ipcMain.invoke("ccf:get-companion-status"), statusPayload);
    assert.deepEqual(status.webContents.sent.at(-1), { channel: "ccf:companion-status", payload: statusPayload });
    const stopResponse = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken },
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "fixture-session", cwd: statusPayload.cwd,
        last_assistant_message: "The three tickets are ready." })
    });
    assert.equal(stopResponse.status, 200);
    assert.equal(replies[0]?.text, "The three tickets are ready.");
    const blockedOpen = await fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/open`, {
      method: "POST", headers: { "x-ccf-token": started.settings.hookToken }
    });
    assert.equal(blockedOpen.status, 503);
    await assert.rejects(electron.ipcMain.invoke("ccf:companion-action", { action: "start" }), /test mode/i);
    assert.equal(starts, 0);
  } finally {
    await runtime.stop();
  }
});

test("runtime start does not block on mascot asset warmup before showing the overlay", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const electron = createFakeElectron({ home, appData });
  let warmCalled = false;
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0",
        CCF_APP_MODE_OVERRIDE: "mascot"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      },
      mascotLibrary: {
        list() {
          return {
            currentMascotId: "bundled:masko",
            mascots: []
          };
        },
        warmBundledAssets() {
          warmCalled = true;
          return new Promise(() => {});
        }
      }
    }
  });

  try {
    const started = await Promise.race([
      runtime.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("runtime_start_blocked_on_mascot_warmup")), 2000))
    ]);
    const overlayWindow = Array.from(FakeBrowserWindow.windowsByWebContents.values()).find((window) =>
      String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay.html"))
    );
    assert.equal(started.settings.appShellMode, "mascot");
    assert.equal(warmCalled, true);
    assert.equal(Boolean(overlayWindow?.isVisible()), true);
  } finally {
    await runtime.stop();
  }
});

test("cleanup actions remove only CCF-owned files and toast state appears for completed sessions", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".chaos-cat-familiar", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(appData, "chaos-cat-familiar", "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1"), "ccf");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: `powershell -File "${path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1")}"` },
            { type: "command", command: "python keep-me.py" }
          ]
        }
      ]
    }
  }, null, 2));

  const electron = createFakeElectron({ home, appData });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0",
        CCF_TEST_MODE: "1",
        CCF_TEST_TOKEN: "token-3"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          return { ok: true, action: "repair", registeredEvents: [] };
        },
        async uninstall() {
          return { ok: true, action: "uninstall" };
        }
      }
    }
  });

  const started = await runtime.start();
  await fetch(`http://127.0.0.1:${started.runtime.controlPort}/inject-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ccf-test-token": "token-3"
    },
    body: JSON.stringify({
      kind: "hook",
      payload: {
        hook_event_name: "Stop",
        session_id: "done-session",
        cwd: "C:/repo/done",
        source: "claude",
        last_assistant_message: "Done"
      }
    })
  });
  const snapshotWithToast = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/snapshot`, {
    headers: { "x-ccf-test-token": "token-3" }
  }).then((response) => response.json());
  assert.equal(snapshotWithToast.state.ui.overlay.toast.projectName, "done");

  const removeHooksResult = await electron.ipcMain.invoke("ccf:cleanup-action", {
    action: "remove-hooks"
  });
  assert.equal(removeHooksResult.ok, true);
  const updatedClaude = readJson(path.join(home, ".claude", "settings.json"));
  assert.equal(updatedClaude.hooks.Stop[0].hooks.length, 1);
  assert.equal(updatedClaude.hooks.Stop[0].hooks[0].command, "python keep-me.py");

  await runtime.stop();
});

test("settings update that changes the port restarts the hook server and repairs hooks", async () => {
  const root = makeTempDir();
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  let repairCalls = 0;
  const electron = createFakeElectron({ home, appData });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: {
      env: {
        CCF_HOME_OVERRIDE: home,
        CCF_APPDATA_OVERRIDE: appData,
        CCF_PORT_OVERRIDE: "0"
      },
      argv: ["node", "main.js"],
      defaultApp: true,
      execPath: process.execPath,
      pid: process.pid
    },
    services: {
      hookInstaller: {
        async diagnose() {
          return {
            hookExists: true,
            registeredEvents: [],
            drift: { healthy: true, missingEvents: [], unexpectedCommands: [] },
            health: { ok: true }
          };
        },
        async install() {
          return { ok: true, action: "install", registeredEvents: [] };
        },
        async repair() {
          repairCalls += 1;
          return { ok: true, action: "repair", registeredEvents: [] };
        }
      }
    }
  });

  const started = await runtime.start();
  const initialPort = started.runtime.hookPort;
  const nextPort = initialPort + 10;

  const updated = await electron.ipcMain.invoke("ccf:update-settings", {
    port: nextPort
  });

  assert.equal(updated.port, nextPort);
  assert.equal(repairCalls, 1);

  const healthResponse = await fetch(`http://127.0.0.1:${nextPort}/health`);
  assert.equal(healthResponse.status, 200);

  await runtime.stop();
});

test("slow startup hook checks do not delay the visible overlay or overlap manual repairs", async (t) => {
  const root = makeTempDir();
  const electron = createFakeElectron({ home: root, appData: root });
  let releaseDiagnosis;
  const diagnosis = new Promise((resolve) => { releaseDiagnosis = resolve; });
  let diagnosisStarted;
  const checking = new Promise((resolve) => { diagnosisStarted = resolve; });
  const calls = [];
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: {
        async diagnose(options) { assert.deepEqual(options, { detailed: false }); calls.push("diagnose"); diagnosisStarted(); return diagnosis; },
        async repair() { calls.push("repair"); return { ok: true, action: "repair" }; }
      },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { releaseDiagnosis({ hookExists: true, drift: { healthy: true } }); await runtime.stop(); });
  const starting = runtime.start();
  await checking;
  const result = await Promise.race([starting, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
  assert.ok(result, "startup must complete while hook diagnosis is pending");
  const overlay = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) =>
    String(window.loadedFile ?? "").endsWith(path.join("renderer", "overlay.html")));
  assert.equal(overlay.isVisible(), true);
  const repairing = electron.ipcMain.invoke("ccf:repair-hooks");
  await Promise.resolve();
  assert.deepEqual(calls, ["diagnose"]);
  releaseDiagnosis({ hookExists: true, drift: { healthy: true } });
  await repairing;
  assert.deepEqual(calls, ["diagnose", "repair"]);
});

test("shutdown waits for active hook checks and skips startup writes and queued repairs", async (t) => {
  const root = makeTempDir();
  const electron = createFakeElectron({ home: root, appData: root });
  let releaseDiagnosis;
  const diagnosis = new Promise((resolve) => { releaseDiagnosis = resolve; });
  const writes = [];
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: {
        async diagnose() { return diagnosis; },
        async install() { writes.push("install"); },
        async repair() { writes.push("repair"); }
      },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { releaseDiagnosis({ hookExists: false }); await runtime.stop(); });
  const starting = runtime.start();
  const ready = await Promise.race([starting, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
  assert.ok(ready, "startup must complete while hook diagnosis is pending");
  const queuedRepair = electron.ipcMain.invoke("ccf:repair-hooks");
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releaseDiagnosis({ hookExists: false });
  await Promise.all([stopping, queuedRepair]);
  assert.deepEqual(writes, []);
});

test("Electron's repeated dev security warning stays out of the console and log", async (t) => {
  const root = makeTempDir();
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({
    electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" },
      argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); });
  await runtime.start();
  const cat = [...FakeBrowserWindow.windowsByWebContents.values()].find((window) => window.getTitle().endsWith("Overlay"));
  const warning = "%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security Policy set";
  for (let reload = 0; reload < 3; reload += 1) cat.webContents.emit("console-message", {}, 2, warning, 1, "electron/js2c/renderer_init");
  cat.webContents.emit("console-message", {}, 1, "mascot ready", 10, "overlay.js");
  // The console receives exactly the lines the log file gets.
  const log = fs.readFileSync(path.join(root, "chaos-cat-familiar", "logs", "chaos-cat-familiar.log"), "utf8");
  assert.equal(log.includes("Security Warning"), false);
  assert.match(log, /overlay: mascot ready/, "other renderer output still reaches the log");
});
