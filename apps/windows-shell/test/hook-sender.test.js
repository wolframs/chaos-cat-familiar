import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { ElectronHookInstallationService, __testing } from "../services/platform-services.js";
import { CcfCoreController, HookServer } from "../../../packages/core/src/index.js";

function fixture(t, settings = { port: 49152 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-sender-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new ElectronHookInstallationService({ getHomePath: () => home }, { load: () => settings });
  // Installing test fixtures must not enumerate real desktop processes or probe real services.
  service.diagnose = async () => ({ registeredEvents: [] });
  return { home, service, settings };
}

test("installer replaces owned legacy hooks, preserves other hooks and skips unchanged settings", async (t) => {
  const { home, service } = fixture(t);
  const settingsPath = path.join(home, ".claude", "settings.json");
  const hookPath = path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1");
  const legacy = { type: "command", command: `powershell -File "${hookPath}"` };
  const other = { type: "command", command: "my-worktree-provider" };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: "yes" }, hooks: {
    WorktreeCreate: [{ hooks: [legacy, other] }], WorktreeRemove: [{ hooks: [legacy] }],
    PermissionRequest: [{ hooks: [legacy] }]
  } }));
  await service.install();
  const raw = fs.readFileSync(settingsPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.env, { KEEP: "yes" });
  assert.deepEqual(parsed.hooks.WorktreeCreate, [{ hooks: [other] }]);
  assert.equal(parsed.hooks.WorktreeRemove, undefined);
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    for (const hook of entries.flatMap((entry) => entry.hooks).filter((hook) => hook.command.includes(hookPath))) {
      assert.match(hook.command, /powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass/);
      if (event === "PermissionRequest") {
        assert.equal(hook.async, undefined);
        assert.equal(hook.timeout, 130);
      } else {
        assert.equal(hook.async, true);
      }
    }
  }
  const before = fs.statSync(settingsPath).mtimeMs;
  await service.install();
  assert.equal(fs.readFileSync(settingsPath, "utf8"), raw);
  assert.equal(fs.statSync(settingsPath).mtimeMs, before);
});

test("generated PowerShell 5.1 sender preserves decisions and UTF-8 over actual pipes and HTTP", { skip: process.platform !== "win32", timeout: 90000 }, async (t) => {
  const received = [];
  let reply = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") { res.end("{}"); return; }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    received.push({ payload: JSON.parse(body), contentType: req.headers["content-type"], token: req.headers["x-ccf-token"] });
    res.writeHead(reply === null ? 204 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(reply === null ? undefined : JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { service } = fixture(t, { port: server.address().port, hookToken: "local-test-token" });
  const { hookPath } = await service.install();
  assert.doesNotMatch(fs.readFileSync(hookPath, "utf8"), /Start-Process|GetTempFileName/);
  for (const behavior of ["allow", "deny", "defer", "routine"]) {
    reply = behavior === "defer" || behavior === "routine" ? null : {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, message: "Größe – 日本語 😸" } }
    };
    const payload = { hook_event_name: behavior === "routine" ? "PostToolUse" : "PermissionRequest", session_id: "test", tool_input: { file_path: "C:\\Größe\\日本語.txt" } };
    const result = await runSender(hookPath, payload);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (reply === null) assert.equal(result.stdout.trim(), "");
    else assert.deepEqual(JSON.parse(result.stdout), reply);
    assert.deepEqual(received.at(-1).payload.tool_input, payload.tool_input);
    assert.match(received.at(-1).contentType, /charset=utf-8/i);
    assert.equal(received.at(-1).token, "local-test-token");
  }
});

test("sender drift detects old content and changed ports and repair regenerates the installed file", async (t) => {
  const { service, settings } = fixture(t);
  const installed = await service.install();
  const command = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${installed.hookPath}"`;
  const describe = () => __testing.describeHookDrift({
    commandMatches: [{ eventName: "PermissionRequest", commands: [command] }],
    expectedEvents: ["PermissionRequest"], expectedHookPath: installed.hookPath,
    actualScript: fs.readFileSync(installed.hookPath, "utf8"), expectedScript: __testing.buildHookSenderScript(settings)
  });
  assert.equal(describe().healthy, true);
  settings.port = 54321;
  assert.equal(describe().senderMismatch, true);
  service.diagnose = async () => ({ registeredEvents: ["PermissionRequest"], hookExists: true, drift: describe(), health: { ok: true } });
  const result = await service.repair();
  assert.equal(result.driftBefore.senderMismatch, true);
  assert.equal(result.driftAfter.healthy, true);
  fs.appendFileSync(installed.hookPath, "\n# obsolete sender");
  assert.equal(describe().senderMismatch, true);
  await service.repair();
  assert.equal(describe().healthy, true);
});

test("registration drift detects stale invocation, missing async and obsolete owned worktree hooks", () => {
  const hookPath = "C:/ccf/hook-sender.ps1";
  const old = { type: "command", command: `powershell -File "${hookPath}"` };
  const drift = __testing.describeHookDrift({
    commandMatches: [
      { eventName: "PreToolUse", commands: [old.command], hooks: [old] },
      { eventName: "WorktreeCreate", commands: [old.command], hooks: [old] }
    ], expectedEvents: ["PreToolUse"], expectedHookPath: hookPath
  });
  assert.equal(drift.healthy, false);
  assert.deepEqual(drift.registrationMismatch, ["PreToolUse"]);
  assert.deepEqual(drift.obsoleteEvents, ["WorktreeCreate"]);
});

test("real hook server and controller return deny and Unicode updatedInput through generated PowerShell", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const controller = new CcfCoreController({
    overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} }, settings: {}
  });
  const server = new HookServer({ controller, port: 0, authToken: "real-server-test-token" });
  await server.start();
  t.after(() => server.stop());
  const { service } = fixture(t, { port: server.port, hookToken: "real-server-test-token" });
  const { hookPath } = await service.install();
  for (const behavior of ["deny", "allow"]) {
    const updatedInput = { userFeedback: "Größe – 日本語 😸" };
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { controller.off("change", onChange); reject(new Error("Sender did not enqueue approval")); }, 20000);
      function onChange(state) {
        const approval = state.approvals[0];
        if (approval) { clearTimeout(timer); controller.off("change", onChange); resolve(approval); }
      }
      controller.on("change", onChange);
    });
    const resultPromise = runSender(hookPath, {
      hook_event_name: "PermissionRequest", session_id: `end-to-end-${behavior}`,
      tool_name: "Edit", tool_input: { file_path: "C:\\Größe\\日本語.txt" }
    });
    const approval = await pending;
    assert.equal(approval.event.toolInput.file_path, "C:\\Größe\\日本語.txt");
    controller.resolveApproval(approval.id, behavior, behavior === "allow" ? { updatedInput } : {});
    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.hookSpecificOutput.hookEventName, "PermissionRequest");
    assert.equal(response.hookSpecificOutput.decision.behavior, behavior);
    if (behavior === "allow") assert.deepEqual(response.hookSpecificOutput.decision.updatedInput, updatedInput);
  }
});

function runSender(hookPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hookPath], { windowsHide: true, timeout: 20000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}
