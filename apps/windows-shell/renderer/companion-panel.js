// The companion's side panel: main reads <companion>/state/panel.json (services/side-panel-feed.js) and pushes its
// snapshot here. The content comes from another program, so it is drawn with textContent and DOM calls only, never
// as HTML. The window is not focusable: every action (open, copy, focus a session) goes through main.
import { clickTarget, formatAge, freshness, itemMeta, linkTarget } from "./companion-panel-model.js";

const AGE_TICK_MS = 30_000;
const FLASH_MS = 1800;
const COLLAPSE_KEY = "ccf.panel.collapsed.";

const surface = document.getElementById("surface");
const titleNode = document.getElementById("panelTitle");
const statusNode = document.getElementById("panelStatus");
const list = document.getElementById("panelList");
const strip = document.getElementById("panelStrip");

let snapshot = null;
// Done keys he marked here: the row dims at once and loses its button; the companion's next panel file drops or
// restyles it. Keys no longer in the file are forgotten.
const markedDone = new Set();
let flash = null;
let flashTimer = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function readCollapsed(section) {
  try {
    const value = localStorage.getItem(COLLAPSE_KEY + section.id);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch { /* storage unavailable: the file's initial state */ }
  return section.collapsed === true;
}

function toggleCollapsed(section) {
  const next = !readCollapsed(section);
  try { localStorage.setItem(COLLAPSE_KEY + section.id, next ? "1" : "0"); } catch { /* not remembered */ }
  render();
}

function clock(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--"
    : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function shortFile(file) {
  if (!file) return "state/panel.json";
  return String(file).split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

function headerText(fresh) {
  const panel = snapshot?.panel;
  switch (fresh.state) {
    case "fresh": return `${clock(panel.generatedAt)} · ${formatAge(fresh.ageSec)}`;
    case "stale": return `stale · ${clock(panel.generatedAt)} · ${formatAge(fresh.ageSec)}`;
    case "invalid": return `unreadable · ${snapshot?.error ?? "unknown error"}`;
    case "unconfigured": return "not configured";
    default: return `no data · ${shortFile(snapshot?.file)}`;
  }
}

function emptyMessage(state) {
  if (state === "invalid") return "The panel file could not be read.";
  if (state === "unconfigured") return "No companion folder is set in CCF's settings.";
  return "Waiting for the companion's watcher.";
}

function renderHeader(fresh) {
  titleNode.textContent = snapshot?.panel?.title ?? "panel";
  statusNode.replaceChildren();
  statusNode.className = "status";
  if (flash) {
    statusNode.classList.add("flash");
    if (flash.error) statusNode.classList.add("error");
    statusNode.textContent = flash.text;
    statusNode.title = flash.text;
    return;
  }
  const text = headerText(fresh);
  statusNode.append(text);
  if (snapshot?.dropped > 0) statusNode.append(element("span", "dropped", ` · ${snapshot.dropped} dropped`));
  statusNode.title = text;
}

const FAILURE_TEXT = { unknown_session: "session not known to CCF", session_ended: "session has ended",
  no_terminal_window: "no terminal window found" };

async function act(target) {
  if (!target) return;
  let result;
  try { result = await window.ccf.sidePanelAction(target); }
  catch (error) { result = { ok: false, reason: String(error?.message ?? error) }; }
  if (result?.ok) {
    if (target.action === "mark-done") {
      markedDone.add(target.key);
      render();
    }
    showFlash(target.action === "copy" ? `copied ${target.text}`
      : target.action === "mark-done" ? "marked done"
      : target.action === "focus-session" ? (result.exact === true ? "focused" : "window raised") : "opened");
  } else {
    showFlash(FAILURE_TEXT[result?.reason] ?? String(result?.reason ?? "failed"), true);
  }
}

function showFlash(text, error = false) {
  flash = { text, error };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; renderHeader(freshness(snapshot, Date.now())); }, FLASH_MS);
  renderHeader(freshness(snapshot, Date.now()));
}

function showStrip(row, body, target) {
  strip.replaceChildren(element("div", "body", body));
  if (target) strip.append(element("div", "target", target));
  const rowBox = row.getBoundingClientRect();
  const surfaceBox = surface.getBoundingClientRect();
  strip.classList.toggle("top", rowBox.top + rowBox.height / 2 > surfaceBox.top + surfaceBox.height / 2);
  strip.hidden = false;
}

function hideStrip() {
  strip.hidden = true;
}

function renderItem(item, now) {
  const target = clickTarget(item);
  const row = element("div", `row${target ? " action" : ""}`);
  row.setAttribute("role", "listitem");
  row.dataset.tone = item.tone ?? "neutral";
  if (item.kind === "heading") row.classList.add("heading");
  if (item.depth) row.dataset.depth = String(item.depth);
  row.append(element("span", "glyph", item.glyph ?? "•"), element("span", "text", item.text));
  const trail = element("span", "trail");
  for (const link of (item.links ?? []).slice(0, 2)) {
    const chip = element("span", "chip", link.label);
    chip.addEventListener("click", (event) => { event.stopPropagation(); void act({ action: "open-link", url: link.url }); });
    chip.addEventListener("mouseenter", () => showStrip(row, link.label, linkTarget(link.url)));
    trail.append(chip);
  }
  if (item.copy && (item.session || item.link)) {
    const copy = element("span", "copy-button", "⧉");
    copy.title = `copy ${item.copy}`;
    copy.addEventListener("click", (event) => { event.stopPropagation(); void act({ action: "copy", text: item.copy }); });
    trail.append(copy);
  }
  const meta = itemMeta(item, now);
  if (meta) trail.append(element("span", "meta", meta));
  if (item.done && markedDone.has(item.done)) row.classList.add("marked");
  else if (item.done) {
    const done = element("span", "done-button", "✓");
    done.title = "mark done (tells the companion)";
    done.addEventListener("click", (event) => {
      event.stopPropagation();
      void act({ action: "mark-done", key: item.done, text: item.text });
    });
    trail.append(done);
  }
  row.append(trail);
  if (target) row.addEventListener("click", () => { void act(target); });
  const hoverTarget = item.link ? linkTarget(item.link) : null;
  row.addEventListener("mouseenter", () => showStrip(row, item.detail ?? item.text, hoverTarget));
  return row;
}

function renderSection(section, now) {
  const collapsed = readCollapsed(section);
  const head = element("div", "section-head");
  head.append(element("span", "name", section.title));
  head.append(element("span", "count", String(section.count ?? section.items.length)));
  if (section.summary) head.append(element("span", "summary", section.summary));
  if (section.stale) {
    head.append(element("span", "warn", "⚠"));
    if (section.note) head.append(element("span", "note", section.note));
    head.title = section.note ?? "stale";
  }
  head.append(element("span", "caret", collapsed ? "▸" : "▾"));
  head.addEventListener("click", () => toggleCollapsed(section));
  head.addEventListener("mouseenter", hideStrip);
  const nodes = [head];
  if (collapsed) return nodes;
  for (const item of section.items) nodes.push(renderItem(item, now));
  if (!section.items.length && section.empty) {
    const empty = element("div", "row empty");
    empty.append(element("span", "glyph", ""), element("span", "text", section.empty), element("span", "trail"));
    nodes.push(empty);
  }
  if (section.more) {
    const hidden = (section.count ?? section.items.length) - section.items.length;
    const more = element("div", "more", hidden > 0 ? `+${hidden} more · ${section.more.label}` : section.more.label);
    more.addEventListener("click", () => { void act({ action: "open-link", url: section.more.url }); });
    more.addEventListener("mouseenter", () => showStrip(more, section.more.label, linkTarget(section.more.url)));
    nodes.push(more);
  }
  return nodes;
}

function render() {
  const now = Date.now();
  const fresh = freshness(snapshot, now);
  surface.dataset.state = fresh.state;
  surface.classList.toggle("dim", fresh.dim);
  renderHeader(fresh);
  const scroll = list.scrollTop;
  const panel = snapshot?.panel;
  if (!panel) {
    hideStrip();
    list.replaceChildren(element("div", "message", emptyMessage(fresh.state)));
    return;
  }
  list.replaceChildren(...panel.sections.flatMap((section) => renderSection(section, now)));
  list.scrollTop = scroll;
}

list.addEventListener("mouseleave", hideStrip);
surface.addEventListener("mouseleave", hideStrip);

function forgetDropped() {
  const keys = new Set((snapshot?.panel?.sections ?? []).flatMap((section) => section.items.map((item) => item.done)));
  for (const key of markedDone) if (!keys.has(key)) markedDone.delete(key);
}

window.ccf.onSidePanel((value) => {
  snapshot = value ?? null;
  forgetDropped();
  render();
});
window.ccf.getSidePanel().then((value) => {
  if (value && !snapshot) snapshot = value;
  render();
}).catch(() => render());

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
// Ages and freshness move on without a new snapshot.
setInterval(() => { if (document.visibilityState === "visible") render(); }, AGE_TICK_MS);
render();
