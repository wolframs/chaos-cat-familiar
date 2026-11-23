import test from "node:test";
import assert from "node:assert/strict";
import { PANEL_SCHEMA, PanelError, clickTarget, cleanText, formatAge, freshness, isDoneKey, isSafeUrl, itemMeta,
  linkTarget, normalizePanel } from "../renderer/companion-panel-model.js";

const base = (extra = {}) => ({ schema: PANEL_SCHEMA, generatedAt: "2026-11-17T16:47:03+01:00", ...extra });
const section = (extra = {}) => ({ id: "on-you", title: "On you", items: [], ...extra });

test("a wrong schema, a missing object or an unusable generatedAt is not a panel", () => {
  for (const raw of [null, [], "x", { ...base(), schema: "ccf-side-panel/2" }, { schema: PANEL_SCHEMA },
    base({ generatedAt: "2026-11-17T16:47:03" }), base({ generatedAt: "yesterday" })]) {
    assert.throws(() => normalizePanel(raw), PanelError);
  }
  const { panel, dropped } = normalizePanel(base());
  assert.equal(dropped, 0);
  assert.deepEqual(panel, { schema: PANEL_SCHEMA, generatedAt: "2026-11-17T16:47:03+01:00", staleAfterSec: 300,
    title: "panel", sections: [] });
  assert.equal(normalizePanel(base({ generatedAt: "2026-11-17T15:47:03Z" })).panel.generatedAt, "2026-11-17T15:47:03Z");
});

test("staleAfterSec is kept only inside 30..86400, the title is cut", () => {
  assert.equal(normalizePanel(base({ staleAfterSec: 420 })).panel.staleAfterSec, 420);
  for (const value of [29, 86401, 4.5, "420"]) assert.equal(normalizePanel(base({ staleAfterSec: value })).panel.staleAfterSec, 300);
  assert.equal(normalizePanel(base({ title: "a".repeat(30) })).panel.title, `${"a".repeat(23)}…`);
});

test("strings are collapsed and cut, sections and items are capped", () => {
  assert.equal(cleanText("  two\n  lines\t here ", 40), "two lines here");
  assert.equal(cleanText("   ", 10), null);
  assert.equal(cleanText("😺".repeat(5), 3), "😺😺…", "cut on code points, not UTF-16 units");
  const items = Array.from({ length: 25 }, (_, index) => ({ id: `i${index}`, text: `item ${index} `.repeat(30) }));
  const sections = Array.from({ length: 10 }, (_, index) => section({ id: `s${index}`, items }));
  const { panel, dropped } = normalizePanel(base({ sections }));
  assert.equal(panel.sections.length, 8);
  assert.equal(panel.sections[0].items.length, 20);
  assert.ok(Array.from(panel.sections[0].items[0].text).length <= 160);
  assert.ok(panel.sections[0].items[0].text.endsWith("…"));
  assert.equal(dropped, 0, "capping is not dropping");
});

test("bad or duplicate section ids, items without text and duplicate item ids are dropped and counted", () => {
  const { panel, dropped } = normalizePanel(base({ sections: [
    section({ id: "Bad Id" }), section(), section({ title: "dupe" }), section({ id: "x", title: "" }),
    section({ id: "tickets", title: "Tickets", items: [{ id: "a", text: "one" }, { id: "a", text: "again" },
      { id: "b" }, { id: "c", text: "   " }, "nope", { id: "d".repeat(65), text: "long id" }, { id: "e", text: "two" }] })
  ] }));
  assert.deepEqual(panel.sections.map((item) => item.id), ["on-you", "tickets"]);
  assert.deepEqual(panel.sections[1].items.map((item) => item.id), ["a", "e"]);
  assert.equal(dropped, 3 + 5);
});

test("unsafe URLs are removed and counted, the item stays", () => {
  assert.equal(isSafeUrl("https://issues.example/x"), true);
  assert.equal(isSafeUrl("file:///C:/Users/me/pinned.md"), true);
  assert.equal(isSafeUrl("file://localhost/C:/x.md"), true);
  for (const url of ["javascript:alert(1)", "file://server/share/x.md", "ftp://x/y", "C:\\x.md", "", 7, "data:text/html,x"]) {
    assert.equal(isSafeUrl(url), false, String(url));
  }
  const { panel, dropped } = normalizePanel(base({ sections: [section({
    more: { label: "pinned.md", url: "javascript:x" },
    items: [{ id: "a", text: "row", link: "javascript:alert(1)", session: "no spaces allowed",
      links: [{ label: "PR 1126", url: "https://x/pr/1126" }, { label: "bad", url: "vbscript:x" },
        { url: "https://x/pr/1127" }, { label: "c", url: "https://x/c" }, { label: "d", url: "https://x/d" }] }]
  })] }));
  const item = panel.sections[0].items[0];
  assert.equal(item.link, undefined);
  assert.equal(item.session, undefined);
  assert.deepEqual(item.links, [{ label: "PR 1126", url: "https://x/pr/1126" }, { label: "x", url: "https://x/pr/1127" },
    { label: "c", url: "https://x/c" }]);
  assert.equal(panel.sections[0].more, undefined);
  assert.equal(dropped, 4, "link, session, one links entry and more");
});

test("tone and glyph fall back, the optional fields keep their shape", () => {
  const { panel } = normalizePanel(base({ sections: [section({ count: 5, summary: "92 open", stale: true, note: "tracker: last ok 47m ago",
    collapsed: true, empty: "nothing on you", more: { label: "pinned.md", url: "file:///C:/x/pinned.md" },
    items: [
      { id: "a", text: "x", tone: "shouting", glyph: "abc", meta: "a very long meta text", since: "2026-11-17T16:39:44+01:00" },
      { id: "b", text: "y", tone: "attention", glyph: "⏸", since: "2026-11-17T16:39:44", copy: "#2335",
        session: "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b" }
    ] })] }));
  const [a, b] = panel.sections[0].items;
  assert.equal(a.tone, "neutral");
  assert.equal(a.glyph, "•");
  assert.equal(a.meta, "a very long met…");
  assert.equal(a.since, "2026-11-17T16:39:44+01:00");
  assert.equal(b.tone, "attention");
  assert.equal(b.glyph, "⏸");
  assert.equal(b.since, undefined, "a naive time is dropped");
  assert.equal(b.session, "a8bd68be-d097-4bf2-b6bc-f95b2a4a264b");
  const { items, ...rest } = panel.sections[0];
  assert.deepEqual(rest, { id: "on-you", title: "On you", count: 5, summary: "92 open", stale: true,
    note: "tracker: last ok 47m ago", collapsed: true, empty: "nothing on you",
    more: { label: "pinned.md", url: "file:///C:/x/pinned.md" } });
});

test("a done key is kept verbatim when it is a plain token, else dropped and counted", () => {
  const { panel, dropped } = normalizePanel(base({ sections: [section({ items: [
    { id: "a", text: "codex · project-2", done: "codex:01a1f433@2026-11-19T15:45:58+01:00" },
    { id: "b", text: "x", done: "../a path" }, { id: "c", text: "y", done: 7 }, { id: "d", text: "z", done: "" }] })] }));
  const [a, b, c, d] = panel.sections[0].items;
  assert.equal(a.done, "codex:01a1f433@2026-11-19T15:45:58+01:00");
  assert.equal(b.done, undefined);
  assert.equal(c.done, undefined);
  assert.equal(d.done, undefined);
  assert.equal(dropped, 3);
  assert.equal(isDoneKey("x".repeat(161)), false);
});

test("a click focuses the session first, then opens the link, then copies", () => {
  assert.deepEqual(clickTarget({ session: "abcdefgh", link: "https://x", copy: "#1" }), { action: "focus-session", sessionId: "abcdefgh" });
  assert.deepEqual(clickTarget({ link: "https://x", copy: "#1" }), { action: "open-link", url: "https://x" });
  assert.deepEqual(clickTarget({ copy: "#1" }), { action: "copy", text: "#1" });
  assert.equal(clickTarget({ text: "inert" }), null);
});

test("freshness: fresh, stale one second past staleAfterSec, a future generatedAt is fresh, statuses dim", () => {
  const generated = Date.parse("2026-11-17T16:00:00+01:00");
  const snapshot = { status: "ok", panel: { generatedAt: "2026-11-17T16:00:00+01:00", staleAfterSec: 420 } };
  assert.deepEqual(freshness(snapshot, generated + 420_000), { state: "fresh", ageSec: 420, dim: false });
  assert.deepEqual(freshness(snapshot, generated + 421_000), { state: "stale", ageSec: 421, dim: true });
  assert.deepEqual(freshness(snapshot, generated - 60_000), { state: "fresh", ageSec: 0, dim: false });
  assert.deepEqual(freshness({ ...snapshot, status: "missing" }, generated), { state: "missing", ageSec: 0, dim: true });
  assert.deepEqual(freshness({ status: "invalid", panel: null }, generated), { state: "invalid", ageSec: null, dim: true });
  assert.equal(freshness(null).state, "missing");
});

test("ages read now, minutes below two hours, then hours; meta gets the live age", () => {
  assert.equal(formatAge(0), "now");
  assert.equal(formatAge(59), "now");
  assert.equal(formatAge(60), "1m");
  assert.equal(formatAge(119 * 60 + 59), "119m");
  assert.equal(formatAge(120 * 60), "2h");
  assert.equal(formatAge(NaN), "now");
  const now = Date.parse("2026-11-17T16:43:44+01:00");
  assert.equal(itemMeta({ meta: "busy", since: "2026-11-17T16:39:44+01:00" }, now), "busy 4m");
  assert.equal(itemMeta({ since: "2026-11-17T16:39:44+01:00" }, now), "4m");
  assert.equal(itemMeta({ meta: "Doing" }, now), "Doing");
  assert.equal(linkTarget("https://issues.example/a/b"), "issues.example");
  assert.equal(linkTarget("file:///C:/Users/me/My%20Notes/pinned.md"), "pinned.md");
});

test("a heading kind and a depth are kept for the tree look, depth capped at 2, anything else ignored", () => {
  const { panel, dropped } = normalizePanel(base({ sections: [section({ items: [
    { id: "h", text: "Today", kind: "heading" }, { id: "a", text: "x", depth: 1 }, { id: "b", text: "y", depth: 5 },
    { id: "c", text: "z", depth: "1", kind: "folder" }, { id: "d", text: "w", depth: 0 }] })] }));
  const [h, a, b, c, d] = panel.sections[0].items;
  assert.equal(h.kind, "heading");
  assert.equal(a.depth, 1);
  assert.equal(b.depth, 2);
  assert.equal(c.depth, undefined);
  assert.equal(c.kind, undefined);
  assert.equal(d.depth, undefined);
  assert.equal(dropped, 0);
});
