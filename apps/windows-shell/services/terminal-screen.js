// Serializable terminal.lines format: rows of adjacent styled runs. Each run has
// text, display-cell columns, nullable #rrggbb foreground/background and boolean
// bold/dim/italic/underline, and a nullable http(s)/file link (OSC 8).
// Wide-character continuation cells are omitted.
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

// OSC 8 hyperlinks (Claude Code prints them for links) live in xterm's internal link
// service; @xterm/headless has no public API for them. Without it, runs carry no link.
const LINK = /^(https?|file):\/\//i;
function cellLink(cell, links) {
  // The scratch cell keeps a stale `extended` when the next cell has no extended attributes.
  const id = cell.hasExtendedAttrs?.() ? cell.extended?.urlId : 0;
  const uri = id ? links?.getLinkData?.(id)?.uri : null;
  return typeof uri === "string" && LINK.test(uri) ? uri : null;
}

function cellStyle(cell, links) {
  let foreground = cell.isFgRGB() ? hex(cell.getFgColor())
    : cell.isFgPalette() ? paletteColour(cell.getFgColor()) : null;
  let background = cell.isBgRGB() ? hex(cell.getBgColor())
    : cell.isBgPalette() ? paletteColour(cell.getBgColor()) : null;
  if (cell.isInverse()) {
    [foreground, background] = [background ?? DEFAULT_BACKGROUND, foreground ?? DEFAULT_FOREGROUND];
  }
  return {
    foreground, background, bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()), underline: Boolean(cell.isUnderline()), link: cellLink(cell, links)
  };
}

function styledLine(line, columns, scratchCell, links) {
  if (!line) return [];
  const runs = [];
  let lastVisibleRun = -1;
  let lastVisibleTextLength = 0;
  let lastVisibleColumns = 0;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column, scratchCell);
    if (!cell || cell.getWidth() === 0) continue;
    const style = cellStyle(cell, links);
    const text = cell.isInvisible() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
    const previousStyle = runs.at(-1);
    if (previousStyle && style.foreground === previousStyle.foreground
      && style.background === previousStyle.background && style.bold === previousStyle.bold
      && style.dim === previousStyle.dim && style.italic === previousStyle.italic
      && style.underline === previousStyle.underline && style.link === previousStyle.link) {
      previousStyle.text += text;
      previousStyle.columns += cell.getWidth();
    } else {
      runs.push({ text, columns: cell.getWidth(), ...style });
    }
    // Coloured or underlined blanks are real output (panels, selection, rules).
    if (text.trim() || style.background || style.underline) {
      lastVisibleRun = runs.length - 1;
      lastVisibleTextLength = runs.at(-1).text.length;
      lastVisibleColumns = runs.at(-1).columns;
    }
  }
  runs.length = lastVisibleRun + 1;
  if (lastVisibleRun >= 0) {
    runs[lastVisibleRun].text = runs[lastVisibleRun].text.slice(0, lastVisibleTextLength);
    runs[lastVisibleRun].columns = lastVisibleColumns;
  }
  return runs;
}

export function readTerminalScreen(terminal) {
  const buffer = terminal.buffer.active;
  // Extract primitives immediately; never retain this mutable xterm cell.
  const scratchCell = buffer.getNullCell();
  const links = terminal._core?._oscLinkService;
  const textLines = [];
  const lines = [];
  const history = [];
  for (let row = Math.max(0, buffer.baseY - 1000); row < buffer.baseY; row++) {
    const line = buffer.getLine(row);
    // getLine returns fresh public wrappers, so identity is not a cache key.
    // Read current cells directly: styles may change without text changing.
    history.push(styledLine(line, terminal.cols, scratchCell, links));
  }
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    textLines.push(line?.translateToString(true) ?? "");
    lines.push(styledLine(line, terminal.cols, scratchCell, links));
  }
  while (lines.length && lines.at(-1).length === 0) lines.pop();
  return {
    screen: textLines.join("\n").trimEnd(), lines, history,
    cursor: { row: buffer.cursorY, column: buffer.cursorX }
  };
}
