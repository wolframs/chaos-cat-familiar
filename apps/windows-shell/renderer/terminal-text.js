// Plain-text rules for the companion terminal's rows. Pure functions, no DOM.
//
// Claude Code (Ink) wraps its output to the pane width itself and sends explicit newlines, so xterm's
// isWrapped never marks those rows: one paragraph, bullet or URL arrives as several screen rows, each
// continuation indented to where the text of the first one starts. These heuristics put the rows back
// together for copying, and find http(s) and file URLs, including ones the wrap cut in two.
//
// A row N+1 continues row N when all of these hold:
// - neither is blank, a table or box row, and N+1 does not start a list item, tool result or quote;
// - N+1 is indented to N's text start (one more column when Ink carried the space over the break);
// - N plus a space and N+1's first word would not have fit the wrap width: the break was forced.
// The wrap width is not sent along. It is the longest row with the same text start, but at least the
// pane width minus WRAP_SLACK: every forced break fills its row close to the edge, and a short screen
// alone must not make every row look full. Rows Claude cut off with "…" (tool call headers) run to the
// pane's edge, past the text's wrap width, so they do not count.
// A URL or path cut by the wrap continues on the next row when its row is full, or when its row reaches
// the pane width minus twice WRAP_SLACK and the next row's piece has URL structure (/ ? = & % #): other
// rows with the same text start can still be wider than Claude's text, which wraps a few columns short
// of the pane (2026-11-20, live: a markdown link's URL lost its second and third rows).

const WRAP_SLACK = 6;
const MARKER = /^(?:[-*+•◦▪▸‣⁃●⏺⎿>]|\d{1,3}[.)])(?=\s|$)/u;
const BOX_ROW = /^[─-▟]|[│┃┆┊║]/u;
const CODE_END = /[{};]$/;
const URL_START = /(?<![\w/])(?:https?|file):\/\//giu;
// Characters a URL may hold here; whitespace, quotes, pipes, box drawing and the ellipsis end it.
const URL_CHAR = /[^\s<>"'`|│┃…─-╿]/u;
const URL_TAIL = /[.,;:!?'"*_~]$/u;
const PATHLIKE = /:\/\/|[\\/]/u;
const URL_STRUCTURE = /[/?=&%#]/u;
const TRUNCATED = /…$/u;
const CLOSERS = { ")": "(", "]": "[", "}": "{" };

function wide(code) {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

// Display cells of a string: wide East Asian and emoji count two, combining marks none.
export function cells(text) {
  let count = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code >= 0x300 && code <= 0x36f) continue;
    count += wide(code) ? 2 : 1;
  }
  return count;
}

export function rowLayout(text) {
  const trimmed = String(text ?? "").replace(/\s+$/u, "");
  const body = trimmed.replace(/^ +/, "");
  const indent = trimmed.length - body.length;
  const marker = MARKER.exec(body);
  const contentStart = marker
    ? indent + cells(marker[0]) + /^\s*/u.exec(body.slice(marker[0].length))[0].length : indent;
  return { text: trimmed, body, indent, contentStart, width: cells(trimmed), marker: Boolean(marker),
    blank: !body, box: BOX_ROW.test(body) };
}

// Wrap width per text start, from the rows themselves (see the top of this file).
export function wrapWidths(layouts, columns) {
  const widest = layouts.reduce((max, layout) => Math.max(max, layout.width), 0);
  const pane = Number.isInteger(columns) && columns > 0 ? columns : widest;
  // Rows from before the pane was narrowed are wider than it; they must not all look forced.
  const cap = Math.max(pane, widest);
  const floor = Math.max(1, pane - WRAP_SLACK);
  const byStart = new Map();
  for (const layout of layouts) {
    if (layout.blank || layout.box || TRUNCATED.test(layout.text)) continue;
    byStart.set(layout.contentStart, Math.max(byStart.get(layout.contentStart) ?? 0, layout.width));
  }
  const widthFor = (contentStart) => Math.min(cap, Math.max(floor, byStart.get(contentStart) ?? 0));
  widthFor.urlFloor = Math.max(1, pane - 2 * WRAP_SLACK);
  return widthFor;
}

// Whether `previous` ends in a URL, path or word the wrap cut; `piece` is where `next` picks it up, and
// `after` the rest of next's text. A piece without URL structure that prose follows ("and that is all")
// is the next sentence, not the URL's end.
function cutToken(previous, next, piece, after, widthFor) {
  if (next.indent !== previous.contentStart) return false;
  const tail = /\S+$/u.exec(previous.text)[0];
  const full = previous.width >= widthFor(previous.contentStart);
  if (PATHLIKE.test(tail)) {
    if (URL_STRUCTURE.test(piece)) return full || previous.width >= widthFor.urlFloor;
    return full && !/\S/u.test(after);
  }
  return full && previous.width - cells(tail) <= previous.contentStart;
}

// How row `next` continues row `previous`: "glue" (a word or URL was cut, no space), "space", or null.
// widthFor: from wrapWidths; a plain number is taken as the wrap width with no slack.
export function wrapJoin(previous, next, widthFor) {
  const widths = typeof widthFor === "function" ? widthFor : Object.assign(() => widthFor, { urlFloor: widthFor });
  if (previous.blank || next.blank || previous.box || next.box || next.marker) return null;
  if (next.indent !== previous.contentStart && next.indent !== previous.contentStart + 1) return null;
  const firstWord = /^\S+/u.exec(next.body)[0];
  if (previous.width + 1 + cells(firstWord) <= widths(previous.contentStart)) return null;
  if (cutToken(previous, next, firstWord, next.body.slice(firstWord.length), widths)) return "glue";
  return CODE_END.test(previous.text) ? null : "space";
}

// Selected rows as copy text: trailing blanks dropped, forced wraps joined (their indentation removed),
// real line breaks kept, and the indentation all copied lines share removed.
// rows: [{ text, start?, end? }] in screen order; context: every row text on screen, for the wrap width.
export function cleanTerminalCopy(rows, { columns, context } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const layouts = rows.map((row) => rowLayout(row.text));
  const widthFor = wrapWidths(Array.isArray(context) ? context.map(rowLayout) : layouts, columns);
  const lines = [];
  for (const [index, row] of rows.entries()) {
    const text = String(row.text ?? "");
    const start = Math.max(0, Math.min(text.length, row.start ?? 0));
    const end = Math.max(start, Math.min(text.length, row.end ?? text.length));
    const piece = text.slice(start, end).replace(/\s+$/u, "");
    const join = index > 0
      ? wrapJoin(layouts[index - 1], layouts[index], widthFor) : null;
    if (join && lines.length) {
      const last = lines.at(-1);
      const rest = piece.replace(/^ +/, "");
      last.text = last.text && rest ? `${last.text}${join === "glue" ? "" : " "}${rest}` : last.text || rest;
    } else {
      // A first row taken from mid-row has no indentation of its own to share.
      lines.push({ text: piece, dedent: start === 0 || index > 0 });
    }
  }
  const shared = lines.filter((line) => line.dedent && line.text.trim())
    .reduce((min, line) => Math.min(min, line.text.length - line.text.replace(/^ +/, "").length), Infinity);
  const cut = Number.isFinite(shared) ? shared : 0;
  return lines.map((line) => line.dedent ? line.text.slice(Math.min(cut, line.text.length - line.text.replace(/^ +/, "").length))
    : line.text.replace(/^ +/, "")).join("\n");
}

function urlEnd(text, from) {
  let index = from;
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index));
    if (!URL_CHAR.test(char)) break;
    index += char.length;
  }
  return index;
}

function count(text, char) {
  let total = 0;
  for (const each of text) if (each === char) total++;
  return total;
}

// Trailing punctuation is sentence, not URL; a closing bracket stays only when the URL opened it.
export function trimUrl(url) {
  let text = url;
  for (;;) {
    const last = text.at(-1);
    if (URL_TAIL.test(text)) text = text.slice(0, -1);
    else if (CLOSERS[last] && count(text, last) > count(text, CLOSERS[last])) text = text.slice(0, -1);
    else return text;
  }
}

// URLs in plain row text. A URL that fills its row to the wrap width continues on the next row when that
// row is indented to the URL row's text start and begins with URL characters.
// Returns Map(row -> [{ start, end, url }]) with string offsets; rows without URLs are absent.
export function findTextLinks(texts, { columns } = {}) {
  const found = new Map();
  const covered = new Map();
  let layouts;
  let widthFor;
  for (let row = 0; row < texts.length; row++) {
    const text = String(texts[row] ?? "");
    if (!text.includes("://")) continue;
    URL_START.lastIndex = 0;
    for (let match = URL_START.exec(text); match; match = URL_START.exec(text)) {
      if (match.index < (covered.get(row) ?? 0)) continue;
      const segments = [{ row, start: match.index, end: urlEnd(text, match.index + match[0].length) }];
      for (;;) {
        const last = segments.at(-1);
        const lastText = String(texts[last.row] ?? "");
        if (last.row + 1 >= texts.length || last.end !== lastText.replace(/\s+$/u, "").length) break;
        if (!layouts) {
          layouts = texts.map(rowLayout);
          widthFor = wrapWidths(layouts, columns);
        }
        const previous = layouts[last.row];
        const next = layouts[last.row + 1];
        if (next.blank || next.marker || next.box) break;
        const end = urlEnd(String(texts[last.row + 1]), next.indent);
        if (end === next.indent) break;
        const nextText = String(texts[last.row + 1]);
        if (!cutToken(previous, next, nextText.slice(next.indent, end), nextText.slice(end), widthFor)) break;
        segments.push({ row: last.row + 1, start: next.indent, end });
      }
      const raw = segments.map((segment) => String(texts[segment.row]).slice(segment.start, segment.end)).join("");
      const url = trimUrl(raw);
      let surplus = raw.length - url.length;
      while (surplus > 0) {
        const last = segments.at(-1);
        const take = Math.min(surplus, last.end - last.start);
        last.end -= take;
        surplus -= take;
        if (last.end === last.start) segments.pop();
      }
      if (url.length <= match[0].length) continue;
      for (const segment of segments) {
        if (!found.has(segment.row)) found.set(segment.row, []);
        found.get(segment.row).push({ start: segment.start, end: segment.end, url });
        covered.set(segment.row, Math.max(covered.get(segment.row) ?? 0, segment.end));
      }
      URL_START.lastIndex = Math.max(URL_START.lastIndex, segments[0].end);
    }
  }
  return found;
}
