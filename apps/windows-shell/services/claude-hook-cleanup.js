function hookCommandIncludes(command, hookPath) {
  return String(command ?? "").toLowerCase().includes(String(hookPath ?? "").toLowerCase());
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
        const remainingHooks = hooks.filter((hook) => !hookCommandIncludes(hook.command, hookPath));
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
