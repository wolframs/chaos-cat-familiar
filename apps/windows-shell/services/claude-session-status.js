import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code keeps one ~/.claude/sessions/<pid>.json per live session with a
// `status`: busy, idle, waiting, or "shell" = the turn ended but a background
// task (shell or sub agent) still runs and will wake the session again. An
// idle_prompt from a "shell" session is not a session waiting on the user: it
// fires each time an orchestrating agent ends a turn while its sub agents work.
export function claudeSessionsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "sessions");
}

export function claudeSessionStatus(sessionId, { dir = claudeSessionsDir(), readdir = fs.readdirSync,
  readFile = fs.readFileSync } = {}) {
  if (!sessionId) return null;
  let names;
  try { names = readdir(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFile(path.join(dir, name), "utf8"));
      if (record?.sessionId === sessionId) return typeof record.status === "string" ? record.status : null;
    } catch {
      // A file being rewritten or gone: skip it.
    }
  }
  return null;
}

export function hasPendingBackgroundWork(sessionId, options) {
  return claudeSessionStatus(sessionId, options) === "shell";
}
