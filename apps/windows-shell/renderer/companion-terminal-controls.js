export function promptKeySequence(event, empty) {
  if (event.isComposing || event.altKey || event.metaKey) return null;
  if (event.ctrlKey) return empty && event.key.toLowerCase() === "c" ? "\x03" : null;
  if (event.key === "Escape") return "\x1b";
  if (!empty || event.shiftKey) return null;
  return { Enter: "\r", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", Tab: "\t" }[event.key] ?? null;
}

export function terminalViewportSize(width, height, cellWidth, lineHeight) {
  return { cols: Math.max(20, Math.min(300, Math.floor(width / Math.max(1, cellWidth)))),
    rows: Math.max(5, Math.min(150, Math.floor(height / Math.max(1, lineHeight)))) };
}
