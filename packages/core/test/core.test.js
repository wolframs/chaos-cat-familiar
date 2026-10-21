import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  HookEventType,
  HookServer,
  InMemoryStateStore,
  CcfCoreController,
  notificationForEvent
} from "../src/index.js";

class FakeOverlayService {
  constructor() {
    this.states = [];
  }

  showOverlay(state) {
    this.states.push({ type: "show", state });
  }

  updateOverlay(state) {
    this.states.push({ type: "update", state });
  }

  hideOverlay() {}
}

class FakeNotificationService {
  constructor() {
    this.notifications = [];
  }

  async notify(notification) {
    this.notifications.push(notification);
  }
}

function requestJson({ port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body
          ? {
              "x-ccf-token": "core-test-token", "content-type": "application/json",
              "content-length": Buffer.byteLength(body)
            }
          : { "x-ccf-token": "core-test-token" }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function requestRaw({ port, method, path, body, contentType = "application/json" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "x-ccf-token": "core-test-token", "content-type": contentType,
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createController(options = {}) {
  return new CcfCoreController({
    overlay: new FakeOverlayService(),
    notifier: new FakeNotificationService(),
    stateStore: options.stateStore,
    settings: {},
    activation: {},
    terminalLocator: {},
    hookInstaller: {},
    logger: options.logger
  });
}

test("authenticated companion status payloads reach the HUD without becoming hook events", async () => {
  const controller = createController();
  const received = [];
  const server = new HookServer({ controller, port: 0, authToken: "core-test-token",
    onCompanionStatus: (payload) => received.push(payload) });
  await server.start();
  try {
    const payload = { session_id: "companion-1", cwd: "C:/Users/test/repos/work-companion",
      context_window: { used_percentage: 34 }, rate_limits: { five_hour: { used_percentage: 55 } } };
    const response = await requestJson({ port: server.port, method: "POST", path: "/companion/status",
      body: JSON.stringify(payload) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, [payload]);
    assert.equal(controller.snapshot().events.length, 0);
  } finally { await server.stop(); }
});

test("authenticated companion open delegates to the shell without ingesting a hook", async () => {
  const controller = createController();
  let opens = 0;
  const server = new HookServer({ controller, port: 0, authToken: "core-test-token",
    onCompanionOpen: async () => { opens += 1; } });
  await server.start();
  try {
    const response = await requestJson({ port: server.port, method: "POST", path: "/companion/open" });
    assert.equal(response.statusCode, 200);
    assert.equal(opens, 1);
    assert.equal(controller.snapshot().events.length, 0);
  } finally { await server.stop(); }
});

test("permission requests stay pending until resolved and round-trip an allow response", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token",
    controller,
    port: 0
  });

  await server.start();

  const pendingResponse = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify({
      hook_event_name: HookEventType.PERMISSION_REQUEST,
      session_id: "session-1",
      cwd: "C:/work/demo",
      tool_name: "Edit",
      tool_input: {
        file_path: "C:/work/demo/src/app.ts"
      }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(controller.approvals.pending.length, 1);

  const approvalId = controller.approvals.pending[0].id;
  const resolveResponse = await requestJson({
    port: server.port,
    method: "POST",
    path: `/approvals/${approvalId}/allow`,
    body: JSON.stringify({})
  });

  assert.equal(resolveResponse.statusCode, 200);

  const hookResponse = await pendingResponse;
  assert.equal(hookResponse.statusCode, 200);
  assert.equal(
    hookResponse.body.hookSpecificOutput.decision.behavior,
    "allow"
  );
  assert.equal(controller.approvals.pending.length, 0);

  await server.stop();
});

test("post-tool-use dismisses the specific pending permission correlated from pre-tool-use", async () => {
  const controller = createController();
  const preToolUse = {
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PRE_TOOL_USE,
    sessionId: "session-2",
    cwd: "C:/repo",
    permissionMode: null,
    transcriptPath: null,
    toolName: "Bash",
    toolInput: null,
    toolResponse: null,
    toolUseId: "tool-123",
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: "agent-a",
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  };

  await controller.ingestEvent(preToolUse);
  controller.approvals.add(
    {
      ...preToolUse,
      id: crypto.randomUUID(),
      hookEventName: HookEventType.PERMISSION_REQUEST,
      toolUseId: null
    },
    () => {}
  );

  assert.equal(controller.approvals.pending.length, 1);
  assert.equal(controller.approvals.pending[0].resolvedToolUseId, "tool-123");

  await controller.ingestEvent({
    ...preToolUse,
    id: crypto.randomUUID(),
    hookEventName: HookEventType.POST_TOOL_USE
  });

  assert.equal(controller.approvals.pending.length, 0);
});

test("defer keeps approval pending and restore makes it visible again", async () => {
  const controller = createController();
  const pending = controller.approvals.add(
    {
      id: crypto.randomUUID(),
      hookEventName: HookEventType.PERMISSION_REQUEST,
      sessionId: "session-4",
      cwd: "C:/repo",
      permissionMode: null,
      transcriptPath: null,
      toolName: "Edit",
      toolInput: null,
      toolResponse: null,
      toolUseId: null,
      message: null,
      title: null,
      notificationType: null,
      source: null,
      reason: null,
      model: null,
      stopHookActive: null,
      lastAssistantMessage: null,
      agentId: null,
      agentType: null,
      taskId: null,
      taskSubject: null,
      permissionSuggestions: null,
      terminalPid: null,
      shellPid: null,
      receivedAt: new Date()
    },
    () => {}
  ).pending;

  controller.resolveApproval(pending.id, "defer");
  assert.equal(controller.approvals.pending.length, 1);
  assert.equal(controller.approvals.collapsedIds.has(pending.id), true);

  controller.restoreApproval(pending.id);
  assert.equal(controller.approvals.collapsedIds.has(pending.id), false);
});

test("session state transitions stay headless and portable", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.SESSION_START,
    sessionId: "session-3",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: "C:/Users/test/.claude/transcript.jsonl",
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: 101,
    shellPid: 202,
    receivedAt: new Date()
  });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PRE_COMPACT,
    sessionId: "session-3",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.STOP,
    sessionId: "session-3",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: "completed",
    model: null,
    stopHookActive: null,
    lastAssistantMessage: "Finished the refactor",
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  const session = controller.sessions.sessions[0];
  assert.equal(session.phase, "idle");
  assert.equal(session.isCompacting, false);
  assert.equal(session.projectName, "project");
  assert.equal(session.terminalPid, 101);
  assert.equal(controller.notifications.length >= 2, true);
});

test("task completion and teammate idle return sessions to idle", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.USER_PROMPT_SUBMIT,
    sessionId: "session-idle",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.TASK_COMPLETED,
    sessionId: "session-idle",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: "done",
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: "task-1",
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.TEAMMATE_IDLE,
    sessionId: "session-idle",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  const session = controller.sessions.sessions[0];
  assert.equal(session.phase, "idle");
  assert.equal(session.status, "active");
});

test("subagent start marks the session as running", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.SESSION_START,
    sessionId: "session-subagent",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.SUBAGENT_START,
    sessionId: "session-subagent",
    cwd: "C:/code/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: "agent-1",
    agentType: "explore",
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  const session = controller.sessions.sessions[0];
  assert.equal(session.phase, "running");
  assert.equal(session.activeSubagentCount, 1);
});

test("controller persists and reloads headless state through the state store", async () => {
  const stateStore = new InMemoryStateStore({
    events: [],
    notifications: [],
    sessions: [],
    settings: {}
  });
  const controller = createController({ stateStore });

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.SESSION_START,
    sessionId: "session-persist",
    cwd: "C:/persisted/project",
    permissionMode: null,
    transcriptPath: null,
    toolName: null,
    toolInput: null,
    toolResponse: null,
    toolUseId: null,
    message: null,
    title: null,
    notificationType: null,
    source: null,
    reason: null,
    model: null,
    stopHookActive: null,
    lastAssistantMessage: null,
    agentId: null,
    agentType: null,
    taskId: null,
    taskSubject: null,
    permissionSuggestions: null,
    terminalPid: null,
    shellPid: null,
    receivedAt: new Date()
  });

  const reloaded = createController({ stateStore });
  assert.equal(reloaded.sessions.sessions.length, 1);
  assert.equal(reloaded.sessions.sessions[0].id, "session-persist");
  assert.equal(reloaded.events.length, 1);
});

test("event and notification retention is bounded in memory and persisted state", async () => {
  const stateStore = new InMemoryStateStore({ events: [], notifications: [], sessions: [], settings: {} });
  const controller = createController({ stateStore });

  for (let index = 0; index < 225; index += 1) {
    await controller.ingestEvent({
      id: `retained-${index}`,
      hookEventName: HookEventType.STOP,
      sessionId: `retained-session-${index}`
    });
  }

  assert.equal(controller.events.length, 200);
  assert.equal(controller.notifications.length, 200);
  assert.equal(controller.events[0].id, "retained-224");
  assert.equal(controller.events.at(-1).id, "retained-25");
  assert.equal(stateStore.load().events.length, 200);
  assert.equal(stateStore.load().notifications.length, 200);
});

test("ended-session retention is bounded while active and approval sessions stay available", async () => {
  const controller = createController();
  for (let index = 0; index < 205; index += 1) {
    const sessionId = `ended-${index}`;
    await controller.ingestEvent({ hookEventName: HookEventType.SESSION_START, sessionId });
    await controller.ingestEvent({ hookEventName: HookEventType.SESSION_END, sessionId });
  }

  await controller.ingestEvent({ hookEventName: HookEventType.SESSION_START, sessionId: "active-session" });
  const approvalEvent = {
    id: "pending-session-event",
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "waiting-session",
    toolName: "Bash",
    toolInput: { command: "inspect" }
  };
  const approval = await controller.enqueueApproval(approvalEvent, () => {});
  await controller.ingestEvent({ hookEventName: HookEventType.SESSION_END, sessionId: "waiting-session" });

  const sessions = controller.sessions.sessions;
  assert.equal(sessions.filter((session) => session.status === "ended").length, 200);
  assert.ok(sessions.some((session) => session.id === "active-session"));
  assert.ok(sessions.some((session) => session.id === "waiting-session"));
  assert.ok(controller.snapshot().approvals.some((item) => item.id === approval.pending.id));
});

test("pre-tool correlation cache keeps only the most recent bounded entries", () => {
  const controller = createController();
  for (let index = 0; index < 225; index += 1) {
    controller.approvals.cachePreToolUse({
      sessionId: `cache-session-${index}`,
      toolName: "Edit",
      toolUseId: `tool-${index}`
    });
  }

  assert.equal(controller.approvals.preToolUseCache.size, 200);
  assert.equal(controller.approvals.preToolUseCache.has("cache-session-0||Edit"), false);
  assert.equal(controller.approvals.preToolUseCache.get("cache-session-224||Edit"), "tool-224");
});

test("hook server rejects invalid hook payloads", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token",
    controller,
    port: 0
  });

  await server.start();
  const response = await requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify({
      session_id: "missing-event-name",
      terminal_pid: "bad"
    })
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_hook_payload");

  await server.stop();
});

test("permission requests can resolve with answers payload", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token",
    controller,
    port: 0
  });

  await server.start();

  const pendingResponse = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify({
      hook_event_name: HookEventType.PERMISSION_REQUEST,
      session_id: "session-answers",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which editor?",
            options: [
              { label: "VS Code" },
              { label: "Cursor" }
            ]
          }
        ]
      }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const approvalId = controller.approvals.pending[0].id;
  await requestJson({
    port: server.port,
    method: "POST",
    path: `/approvals/${approvalId}/allowWithAnswers`,
    body: JSON.stringify({
      answers: {
        "Which editor?": "VS Code"
      }
    })
  });

  const hookResponse = await pendingResponse;
  assert.equal(
    hookResponse.body.hookSpecificOutput.decision.updatedInput.answers["Which editor?"],
    "VS Code"
  );

  await server.stop();
});

test("permission requests can resolve with updated permissions payload", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token",
    controller,
    port: 0
  });

  await server.start();

  const pendingResponse = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify({
      hook_event_name: HookEventType.PERMISSION_REQUEST,
      session_id: "session-permissions",
      tool_name: "Edit",
      permission_suggestions: [
        {
          type: "addRules",
          destination: "localSettings",
          behavior: "allow",
          rules: [
            {
              toolName: "Edit",
              ruleContent: "C:/repo/**"
            }
          ]
        }
      ]
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const approvalId = controller.approvals.pending[0].id;
  await requestJson({
    port: server.port,
    method: "POST",
    path: `/approvals/${approvalId}/allowWithPermissions`,
    body: JSON.stringify({
      updatedPermissions: [
        {
          type: "addRules",
          destination: "localSettings",
          behavior: "allow",
          rules: [
            {
              toolName: "Edit",
              ruleContent: "C:/repo/**"
            }
          ]
        }
      ]
    })
  });

  const hookResponse = await pendingResponse;
  assert.equal(
    hookResponse.body.hookSpecificOutput.decision.updatedPermissions[0].rules[0].ruleContent,
    "C:/repo/**"
  );

  await server.stop();
});

test("hook server rejects malformed JSON request bodies", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token",
    controller,
    port: 0
  });

  await server.start();
  const response = await requestRaw({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: "{invalid-json"
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /Unexpected token|Expected property name/i);

  await server.stop();
});

test("notification routing extracts AskUserQuestion text", () => {
  const notification = notificationForEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "session-question",
    cwd: "C:/repo",
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        {
          question: "Do you want to continue?"
        }
      ]
    }
  });

  assert.equal(notification.title, "Claude Has a Question");
  assert.equal(notification.body, "Do you want to continue?");
});

test("unknown notification types do not create app notifications", () => {
  const notification = notificationForEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.NOTIFICATION,
    sessionId: "session-none",
    cwd: "C:/repo",
    notificationType: "mystery_event"
  });

  assert.equal(notification, null);
});

// --- Fix A: Unbounded request body ---

test("hook server returns 413 for oversized request body", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();

  const bigBody = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "s",
    data: "x".repeat(2_100_000)
  });

  const response = await requestRaw({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: bigBody
  });

  assert.equal(response.statusCode, 413);
  await server.stop();
});

// Permission-client disconnects

test("client disconnect auto-dismisses pending permission", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: server.port,
      method: "POST",
      path: "/hook",
      headers: {
        "x-ccf-token": "core-test-token", "content-type": "application/json"
      }
    });

    const body = JSON.stringify({
      hook_event_name: HookEventType.PERMISSION_REQUEST,
      session_id: "session-close",
      tool_name: "Bash",
      tool_input: { command: "ls" }
    });

    // Swallow expected errors from destroying the socket
    req.on("error", () => {});

    req.setHeader("content-length", Buffer.byteLength(body));
    req.write(body);
    req.end();

    setTimeout(() => {
      try {
        assert.equal(controller.approvals.pending.length, 1);
      } catch (e) {
        reject(e);
        return;
      }

      // Destroy the client connection
      req.destroy();

      setTimeout(() => {
        try {
          assert.equal(controller.approvals.pending.length, 0);
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 100);
    }, 100);
  });

  await server.stop();
});

test("disconnect during asynchronous approval enqueue removes the waiter and publishes state", async () => {
  const controller = createController();
  let enteredNotify;
  let releaseNotify;
  const entered = new Promise((resolve) => { enteredNotify = resolve; });
  const notified = new Promise((resolve) => { releaseNotify = resolve; });
  controller.notifier.notify = async () => { enteredNotify(); await notified; };
  const changes = [];
  controller.on("change", (state) => changes.push(state));
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();
  const request = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/hook",
    headers: { "x-ccf-token": "core-test-token", "content-type": "application/json" } });
  request.on("error", () => {});
  try {
    request.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "early-close", tool_name: "Bash" }));
    await entered;
    const closed = new Promise((resolve) => request.on("close", resolve));
    request.destroy();
    await closed;
    // The server must observe the closed socket before enqueue resumes.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseNotify();
    const deadline = Date.now() + 1000;
    while (controller.snapshot().approvals.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(controller.snapshot().approvals.length, 0);
    assert.equal(changes.at(-1).approvals.length, 0);
    assert.equal(controller.overlay.states.at(-1).state.approvals.length, 0);
  } finally {
    request.destroy();
    releaseNotify();
    await server.stop();
  }
});

test("stopping the hook server releases pending permission requests without deciding them", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();

  const pendingResponse = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify({
      hook_event_name: HookEventType.PERMISSION_REQUEST,
      session_id: "shutdown-pending",
      tool_name: "Bash"
    })
  });
  const deadline = Date.now() + 1000;
  while (controller.approvals.pending.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.approvals.pending.length, 1);

  await server.stop();
  const response = await pendingResponse;
  assert.equal(response.statusCode, 204);
  assert.equal(controller.approvals.pending.length, 0);
});

// Approval-action payload validation

test("malformed JSON to /approvals returns 400", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();

  // Add a fake pending approval so the route is reachable
  const pending = controller.approvals.add(
    {
      id: crypto.randomUUID(),
      hookEventName: HookEventType.PERMISSION_REQUEST,
      sessionId: "session-json",
      toolName: "Edit",
      toolInput: null
    },
    () => {}
  ).pending;

  const response = await requestRaw({
    port: server.port,
    method: "POST",
    path: `/approvals/${pending.id}/allow`,
    body: "{invalid-json"
  });

  assert.equal(response.statusCode, 400);
  await server.stop();
});

// Duplicate permission detection

test("duplicate permission by toolUseId returns existing pending item", () => {
  const controller = createController();
  const event1 = {
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "s1",
    toolName: "Edit",
    toolUseId: "tool-dup-1",
    toolInput: { file: "a.js" }
  };

  const p1 = controller.approvals.add(event1, () => {}).pending;
  const p2 = controller.approvals.add({ ...event1, id: crypto.randomUUID() }, () => {}).pending;

  assert.equal(p1.id, p2.id);
  assert.equal(controller.approvals.pending.length, 1);
});

test("duplicate permission by canonical signature returns existing pending item", () => {
  const controller = createController();
  const base = {
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "s1",
    agentId: null,
    toolName: "Bash",
    toolUseId: null,
    toolInput: { command: "ls" }
  };

  const p1 = controller.approvals.add({ ...base, id: crypto.randomUUID() }, () => {}).pending;
  const p2 = controller.approvals.add({ ...base, id: crypto.randomUUID() }, () => {}).pending;

  assert.equal(p1.id, p2.id);
  assert.equal(controller.approvals.pending.length, 1);
});

test("different events are both kept in pending", () => {
  const controller = createController();
  const p1 = controller.approvals.add(
    { id: crypto.randomUUID(), hookEventName: HookEventType.PERMISSION_REQUEST, sessionId: "s1", toolName: "Edit", toolUseId: "t1", toolInput: { file: "a.js" } },
    () => {}
  ).pending;
  const p2 = controller.approvals.add(
    { id: crypto.randomUUID(), hookEventName: HookEventType.PERMISSION_REQUEST, sessionId: "s1", toolName: "Bash", toolUseId: "t2", toolInput: { command: "ls" } },
    () => {}
  ).pending;

  assert.notEqual(p1.id, p2.id);
  assert.equal(controller.approvals.pending.length, 2);
});

test("duplicate permission requests share the same eventual HTTP response", async () => {
  const controller = createController();
  const server = new HookServer({ authToken: "core-test-token", controller, port: 0 });
  await server.start();

  const payload = {
    hook_event_name: HookEventType.PERMISSION_REQUEST,
    session_id: "session-dup-http",
    cwd: "C:/repo",
    tool_name: "Edit",
    tool_use_id: "dup-http-1",
    tool_input: { file_path: "a.js" }
  };

  const first = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify(payload)
  });
  const second = requestJson({
    port: server.port,
    method: "POST",
    path: "/hook",
    body: JSON.stringify(payload)
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(controller.approvals.pending.length, 1);

  await requestJson({
    port: server.port,
    method: "POST",
    path: `/approvals/${controller.approvals.pending[0].id}/allow`,
    body: JSON.stringify({})
  });

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.deepEqual(firstResponse.body, secondResponse.body);

  await server.stop();
});

// --- Fix E: Stop event priority ---

test("stop event notification has normal priority", () => {
  const notification = notificationForEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.STOP,
    sessionId: "session-stop",
    cwd: "C:/repo/project",
    lastAssistantMessage: "Done"
  });

  assert.equal(notification.priority, "normal");
});

test("permission notifications name Claude", () => {
  const notification = notificationForEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "session-claude",
    cwd: "C:/repo",
    toolName: "Edit"
  });

  assert.equal(notification.title, "Claude Needs Approval");
  assert.equal(notification.body, "Claude wants to use Edit in repo");
});

test("approval snapshots are labelled Claude", () => {
  const controller = createController();
  const pending = controller.approvals.add(
    {
      id: crypto.randomUUID(),
      hookEventName: HookEventType.PERMISSION_REQUEST,
      sessionId: "session-label",
      toolName: "Edit"
    },
    () => {}
  ).pending;

  const approval = controller.snapshot().approvals.find((item) => item.id === pending.id);
  assert.equal(approval.assistantLabel, "Claude");
});

test("SessionStart's source field does not relabel the session", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.SESSION_START,
    sessionId: "session-resume",
    cwd: "C:/repo/project",
    source: "resume",
    receivedAt: new Date()
  });

  const session = controller.snapshot().sessions.find((item) => item.id === "session-resume");
  assert.equal(session.assistantLabel, "Claude");
});

test("notification actions update read state and support dismiss", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.STOP,
    sessionId: "session-notify",
    cwd: "C:/repo/project",
    lastAssistantMessage: "Done"
  });

  const notification = controller.snapshot().notifications[0];
  assert.equal(controller.snapshot().notificationSummary.unreadCount, 1);

  assert.equal(controller.markNotificationRead(notification.id), true);
  assert.equal(controller.snapshot().notifications[0].isRead, true);
  assert.equal(controller.snapshot().notificationSummary.unreadCount, 0);

  assert.equal(controller.dismissNotification(notification.id), true);
  assert.equal(controller.snapshot().notifications.length, 0);
});

test("markAllNotificationsRead marks every notification as read", async () => {
  const controller = createController();

  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.STOP,
    sessionId: "session-read-all-1",
    cwd: "C:/repo/one",
    lastAssistantMessage: "Done"
  });
  await controller.ingestEvent({
    id: crypto.randomUUID(),
    hookEventName: HookEventType.PERMISSION_REQUEST,
    sessionId: "session-read-all-2",
    cwd: "C:/repo/two",
    toolName: "Edit"
  });

  assert.equal(controller.snapshot().notificationSummary.unreadCount, 2);
  assert.equal(controller.markAllNotificationsRead(), true);
  assert.equal(controller.snapshot().notificationSummary.unreadCount, 0);
  assert.equal(controller.snapshot().notifications.every((item) => item.isRead), true);
});
