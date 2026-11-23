import test from "node:test";
import assert from "node:assert/strict";
import { companionMenuTemplate, flattenMenu } from "../services/companion-menu.js";

const state = { visible: true, mascotMode: true, alwaysOnTop: true, sidePanelVisible: true, waitingCount: 0, appShellMode: "mascot" };
const ids = (template) => template.map((item) => item.id ?? item.type);

test("the tray menu: shared items first, then the app items and Quit", () => {
  const template = companionMenuTemplate(state, {}, { surface: "tray" });
  assert.deepEqual(ids(template), ["show-companion", "always-on-top", "side-panel", "minimize-to-tray", "separator",
    "dashboard", "settings", "mascots", "advanced", "separator", "quit"]);
  assert.deepEqual(ids(template.find((item) => item.id === "advanced").submenu),
    ["diagnostics", "preview", "separator", "mascot-mode", "developer-mode"]);
  assert.equal(flattenMenu(template).find((item) => item.id === "mascot-mode").checked, true);
});

test("the cat's menu has no Mascots, Advanced or Quit", () => {
  const template = companionMenuTemplate(state, {}, { surface: "cat" });
  assert.deepEqual(ids(template), ["show-companion", "always-on-top", "side-panel", "minimize-to-tray", "separator",
    "dashboard", "settings"]);
});

test("checkboxes follow the settings, Side Panel needs mascot mode, Minimize needs a visible cluster", () => {
  const find = (template, id) => template.find((item) => item.id === id);
  let template = companionMenuTemplate(state);
  assert.equal(find(template, "always-on-top").type, "checkbox");
  assert.equal(find(template, "always-on-top").checked, true);
  assert.equal(find(template, "side-panel").checked, true);
  assert.equal(find(template, "side-panel").enabled, true);
  assert.equal(find(template, "minimize-to-tray").enabled, true);
  template = companionMenuTemplate({ ...state, visible: false, mascotMode: false, alwaysOnTop: false, sidePanelVisible: false });
  assert.equal(find(template, "always-on-top").checked, false);
  assert.equal(find(template, "side-panel").checked, false);
  assert.equal(find(template, "side-panel").enabled, false);
  assert.equal(find(template, "minimize-to-tray").enabled, false);
});

test("a hidden companion's waiting count shows in the Show label, and clicks run the action by id", () => {
  const calls = [];
  const actions = Object.fromEntries(["show-companion", "always-on-top", "quit"].map((id) => [id, () => calls.push(id)]));
  const template = companionMenuTemplate({ ...state, visible: false, waitingCount: 3 }, actions);
  assert.equal(template[0].label, "Show Companion · 3 waiting");
  assert.equal(companionMenuTemplate(state, actions)[0].label, "Show Companion");
  template[0].click();
  template[1].click();
  flattenMenu(template).find((item) => item.id === "quit").click();
  assert.deepEqual(calls, ["show-companion", "always-on-top", "quit"]);
});
