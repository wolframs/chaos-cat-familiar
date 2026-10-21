import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../src/approval-store.js";
import { CcfCoreController } from "../src/core-controller.js";
import { SessionStore } from "../src/session-store.js";

const event = (extra = {}) => ({ id: crypto.randomUUID(), hookEventName: "PermissionRequest", sessionId: "session", agentId: null, toolName: "Bash", toolInput: { command: "echo hi" }, ...extra });
function controller(extra = {}) {
  return new CcfCoreController({ overlay: { showOverlay() {}, updateOverlay() {} }, notifier: { async notify() {} }, ...extra });
}

test("deny carries a successful HTTP status and waiter failures are isolated", () => {
  const store = new ApprovalStore();
  const { pending } = store.add(event(), () => { throw new Error("closed response"); });
  let response;
  store.add(event(), (value) => { response = value; });
  assert.doesNotThrow(() => store.resolve(pending.id, "deny"));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.hookSpecificOutput.decision.behavior, "deny");
  const dismissed = store.add(event(), () => { throw new Error("closed"); });
  store.add(event(), (value) => { response = value; });
  assert.doesNotThrow(() => store.removeWithoutResponse(dismissed.pending.id));
  assert.equal(response, null);
});

for (const failure of ["notification", "persistence"]) {
  test(`failed ${failure} enqueue detaches the waiter and dismisses history`, async () => {
    const core = controller(failure === "notification"
      ? { notifier: { async notify() { throw new Error("notify failed"); } } }
      : { stateStore: { load() { return {}; }, save() { throw new Error("save failed"); } } });
    let resolved = false;
    await assert.rejects(core.enqueueApproval(event(), () => { resolved = true; }));
    assert.equal(core.approvals.pending.length, 0);
    assert.equal(resolved, false);
    assert.equal(core.notifications[0].resolutionOutcome, "dismissed");
  });
}

test("duplicate permission requests notify only once and keep both waiters", async () => {
  let count = 0;
  const core = controller({ notifier: { async notify() { count += 1; } } });
  await core.enqueueApproval(event(), () => {});
  await core.enqueueApproval(event(), () => {});
  assert.equal(count, 1);
  assert.equal(core.notifications.length, 1);
  assert.equal(core.approvals.pending[0].waiters.length, 2);
});

for (const hookEventName of ["PostToolUse", "Stop", "UserPromptSubmit", "disconnect", "server-stop"]) {
  test(`${hookEventName} dismissal closes notification history`, async () => {
    const core = controller();
    const result = await core.enqueueApproval(event({ toolUseId: "tool" }), () => {});
    if (hookEventName === "disconnect") core.detachApprovalWaiter(result.pending.id, result.waiterId);
    else if (hookEventName === "server-stop") core.approvals.removeWithoutResponse(result.pending.id);
    else await core.ingestEvent(event({ hookEventName, toolUseId: "tool" }));
    assert.equal(core.approvals.pending.length, 0);
    assert.equal(core.notifications.find((item) => item.eventId === result.pending.event.id).resolutionOutcome, "dismissed");
  });
}

test("ambiguous parallel tool calls never correlate to an arbitrary tool id", () => {
  const store = new ApprovalStore();
  store.cachePreToolUse(event({ toolUseId: "one" }));
  store.cachePreToolUse(event({ toolUseId: "two" }));
  const { pending } = store.add(event(), () => {});
  assert.equal(pending.resolvedToolUseId, null);
  store.handleLifecycleEvent(event({ hookEventName: "PostToolUse", toolUseId: "two" }));
  assert.equal(store.pending.length, 1);
  const explicit = store.add(event({ toolUseId: "one", toolInput: { command: "different" } }), () => {});
  assert.equal(explicit.pending.resolvedToolUseId, "one");
});

test("restored session identity drops obsolete terminal PIDs and refreshes valid shell PIDs", () => {
  const store = new SessionStore([{ id: "session", status: "active", eventCount: 1, terminalPid: 11, shellPid: 22 }]);
  assert.equal(store.sessions[0].terminalPid, null);
  store.recordEvent(event({ hookEventName: "SessionStart", shellPid: 33 }));
  assert.equal(store.sessions[0].shellPid, 33);
  store.recordEvent(event({ hookEventName: "UserPromptSubmit", shellPid: 44 }));
  assert.equal(store.sessions[0].shellPid, 44);
  store.recordEvent(event({ hookEventName: "UserPromptSubmit", shellPid: -1 }));
  assert.equal(store.sessions[0].shellPid, 44);
});

test("logging failure during enqueue rolls back its waiter", async () => {
  const core = controller({ logger: { info() { throw new Error("EPERM log"); } } });
  let resolved = false;
  await assert.rejects(core.enqueueApproval(event(), () => { resolved = true; }), /EPERM log/);
  assert.equal(core.approvals.pending.length, 0);
  assert.equal(resolved, false);
});

for (const failure of ["logging", "persistence"]) {
  test(`resolved approval publishes UI despite ${failure} failure`, async () => {
    let fail = false;
    const states = [];
    const core = controller({
      overlay: { showOverlay() {}, updateOverlay(state) { states.push(state); } },
      logger: { info() { if (fail && failure === "logging") throw new Error("EPERM log"); } },
      stateStore: { load() { return {}; }, save() { if (fail && failure === "persistence") throw new Error("EPERM save"); } }
    });
    let response;
    const { pending } = await core.enqueueApproval(event(), (value) => { response = value; });
    fail = true;
    assert.throws(() => core.resolveApproval(pending.id, "allow"), /EPERM/);
    assert.equal(response.body.hookSpecificOutput.decision.behavior, "allow");
    assert.equal(states.at(-1).approvals.length, 0);
    assert.equal(states.at(-1).notifications[0].resolutionOutcome, "allowed");
  });
}

test("disconnect cleanup tolerates persistence and diagnostic logging failure", async () => {
  let fail = false;
  const core = controller({
    stateStore: { load() { return {}; }, save() { if (fail) throw new Error("EPERM save"); } },
    logger: { info() {}, warn() { throw new Error("EPERM log"); } }
  });
  const { pending, waiterId } = await core.enqueueApproval(event(), () => {});
  fail = true;
  assert.doesNotThrow(() => core.detachApprovalWaiter(pending.id, waiterId));
  assert.equal(core.approvals.pending.length, 0);
});

test("waiter error diagnostics cannot prevent the remaining waiters receiving a decision", async () => {
  const core = controller({ logger: { info() {}, warn() { throw new Error("EPERM log"); } } });
  const { pending } = await core.enqueueApproval(event(), () => { throw new Error("closed response"); });
  let response;
  await core.enqueueApproval(event(), (value) => { response = value; });
  assert.doesNotThrow(() => core.resolveApproval(pending.id, "deny"));
  assert.equal(response.body.hookSpecificOutput.decision.behavior, "deny");
});

test("approval store isolates a throwing resolver error reporter", () => {
  const store = new ApprovalStore({ onResolverError() { throw new Error("report failed"); } });
  const { pending } = store.add(event(), () => { throw new Error("closed"); });
  let response;
  store.add(event(), (value) => { response = value; });
  assert.doesNotThrow(() => store.resolve(pending.id, "deny"));
  assert.equal(response.statusCode, 200);
});
