import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { createFakeElectron } from "../test-support/fake-electron.js";

test("approval IPC normalizes answers, feedback and permission updates while retaining tool input", { timeout: 8000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-approval-ipc-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: { hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, health: { ok: true } }; } }, mascotLibrary: { list() { return { mascots: [] }; } } }
  });
  const controllers = [];
  t.after(async () => { for (const controller of controllers) controller.abort(); await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  for (const [action, payload, expected] of [
    ["allowWithAnswers", { answers: { "Which?": "First" } }, { updatedInput: { questions: [{ question: "Which?" }], answers: { "Which?": "First" } } }],
    ["allowWithFeedback", { feedback: "Include tests" }, { updatedInput: { questions: [{ question: "Which?" }], userFeedback: "Include tests" } }],
    ["allowWithPermissions", { updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] }, { updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] }]
  ]) {
    const controller = new AbortController(); controllers.push(controller);
    const responsePromise = fetch(`http://127.0.0.1:${started.runtime.hookPort}/hook`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "x-ccf-token": started.settings.hookToken }, body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: action, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?" }] } }) });
    const deadline = Date.now() + 1500;
    while (!runtime.snapshot().state.approvals.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const approval = runtime.snapshot().state.approvals[0];
    assert.ok(approval);
    await electron.ipcMain.invoke("ccf:approval-action", { id: approval.id, action, payload });
    const response = await responsePromise;
    const body = await response.json();
    assert.equal(body.hookSpecificOutput.decision.behavior, "allow");
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(body.hookSpecificOutput.decision[key], value);
    assert.equal(runtime.snapshot().state.notifications.find((item) => item.eventId === approval.event.id)?.resolutionOutcome, "allowed");
  }
});
