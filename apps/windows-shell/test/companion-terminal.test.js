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

test("terminal runs merge identical styles and split on every displayed attribute", async () => {
  const terminal = new headless.Terminal({ cols: 30, rows: 5, allowProposedApi: true });
  try {
    await write(terminal, "AB\x1b[31mC\x1b[44mD\x1b[1mE\x1b[2mF\x1b[3mG\x1b[4mHI\x1b[0mJK");
    const runs = readTerminalScreen(terminal).lines[0];
    assert.deepEqual(runs.map((run) => run.text), ["AB", "C", "D", "E", "F", "G", "HI", "JK"]);
    assert.deepEqual(runs.map((run) => run.columns), [2, 1, 1, 1, 1, 1, 2, 2]);
    for (const [index, field] of [[1, "foreground"], [2, "background"], [3, "bold"], [4, "dim"], [5, "italic"], [6, "underline"]]) {
      assert.notEqual(runs[index][field], runs[index - 1][field], `${field} changes start a new run`);
    }
    assert.equal(runs.at(-1).foreground, null);
    assert.equal(runs.at(-1).underline, false);
  } finally { terminal.dispose(); }
});

test("screen serialization reuses one scratch cell without retaining mutable cell data", async () => {
  const terminal = new headless.Terminal({ cols: 20, rows: 5, scrollback: 20, allowProposedApi: true });
  try {
    await write(terminal, "\x1b[31mOld\x1b[0m\r\n1\r\n2\r\n3\r\n4\r\n\x1b[32mNew\x1b[0m");
    const buffer = terminal.buffer.active;
    const getLine = buffer.getLine.bind(buffer);
    const getNullCell = buffer.getNullCell.bind(buffer);
    let scratch;
    let scratchCreations = 0;
    let cellReads = 0;
    buffer.getNullCell = () => { scratchCreations += 1; scratch = getNullCell(); return scratch; };
    buffer.getLine = (row) => {
      const line = getLine(row);
      if (!line) return line;
      const getCell = line.getCell.bind(line);
      line.getCell = (column, target) => {
        cellReads += 1;
        assert.ok(target, "every cell read receives a scratch cell");
        assert.equal(target, scratch, "history and viewport share one per-read scratch cell");
        return getCell(column, target);
      };
      return line;
    };
    const snapshot = readTerminalScreen(terminal);
    assert.equal(scratchCreations, 1);
    assert.ok(cellReads >= terminal.cols * terminal.rows);
    assert.equal(snapshot.history[0][0].text, "Old");
    assert.equal(snapshot.history[0][0].foreground, "#cd3131");
    assert.equal(snapshot.lines.at(-1)[0].text, "New");
    assert.equal(snapshot.lines.at(-1)[0].foreground, "#0dbc79");
    getLine(buffer.baseY).getCell(0, scratch);
    assert.equal(snapshot.history[0][0].text, "Old", "later scratch mutation cannot alter serialized primitives");
    assert.equal(snapshot.history[0][0].foreground, "#cd3131");
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
    assert.ok(element.children.some((node) => node.textContent.includes("Earlier line 0")));
  } finally { terminal.dispose(); }
});

test("terminal history stays correct across trim, alternate screen, same-text repaint and scrollback clear", async () => {
  const terminal = new headless.Terminal({ cols: 20, rows: 5, scrollback: 6, allowProposedApi: true });
  try {
    await write(terminal, Array.from({ length: 20 }, (_, index) => `line ${index}\r\n`).join(""));
    const normal = readTerminalScreen(terminal);
    assert.equal(normal.history.length, 6);
    assert.equal(normal.history[0][0].text, "line 10");
    await write(terminal, "\x1b[?1049h\x1b[31mSame\x1b[0m");
    assert.deepEqual(readTerminalScreen(terminal).history, []);
    await write(terminal, "\x1b[H\x1b[32mSame\x1b[0m");
    const repainted = readTerminalScreen(terminal);
    assert.equal(repainted.lines[0][0].text, "Same");
    assert.equal(repainted.lines[0][0].foreground, "#0dbc79");
    await write(terminal, "\x1b[?1049l");
    assert.deepEqual(readTerminalScreen(terminal).history, normal.history);
    await write(terminal, "\x1b[3J\x1b[2J\x1b[H\x1b[44m   \x1b[0m  ");
    const cleared = readTerminalScreen(terminal);
    assert.deepEqual(cleared.history, []);
    assert.equal(cleared.lines[0][0].text, "   ", "painted blanks survive trimming of ordinary trailing blanks");
    assert.equal(cleared.lines[0].length, 1);
  } finally { terminal.dispose(); }
});

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.style = {};
    this.children = [];
    this._textContent = "";
    this.parentNode = null;
  }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._textContent = value; this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentNode = this;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0);
    this.children.splice(index, 1);
    child.parentNode = null;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = "";
    this.append(...children);
  }
}
const document = { createElement: (tag) => new Element(tag, document) };

test("terminal renderer creates safe styled spans and rejects untrusted CSS values", () => {
  const element = new Element("pre", document);
  renderCompanionTerminal(element, { lines: [[{
    text: '<img src=x onerror="bad()">', foreground: "#aabbcc", background: "url(evil)",
    bold: true, italic: true, underline: true, dim: true
  }, { text: "plain", foreground: "red;display:none" }], [{ text: "next" }]] });
  const [, styled, plain] = element.children[0].children;
  const [newline, next] = element.children[1].children;
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

test("terminal DOM retains 1000 history rows across repaint, append and trim with legacy snapshots", () => {
  let created = 0;
  const doc = { createElement(tag) { created++; return new Element(tag, doc); } };
  const element = new Element("pre", doc);
  const history = Array.from({ length: 1000 }, (_, index) => [{ text: `History ${index}`, foreground: "#00ff00" }]);
  assert.equal(renderCompanionTerminal(element, { history, lines: [[{ text: "Working" }]] }), true);
  const original = [...element.children];
  const beforeRepaint = created;
  assert.equal(renderCompanionTerminal(element, { history: structuredClone(history), lines: [[{ text: "Done", foreground: "#ff0000" }]] }), true);
  assert.equal(created - beforeRepaint, 3, "a repaint allocates one row, its separator and one run instead of 1001 rows");
  assert.equal(element.children[0], original[0]);
  assert.equal(element.children[999], original[999]);
  const beforeRepeat = created;
  assert.equal(renderCompanionTerminal(element, { history: structuredClone(history), lines: [[{ text: "Done", foreground: "#ff0000" }]] }), false);
  assert.equal(created, beforeRepeat, "unchanged legacy snapshots allocate no DOM");
  const trimmedHistory = [...history.slice(1), [{ text: "Done", foreground: "#ff0000" }]];
  const beforeTrim = created;
  renderCompanionTerminal(element, { history: trimmedHistory, lines: [[{ text: "Next" }]] });
  assert.equal(created - beforeTrim, 3, "scrollback trim and append reuse shifted row nodes");
  assert.equal(element.children[0], original[1]);
  assert.ok(element.textContent.startsWith("History 1\nHistory 2"), "the new first row has no stale leading newline");
  assert.ok(element.textContent.endsWith("\nDone\nNext"));
  renderCompanionTerminal(element, { lines: [[{ text: '<script>猫😸</script>', background: "url(evil)" }]] });
  assert.equal(element.children.length, 1);
  assert.equal(element.textContent, '<script>猫😸</script>');
  assert.equal(element.children[0].children[1].style.backgroundColor, undefined);
});

test("shifted history with a common styled prefix reuses all remaining rows", () => {
  let created = 0;
  const doc = { createElement(tag) { created++; return new Element(tag, doc); } };
  const element = new Element("pre", doc);
  const history = Array.from({ length: 1000 }, (_, index) => [{ text: "shared prefix", bold: true }, { text: ` value ${index}` }]);
  renderCompanionTerminal(element, { history });
  const second = element.children[1];
  const before = created;
  renderCompanionTerminal(element, { history: [...history.slice(1), [{ text: "shared prefix", bold: true }, { text: " value 1000" }]] });
  assert.equal(element.children[0], second);
  assert.equal(created - before, 4);
  assert.ok(element.textContent.startsWith("shared prefix value 1\nshared prefix value 2"));
});
