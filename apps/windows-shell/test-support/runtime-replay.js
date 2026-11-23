// Runtime behaviour replay (process-split plan, step 1): JSON scenarios in ../test/fixtures/replay drive the whole
// shell runtime (fake Electron, real HookServer, a recording companion session) and pin what the companion session
// is told (identity, presentation, assistant replies, lifecycle commands), what the windows receive, and what IPC
// returns. The fixtures must pass unchanged while the runtime moves behind service boundaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron, FakeBrowserWindow, nodeUtilityProcess } from "./fake-electron.js";
import { fakeView } from "./fake-view.js";
import { OVERLAY_TOPICS, composeOverlayState } from "../renderer/overlay-state.js";
import { assertSubset, summarizeState } from "../../../packages/core/test/support/replay.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "replay");

export function loadRuntimeReplayFixtures() {
  return fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).sort()
    .map((name) => ({ file: name, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) }));
}

// A companion session double that records every call the runtime makes, in order.
export function recordingCompanion({ cwd, backend = "claude", connected = true } = {}) {
  const session = new EventEmitter();
  const calls = [];
  const snapshot = { backend, connected, phase: connected ? "idle" : "offline", title: "Work companion",
    messages: [], terminal: {}, conversationId: null };
  const record = (method, behaviour) => (...args) => {
    calls.push({ method, args: JSON.parse(JSON.stringify(args)) });
    return behaviour?.(...args);
  };
  Object.assign(session, {
    getSnapshot: () => ({ ...snapshot }),
    sessions: { claude: { spec: { cwd }, getSnapshot: () => ({ connected: snapshot.connected && snapshot.backend === "claude" }) } },
    observeConversation: record("observeConversation"),
    recordAssistantMessage: record("recordAssistantMessage"),
    updatePresentation: record("updatePresentation"),
    start: record("start", async () => { snapshot.connected = true; }),
    stop: record("stop", async () => {}),
    selectBackend: record("selectBackend", (next) => {
      if (!["claude", "codex"].includes(next)) throw new Error("Unsupported companion backend.");
      snapshot.backend = next;
    }),
    switchBackend: record("switchBackend", async ({ userInitiated }) => {
      if (!userInitiated) throw new Error("Explicit switch required");
    }),
    resolveUnknown: record("resolveUnknown"),
    resolveRequest: record("resolveRequest", async () => true),
    history: record("history", async () => ({ items: [{ id: "h-1" }] })),
    getOutput: record("getOutput", async () => "output"),
    recoverFailedStart: record("recoverFailedStart", async () => {}),
    write: record("write"),
    resize: record("resize"),
    interrupt: record("interrupt", async () => {}),
    submit: record("submit", async ({ id }) => ({ id, state: "accepted", turnId: "turn-1" }))
  });
  return { session, calls, snapshot };
}

function substitute(value, vars) {
  if (typeof value === "string") return value.replace(/\$(ROOT|COMPANION|OTHER)/g, (_, key) => vars[key]);
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  }
  return value;
}

function windowFor(kind) {
  const file = { overlay: "overlay.html", conversation: "companion-conversation.html", status: "companion-status.html",
    bubble: "companion-bubble.html", dashboard: "dashboard.html" }[kind];
  return [...FakeBrowserWindow.windowsByWebContents.values()]
    .filter((window) => !window.destroyed && String(window.loadedFile ?? "").endsWith(file)).at(-1) ?? null;
}

async function waitFor(read, predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

// The event count without the event history: a projection carries it as summary.eventCount (the history only goes to
// a detail view); a live in-process read has the history itself.
const eventCount = (state) => state.summary?.eventCount ?? state.events.length;

// coreProcess: run the core in a forked child (the utility-process stand-in) instead of in-process.
export async function runRuntimeReplay(fixture, { createRuntime = createWindowsShellRuntime, coreProcess = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-replay-"));
  const vars = { ROOT: root, COMPANION: path.join(root, "repos", "work-companion"), OTHER: path.join(root, "repos", "other") };
  const steps = substitute(fixture.steps, vars);
  const companion = recordingCompanion({ cwd: vars.COMPANION, ...(fixture.companion ?? {}) });
  const electron = createFakeElectron({ home: root, appData: root });
  if (coreProcess) electron.utilityProcess = nodeUtilityProcess();
  const runtime = createRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot", CCF_TEST_TOKEN: "runtime-replay" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      companionSession: companion.session,
      companionAttachments: { list: () => [], select: (ids) => ids.map((id) => ({ id, path: `${root}/${id}.png` })),
        markSent: (ids) => companion.calls.push({ method: "attachments.markSent", args: [ids] }) },
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, registeredEvents: [] }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} },
      catLines: { pick: (event) => event === "agent_idle" ? { text: "Idle again", tier: "common", kind: "line", special: false } : null },
      random: () => 0,
      coreLogToConsole: false
    }
  });
  const held = new Map();
  let overlay = null;
  try {
    const started = await runtime.start();
    const port = started.runtime.hookPort;
    const token = started.settings.hookToken;
    const post = (route, body, signal) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", signal,
      headers: { "content-type": "application/json", "x-ccf-token": token },
      body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (response) => {
        const text = await response.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        return { status: response.status, body: parsed };
      }, (error) => ({ status: "disconnected", error: error.name }));
    for (const [index, step] of steps.entries()) {
      const where = `${fixture.file} step ${index} (${step.do})`;
      switch (step.do) {
        case "hook": {
          const before = eventCount(runtime.snapshot().state);
          const result = await post("/hook", step.body);
          assert.equal(result.status, 200, `${where}: ${JSON.stringify(result.body)}`);
          await waitFor(() => eventCount(runtime.snapshot().state), (count) => count > before || count === 200, `${where} ingestion`);
          break;
        }
        case "permission": {
          const abort = new AbortController();
          held.set(step.as, { abort, response: post("/hook", step.body, abort.signal) });
          await waitFor(() => runtime.snapshot().state.approvals.length, (count) => count === step.waitApprovals,
            `${where} approvals`);
          break;
        }
        case "response":
          assertSubset(await held.get(step.of).response, step.expect, where);
          break;
        case "post":
          assertSubset(await post(step.route, step.body), step.expect, where);
          break;
        case "ipc": {
          const args = (step.args ?? []).map((arg) => arg === "$APPROVAL0" ? runtime.snapshot().state.approvals[0]?.id
            : arg && typeof arg === "object" && arg.id === "$APPROVAL0" ? { ...arg, id: runtime.snapshot().state.approvals[0]?.id }
              : arg && typeof arg === "object" && arg.id === "$NOTIFICATION0" ? { ...arg, id: runtime.snapshot().state.notifications[0]?.id }
                : arg);
          if (step.rejects) {
            await assert.rejects(electron.ipcMain.invoke(step.channel, ...args), new RegExp(step.rejects), where);
          } else {
            const result = await electron.ipcMain.invoke(step.channel, ...args);
            if (step.expect !== undefined) assertSubset(result, step.expect, where);
          }
          break;
        }
        case "companionChange":
          Object.assign(companion.snapshot, step.snapshot);
          companion.session.emit("change", { ...companion.snapshot });
          break;
        case "calls":
          assertSubset(companion.calls, step.expect, where);
          companion.calls.length = 0;
          break;
        case "sent": {
          const window = windowFor(step.window);
          if (step.absent) { assert.equal(window, null, `${where}: ${step.window} should not exist`); break; }
          assert.ok(window, `${where}: no ${step.window} window`);
          const messages = window.webContents.sent.filter((message) => message.channel === step.channel);
          assert.ok(messages.length, `${where}: nothing on ${step.channel}`);
          assertSubset(messages.at(-1).payload, step.expectLast, where);
          break;
        }
        case "state":
          assertSubset(summarizeState(runtime.snapshot().state), step.expect, where);
          break;
        // What the overlay page draws (process-split plan, step 7): its own port's state with main's part.
        case "overlay": {
          const window = windowFor("overlay");
          overlay ??= { view: await fakeView(electron, window, { topics: OVERLAY_TOPICS }),
            shell: await electron.ipcMain.invokeFrom(window.webContents, "ccf:get-shell-state") };
          const drawn = () => {
            const shell = window.webContents.sent.filter((message) => message.channel === "ccf:shell-state").at(-1)?.payload ?? overlay.shell;
            return overlay.view.state() ? composeOverlayState(overlay.view.state(), shell, overlay.view.mirror) : null;
          };
          const matches = (state) => { try { assertSubset(state, step.expect, where); return true; } catch { return false; } };
          assertSubset(await waitFor(drawn, (state) => state && matches(state), `${where} overlay`), step.expect, where);
          if (step.noLegacyState) assert.equal(window.webContents.sent.filter((message) => message.channel === "ccf:state").length, 0,
            `${where}: main sent the overlay ccf:state`);
          break;
        }
        case "settings":
          assertSubset(runtime.snapshot().settings, step.expect, where);
          break;
        default:
          assert.fail(`${where}: unknown step`);
      }
    }
  } finally {
    overlay?.view.close();
    for (const request of held.values()) request.abort.abort();
    await runtime.stop();
    for (const child of electron.utilityProcess?.children ?? []) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
