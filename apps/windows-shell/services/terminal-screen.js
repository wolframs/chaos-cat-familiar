// Serializable terminal.lines format: rows of adjacent styled runs. Each run has
// text, display-cell columns, nullable #rrggbb foreground/background and boolean
// bold/dim/italic/underline. Wide-character continuation cells are omitted.
// Inverse is resolved against these defaults before serialization. No ANSI or
// markup reaches the renderer. terminal.screen remains the plain-text viewport.
const DEFAULT_FOREGROUND = "#ded6ea";
const DEFAULT_BACKGROUND = "#100d18";
const ANSI_PALETTE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff"
];
const historyCaches = new WeakMap();

function hex(value) { return `#${value.toString(16).padStart(6, "0")}`; }

function paletteColour(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return ANSI_PALETTE[index];
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return hex((grey << 16) | (grey << 8) | grey);
  }
  const cube = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return hex((levels[Math.floor(cube / 36)] << 16)
    | (levels[Math.floor(cube / 6) % 6] << 8) | levels[cube % 6]);
}

function cellStyle(cell) {
  let foreground = cell.isFgRGB() ? hex(cell.getFgColor())
    : cell.isFgPalette() ? paletteColour(cell.getFgColor()) : null;
  let background = cell.isBgRGB() ? hex(cell.getBgColor())
    : cell.isBgPalette() ? paletteColour(cell.getBgColor()) : null;
  if (cell.isInverse()) {
    [foreground, background] = [background ?? DEFAULT_BACKGROUND, foreground ?? DEFAULT_FOREGROUND];
  }
  return {
    foreground, background, bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()), underline: Boolean(cell.isUnderline())
  };
}

function styledLine(line, columns) {
  if (!line) return [];
  const cells = [];
  let lastVisible = -1;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const style = cellStyle(cell);
    const text = cell.isInvisible() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
    cells.push({ text, columns: cell.getWidth(), style });
    // Coloured or underlined blanks are real output (panels, selection, rules).
    if (text.trim() || style.background || style.underline) lastVisible = cells.length - 1;
  }
  const runs = [];
  let previousKey;
  for (const cell of cells.slice(0, lastVisible + 1)) {
    const key = JSON.stringify(cell.style);
    if (key === previousKey) {
      runs.at(-1).text += cell.text;
      runs.at(-1).columns += cell.columns;
    } else {
      runs.push({ text: cell.text, columns: cell.columns, ...cell.style });
      previousKey = key;
    }
  }
  return runs;
}

export function readTerminalScreen(terminal) {
  const buffer = terminal.buffer.active;
  const textLines = [];
  const lines = [];
  const prior = historyCaches.get(terminal);
  const cached = prior?.cols === terminal.cols ? prior.lines : new Map();
  const nextCache = new Map();
  const history = [];
  for (let row = Math.max(0, buffer.baseY - 1000); row < buffer.baseY; row++) {
    const line = buffer.getLine(row);
    const text = line?.translateToString(true) ?? "";
    const previous = cached.get(line);
    const runs = previous?.text === text ? previous.runs : styledLine(line, terminal.cols);
    history.push(runs);
    if (line) nextCache.set(line, { text, runs });
  }
  historyCaches.set(terminal, { cols: terminal.cols, lines: nextCache });
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    textLines.push(line?.translateToString(true) ?? "");
    lines.push(styledLine(line, terminal.cols));
  }
  while (lines.length && lines.at(-1).length === 0) lines.pop();
  return {
    screen: textLines.join("\n").trimEnd(), lines, history,
    cursor: { row: buffer.cursorY, column: buffer.cursorX }
  };
}
