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
const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "forward-companion-statusline.ps1");

test("PowerShell status bridge forwards only work-companion payloads without writing to stdout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-status-bridge-test-"));
  const companionPath = path.join(root, "work-companion");
  const settingsPath = path.join(root, "settings.json");
  const received = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ path: request.url, token: request.headers["x-ccf-token"], payload: JSON.parse(body) });
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ port: server.address().port, hookToken: "fixture-token" }));
    const payload = { session_id: "fixture", cwd: companionPath, context_window: { used_percentage: 11 } };
    const args = ["-NoProfile", "-NonInteractive", "-File", bridgePath, "-SettingsPath", settingsPath,
      "-CompanionPath", companionPath, "-Payload"];
    const good = await run("pwsh", [...args, JSON.stringify(payload)], { timeout: 10000 });
    assert.equal(good.stdout, "");
    assert.equal(good.stderr, "");
    assert.deepEqual(received, [{ path: "/companion/status", token: "fixture-token", payload }]);
    await run("pwsh", [...args, JSON.stringify({ ...payload, cwd: root })], { timeout: 10000 });
    assert.equal(received.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
