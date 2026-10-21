import fs from "node:fs";
import path from "node:path";
import { removeCcfHookRegistrations } from "./claude-hook-cleanup.js";

function removePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

export function removeCcfClaudeHooks({ home, appRootName = ".chaos-cat-familiar" }) {
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const hookPath = path.join(home, appRootName, "hooks", "hook-sender.ps1");
  let changed = false;
  let removedEvents = [];

  if (fs.existsSync(claudeSettingsPath)) {
    const raw = fs.readFileSync(claudeSettingsPath, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    const result = removeCcfHookRegistrations(parsed, hookPath);
    changed = result.changed;
    removedEvents = result.removedEvents;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(result.updated, null, 2));
  }

  const removedHookScript = removePath(hookPath);
  return {
    ok: true,
    changed,
    removedEvents,
    removedHookScript
  };
}

export function clearCcfLocalData({ appDataRoot, homeRoot, preserveHooks = true }) {
  const removed = [];
  if (appDataRoot && fs.existsSync(appDataRoot)) {
    for (const name of ["state.json", "mascots.json"]) {
      const target = path.join(appDataRoot, name);
      if (removePath(target)) {
        removed.push(target);
      }
    }
  }
  if (homeRoot && fs.existsSync(homeRoot)) {
    if (preserveHooks) {
      const entries = fs.readdirSync(homeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "hooks") {
          continue;
        }
        const target = path.join(homeRoot, entry.name);
        removePath(target);
        removed.push(target);
      }
    } else if (removePath(homeRoot)) {
      removed.push(homeRoot);
    }
  }
  return {
    ok: true,
    removed
  };
}

export function clearCcfCacheAndLogs({ appDataRoot }) {
  const removed = [];
  for (const name of ["logs", "mascot-assets", "runtime.json"]) {
    const target = path.join(appDataRoot, name);
    if (removePath(target)) {
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
