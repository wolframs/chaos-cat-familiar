import test from "node:test";
import assert from "node:assert/strict";
import { isCcfHttpHook, removeCcfHookRegistrations } from "../services/claude-hook-cleanup.js";

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

test("removeCcfHookRegistrations removes CCF http hooks on any port and keeps other http hooks", () => {
  const ccfHttp = (port) => ({ type: "http", url: `http://127.0.0.1:${port}/hook`,
    headers: { "X-Ccf-Token": "old-token" }, timeout: 5 });
  const foreignHttp = [
    { type: "http", url: "http://127.0.0.1:49152/hook" },
    { type: "http", url: "http://127.0.0.1:49152/other", headers: { "X-Ccf-Token": "t" } },
    { type: "http", url: "https://example.com/hook", headers: { "X-Ccf-Token": "t" } }
  ];
  const input = { hooks: {
    PreToolUse: [{ matcher: "", hooks: [ccfHttp(49152)] }, { matcher: "Bash", hooks: foreignHttp }],
    Stop: [{ matcher: "", hooks: [ccfHttp(50123), { type: "command", command: "python keep-me.py" }] }]
  } };

  const result = removeCcfHookRegistrations(input, "C:\\Users\\dev\\.chaos-cat-familiar\\hooks\\hook-sender.ps1");

  assert.equal(result.changed, true);
  assert.deepEqual(result.updated.hooks.PreToolUse, [{ matcher: "Bash", hooks: foreignHttp }]);
  assert.deepEqual(result.updated.hooks.Stop, [{ matcher: "", hooks: [{ type: "command", command: "python keep-me.py" }] }]);
  assert.equal(isCcfHttpHook({ ...ccfHttp(1), headers: { "x-ccf-token": "lower" } }), true);
  assert.equal(isCcfHttpHook({ ...ccfHttp(1), url: "http://localhost:1/hook" }), false);
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
