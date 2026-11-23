// One menu definition for the tray and the cat's right-click menu (docs/ARCHITECTURE.md, "The side panel and the
// cluster menu"). Pure: the runtime passes the state and the actions (keyed by item id) and builds the native menu.
// The cat's menu leaves out Mascots, Advanced and Quit: quitting ends the companion's session, and a slip on a
// right-click menu should not do that.
//
// state: { visible, mascotMode, alwaysOnTop, sidePanelVisible, waitingCount, appShellMode }
// actions: { "show-companion", "always-on-top", "side-panel", "minimize-to-tray", dashboard, settings, mascots,
//            diagnostics, preview, "mascot-mode", "developer-mode", quit } -> functions
export function companionMenuTemplate(state = {}, actions = {}, { surface = "tray" } = {}) {
  const tray = surface === "tray";
  const item = (id, label, extra = {}) => ({ id, label, click: actions[id], ...extra });
  const waiting = state.waitingCount > 0 ? ` · ${state.waitingCount} waiting` : "";
  const template = [
    item("show-companion", `Show Companion${waiting}`),
    item("always-on-top", "Always on Top", { type: "checkbox", checked: state.alwaysOnTop !== false }),
    item("side-panel", "Side Panel", { type: "checkbox", checked: state.sidePanelVisible !== false,
      enabled: Boolean(state.mascotMode) }),
    item("minimize-to-tray", "Minimize to Tray", { enabled: Boolean(state.visible) }),
    { type: "separator" },
    item("dashboard", "Dashboard..."),
    item("settings", "Settings...")
  ];
  if (!tray) return template;
  template.push(
    item("mascots", "Mascots..."),
    { id: "advanced", label: "Advanced", submenu: [
      item("diagnostics", "Diagnostics..."),
      item("preview", "Mascot Preview..."),
      { type: "separator" },
      item("mascot-mode", "Floating Mascot", { type: "radio", checked: state.appShellMode === "mascot" }),
      item("developer-mode", "Developer Overlay", { type: "radio", checked: state.appShellMode === "developer" })
    ] },
    { type: "separator" },
    item("quit", "Quit")
  );
  return template;
}

// Every item with an id, submenus included (the test route and tests click items by id).
export function flattenMenu(template) {
  return template.flatMap((entry) => [entry, ...(Array.isArray(entry.submenu) ? flattenMenu(entry.submenu) : [])]);
}
