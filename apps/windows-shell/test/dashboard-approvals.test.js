import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dashboardApprovalSubmission } from "../renderer/dashboard-approval-input.js";

test("dashboard shows pending tool details before diagnosis and does not block with onboarding", async () => {
  const source = (await readFile(new URL("../renderer/dashboard.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  let stateHandler;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { html: "", writes: 0, set innerHTML(value) { this.html = value; this.writes += 1; }, get innerHTML() { return this.html; }, classList: { toggle(name, value) { this[name] = value; } }, addEventListener() {}, querySelector() { return node("field"); }, querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  const approval = { id: "p", event: { sessionId: "session-a", toolName: "Bash", cwd: "C:/project", toolInput: { command: "echo <review me>" } } };
  const state = { approvals: [approval], sessions: [], notifications: [], ui: { onboarding: { required: true } } };
  vm.runInNewContext(source, {
    document: { getElementById: node },
    window: { ccf: {
      getLogMetadata: async () => ({ filePath: "C:/test/ccf.log" }), getState: async () => state, getSettings: async () => ({}), getMascotLibrary: async () => ({ mascots: [] }),
      diagnoseHooks: async () => new Promise(() => {}), onState(fn) { stateHandler = fn; }, onSettings() {}, onMascotLibrary() {}
    } }, console
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("viewTitle").textContent, "Approvals");
  assert.equal(node("onboarding").classList.visible, false);
  assert.match(node("viewBody").innerHTML, /echo &lt;review me&gt;/);
  assert.match(node("viewBody").innerHTML, /session-a/);
  assert.match(node("viewBody").innerHTML, /<details/);
  assert.doesNotMatch(node("viewBody").innerHTML, /data-expand=/);
  const writes = node("viewBody").writes;
  stateHandler({ ...state, sessions: [{ id: "other-session", phase: "running" }] });
  assert.equal(node("viewBody").writes, writes, "routine activity preserves the form, focus and caret");
});

test("questions require answers and plan feedback uses supported approval actions", () => {
  const approval = { id: "question", event: { toolInput: { questions: [{ question: "Which?" }] } } };
  assert.throws(() => dashboardApprovalSubmission(approval), /Answer each question/);
  assert.deepEqual(dashboardApprovalSubmission(approval, { answers: { "Which?": "First, Second" } }), { id: "question", action: "allowWithAnswers", payload: { answers: { "Which?": "First, Second" } } });
  assert.deepEqual(dashboardApprovalSubmission({ id: "plan", event: { toolName: "ExitPlanMode" } }, { feedback: " use tests " }), { id: "plan", action: "allowWithFeedback", payload: { feedback: "use tests" } });
});
