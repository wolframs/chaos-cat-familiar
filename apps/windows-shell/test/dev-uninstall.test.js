import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("dev uninstall respects flags, preserves unrelated hooks and keeps data on hook-cleanup failure", { skip: process.platform !== "win32" }, (t) => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const tempDir = path.join(repoRoot, ".tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempDir, "ccf-uninstall-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  const hookPath = path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1");
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.join(appData, "chaos-cat-familiar"), { recursive: true });
  fs.writeFileSync(hookPath, "test sender");
  const initialSettings = JSON.stringify({ otherSetting: true, hooks: { Stop: [{ hooks: [
    { type: "command", command: `powershell -File "${hookPath}"` },
    { type: "command", command: "python keep-me.py" }
  ] }] } });
  fs.writeFileSync(settingsPath, initialSettings);
  const script = fileURLToPath(new URL("../../../scripts/windows/dev-uninstall.ps1", import.meta.url));
  const run = (...args) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    cwd: root,
    env: { ...process.env, CCF_HOME_OVERRIDE: home, CCF_APPDATA_OVERRIDE: appData },
    encoding: "utf8", timeout: 15000, windowsHide: true
  });
  const noFlags = run();
  assert.equal(noFlags.status, 0, noFlags.stderr);
  assert.equal(fs.existsSync(hookPath), true);
  fs.writeFileSync(settingsPath, "{ invalid json");
  const failed = run("-RemoveClaudeHooks", "-RemoveAppData");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Claude hook cleanup failed/);
  assert.equal(fs.existsSync(hookPath), true);
  assert.equal(fs.existsSync(path.join(appData, "chaos-cat-familiar")), true);
  fs.writeFileSync(settingsPath, initialSettings);
  const result = run("-RemoveClaudeHooks", "-RemoveAppData");
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.otherSetting, true);
  assert.deepEqual(settings.hooks.Stop[0].hooks, [{ type: "command", command: "python keep-me.py" }]);
  assert.equal(fs.existsSync(path.join(home, ".chaos-cat-familiar")), false);
  assert.equal(fs.existsSync(path.join(appData, "chaos-cat-familiar")), false);
});
