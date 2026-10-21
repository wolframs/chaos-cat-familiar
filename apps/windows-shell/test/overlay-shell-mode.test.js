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
