// The cleanup actions of the dashboard's "Storage & Cleanup" (process-split plan, step 7: covered before main's file work
// became asynchronous).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCcfCacheAndLogs, clearCcfLocalData, removeCcfClaudeHooks } from "../services/windows-cleanup.js";

function roots(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDataRoot = path.join(root, "appdata", "chaos-cat-familiar");
  const home = path.join(root, "home");
  const write = (file, text = "x") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { appDataRoot, home, homeRoot: path.join(home, ".chaos-cat-familiar"), write };
}

test("clearing local data removes CCF's own files and keeps the hook sender and the database", async (t) => {
  const { appDataRoot, homeRoot, write } = roots(t);
  for (const name of ["mascots.json", "state.json", "ccf.sqlite", "settings.json"]) write(path.join(appDataRoot, name));
  write(path.join(homeRoot, "hooks", "hook-sender.ps1"));
  write(path.join(homeRoot, "scratch", "note.txt"));
  const result = await clearCcfLocalData({ appDataRoot, homeRoot, preserveHooks: true });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(appDataRoot).sort(), ["ccf.sqlite", "settings.json"]);
  assert.deepEqual(fs.readdirSync(homeRoot), ["hooks"]);
  assert.deepEqual(result.removed.map((item) => path.basename(item)).sort(), ["mascots.json", "scratch", "state.json"]);
});

test("clearing cache and logs removes the log folder, the mascot cache and runtime.json only", async (t) => {
  const { appDataRoot, write } = roots(t);
  write(path.join(appDataRoot, "logs", "chaos-cat-familiar.log"));
  write(path.join(appDataRoot, "mascot-assets", "0123456789ab.png"));
  write(path.join(appDataRoot, "runtime.json"), "{}");
  write(path.join(appDataRoot, "settings.json"), "{}");
  const result = await clearCcfCacheAndLogs({ appDataRoot });
  assert.deepEqual(fs.readdirSync(appDataRoot), ["settings.json"]);
  assert.equal(result.removed.length, 3);
  assert.deepEqual((await clearCcfCacheAndLogs({ appDataRoot })).removed, [], "nothing left the second time");
});

test("removing hooks takes out CCF's registrations and sender, and leaves other hooks alone", async (t) => {
  const { home, write } = roots(t);
  const hookPath = path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1");
  write(hookPath, "# sender");
  const settingsPath = path.join(home, ".claude", "settings.json");
  write(settingsPath, JSON.stringify({ model: "x", hooks: {
    Stop: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:49152/hook", headers: { "X-Ccf-Token": "t" }, timeout: 5 }] },
      { matcher: "", hooks: [{ type: "command", command: "my-own-hook" }] }],
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `powershell -NoProfile -File "${hookPath}"` }] }]
  } }));
  const result = await removeCcfClaudeHooks({ home });
  assert.equal(result.ok, true);
  assert.equal(result.removedHookScript, true);
  assert.equal(fs.existsSync(hookPath), false);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.model, "x");
  assert.deepEqual(JSON.stringify(settings.hooks).includes("my-own-hook"), true);
  assert.equal(JSON.stringify(settings.hooks).includes("X-Ccf-Token"), false);
  assert.equal(JSON.stringify(settings.hooks).includes("hook-sender.ps1"), false);
  assert.deepEqual((await removeCcfClaudeHooks({ home })).removedHookScript, false, "nothing left to remove");
});
