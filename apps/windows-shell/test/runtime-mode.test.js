import test from "node:test";
import assert from "node:assert/strict";
import { detectRuntimeMode } from "../services/runtime-mode.js";

test("detectRuntimeMode reports development mode for unpackaged runs", () => {
  const mode = detectRuntimeMode({
    app: { isPackaged: false },
    processLike: { defaultApp: true }
  });

  assert.deepEqual(mode, {
    isPackaged: false,
    isDefaultApp: true,
    mode: "development"
  });
});

test("detectRuntimeMode reports packaged mode for packaged runs", () => {
  const mode = detectRuntimeMode({
    app: { isPackaged: true },
    processLike: { defaultApp: false }
  });

  assert.deepEqual(mode, {
    isPackaged: true,
    isDefaultApp: false,
    mode: "packaged"
  });
});
