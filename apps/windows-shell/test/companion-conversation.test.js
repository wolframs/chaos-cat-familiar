import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanionSnapshot,
  normalizeSubmission,
  shouldSubmitOnKeydown
} from "../renderer/companion-conversation-model.js";

test("conversation snapshot preserves readable transcript and a separate streaming reply", () => {
  const snapshot = normalizeCompanionSnapshot({
    connected: true,
    phase: "working",
    title: "Status der drei Tickets",
    messages: [
      { id: "one", role: "user", text: "What changed?" },
      { id: "two", role: "assistant", text: "First answer" }
    ],
    liveText: "Still checking…"
  });

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.phase, "working");
  assert.equal(snapshot.title, "Status der drei Tickets");
  assert.deepEqual(snapshot.messages.map(({ role, text }) => [role, text]), [
    ["user", "What changed?"],
    ["assistant", "First answer"]
  ]);
  assert.equal(snapshot.liveText, "Still checking…");
});

test("conversation snapshot rejects unsupported roles and handles offline state", () => {
  const snapshot = normalizeCompanionSnapshot({
    messages: [{ role: "developer", text: "secret" }, { role: "system", text: "Waiting" }],
    phase: "unknown"
  });

  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.phase, "offline");
  assert.deepEqual(snapshot.messages.map(({ role, text }) => [role, text]), [["system", "Waiting"]]);
});

test("message submission preserves multiline content but ignores whitespace-only drafts", () => {
  assert.deepEqual(normalizeSubmission("  First line\nsecond line  ", true), {
    action: "send",
    text: "First line\nsecond line"
  });
  assert.equal(normalizeSubmission("  \n  ", true), null);
  assert.equal(normalizeSubmission("Hello", false), null);
});

test("Enter submits, Shift+Enter and composition keep editing", () => {
  assert.equal(shouldSubmitOnKeydown({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnKeydown({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnKeydown({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitOnKeydown({ key: "Tab" }), false);
});

test("conversation keeps terminal colour runs and owns its normalized copy", () => {
  const terminal = { screen: "Red", lines: [[{ text: "Red", foreground: "#cd3131", bold: true }]] };
  const snapshot = normalizeCompanionSnapshot({ connected: true, terminal });
  assert.deepEqual(snapshot.terminal.lines, terminal.lines);
  snapshot.terminal.lines[0][0].text = "changed";
  assert.equal(terminal.lines[0][0].text, "Red");
});

test("an image-only draft can be sent and carries only staged image identifiers", () => {
  const snapshot = normalizeCompanionSnapshot({ connected: true, attachments: [
    { id: "picture-1", name: "Screenshot.png", previewUrl: "file:///ccf/picture.png", path: "do not accept renderer paths" }
  ], terminal: { history: [[{ text: "Earlier output", foreground: "#123456" }]] } });
  assert.deepEqual(normalizeSubmission("", true, snapshot.attachments), { action: "send", text: "", attachmentIds: ["picture-1"] });
  assert.equal(snapshot.attachments[0].path, undefined);
  assert.equal(snapshot.terminal.history[0][0].text, "Earlier output");
});
