import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "open-work-companion-hud.ps1");

test("companion launcher focuses CCF through its authenticated endpoint without starting a process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-companion-open-test-"));
  const settingsPath = path.join(root, "settings.json");
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url, token: request.headers["x-ccf-token"] });
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ port: server.address().port, hookToken: "fixture-token" }));
    const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", script,
      "-SettingsPath", settingsPath], { timeout: 10000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(calls, [
      { method: "GET", path: "/health", token: undefined },
      { method: "POST", path: "/companion/open", token: "fixture-token" }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
