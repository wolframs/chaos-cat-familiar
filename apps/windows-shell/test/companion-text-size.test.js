import test from "node:test";
import assert from "node:assert/strict";
import { fontSizeShortcut, normalizeTextSize, installCompanionTextSize } from "../renderer/companion-text-size.js";
import { promptKeySequence, terminalViewportSize } from "../renderer/companion-terminal-controls.js";

test("Ctrl numpad text sizing supports both keyboards and leaves unrelated input alone", () => {
  assert.equal(fontSizeShortcut({ ctrlKey: true, code: "NumpadAdd" }), 1);
  assert.equal(fontSizeShortcut({ ctrlKey: true, code: "NumpadSubtract" }), -1);
  assert.equal(fontSizeShortcut({ ctrlKey: true, code: "Numpad0" }), 0);
  assert.equal(fontSizeShortcut({ ctrlKey: true, key: "+" }), 1);
  assert.equal(fontSizeShortcut({ ctrlKey: true, key: "-" }), -1);
  for (const event of [{ code: "NumpadAdd" }, { ctrlKey: true, altKey: true, code: "NumpadAdd" },
    { ctrlKey: true, code: "NumpadAdd", isComposing: true }]) assert.equal(fontSizeShortcut(event), null);
  assert.equal(normalizeTextSize("invalid"), 14);
  assert.equal(normalizeTextSize(200), 28);
  assert.equal(normalizeTextSize(2), 10);
});

test("text size persists, adjusts independently of page zoom and survives blocked storage", () => {
  const values = new Map([["ccf:companion:text-size", "16"]]);
  let keydown;
  let size;
  const sizes = [];
  const window = { localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    addEventListener(_name, listener) { keydown = listener; }, removeEventListener() {} };
  const document = { documentElement: { style: { setProperty(_key, value) { size = value; } } } };
  const controller = installCompanionTextSize({ window, document, onChange: (value) => sizes.push(value) });
  assert.equal(size, "16px");
  let prevented = false;
  keydown({ ctrlKey: true, code: "NumpadAdd", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(size, "17px");
  assert.equal(values.get("ccf:companion:text-size"), "17");
  assert.deepEqual(sizes, [16, 17]);
  controller.dispose();
  window.localStorage.getItem = () => { throw new Error("blocked"); };
  installCompanionTextSize({ window, document });
  assert.equal(size, "14px");
});

test("one empty composer supplies terminal dialog keys while ordinary drafts keep editing", () => {
  assert.equal(promptKeySequence({ key: "ArrowDown" }, true), "\x1b[B");
  assert.equal(promptKeySequence({ key: "Enter" }, true), "\r");
  assert.equal(promptKeySequence({ key: "Escape" }, false), "\x1b");
  assert.equal(promptKeySequence({ key: "c", ctrlKey: true }, true), "\x03");
  assert.equal(promptKeySequence({ key: "ArrowUp" }, false), null);
  assert.equal(promptKeySequence({ key: "Enter", shiftKey: true }, true), null);
  assert.equal(promptKeySequence({ key: "Enter", isComposing: true }, true), null);
});

test("larger terminal text requests fewer columns and rows so output reflows", () => {
  assert.deepEqual(terminalViewportSize(600, 300, 7, 15), { cols: 85, rows: 20 });
  assert.deepEqual(terminalViewportSize(600, 300, 10, 20), { cols: 60, rows: 15 });
  assert.deepEqual(terminalViewportSize(0, 0, 10, 20), { cols: 20, rows: 5 });
});
