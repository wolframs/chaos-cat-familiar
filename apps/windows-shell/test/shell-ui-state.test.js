import test from "node:test";
import assert from "node:assert/strict";
import { ShellUiState } from "../runtime/shell-ui-state.js";

function createSettingsStore(seed = {}) {
  let value = {
    onboardingVersion: null,
    onboardingCompletedAt: null,
    ...seed
  };
  return {
    load() {
      return { ...value };
    },
    save(next) {
      value = { ...next };
    }
  };
}

function createTimers() {
  return {
    setTimeout(fn) {
      return setTimeout(fn, 0);
    },
    clearTimeout(id) {
      clearTimeout(id);
    }
  };
}

test("onboarding advances linearly through all seven steps", async () => {
  const ui = new ShellUiState({
    settingsStore: createSettingsStore(),
    timers: createTimers(),
    onboardingVersion: 1
  });

  assert.equal(ui.snapshot().onboarding.currentStep, 0);

  for (let expected = 1; expected <= 6; expected += 1) {
    await ui.dispatch("advance-onboarding", {}, {
      coreState: () => ({ approvals: [] }),
      focusSession: async () => {},
      saveSettingsPatch: () => {}
    });
    assert.equal(ui.snapshot().onboarding.currentStep, expected);
  }

  await ui.dispatch("advance-onboarding", {}, {
    coreState: () => ({ approvals: [] }),
    focusSession: async () => {},
    saveSettingsPatch: () => {}
  });
  assert.equal(ui.snapshot().onboarding.currentStep, 6);
});

test("pending approvals suppress routine completion toasts, including deferred requests", () => {
  let scheduled = 0;
  const ui = new ShellUiState({ settingsStore: createSettingsStore(), timers: { setTimeout() { scheduled += 1; return scheduled; }, clearTimeout() {} } });
  const event = { id: "done", hookEventName: "Stop", sessionId: "one" };
  ui.sync({ sessions: [], approvals: [{ id: "pending", collapsed: true }] }, event);
  assert.equal(ui.snapshot().overlay.toast, null);
  assert.equal(scheduled, 0);
  ui.sync({ sessions: [], approvals: [] }, event);
  assert.equal(ui.snapshot().overlay.toast, null, "a suppressed event does not reappear after approval");
});

test("completion bursts share one expiry instead of extending the notification on every session", () => {
  let scheduled = 0;
  const ui = new ShellUiState({ settingsStore: createSettingsStore(), timers: { setTimeout() { scheduled += 1; return scheduled; }, clearTimeout() {} } });
  ui.sync({ sessions: [], approvals: [] }, { id: "first", hookEventName: "Stop", sessionId: "one" });
  const expiry = ui.snapshot().overlay.toast.visibleUntil;
  ui.sync({ sessions: [], approvals: [] }, { id: "second", hookEventName: "Stop", sessionId: "two" });
  assert.equal(scheduled, 1);
  assert.equal(ui.snapshot().overlay.toast.visibleUntil, expiry);
  assert.equal(ui.snapshot().overlay.toast.completedCount, 2);
  ui.sync({ sessions: [], approvals: [] }, { id: "third", hookEventName: "SessionEnd", sessionId: "two" });
  assert.equal(ui.snapshot().overlay.toast.completedCount, 2, "Stop and SessionEnd count the same session once");
  ui.sync({ sessions: [], approvals: [{ id: "pending" }] });
  assert.equal(ui.snapshot().overlay.toast, null);
});

test("disposing shell UI state clears its pending timer", () => {
  const cleared = [];
  const ui = new ShellUiState({ settingsStore: createSettingsStore(), timers: { setTimeout() { return 42; }, clearTimeout(id) { cleared.push(id); } } });
  ui.sync({ sessions: [], approvals: [] }, { id: "done", hookEventName: "Stop", sessionId: "one" });
  ui.dispose();
  ui.dispose();
  assert.deepEqual(cleared, [42]);
  assert.equal(ui.snapshot().overlay.toast, null);
});
