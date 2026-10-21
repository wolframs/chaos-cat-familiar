// Accept only serialized colour values from the screen model, never arbitrary
// CSS or terminal-supplied HTML. textContent also keeps OSC/URL text inert.
function safeColour(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

export function renderCompanionTerminal(element, terminalSnapshot) {
  const document = element.ownerDocument;
  const current = Array.isArray(terminalSnapshot?.lines) ? terminalSnapshot.lines : [];
  const history = Array.isArray(terminalSnapshot?.history) ? terminalSnapshot.history : [];
  const lines = [...history, ...current];
  if (!Array.isArray(lines) || lines.length === 0) {
    const text = document.createElement("span");
    text.textContent = typeof terminalSnapshot?.screen === "string" ? terminalSnapshot.screen : "";
    element.replaceChildren(text);
    return;
  }
  const nodes = [];
  for (const [index, runs] of lines.entries()) {
    if (index) {
      const newline = document.createElement("span");
      newline.textContent = "\n";
      nodes.push(newline);
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      if (!run || typeof run.text !== "string") continue;
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
      nodes.push(span);
    }
  }
  element.replaceChildren(...nodes);
}
