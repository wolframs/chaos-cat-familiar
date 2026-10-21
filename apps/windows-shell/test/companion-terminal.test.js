import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { readTerminalScreen } from "../services/terminal-screen.js";
import { renderCompanionTerminal } from "../renderer/companion-terminal.js";

function write(terminal, text) {
  return new Promise((resolve) => terminal.write(text, resolve));
}

test("styled terminal snapshot preserves palette, RGB, attributes and cursor-positioned repaint", async () => {
  const terminal = new headless.Terminal({ cols: 30, rows: 5, allowProposedApi: true });
  try {
    await write(terminal, "\x1b[31;1;2;3;4mRed\x1b[0m \x1b[38;5;196m256\x1b[0m \x1b[38;2;12;34;56;48;2;65;43;21mRGB\x1b[0m!");
    const snapshot = readTerminalScreen(terminal);
    assert.equal(snapshot.screen, "Red 256 RGB!");
    assert.deepEqual(snapshot.cursor, { row: 0, column: 12 });
    assert.equal(snapshot.lines.length, 1);
    const [red, , palette, , rgb, reset] = snapshot.lines[0];
    assert.equal(red.foreground, "#cd3131");
    assert.equal(red.bold, true);
    assert.equal(red.dim, true);
    assert.equal(red.italic, true);
    assert.equal(red.underline, true);
    assert.equal(palette.foreground, "#ff0000");
    assert.equal(rgb.foreground, "#0c2238");
    assert.equal(rgb.background, "#412b15");
    assert.equal(reset.foreground, null);
    await write(terminal, "\x1b[2J\x1b[H\x1b[32mNew\x1b[0m");
    const repaint = readTerminalScreen(terminal);
    assert.equal(repaint.screen, "New");
    assert.equal(repaint.lines[0][0].foreground, "#0dbc79");
    assert.equal(repaint.lines[0][0].text, "New");
  } finally { terminal.dispose(); }
});

test("wide Unicode cells do not duplicate padding, and painted whitespace and inverse survive", async () => {
  const terminal = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  try {
    await write(terminal, "猫😸e\u0301 X\r\n\x1b[44m   \x1b[0m\r\n\x1b[7mI\x1b[0m");
    const snapshot = readTerminalScreen(terminal);
    assert.equal(snapshot.lines[0].map((run) => run.text).join(""), "猫😸é X");
    // Match the installed xterm Unicode table (CJK is wide; this emoji is 1).
    assert.equal(snapshot.lines[0].reduce((total, run) => total + run.columns, 0), 6);
    assert.equal(snapshot.lines[1][0].text, "   ");
    assert.equal(snapshot.lines[1][0].background, "#2472c8");
    assert.equal(snapshot.lines[2][0].foreground, "#100d18");
    assert.equal(snapshot.lines[2][0].background, "#ded6ea");
  } finally { terminal.dispose(); }
});

test("terminal output retains styled scrollback outside the current viewport", async () => {
  const terminal = new headless.Terminal({ cols: 30, rows: 5, scrollback: 20, allowProposedApi: true });
  try {
    await write(terminal, Array.from({ length: 18 }, (_, i) => `\x1b[32mEarlier line ${i}\x1b[0m\r\n`).join(""));
    const snapshot = readTerminalScreen(terminal);
    assert.ok(snapshot.history.length > 0);
    assert.equal(snapshot.history[0][0].text, "Earlier line 0");
    assert.equal(snapshot.history[0][0].foreground, "#0dbc79");
    assert.ok(!snapshot.screen.includes("Earlier line 0"), "current-screen API remains a viewport");
    assert.ok(snapshot.history.length <= 20);
    await write(terminal, "\x1b[2J\x1b[HFresh screen");
    const repainted = readTerminalScreen(terminal);
    assert.equal(repainted.history[0][0].text, "Earlier line 0", "TUI repaint cannot erase older scrollback");
    const element = new Element("pre", document);
    renderCompanionTerminal(element, repainted);
    assert.ok(element.children.some((node) => node.textContent === "Earlier line 0"));
  } finally { terminal.dispose(); }
});

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.style = {};
    this.children = [];
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
const document = { createElement: (tag) => new Element(tag, document) };

test("terminal renderer creates safe styled spans and rejects untrusted CSS values", () => {
  const element = new Element("pre", document);
  renderCompanionTerminal(element, { lines: [[{
    text: '<img src=x onerror="bad()">', foreground: "#aabbcc", background: "url(evil)",
    bold: true, italic: true, underline: true, dim: true
  }, { text: "plain", foreground: "red;display:none" }], [{ text: "next" }]] });
  const [styled, plain, newline, next] = element.children;
  assert.equal(styled.tagName, "span");
  assert.equal(styled.textContent, '<img src=x onerror="bad()">');
  assert.equal(styled.children.length, 0);
  assert.equal(styled.style.color, "#aabbcc");
  assert.equal(styled.style.backgroundColor, undefined);
  assert.equal(styled.style.fontWeight, "700");
  assert.equal(styled.style.fontStyle, "italic");
  assert.equal(styled.style.textDecorationLine, "underline");
  assert.equal(styled.style.opacity, "0.65");
  assert.equal(plain.style.color, undefined);
  assert.equal(newline.textContent, "\n");
  assert.equal(next.textContent, "next");
  renderCompanionTerminal(element, { screen: "old fixture\ntext" });
  assert.equal(element.children[0].textContent, "old fixture\ntext");
});
