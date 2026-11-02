import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShellMode, overlayWindowSizeForMode } from "../services/overlay-shell-mode.js";

test("normalizeShellMode keeps mascot mode and falls back unknown values to developer", () => {
  assert.equal(normalizeShellMode("mascot"), "mascot");
  assert.equal(normalizeShellMode("developer"), "developer");
  assert.equal(normalizeShellMode("anything-else"), "developer");
});

test("overlayWindowSizeForMode returns compact mascot size and full developer size", () => {
  assert.deepEqual(overlayWindowSizeForMode("mascot"), { width: 168, height: 144 });
  assert.deepEqual(overlayWindowSizeForMode("developer"), { width: 420, height: 320 });
});

test("developer overlay never inherits the mascot's saved size but keeps its own", () => {
  assert.deepEqual(overlayWindowSizeForMode("developer", { x: 9, y: 9, width: 170, height: 146 }), { width: 420, height: 320 });
  assert.deepEqual(overlayWindowSizeForMode("developer", { x: 9, y: 9, width: 600, height: 480 }), { width: 600, height: 480 });
  assert.deepEqual(overlayWindowSizeForMode("mascot", { x: 9, y: 9, width: 600, height: 480 }), { width: 168, height: 144 });
});
