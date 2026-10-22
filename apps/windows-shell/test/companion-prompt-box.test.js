import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { readTerminalScreen } from "../services/terminal-screen.js";
import { hideClaudePromptBox } from "../renderer/companion-terminal.js";

const COLS = 60;
const RULE = `\x1b[38;2;136;136;136m${"─".repeat(COLS)}\x1b[39m`;
const MODE = "  \x1b[38;2;255;107;128m⏵⏵ bypass permissions on\x1b[39m \x1b[2m(shift+tab to cycle) · 1 shell\x1b[22m";

// Renders rows through the real headless xterm the main process uses, so the
// detector sees exactly the serialized runs the renderer receives.
async function viewport(rows, size = 16) {
  const terminal = new headless.Terminal({ cols: COLS, rows: size, allowProposedApi: true });
  try {
    await new Promise((resolve) => terminal.write(rows.join("\r\n"), resolve));
    return readTerminalScreen(terminal).lines;
  } finally { terminal.dispose(); }
}

const text = (lines) => lines.map((runs) => runs.map((run) => run.text).join("").trimEnd());

test("hides Claude Code's idle input box and keeps the mode line and everything above", async () => {
  const lines = await viewport(["● The three tickets are ready.", "", RULE, "❯ \x1b[7m \x1b[27m", RULE, MODE]);
  assert.deepEqual(text(hideClaudePromptBox(lines)), ["● The three tickets are ready.",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell"]);
});

test("hides the box with a dim placeholder, a '>' glyph, no spacer or no footer", async () => {
  const placeholder = await viewport(["Reply", "", RULE, "❯ \x1b[7mT\x1b[27m\x1b[2mry \"fix lint errors\"\x1b[22m", RULE, MODE]);
  assert.deepEqual(text(hideClaudePromptBox(placeholder)), ["Reply", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell"]);
  const ascii = await viewport(["Reply", RULE, ">", RULE, MODE, "  ? for shortcuts"]);
  assert.deepEqual(text(hideClaudePromptBox(ascii)), ["Reply", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell", "  ? for shortcuts"]);
  const bare = await viewport(["Reply", "", RULE, "❯", RULE]);
  assert.deepEqual(text(hideClaudePromptBox(bare)), ["Reply"]);
});

test("shows everything when the box holds real input, so nothing is sent blind", async () => {
  const typed = await viewport(["Reply", "", RULE, "❯ leftover draft\x1b[7m \x1b[27m", RULE, MODE]);
  assert.equal(hideClaudePromptBox(typed), typed);
  const wrapped = await viewport(["Reply", "", RULE, "❯ first line of a long draft", "  second line", RULE, MODE]);
  assert.equal(hideClaudePromptBox(wrapped), wrapped);
});

test("leaves dialogs, permission prompts and menus untouched", async () => {
  const permission = await viewport(["Reply", RULE, " Bash command", "   rm -rf build", " Do you want to proceed?",
    " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"]);
  assert.equal(hideClaudePromptBox(permission), permission);
  const menu = await viewport(["Reply", "", RULE, "❯ 1. Ship it", RULE, "  2. Chat about this", "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel"]);
  assert.equal(hideClaudePromptBox(menu), menu);
  const hinted = await viewport(["Reply", "", RULE, "❯", RULE, "Enter to confirm · Esc to cancel"]);
  assert.equal(hideClaudePromptBox(hinted), hinted, "a dialog hint below the box means it is not the idle prompt");
});

test("requires the box near the bottom and matching full rules", async () => {
  const far = await viewport(["Reply", "", RULE, "❯", RULE, "1", "2", "3", "4", "5", "6"]);
  assert.equal(hideClaudePromptBox(far), far);
  const short = await viewport(["Reply", "", "─".repeat(12), "❯", "─".repeat(12), MODE]);
  assert.equal(hideClaudePromptBox(short), short);
  const uneven = await viewport(["Reply", "", RULE, "❯", "─".repeat(COLS - 10), MODE]);
  assert.equal(hideClaudePromptBox(uneven), uneven);
  for (const value of [[], null, undefined]) assert.equal(hideClaudePromptBox(value), value);
});
