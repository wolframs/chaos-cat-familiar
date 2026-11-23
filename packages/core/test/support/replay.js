// Behaviour replay (process-split plan, step 1): JSON scenarios in ../fixtures/replay drive a core over real HTTP and
// pin what Claude Code and the shell observe: HTTP replies, held permission responses, disconnects, notification
// actions, the shell intents behind /companion/*, and a normalized summary of the state. Each scenario runs against
// every target, so the same fixtures prove that a boundary (in-process client today, a utility process later)
// behaves like the direct controller.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CcfCoreController, CoreClient, HookServer, ServiceEndpoint, applyEffect, createInProcessCore, parentSidePort }
  from "../../src/index.js";

export const REPLAY_TOKEN = "replay-token";
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "replay");

export function loadReplayFixtures() {
  return fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).sort()
    .map((name) => ({ file: name, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) }));
}

// The shell side of the core: toasts, overlay calls and the /companion/* intents, recorded in order.
export function createShellRecorder() {
  const recorder = {
    toasts: [], overlayShows: 0, intents: [],
    notifier: { async notify(notification) { recorder.toasts.push(notification.title); } },
    overlay: { showOverlay() { recorder.overlayShows++; }, updateOverlay() {}, hideOverlay() {} },
    onCompanionStatus: async (payload) => { recorder.intents.push({ kind: "status", sessionId: payload.session_id }); },
    onCompanionOpen: async (payload) => {
      recorder.intents.push({ kind: "open", backend: payload.backend ?? null });
      if (payload.backend === "codex") throw new Error("Work companion is already running (PID 1).");
    },
    onCompanionBubble: async (payload) => {
      recorder.intents.push({ kind: "bubble", text: payload.text, event: payload.event });
      return payload.event === "unknown_event" ? { shown: false, rejected: "unknown_bubble_event" } : { shown: true };
    }
  };
  return recorder;
}

// Today's wiring: the controller and HookServer used directly.
export function directTarget() {
  const shell = createShellRecorder();
  const controller = new CcfCoreController({ overlay: shell.overlay, notifier: shell.notifier,
    settings: { load: () => ({}) } });
  const server = new HookServer({ controller, port: 0, authToken: REPLAY_TOKEN,
    onCompanionStatus: shell.onCompanionStatus, onCompanionOpen: shell.onCompanionOpen,
    onCompanionBubble: shell.onCompanionBubble });
  return {
    shell,
    async start() { await server.start(); return { port: server.port }; },
    async state() { return controller.snapshot(); },
    idle: () => server.idle(),
    async decide(id, decision, extra) { return Boolean(controller.resolveApproval(id, decision, extra)); },
    async restore(id) { controller.restoreApproval(id); },
    async notificationAction(action, id) {
      if (action === "mark-read") return controller.markNotificationRead(id);
      if (action === "dismiss") return controller.dismissNotification(id);
      if (action === "mark-all-read") return controller.markAllNotificationsRead();
      return false;
    },
    async stop() { await server.stop(); }
  };
}

// The same core behind the service boundary: every call is a request through CoreClient, the /companion/* intents
// come back as requests from the core. With projectionOnly, reads use the pushed projections (step 3's view).
export function clientTarget({ projectionOnly = false } = {}) {
  const shell = createShellRecorder();
  const { client } = createInProcessCore({ overlay: shell.overlay, notifier: shell.notifier,
    settings: { load: () => ({}) }, projectionOnly });
  client.handleIntents({ companionStatus: shell.onCompanionStatus, companionOpen: shell.onCompanionOpen,
    companionBubble: shell.onCompanionBubble });
  return {
    shell,
    async start() {
      return { port: (await client.startHookServer({ port: 0, authToken: REPLAY_TOKEN })).port };
    },
    // Main's projection carries no event history: the summary reads the full state by query, as main does.
    // (once stopped, the last state main's mirror holds)
    async state() { return projectionOnly ? client.query().catch(() => client.state()) : client.state(); },
    idle: () => client.idle(),
    decide: (id, decision, extra) => client.resolveApproval(id, decision, extra),
    restore: (id) => client.restoreApproval(id),
    notificationAction: (action, id) => client.notificationAction(action, id),
    async stop() { await client.stopHookServer(); client.close("replay finished"); }
  };
}

// The same core in a forked child (structured-clone serialization, as an Electron utility process): projections,
// effects and intents all cross a real process boundary.
export function processTarget() {
  const shell = createShellRecorder();
  const child = fork(path.join(path.dirname(fileURLToPath(import.meta.url)), "replay-core-child.js"), [],
    { serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const client = new CoreClient({ endpoint: new ServiceEndpoint({ port: parentSidePort(child), name: "main" }) });
  client.on("effect", (effect) => applyEffect(effect, shell));
  client.handleIntents({ companionStatus: shell.onCompanionStatus, companionOpen: shell.onCompanionOpen,
    companionBubble: shell.onCompanionBubble });
  return {
    shell,
    async start() {
      await client.whenReady();
      return { port: (await client.startHookServer({ port: 0, authToken: REPLAY_TOKEN })).port };
    },
    async state() { return client.query().catch(() => client.state()); },
    idle: () => client.idle(),
    decide: (id, decision, extra) => client.resolveApproval(id, decision, extra),
    restore: (id) => client.restoreApproval(id),
    notificationAction: (action, id) => client.notificationAction(action, id),
    async stop() {
      await client.stopHookServer().catch(() => {});
      client.close("replay finished");
      await exited;
    }
  };
}

export function summarizeState(state) {
  return {
    approvals: state.approvals.map((item) => ({ session: item.event.sessionId, tool: item.event.toolName ?? null,
      collapsed: item.collapsed })),
    sessions: state.sessions.map((item) => ({ id: item.id, status: item.status, phase: item.phase ?? null })),
    notifications: state.notifications.map((item) => ({ category: item.category, isRead: item.isRead,
      outcome: item.resolutionOutcome ?? null })),
    unread: state.notificationSummary.unreadCount,
    events: state.events.map((item) => item.hookEventName)
  };
}

// Every key in `expected` must match; arrays must match in length and element by element.
export function assertSubset(actual, expected, where = "value") {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${where}: length (${JSON.stringify(actual)})`);
    expected.forEach((item, index) => assertSubset(actual[index], item, `${where}[${index}]`));
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", `${where}: expected an object, got ${JSON.stringify(actual)}`);
    for (const [key, value] of Object.entries(expected)) assertSubset(actual[key], value, `${where}.${key}`);
  } else {
    assert.deepEqual(actual, expected, where);
  }
}

function send(port, route, body, headers = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    request = http.request({ host: "127.0.0.1", port, method: "POST", path: route,
      headers: { "x-ccf-token": REPLAY_TOKEN, "content-type": "application/json",
        "content-length": Buffer.byteLength(payload), ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    request.on("error", (error) => resolve({ status: "disconnected", error: error.code ?? error.message }));
    request.end(payload);
  });
  return { response, destroy: () => request.destroy() };
}

async function waitFor(read, predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

export async function runReplay(fixture, target) {
  const { port } = await target.start();
  const held = new Map();
  let stopped = false;
  try {
    for (const [index, step] of fixture.steps.entries()) {
      const where = `${fixture.file} step ${index} (${step.do})`;
      switch (step.do) {
        case "hook":
        case "post": {
          const route = step.route ?? "/hook";
          const result = await send(port, route, step.body, step.headers).response;
          if (route === "/hook") await target.idle();
          if (step.expect) assertSubset(result, step.expect, where);
          break;
        }
        case "permission":
          held.set(step.as, send(port, "/hook", step.body));
          if (step.waitApprovals !== undefined) {
            await waitFor(() => target.state(), (state) => state.approvals.length === step.waitApprovals, `${where} approvals`);
          }
          break;
        case "waitApprovals":
          await waitFor(() => target.state(), (state) => state.approvals.length === step.count, `${where} approvals`);
          break;
        case "disconnect":
          held.get(step.of).destroy();
          await held.get(step.of).response;
          break;
        case "response": {
          const result = await held.get(step.of).response;
          assertSubset(result, step.expect, where);
          break;
        }
        case "decide": {
          const state = await target.state();
          const approval = state.approvals[step.approval];
          assert.ok(approval, `${where}: no approval at ${step.approval}`);
          if (step.via === "http") {
            const result = await send(port, `/approvals/${approval.id}/${step.action}`, step.payload ?? {}).response;
            if (step.expect) assertSubset(result, step.expect, where);
          } else if (step.action === "restore") {
            await target.restore(approval.id);
          } else {
            const resolved = await target.decide(approval.id, step.action, step.extra ?? {});
            if (step.expect) assertSubset({ resolved }, step.expect, where);
          }
          break;
        }
        case "decideUnknown": {
          const result = await send(port, `/approvals/no-such-approval/${step.action}`, {}).response;
          assertSubset(result, step.expect, where);
          break;
        }
        case "notification": {
          const state = await target.state();
          const id = step.notification === undefined ? undefined : state.notifications[step.notification]?.id ?? "missing";
          const result = await target.notificationAction(step.action, id);
          if (step.expect) assertSubset({ result }, step.expect, where);
          break;
        }
        case "state":
          assertSubset(summarizeState(await target.state()), step.expect, where);
          break;
        case "waitShell":
          await waitFor(async () => target.shell.overlayShows, (count) => count === step.overlayShows, `${where} overlay shows`);
          break;
        case "shell":
          assertSubset({ toasts: target.shell.toasts, intents: target.shell.intents, overlayShows: target.shell.overlayShows },
            step.expect, where);
          break;
        case "stop":
          await target.stop();
          stopped = true;
          break;
        default:
          assert.fail(`${where}: unknown step`);
      }
    }
  } finally {
    for (const request of held.values()) request.destroy();
    if (!stopped) await target.stop();
  }
}
