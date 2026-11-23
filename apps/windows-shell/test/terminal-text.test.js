import test from "node:test";
import assert from "node:assert/strict";
import { cleanTerminalCopy, findTextLinks, rowLayout, trimUrl, wrapJoin } from "../renderer/terminal-text.js";

const COLUMNS = 60;

// Word wrap the way Ink does it (wrap-ansi, hard): words move to the next row, a word longer than
// the row is cut at the edge.
function wrap(text, width) {
  const rows = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row && row.length + 1 + word.length > width) { rows.push(row); row = ""; }
    let rest = row ? `${row} ${word}` : word;
    while (rest.length > width) { rows.push(rest.slice(0, width)); rest = rest.slice(width); }
    row = rest;
  }
  rows.push(row);
  return rows;
}

// One Claude block: the first row starts with `first`, its continuations are indented to match.
function block(first, text, columns = COLUMNS) {
  const indent = " ".repeat(first.length);
  return wrap(text, columns - first.length).map((row, index) => `${index ? indent : first}${row}`);
}

const copy = (rows, columns = COLUMNS) => cleanTerminalCopy(rows.map((text) => ({ text })), { columns });

const PARAGRAPH = "Here is a paragraph that Claude wrote. It runs long enough that the pane wraps it "
  + "across several rows, and copying it should give back one line with single spaces.";

test("a wrapped paragraph copies as one line", () => {
  const rows = block("● ", PARAGRAPH);
  assert.ok(rows.length >= 3);
  assert.equal(copy(rows), `● ${PARAGRAPH}`);
});

test("wrapped bullets join per bullet; items, nesting and blank lines stay", () => {
  const first = "First bullet that is long enough to wrap onto a second row in this pane.";
  const third = "Third bullet, which also wraps because it carries a fair amount of explanation.";
  const nested = "A nested bullet below the third one that wraps as well in the narrow pane.";
  const rows = ["● Summary:", "", ...block("  - ", first), ...block("  - ", "Second bullet"),
    ...block("  - ", third), ...block("    - ", nested), "", ...block("  1. ", "Numbered item that wraps around "
    + "the edge of the pane like the bullets do."), ...block("  2. ", "Short")];
  assert.equal(copy(rows), ["● Summary:", "", `  - ${first}`, "  - Second bullet", `  - ${third}`,
    `    - ${nested}`, "", "  1. Numbered item that wraps around the edge of the pane like the bullets do.",
    "  2. Short"].join("\n"));
});

test("a file URL cut by the wrap copies whole and links on both rows", () => {
  const url = "file:///C:/Users/someone/repos/project-shared/agentext/cases/2220/layout/render/index.html";
  const linkedText = (rows, links) => [...links].map(([row, [piece]]) => rows[row].slice(piece.start, piece.end)).join("");
  // Ink moves the long URL to a row of its own and cuts it at the edge.
  const moved = block("  ", `The render is at ${url} for review.`);
  assert.equal(moved.length, 3);
  assert.equal(copy(moved), `The render is at ${url} for review.`);
  const movedLinks = findTextLinks(moved, { columns: COLUMNS });
  assert.deepEqual([...movedLinks.keys()], [1, 2]);
  assert.ok([...movedLinks.values()].flat().every((piece) => piece.url === url));
  assert.equal(linkedText(moved, movedLinks), url);
  // Or it starts the URL mid-row and fills the row with it.
  const filled = [`  The render is at ${url.slice(0, 41)}`, `  ${url.slice(41)}`, "  for review."];
  assert.equal(filled[0].length, COLUMNS);
  const filledLinks = findTextLinks(filled, { columns: COLUMNS });
  assert.deepEqual([...filledLinks.keys()], [0, 1]);
  assert.equal(linkedText(filled, filledLinks), url);
  assert.equal(copy(filled), `The render is at ${url}\nfor review.`);
});

test("a URL that ends at a short row's end does not swallow the next row", () => {
  const rows = ["  Docs: https://example.com/a", "  and then the next sentence on its own row."];
  const links = findTextLinks(rows, { columns: COLUMNS });
  assert.deepEqual(links.get(0), [{ start: 8, end: 29, url: "https://example.com/a" }]);
  assert.equal(links.has(1), false);
  assert.equal(copy(rows), "Docs: https://example.com/a\nand then the next sentence on its own row.");
});

test("code blocks keep their lines and their relative indentation", () => {
  const rows = ["  function demo() {", "    const value = compute(1, 2);", "    return value;", "  }"];
  assert.equal(copy(rows), "function demo() {\n  const value = compute(1, 2);\n  return value;\n}");
  // A code line that reaches the edge is not joined to the next statement.
  const longLine = `  const longName = buildSomething(alpha, beta, gamma, delt);`;
  assert.equal(longLine.length, 60);
  assert.equal(copy([longLine, "  return longName;"]), `${longLine.trim()}\nreturn longName;`);
});

test("table rows, rules and tool results stay as drawn, minus the padding", () => {
  const rows = ["  ┌──────┬──────────────────────┐   ", "  │ Name │ Link                 │",
    "  ├──────┼──────────────────────┤", "  │ a    │ https://x.example/a  │", "  └──────┴──────────────────────┘"];
  assert.equal(copy(rows), rows.map((row) => row.trimEnd().slice(2)).join("\n"));
  assert.deepEqual(findTextLinks(rows).get(3), [{ start: 11, end: 30, url: "https://x.example/a" }]);
  const tool = ["● Bash(npm test)", ...block("  ⎿  ", "ok 1 - first test passes and its name is long enough to wrap"),
    "     ok 2 - second"];
  assert.equal(copy(tool), "● Bash(npm test)\n  ⎿  ok 1 - first test passes and its name is long enough to wrap\n"
    + "     ok 2 - second");
});

test("short rows with the same indentation stay separate lines", () => {
  assert.equal(copy(["  Line one   ", "  Line two", "", "  Line three"]), "Line one\nLine two\n\nLine three");
});

test("a selection that starts and ends mid-row keeps only the selected text", () => {
  const rows = block("● ", PARAGRAPH);
  const picked = rows.map((text) => ({ text }));
  picked[0].start = rows[0].indexOf("paragraph");
  picked.at(-1).end = rows.at(-1).indexOf("single") + "single".length;
  const expected = PARAGRAPH.slice(PARAGRAPH.indexOf("paragraph"), PARAGRAPH.indexOf("single") + "single".length);
  assert.equal(cleanTerminalCopy(picked, { columns: COLUMNS }), expected);
});

test("rows from before the pane was narrowed keep the width they were wrapped at", () => {
  const older = block("  ", PARAGRAPH, 80);
  const lines = ["  This is the first line of an older and wider screen of text here.",
    "  This is the second line of that wider screen, a separate line too."];
  const context = [...older, "", ...lines, "", ...block("  ", PARAGRAPH, 40)];
  const picked = (rows) => cleanTerminalCopy(rows.map((text) => ({ text })), { columns: 40, context });
  assert.equal(picked(lines), lines.map((line) => line.trim()).join("\n"));
  assert.equal(picked(older), PARAGRAPH);
});

test("Ink's carried-over space after a word that exactly fits still joins with one space", () => {
  const previous = rowLayout(`  ${"word ".repeat(11)}abcdefgh`);
  assert.equal(previous.width, 65);
  assert.equal(wrapJoin(previous, rowLayout("   next words"), 65), "space");
  assert.equal(wrapJoin(previous, rowLayout("  - a list item"), 65), null);
  assert.equal(wrapJoin(previous, rowLayout("      deeper"), 65), null);
});

test("URLs lose sentence punctuation and unbalanced brackets, Markdown links give their target", () => {
  assert.equal(trimUrl("https://example.com/a."), "https://example.com/a");
  assert.equal(trimUrl("https://example.com/a),"), "https://example.com/a");
  assert.equal(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)"), "https://en.wikipedia.org/wiki/Foo_(bar)");
  const urls = (text) => [...findTextLinks([text]).values()].flat().map((link) => link.url);
  assert.deepEqual(urls("See [the docs](https://code.claude.com/docs/en/env-vars)."), ["https://code.claude.com/docs/en/env-vars"]);
  assert.deepEqual(urls("(http://a.example/x?y=1) and **https://b.example/z**"), ["http://a.example/x?y=1", "https://b.example/z"]);
  assert.deepEqual(urls("open file:///C:/x/handoff.md, then <https://c.example>"), ["file:///C:/x/handoff.md", "https://c.example"]);
  assert.deepEqual(urls("javascript://x ftp://y https:// alone"), []);
  assert.deepEqual(urls("redirect https://a.example/?to=https://b.example/c"), ["https://a.example/?to=https://b.example/c"]);
});

// The live pane on 2026-11-20: Claude wrapped its text at 73 columns while a tool call header above, cut
// off with "…", ran to the pane's edge. The URL got a link on its first row only.
const LIVE_URL = "https://wiki.example.org/bin/view/Handbooks/Desktop-Tools/Companions/Chaos-Cat-Familiar/Settings/"
  + "Conversation-Pane/Links%20and%20Copy/Overviews/";
function liveScreen(columns) {
  return [`● Bash(cd /c/Users/someone/repos/work-companion && python tools/watch.py --until-event`.slice(0, columns - 1) + "…",
    "  ⎿  Running in the background (↓ to manage)", "",
    "● Back after the restart, and I'm watching for events again. Clickable",
    "  links and clean copy should work in the chat pane now, but nobody has",
    "  tried them for real yet: test link (https://wiki.example.org/bin/view/H",
    "  andbooks/Desktop-Tools/Companions/Chaos-Cat-Familiar/Settings/Conversat",
    "  ion-Pane/Links%20and%20Copy/Overviews/)"];
}

test("live rows: the cut markdown link URL links on all three rows and copies whole", () => {
  for (const columns of [74, 76, 80, 84]) {
    const rows = liveScreen(columns);
    const links = findTextLinks(rows, { columns });
    assert.deepEqual([...links.keys()], [5, 6, 7], `columns ${columns}`);
    assert.ok([...links.values()].flat().every((piece) => piece.url === LIVE_URL));
    assert.equal([...links].map(([row, [piece]]) => rows[row].slice(piece.start, piece.end)).join(""), LIVE_URL);
    // Claude's text stops a few columns short of the pane; past WRAP_SLACK the prose rows look unforced.
    if (columns <= 80) assert.equal(copy(rows.slice(3), columns), "● Back after the restart, and I'm watching for events again. Clickable "
      + "links and clean copy should work in the chat pane now, but nobody has tried them for real yet: test link "
      + `(${LIVE_URL})`);
  }
});

test("a URL that ends near the edge does not take a next row without URL structure", () => {
  const rows = ["  The list is at https://example.com/some/longer/path/to/the/listing/pages",
    "  and that is all for today."];
  assert.equal(rows[0].length, 74);
  assert.equal(findTextLinks(rows, { columns: 80 }).has(1), false);
  // As copy text it may well be one wrapped sentence, but never one token.
  assert.equal(copy(rows, 80), "The list is at https://example.com/some/longer/path/to/the/listing/pages and that is all for today.");
});
