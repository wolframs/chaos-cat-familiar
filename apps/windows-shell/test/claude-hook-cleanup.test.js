import test from "node:test";
import assert from "node:assert/strict";
import { removeCcfHookRegistrations } from "../services/claude-hook-cleanup.js";

test("removeCcfHookRegistrations removes only CCF hook commands", () => {
  const input = {
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "powershell -ExecutionPolicy Bypass -File \"C:\\Users\\dev\\.chaos-cat-familiar\\hooks\\hook-sender.ps1\"" },
            { type: "command", command: "python some-other-hook.py" }
          ]
        }
      ],
      Notification: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "powershell -ExecutionPolicy Bypass -File \"C:\\Users\\dev\\.chaos-cat-familiar\\hooks\\hook-sender.ps1\"" }
          ]
        }
      ]
    }
  };

  const result = removeCcfHookRegistrations(input, "C:\\Users\\dev\\.chaos-cat-familiar\\hooks\\hook-sender.ps1");

  assert.equal(result.changed, true);
  assert.deepEqual(result.removedEvents.sort(), ["Notification"]);
  assert.equal(result.updated.hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(result.updated.hooks.PreToolUse[0].hooks[0].command, "python some-other-hook.py");
  assert.equal("Notification" in result.updated.hooks, false);
});

test("removeCcfHookRegistrations leaves unrelated settings unchanged", () => {
  const input = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "python keep-me.py" }]
        }
      ]
    }
  };

  const result = removeCcfHookRegistrations(input, "C:\\Users\\dev\\.chaos-cat-familiar\\hooks\\hook-sender.ps1");

  assert.equal(result.changed, false);
  assert.deepEqual(result.updated, input);
});
