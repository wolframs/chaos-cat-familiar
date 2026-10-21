import test from "node:test";
import assert from "node:assert/strict";
import { sessionActivationTarget } from "../renderer/session-activation.js";

test("session activation keeps the selected session's PID and project together", () => {
  assert.deepEqual(sessionActivationTarget({ id: "second", projectDir: "C:\\same", shellPid: 222 }), { projectDir: "C:\\same", shellPid: 222 });
});

test("approval activation can reuse only the matching session's shell PID", () => {
  const session = { id: "first", projectDir: "C:\\first", shellPid: 111 };
  assert.deepEqual(sessionActivationTarget(session, { sessionId: "first", cwd: "C:\\worktree" }), { projectDir: "C:\\worktree", shellPid: 111 });
  assert.deepEqual(sessionActivationTarget(session, { sessionId: "second", cwd: "C:\\second" }), { projectDir: "C:\\second", shellPid: null });
  assert.deepEqual(sessionActivationTarget(null, { sessionId: "second", cwd: "C:\\second", shellPid: 222 }), { projectDir: "C:\\second", shellPid: 222 });
});
