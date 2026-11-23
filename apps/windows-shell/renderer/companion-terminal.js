import { cells, cleanTerminalCopy, findTextLinks } from "./terminal-text.js";

// Accept only serialized colour values from the screen model, never arbitrary
// CSS or terminal-supplied HTML. textContent also keeps OSC/URL text inert.
function safeColour(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

// Claude Code's own input box (blank spacer, rule, "❯" prompt row, rule) is
// redundant under CCF's composer. This renderer has no xterm instance: it draws
// the viewport rows the main process serializes from its headless buffer. The
// cleanest cut is therefore to drop exactly those rows from the data before
// rendering, rather than masking pixels: no row-height measuring, so scrolling,
// resizing and Ctrl +/- text size keep working, and the scrollback above simply
// moves down by the hidden rows. Only the idle box is hidden. Dialogs, menus,
// permission prompts and a box holding real input are left exactly as drawn;
// any doubt means nothing is hidden.
const RULE = /^─{20,}$/;
const PROMPT_ROW = /^\s*[❯>](\s|$)/;
const MENU_ROW = /^\s*[❯>]?\s*\d+[.)]\s/;
const DIALOG_HINT = /Enter to (select|confirm|submit)|to navigate|Esc to (cancel|go back|exit|close)|Tab to amend|Do you want to/i;
const MAX_FOOTER_ROWS = 5;

function rowText(runs) {
  return Array.isArray(runs) ? runs.map((run) => typeof run?.text === "string" ? run.text : "").join("") : "";
}

// Empty means only whitespace, Claude's inverse cursor cell, or dim placeholder
// text follows the glyph. Anything else is input the user should still see.
function promptIsEmpty(runs) {
  const rest = [];
  let glyphSeen = false;
  for (const run of runs) {
    let text = typeof run?.text === "string" ? run.text : "";
    if (!glyphSeen) {
      const index = text.search(/\S/);
      if (index < 0) continue;
      glyphSeen = true;
      text = text.slice(index + 1);
    }
    if (text.trim()) rest.push({ ...run, text });
  }
  // The cursor cell may sit on the placeholder's first character.
  if (rest[0]?.text.trim().length === 1 && rest[0].background && rest.slice(1).some((run) => run.dim === true)) {
    rest.shift();
  }
  return rest.every((run) => run.dim === true);
}

export function hideClaudePromptBox(lines) {
  if (!Array.isArray(lines) || lines.length < 3) return lines;
  const texts = lines.map((runs) => rowText(runs).trim());
  let bottom = -1;
  for (let row = texts.length - 1; row >= Math.max(0, texts.length - 1 - MAX_FOOTER_ROWS); row -= 1) {
    if (RULE.test(texts[row])) { bottom = row; break; }
  }
  const top = bottom - 2;
  if (top < 0 || !RULE.test(texts[top]) || texts[top].length !== texts[bottom].length) return lines;
  const prompt = rowText(lines[bottom - 1]);
  if (!PROMPT_ROW.test(prompt) || MENU_ROW.test(prompt) || !promptIsEmpty(lines[bottom - 1])) return lines;
  if (texts.slice(bottom + 1).some((text) => RULE.test(text) || DIALOG_HINT.test(text))) return lines;
  const start = top > 0 && !texts[top - 1] ? top - 1 : top;
  return [...lines.slice(0, start), ...lines.slice(bottom + 1)];
}

const renderedScreens = new WeakMap();
const RUN_FIELDS = ["text", "columns", "foreground", "background", "bold", "dim", "italic", "underline", "link"];
const LINK = /^(https?|file):\/\//i;

function validRun(run) { return run && typeof run.text === "string"; }
function hasLink(run) { return typeof run.link === "string" && LINK.test(run.link); }

function splitRun(run, text, link) {
  const columns = run.columns === run.text.length ? text.length : cells(text);
  return { ...run, text, columns, link };
}

function linkRuns(runs, ranges) {
  const linked = [];
  let offset = 0;
  for (const run of runs) {
    if (!validRun(run)) continue;
    const runStart = offset;
    offset += run.text.length;
    if (hasLink(run)) { linked.push(run); continue; }
    let cursor = runStart;
    for (const range of ranges) {
      const start = Math.max(range.start, cursor);
      const end = Math.min(range.end, offset);
      if (start >= end) continue;
      if (start > cursor) linked.push(splitRun(run, run.text.slice(cursor - runStart, start - runStart), run.link ?? null));
      linked.push(splitRun(run, run.text.slice(start - runStart, end - runStart), range.url));
      cursor = end;
    }
    if (cursor === runStart) linked.push(run);
    else if (cursor < offset) linked.push(splitRun(run, run.text.slice(cursor - runStart), run.link ?? null));
  }
  return linked;
}

// Plain-text http(s) and file URLs become links like OSC 8 ones (same span, same click path through main's
// openLink and its file allow-list), across Claude's own line wraps too; OSC 8 runs keep their own target.
export function linkPlainUrls(lines, { columns } = {}) {
  if (!Array.isArray(lines)) return lines;
  const found = findTextLinks(lines.map(rowText), { columns });
  if (found.size === 0) return lines;
  return lines.map((runs, row) => found.has(row) && Array.isArray(runs) ? linkRuns(runs, found.get(row)) : runs);
}

function rowKey(runs) {
  let hash = 2166136261;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!validRun(run)) continue;
    for (const field of RUN_FIELDS) {
      const value = run[field];
      const text = `${typeof value}:${value}`;
      for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
      hash = Math.imul(hash ^ 0xff, 16777619);
    }
  }
  return hash;
}

function rowMatches(row, runs) {
  let index = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!validRun(run)) continue;
    const prior = row.runs[index++];
    if (!prior) return false;
    for (const field of RUN_FIELDS) if (prior[field] !== run[field]) return false;
  }
  return index === row.runs.length;
}

function createRow(document, runs) {
  const node = document.createElement("span");
  const separator = document.createElement("span");
  node.append(separator);
  const savedRuns = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!validRun(run)) continue;
    savedRuns.push(Object.fromEntries(RUN_FIELDS.map((field) => [field, run[field]])));
    const span = document.createElement("span");
    span.textContent = run.text;
    const foreground = safeColour(run.foreground);
    const background = safeColour(run.background);
    if (foreground) span.style.color = foreground;
    if (background) span.style.backgroundColor = background;
    if (run.bold === true) span.style.fontWeight = "700";
    if (run.dim === true) span.style.opacity = "0.65";
    if (run.italic === true) span.style.fontStyle = "italic";
    if (run.underline === true) span.style.textDecorationLine = "underline";
    // A data attribute, not <a href>: a click must never navigate the pane itself.
    if (typeof run.link === "string" && LINK.test(run.link)) {
      span.dataset.link = run.link;
      span.title = run.link;
      span.classList.add("terminal-link");
    }
    node.append(span);
  }
  return { node, separator, runs: savedRuns, key: rowKey(savedRuns) };
}

// Full snapshots from older backends remain supported. Retain unchanged rows,
// including shifted scrollback, so a spinner repaint never rebuilds its history.
// options.columns: the pane's width in cells (the PTY's), for finding URLs cut by a wrap.
export function renderCompanionTerminal(element, terminalSnapshot, options = {}) {
  const document = element.ownerDocument;
  const current = Array.isArray(terminalSnapshot?.lines) ? terminalSnapshot.lines : [];
  const history = Array.isArray(terminalSnapshot?.history) ? terminalSnapshot.history : [];
  const lines = linkPlainUrls([...history, ...current], options);
  const prior = renderedScreens.get(element);
  if (lines.length === 0) {
    const content = typeof terminalSnapshot?.screen === "string" ? terminalSnapshot.screen : "";
    if (prior?.text === content) return false;
    const text = document.createElement("span");
    text.textContent = content;
    element.replaceChildren(text);
    renderedScreens.set(element, { text: content, rows: [] });
    return true;
  }
  const previousRows = prior?.rows ?? [];
  const used = new Set();
  const rows = [];
  let candidates;
  for (const [index, runs] of lines.entries()) {
    let row = previousRows[index];
    if (!row || used.has(row) || !rowMatches(row, runs)) {
      row = undefined;
      if (!candidates) {
        candidates = new Map();
        for (const previous of previousRows) {
          if (!candidates.has(previous.key)) candidates.set(previous.key, { rows: [], head: 0 });
          candidates.get(previous.key).rows.push(previous);
        }
      }
      const bucket = candidates.get(rowKey(runs));
      if (bucket) {
        while (bucket.head < bucket.rows.length && used.has(bucket.rows[bucket.head])) bucket.head++;
        // Verify full values even after hashing; collisions cannot render stale rows.
        for (let candidateIndex = bucket.head; candidateIndex < bucket.rows.length; candidateIndex++) {
          const candidate = bucket.rows[candidateIndex];
          if (!used.has(candidate) && rowMatches(candidate, runs)) { row = candidate; break; }
        }
      }
    }
    row ??= createRow(document, runs);
    used.add(row);
    rows.push(row);
  }
  let changed = !prior || Object.hasOwn(prior, "text");
  if (changed) element.replaceChildren();
  for (const row of previousRows) {
    if (!used.has(row)) { element.removeChild(row.node); changed = true; }
  }
  let cursor = element.firstChild;
  for (const [index, row] of rows.entries()) {
    const separator = index ? "\n" : "";
    if (row.separator.textContent !== separator) {
      row.separator.textContent = separator;
      changed = true;
    }
    if (row.node !== cursor) {
      element.insertBefore(row.node, cursor);
      changed = true;
    }
    cursor = row.node.nextSibling;
  }
  renderedScreens.set(element, { rows });
  return changed;
}

// A DOM selection point as { row, column } in the rendered rows (column: offset in the row's text), or null
// outside them. Each row node holds a separator span, then one span per run, each with a single text node.
function selectionPoint(element, rows, node, offset) {
  if (node === element) {
    if (offset < rows.length) return { row: offset, column: 0 };
    return rows.length ? { row: rows.length - 1, column: rowText(rows.at(-1).runs).length } : null;
  }
  let rowNode = node;
  let child = null;
  while (rowNode && rowNode.parentNode !== element) { child = rowNode; rowNode = rowNode.parentNode; }
  const row = rowNode ? rows.findIndex((candidate) => candidate.node === rowNode) : -1;
  if (row < 0) return null;
  const spans = [...rowNode.children];
  const index = child ? spans.indexOf(child) : offset;
  let column = 0;
  for (const span of spans.slice(1, Math.max(1, index))) column += span.textContent.length;
  if (child && index > 0) column += node === child ? (offset > 0 ? child.textContent.length : 0) : offset;
  return { row, column };
}

// The selection's text for the clipboard (see cleanTerminalCopy), or null when the selection is not
// within the rendered rows and the browser's own copy should stand.
export function terminalSelectionText(element, selection, { columns } = {}) {
  const rows = renderedScreens.get(element)?.rows;
  if (!rows?.length || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = selectionPoint(element, rows, range.startContainer, range.startOffset);
  const end = selectionPoint(element, rows, range.endContainer, range.endOffset);
  if (!start || !end || end.row < start.row) return null;
  const texts = rows.map((row) => rowText(row.runs));
  const picked = [];
  for (let row = start.row; row <= end.row; row++) {
    picked.push({ text: texts[row], start: row === start.row ? start.column : 0,
      end: row === end.row ? end.column : texts[row].length });
  }
  // A selection dragged to the start of the next row ends there, not in it.
  if (picked.length > 1 && picked.at(-1).end === 0) picked.pop();
  return cleanTerminalCopy(picked, { columns, context: texts });
}
