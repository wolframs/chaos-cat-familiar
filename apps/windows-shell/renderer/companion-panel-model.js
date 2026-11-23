// The side panel's content contract, schema "ccf-side-panel/1" (browser-safe; used by main's SidePanelFeed and by the
// panel page). The file is written by another program (the work companion's tools/panel.py), so everything here is
// validated, capped and cut, and what is invalid is dropped and counted. The panel renders text only; links open
// through main (openLink in the runtime), which refuses executables.
export const PANEL_SCHEMA = "ccf-side-panel/1";

export const PANEL_LIMITS = Object.freeze({
  title: 24, sections: 8, sectionId: 32, sectionTitle: 40, summary: 60, note: 120, empty: 60, moreLabel: 40,
  items: 20, itemId: 64, text: 160, detail: 400, glyph: 2, meta: 16, links: 3, linkLabel: 16, copy: 200, depth: 2
});
export const PANEL_TONES = Object.freeze(["neutral", "attention", "busy", "idle", "ok", "muted"]);
const DEFAULT_STALE_AFTER_SEC = 300;
const SECTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
// An item's done key: opaque to CCF, handed back verbatim when he marks the row done (mark-done action).
const DONE_KEY = /^[A-Za-z0-9:@._+-]{1,160}$/;
// ISO 8601 date and time with an explicit offset (or Z): a naive local time would be read in the wrong zone.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export class PanelError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "PanelError";
    this.reason = reason;
  }
}

// Trimmed, whitespace collapsed, cut to `max` code points with "…"; null for a non-string or empty value.
export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : text;
}

// http(s), or file: on this machine (empty or localhost host). Whether a file link may be opened (no programs or
// scripts) is decided when it is opened, not here.
export function isSafeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let url;
  try { url = new URL(value.trim()); } catch { return false; }
  if (url.protocol === "https:" || url.protocol === "http:") return Boolean(url.hostname);
  return url.protocol === "file:" && (url.hostname === "" || url.hostname === "localhost");
}

function validTime(value) {
  return typeof value === "string" && ISO_WITH_OFFSET.test(value.trim()) && Number.isFinite(Date.parse(value.trim()));
}

function normalizeItem(raw, ids, counter) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const text = cleanText(raw.text, PANEL_LIMITS.text);
  if (!id || Array.from(id).length > PANEL_LIMITS.itemId || ids.has(id) || !text) return null;
  ids.add(id);
  const item = { id, text, tone: PANEL_TONES.includes(raw.tone) ? raw.tone : "neutral", glyph: "•" };
  const glyph = cleanText(raw.glyph, 8);
  if (glyph && Array.from(glyph).length <= PANEL_LIMITS.glyph) item.glyph = glyph;
  const detail = cleanText(raw.detail, PANEL_LIMITS.detail);
  if (detail) item.detail = detail;
  const meta = cleanText(raw.meta, PANEL_LIMITS.meta);
  if (meta) item.meta = meta;
  if (validTime(raw.since)) item.since = raw.since.trim();
  if (raw.link !== undefined && raw.link !== null) {
    if (isSafeUrl(raw.link)) item.link = raw.link.trim();
    else counter.dropped++;
  }
  if (Array.isArray(raw.links)) {
    const links = [];
    for (const entry of raw.links) {
      if (links.length >= PANEL_LIMITS.links) break;
      if (!entry || typeof entry !== "object" || !isSafeUrl(entry.url)) { counter.dropped++; continue; }
      const url = entry.url.trim();
      links.push({ label: cleanText(entry.label, PANEL_LIMITS.linkLabel) ?? linkTarget(url) ?? "link", url });
    }
    if (links.length) item.links = links;
  }
  const copy = cleanText(raw.copy, PANEL_LIMITS.copy);
  if (copy) item.copy = copy;
  if (raw.session !== undefined && raw.session !== null) {
    if (typeof raw.session === "string" && SESSION_ID.test(raw.session)) item.session = raw.session;
    else counter.dropped++;
  }
  if (raw.done !== undefined && raw.done !== null) {
    if (typeof raw.done === "string" && DONE_KEY.test(raw.done)) item.done = raw.done;
    else counter.dropped++;
  }
  // Tree look (2026-11-23, his ask: "a soft indication of it being a tree"): a heading row groups the rows under it,
  // depth indents a row with a guide line. Anything else is ignored, not counted: both are presentation only.
  if (raw.kind === "heading") item.kind = "heading";
  if (Number.isInteger(raw.depth) && raw.depth > 0) item.depth = Math.min(raw.depth, PANEL_LIMITS.depth);
  return item;
}

export function isDoneKey(value) {
  return typeof value === "string" && DONE_KEY.test(value);
}

function normalizeSection(raw, sectionIds, counter) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = cleanText(raw.title, PANEL_LIMITS.sectionTitle);
  if (!SECTION_ID.test(id) || sectionIds.has(id) || !title) return null;
  sectionIds.add(id);
  const section = { id, title, items: [] };
  if (Number.isInteger(raw.count) && raw.count >= 0) section.count = raw.count;
  const summary = cleanText(raw.summary, PANEL_LIMITS.summary);
  if (summary) section.summary = summary;
  if (raw.stale === true) section.stale = true;
  const note = cleanText(raw.note, PANEL_LIMITS.note);
  if (note) section.note = note;
  if (typeof raw.collapsed === "boolean") section.collapsed = raw.collapsed;
  const empty = cleanText(raw.empty, PANEL_LIMITS.empty);
  if (empty) section.empty = empty;
  if (raw.more !== undefined && raw.more !== null) {
    if (raw.more && typeof raw.more === "object" && isSafeUrl(raw.more.url)) {
      const url = raw.more.url.trim();
      section.more = { label: cleanText(raw.more.label, PANEL_LIMITS.moreLabel) ?? linkTarget(url) ?? "more", url };
    } else counter.dropped++;
  }
  const ids = new Set();
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (section.items.length >= PANEL_LIMITS.items) break;
    const item = normalizeItem(entry, ids, counter);
    if (item) section.items.push(item);
    else counter.dropped++;
  }
  return section;
}

// raw (parsed JSON) -> { panel, dropped }. Throws PanelError for something that is not a panel at all.
// dropped counts the sections, items, links and session ids that were invalid and left out.
export function normalizePanel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PanelError("not a JSON object");
  if (raw.schema !== PANEL_SCHEMA) throw new PanelError(`schema is not ${PANEL_SCHEMA}`);
  if (!validTime(raw.generatedAt)) throw new PanelError("generatedAt is not an ISO time with an offset");
  const counter = { dropped: 0 };
  const staleAfterSec = Number.isInteger(raw.staleAfterSec) && raw.staleAfterSec >= 30 && raw.staleAfterSec <= 86400
    ? raw.staleAfterSec : DEFAULT_STALE_AFTER_SEC;
  const panel = { schema: PANEL_SCHEMA, generatedAt: raw.generatedAt.trim(), staleAfterSec,
    title: cleanText(raw.title, PANEL_LIMITS.title) ?? "panel", sections: [] };
  const sectionIds = new Set();
  for (const entry of Array.isArray(raw.sections) ? raw.sections : []) {
    if (panel.sections.length >= PANEL_LIMITS.sections) break;
    const section = normalizeSection(entry, sectionIds, counter);
    if (section) panel.sections.push(section);
    else counter.dropped++;
  }
  return { panel, dropped: counter.dropped };
}

// What a click on a row does: focus the session's terminal, else open the link, else copy; null: the row is inert.
export function clickTarget(item) {
  if (!item) return null;
  if (item.session) return { action: "focus-session", sessionId: item.session };
  if (item.link) return { action: "open-link", url: item.link };
  if (item.copy) return { action: "copy", text: item.copy };
  return null;
}

// The feed's snapshot ({status, panel, ...}) at `now` -> { state, ageSec, dim }. state: fresh | stale | missing |
// invalid | unconfigured. A generatedAt in the future counts as fresh (age 0).
export function freshness(snapshot, now = Date.now()) {
  const panel = snapshot?.panel ?? null;
  const generated = panel ? Date.parse(panel.generatedAt) : NaN;
  const ageSec = Number.isFinite(generated) ? Math.max(0, Math.floor((now - generated) / 1000)) : null;
  const status = snapshot?.status ?? "missing";
  if (status !== "ok") return { state: status, ageSec, dim: true };
  if (!panel || ageSec === null) return { state: "missing", ageSec, dim: true };
  const stale = ageSec > panel.staleAfterSec;
  return { state: stale ? "stale" : "fresh", ageSec, dim: stale };
}

// < 60 s "now", < 120 min "Nm", else "Nh".
export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

// The right-aligned meta text: meta, plus the live age of `since` ("busy 4m").
export function itemMeta(item, now = Date.now()) {
  const since = item?.since ? Date.parse(item.since) : NaN;
  const age = Number.isFinite(since) ? formatAge(Math.max(0, (now - since) / 1000)) : null;
  return [item?.meta ?? null, age].filter(Boolean).join(" ");
}

// A link's target for the hover strip: the host of a web link, the file name of a file link.
export function linkTarget(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "") || null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}
