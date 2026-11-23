// The core in a real second process (process-split plan, step 3). Electron's utilityProcess is not available under
// node:test, so the stand-in is a Node child forked with structured-clone serialization running the same entrypoint
// (core/core-process.js) and composition. What this proves: the boot handshake and authenticated readiness, crash
// detection and restart (same token, same port when free, fallback when not), what a held permission request sees when
// the core dies, and graceful shutdown. What it does not: Electron's own utility-process launch (smoke test).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { storedState } from "../test-support/stored-state.js";
import { EventEmitter } from "node:events";
import { CoreClient } from "../../../packages/core/src/index.js";
import { CoreProcessHost } from "../core/core-host.js";
import { settingsDefaults } from "../core/settings-defaults.js";
import { nodeUtilityProcess } from "../test-support/fake-electron.js";

function paths(root) {
  const data = path.join(root, "chaos-cat-familiar");
  return { home: root, root: data, settingsPath: path.join(data, "settings.json"), statePath: path.join(data, "state.json"),
    logPath: path.join(data, "logs", "chaos-cat-familiar.log") };
}

async function startCore(t, { restartDelaysMs = [50], maxRestarts = 5, preferredPort = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-core-process-"));
  const utility = nodeUtilityProcess();
  const client = new CoreClient();
  const config = { paths: paths(root), settingsDefaults: settingsDefaults({ home: root, portOverride: preferredPort }),
    preferredPort, testMode: true, watchSettingsMs: 50, logToConsole: false };
  const host = new CoreProcessHost({ client, config, restartDelaysMs, maxRestarts,
    fork: (modulePath, args, options) => utility.fork(modulePath, args, options) });
  t.after(async () => {
    await host.stop({ deadlineMs: 3000 }).catch(() => {});
    for (const child of utility.children) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const info = await host.start();
  return { root, host, client, info, config, utility };
}

function post(port, token, body, { signal } = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/hook",
      headers: { "content-type": "application/json", "x-ccf-token": token, "content-length": Buffer.byteLength(payload) } },
    (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data }));
      response.on("error", (error) => resolve({ status: "disconnected", error: error.code ?? error.message }));
    });
    request.on("error", (error) => resolve({ status: "disconnected", error: error.code ?? error.message }));
    signal?.addEventListener("abort", () => request.destroy());
    request.end(payload);
  });
}

async function waitFor(read, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

test("the core boots in its own process and reports its port only after an authenticated probe", { timeout: 30000 }, async (t) => {
  const { host, client, info, config } = await startCore(t);
  assert.notEqual(host.pid, process.pid, "a second process");
  assert.equal(info.authenticated, true);
  assert.ok(info.port > 0);
  assert.equal(client.status, "ready");
  assert.equal(client.hookPort, info.port);
  const settings = JSON.parse(fs.readFileSync(config.paths.settingsPath, "utf8"));
  assert.equal(settings.port, info.port, "the core persisted the port it got");
  assert.match(settings.hookToken, /^[0-9a-f]{64}$/, "and created the hook token, as the only settings writer");
  assert.deepEqual(info.settings.hookToken, settings.hookToken);
  const ready = await fetch(`http://127.0.0.1:${info.port}/ready`, { headers: { "x-ccf-token": settings.hookToken } });
  assert.deepEqual(await ready.json(), { ok: true, instance: info.instance });
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/ready`)).status, 401, "readiness is authenticated");

  const changes = [];
  client.on("state", (info) => changes.push({ sessions: client.state().sessions.length, event: info.lastEvent?.hookEventName, revision: info.revision }));
  assert.equal((await post(info.port, settings.hookToken, { hook_event_name: "SessionStart", session_id: "p-1", cwd: "C:/p" })).status, 200);
  await waitFor(() => changes.length, "a pushed change");
  assert.deepEqual(changes[0], { sessions: 1, event: "SessionStart", revision: 1 });
  assert.deepEqual(client.state().events, [], "overlay-sized by default");
});

test("a core crash: the held permission request is dropped without a decision, approvals pause, the core comes back on its port with its token", { timeout: 30000 }, async (t) => {
  const { host, client, info, config } = await startCore(t);
  const token = info.settings.hookToken;
  const held = post(info.port, token, { hook_event_name: "PermissionRequest", session_id: "p-2", cwd: "C:/p", tool_name: "Bash",
    tool_input: { command: "echo held" } });
  await waitFor(() => client.state().approvals.length === 1, "the approval");
  const [approval] = client.state().approvals;
  const statuses = [];
  client.on("status", (status) => statuses.push(status));
  const restarted = once(host, "restarted");
  process.kill(host.pid);   // TerminateProcess on Windows: a crash, no shutdown

  const answer = await held;
  assert.equal(answer.status, "disconnected", `no allow/deny reaches Claude Code: ${JSON.stringify(answer)}`);
  await waitFor(() => client.status === "recovering" || statuses.includes("recovering"), "recovering");
  assert.deepEqual(statuses[0], "recovering");
  assert.deepEqual(client.state().approvals, [], "stale approvals are gone from the projection");
  await assert.rejects(client.resolveApproval(approval.id, "allow"), (error) => error.code === "core_recovering");

  const back = await restarted;
  assert.equal(back.port, info.port, "same port");
  assert.equal(back.attempts, 1, "the dead process's listener was gone at once: no rebind wait");
  assert.equal(back.previousPort, info.port);
  assert.equal(back.settings.hookToken, token, "same token (from settings.json)");
  assert.equal(client.status, "ready");
  assert.deepEqual(client.state().approvals, [], "nothing replayed");
  assert.equal(JSON.parse(fs.readFileSync(config.paths.settingsPath, "utf8")).hookToken, token);
  assert.equal((await post(back.port, token, { hook_event_name: "SessionStart", session_id: "p-3", cwd: "C:/p" })).status, 200);
  await waitFor(() => client.state().sessions.some((session) => session.id === "p-3"), "ingestion after the restart");
  assert.equal(await client.resolveApproval(approval.id, "allow"), false, "the old approval id means nothing to the new core");
});

test("port rebind: a restarted core whose port was taken meanwhile falls back to a free one and persists it", { timeout: 30000 }, async (t) => {
  const { host, info, config } = await startCore(t, { restartDelaysMs: [300] });
  const blocker = http.createServer((_req, res) => res.end("someone else"));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const restarted = once(host, "restarted");
  const crashed = once(host, "crashed");
  process.kill(host.pid);
  await crashed;
  await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(info.port, "127.0.0.1", resolve); });
  const back = await restarted;
  assert.notEqual(back.port, info.port);
  assert.equal(back.previousPort, info.port);
  assert.equal(back.fallbackUsed, true);
  assert.ok(back.attempts >= 1);
  assert.equal(JSON.parse(fs.readFileSync(config.paths.settingsPath, "utf8")).port, back.port);
});

test("graceful shutdown releases a pending permission request with no decision, flushes state and log, and the process exits", { timeout: 30000 }, async (t) => {
  const { host, client, info, config } = await startCore(t);
  const token = info.settings.hookToken;
  const held = post(info.port, token, { hook_event_name: "PermissionRequest", session_id: "p-4", cwd: "C:/p", tool_name: "Bash",
    tool_input: { command: "echo held" } });
  await waitFor(() => client.state().approvals.length === 1, "the approval");
  client.sendLog([{ timestamp: new Date(), level: "info", category: "shutdown", message: "Main says goodbye", context: {} }]);
  const pid = host.pid;
  const result = await host.stop({ deadlineMs: 5000 });
  assert.deepEqual(result, { stateSaved: true, logsSaved: true, settingsSaved: true });
  assert.equal((await held).status, 204, "released without allow or deny");
  assert.equal(client.status, "stopped");
  assert.throws(() => process.kill(pid, 0), "the core process is gone");
  const { state: checkpoint } = await storedState(config.paths.root);
  assert.ok(checkpoint.sessions.some((session) => session.id === "p-4"), "the final commit holds the last session");
  assert.match(fs.readFileSync(config.paths.logPath, "utf8"), /Main says goodbye/, "main's lines reach the core's log file");
});

test("settings: main's patch reaches the file through the core, and an outside edit is pushed back", { timeout: 30000 }, async (t) => {
  const { client, config } = await startCore(t);
  const result = await client.request("settings.update", { patch: { overlayOpacity: 0.5, hotkeys: { openDashboard: "X" } }, seq: 1 });
  assert.equal(result.saved, true);
  const onDisk = JSON.parse(fs.readFileSync(config.paths.settingsPath, "utf8"));
  assert.equal(onDisk.overlayOpacity, 0.5);
  assert.equal(onDisk.hotkeys.openDashboard, "X");
  assert.equal(onDisk.hotkeys.toggleOverlay, "CommandOrControl+Shift+Space", "hotkeys merge, not replace");
  const pushed = new Promise((resolve) => client.on("settings", ({ value }) => { if (value.hookRelayPort === 49151) resolve(value); }));
  fs.writeFileSync(config.paths.settingsPath, JSON.stringify({ ...onDisk, hookRelayPort: 49151 }));
  const value = await pushed;
  assert.equal(value.overlayOpacity, 0.5);
});

test("repeated crashes stop the restarts instead of looping", { timeout: 30000 }, async (t) => {
  const { host } = await startCore(t, { restartDelaysMs: [20], maxRestarts: 1 });
  let restarted = once(host, "restarted");
  process.kill(host.pid);
  await restarted;
  const failed = once(host, "failed");
  process.kill(host.pid);
  assert.deepEqual(await failed, { restarts: 1 });
});

test("a core that does not answer shutdown is killed after its deadline", async () => {
  // A child that boots but never answers "shutdown" (hung on a held file, say).
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => { child.killed = true; child.pid = undefined; setImmediate(() => child.emit("exit", null)); };
  child.postMessage = (message) => {
    if (message.type === "request" && message.method === "boot") {
      setImmediate(() => child.emit("message", { type: "response", id: message.id, ok: true,
        result: { port: 1, state: null, settings: {}, revision: 0, authenticated: true } }));
    }
  };
  const client = new CoreClient();
  const host = new CoreProcessHost({ client, config: { paths: {} }, fork: () => {
    setImmediate(() => child.emit("message", { type: "ready", info: { booted: false } }));
    return child;
  }, exitDeadlineMs: 50 });
  await host.start();
  const started = Date.now();
  assert.equal(await host.stop({ deadlineMs: 100 }), null);
  assert.equal(child.killed, true);
  assert.ok(Date.now() - started < 2000);
  assert.equal(client.status, "stopped");
});

// A child that boots like a core (fake utility process): messages in, "message"/"exit"/"error" out.
function fakeCoreChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => { child.pid = undefined; setImmediate(() => child.emit("exit", null)); };
  child.postMessage = (message) => {
    if (message.type === "request" && message.method === "boot") {
      setImmediate(() => child.emit("message", { type: "response", id: message.id, ok: true,
        result: { port: 1, state: null, settings: {}, revision: 0, authenticated: true, pid } }));
    }
  };
  setImmediate(() => child.emit("message", { type: "ready", info: { booted: false } }));
  return child;
}

// Review 2026-11-05 (P1): Electron's utility process emits "error" (FatalError) before it exits; an EventEmitter error
// without a listener would throw into main's fatal handler and close CCF instead of restarting the core.
test("a utility process error event is reported and only the core restarts", async () => {
  const children = [];
  const client = new CoreClient();
  const logged = [];
  const host = new CoreProcessHost({ client, config: { paths: {} }, restartDelaysMs: [5],
    logger: { error: (...args) => logged.push(args), warn() {}, info() {} },
    exitDeadlineMs: 50, fork: () => { const child = fakeCoreChild(5000 + children.length); children.push(child); return child; } });
  await host.start();
  const restarted = once(host, "restarted");
  assert.doesNotThrow(() => children[0].emit("error", "FatalError", "v8::Isolate", "report"));
  assert.ok(logged.some(([category, message]) => category === "core" && /error/i.test(message)), JSON.stringify(logged));
  children[0].kill();
  await restarted;
  assert.equal(children.length, 2);
  assert.equal(client.status, "ready");
  await host.stop({ deadlineMs: 100 });
});

// Review 2026-11-05 (P2): a restart whose fork() throws has no exit event to schedule the next attempt.
test("a restart whose fork throws keeps trying until the restart limit, then reports failure", async () => {
  let forks = 0;
  const client = new CoreClient();
  const host = new CoreProcessHost({ client, config: { paths: {} }, restartDelaysMs: [5], maxRestarts: 2,
    logger: { error() {}, warn() {}, info() {} },
    fork: () => { forks++; if (forks > 1) throw new Error("spawn EAGAIN"); return fakeCoreChild(6000); } });
  await host.start();
  const failed = once(host, "failed");
  process.nextTick(() => host.child.kill());
  const result = await Promise.race([failed, new Promise((resolve) => setTimeout(() => resolve("silent"), 2000))]);
  assert.notEqual(result, "silent", "recovery must not stop silently");
  assert.equal(forks, 3, "the first fork plus two failed restarts");
  await host.stop({ deadlineMs: 100 });
});

// What Claude Code sees when the core dies under a held permission request: the generated sender exits 0 with no
// output, which Claude Code treats as "no decision" and shows its own prompt.
test("the generated PowerShell sender falls back quietly when the core dies mid-request", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const { host, client, info, root } = await startCore(t, { restartDelaysMs: [60000] });
  const installed = await client.request("hooks", { op: "install", desktop: {} });
  assert.ok(fs.existsSync(installed.hookPath));
  assert.ok(installed.hookPath.startsWith(root), "hooks land in the temp home");
  const sender = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installed.hookPath],
    { windowsHide: true, timeout: 45000 });
  let stdout = "", stderr = "";
  sender.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
  sender.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
  const closed = new Promise((resolve) => sender.on("close", resolve));
  sender.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "p-5", tool_name: "Bash",
    tool_input: { command: "echo held" } }), "utf8");
  await waitFor(() => client.state().approvals.length === 1, "the sender's approval", 40000);
  process.kill(host.pid);
  assert.equal(await closed, 0, stderr);
  assert.equal(stdout.trim(), "", "no decision on stdout");
  assert.equal(info.authenticated, true);
});
