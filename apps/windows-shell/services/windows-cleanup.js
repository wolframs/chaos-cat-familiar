import fs from "node:fs/promises";
import path from "node:path";
import { removeCcfHookRegistrations } from "./claude-hook-cleanup.js";

// The dashboard's cleanup actions (main) and hook removal (the core). Asynchronous: neither process's event loop waits on
// the disk or the virus scanner (process-split plan, step 7).

async function exists(targetPath) {
  try { await fs.access(targetPath); return true; } catch { return false; }
}

async function removePath(targetPath) {
  if (!targetPath || !(await exists(targetPath))) {
    return false;
  }
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
}

export async function removeCcfClaudeHooks({ home, appRootName = ".chaos-cat-familiar" }) {
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const hookPath = path.join(home, appRootName, "hooks", "hook-sender.ps1");
  let changed = false;
  let removedEvents = [];

  const raw = await fs.readFile(claudeSettingsPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw !== null) {
    const parsed = raw ? JSON.parse(raw) : {};
    const result = removeCcfHookRegistrations(parsed, hookPath);
    changed = result.changed;
    removedEvents = result.removedEvents;
    await fs.writeFile(claudeSettingsPath, JSON.stringify(result.updated, null, 2));
  }

  const removedHookScript = await removePath(hookPath);
  return {
    ok: true,
    changed,
    removedEvents,
    removedHookScript
  };
}

export async function clearCcfLocalData({ appDataRoot, homeRoot, preserveHooks = true }) {
  const removed = [];
  if (appDataRoot && await exists(appDataRoot)) {
    for (const name of ["state.json", "mascots.json"]) {
      const target = path.join(appDataRoot, name);
      if (await removePath(target)) {
        removed.push(target);
      }
    }
  }
  if (homeRoot && await exists(homeRoot)) {
    if (preserveHooks) {
      const entries = await fs.readdir(homeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "hooks") {
          continue;
        }
        const target = path.join(homeRoot, entry.name);
        await removePath(target);
        removed.push(target);
      }
    } else if (await removePath(homeRoot)) {
      removed.push(homeRoot);
    }
  }
  return {
    ok: true,
    removed
  };
}

export async function clearCcfCacheAndLogs({ appDataRoot }) {
  const removed = [];
  for (const name of ["logs", "mascot-assets", "runtime.json"]) {
    const target = path.join(appDataRoot, name);
    if (await removePath(target)) {
      removed.push(target);
    }
  }
  return {
    ok: true,
    removed
  };
}

export function removeIdeIntegration() {
  return {
    ok: true,
    removed: [],
    skipped: true,
    reason: "No bundled Windows IDE integration installer is present in this repo yet."
  };
}
