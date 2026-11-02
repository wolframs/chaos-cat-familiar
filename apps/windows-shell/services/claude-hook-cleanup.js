// CCF owns two kinds of Claude hook entries: the PowerShell sender command (events that need a
// shell PID or a blocking reply) and http hooks that POST straight to the local hook server.
const CCF_HOOK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/hook$/;

function hookCommandIncludes(command, hookPath) {
  return String(command ?? "").toLowerCase().includes(String(hookPath ?? "").toLowerCase());
}

export function isCcfHttpHook(hook) {
  if (hook?.type !== "http" || !CCF_HOOK_URL.test(String(hook.url ?? ""))) return false;
  const headers = hook.headers && typeof hook.headers === "object" ? Object.keys(hook.headers) : [];
  return headers.some((name) => name.toLowerCase() === "x-ccf-token");
}

export function isCcfOwnedHook(hook, hookPath) {
  return hookCommandIncludes(hook?.command, hookPath) || isCcfHttpHook(hook);
}

export function removeCcfHookRegistrations(settingsJson, hookPath) {
  const next = typeof settingsJson === "object" && settingsJson !== null
    ? structuredClone(settingsJson)
    : {};

  if (!next.hooks || typeof next.hooks !== "object") {
    return {
      updated: next,
      removedEvents: [],
      changed: false
    };
  }

  const removedEvents = [];
  let changed = false;

  for (const [eventName, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    const filteredEntries = entries
      .map((entry) => {
        const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
        const remainingHooks = hooks.filter((hook) => !isCcfOwnedHook(hook, hookPath));
        if (remainingHooks.length !== hooks.length) {
          changed = true;
        }
        if (remainingHooks.length === 0) {
          return null;
        }
        return {
          ...entry,
          hooks: remainingHooks
        };
      })
      .filter(Boolean);

    if (filteredEntries.length !== entries.length) {
      removedEvents.push(eventName);
    }

    if (filteredEntries.length > 0) {
      next.hooks[eventName] = filteredEntries;
    } else {
      delete next.hooks[eventName];
    }
  }

  return {
    updated: next,
    removedEvents,
    changed
  };
}
