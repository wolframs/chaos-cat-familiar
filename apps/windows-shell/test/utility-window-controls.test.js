import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

test("utility window controls work without waiting for page data or feature initialization", async () => {
  const handlers = new Map();
  const calls = [];
  const buttons = ["minimize", "toggle-maximize", "close"].map((action) => ({
    dataset: { windowAction: action },
    addEventListener(type, handler) { handlers.set(action, handler); }
  }));
  const source = fs.readFileSync(new URL("../renderer/window-controls.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => buttons },
    window: { ccf: { windowAction: async (action) => calls.push(action) } }
  });
  for (const action of ["minimize", "toggle-maximize", "close"]) await handlers.get(action)();
  assert.deepEqual(calls, ["minimize", "toggle-maximize", "close"]);
});
