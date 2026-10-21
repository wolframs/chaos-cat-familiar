import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { spawnLoggedProcess } from "./process-supervisor.mjs";

test("waitForExit reports a child that exited before the wait began", async () => {
  const supervisor = spawnLoggedProcess(process.execPath, ["-e", "process.exit(7)"], {
    cwd: process.cwd(),
    env: process.env
  });
  try {
    await once(supervisor.child, "exit");
    const result = await supervisor.waitForExit(100);
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
  } finally {
    await supervisor.closeLog();
  }
});
