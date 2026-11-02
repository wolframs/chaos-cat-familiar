// The cat's speech bubbles. Main owns the stack (services/companion-bubbles.js);
// this view keeps one node per bubble so only new ones play their entrance.
// A click pops one bubble; empty space stays click-through (pointer reports).
export const VISIBLE_BUBBLES = 3;
const LEAVE_MS = 200;
const SPARKS = ["✦", "🐾", "✧", "🐾", "✦", "♥", "✧", "🐾"];

const stack = document.getElementById("bubbleStack");
const nodes = new Map();
let badge = null;
let pointerInside = false;

const TAIL_PATH = "M44,0 Q26,30 0,54 Q44,32 82,0";

function tail() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tail");
  svg.setAttribute("viewBox", "0 0 82 54");
  svg.setAttribute("aria-hidden", "true");
  for (const kind of ["tail-fill", "tail-line"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", kind);
    path.setAttribute("d", kind === "tail-fill" ? `${TAIL_PATH} Z` : TAIL_PATH);
    svg.append(path);
  }
  return svg;
}

function sparkle(bubble) {
  const burst = document.createElement("span");
  burst.className = "sparks";
  burst.setAttribute("aria-hidden", "true");
  SPARKS.forEach((glyph, index) => {
    const spark = document.createElement("span");
    spark.textContent = glyph;
    const angle = (index / SPARKS.length) * Math.PI * 2;
    spark.style.setProperty("--dx", `${Math.round(Math.cos(angle) * 120)}px`);
    spark.style.setProperty("--dy", `${Math.round(Math.sin(angle) * 80)}px`);
    spark.style.animationDelay = `${700 + index * 40}ms`;
    burst.append(spark);
  });
  bubble.append(burst);
  setTimeout(() => burst.remove(), 2600);
}

function createNode(item) {
  const slot = document.createElement("div");
  slot.className = "slot";
  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = `bubble ${item.special ? "enter-special" : "enter"}`;
  bubble.dataset.style = item.style;
  bubble.dataset.id = item.id;
  bubble.title = "Click to dismiss";
  const text = document.createElement("span");
  text.className = "text";
  text.textContent = item.text;
  bubble.append(text, tail());
  bubble.addEventListener("animationend", (event) => {
    if (event.target === bubble && !bubble.classList.contains("leaving")) bubble.classList.remove("enter", "enter-special");
  });
  bubble.addEventListener("click", () => {
    if (bubble.classList.contains("leaving")) return;
    bubble.classList.remove("enter", "enter-special");
    bubble.classList.add("leaving");
    setTimeout(() => window.ccf.dismissCompanionBubble(item.id), LEAVE_MS);
  });
  if (item.special) sparkle(bubble);
  slot.append(bubble);
  return slot;
}

export function render(items = []) {
  const ids = new Set(items.map((item) => item.id));
  for (const [id, node] of nodes) {
    if (!ids.has(id)) { node.remove(); nodes.delete(id); }
  }
  for (const item of items) {
    if (!nodes.has(item.id)) {
      const node = createNode(item);
      nodes.set(item.id, node);
      stack.append(node);
    }
  }
  // Newest at the bottom, next to the cat; older ones pile up above it.
  const ordered = items.map((item) => nodes.get(item.id));
  ordered.forEach((node, index) => {
    const depth = ordered.length - 1 - index;
    node.dataset.depth = String(Math.min(depth, VISIBLE_BUBBLES));
    node.hidden = depth >= VISIBLE_BUBBLES;
    node.classList.toggle("newest", depth === 0);
  });
  const buried = Math.max(0, items.length - VISIBLE_BUBBLES);
  if (buried && !badge) {
    badge = document.createElement("div");
    badge.className = "more";
  }
  if (badge) {
    if (buried) {
      badge.textContent = `+${buried} more ${buried === 1 ? "meow" : "meows"}`;
      stack.prepend(badge);
    } else { badge.remove(); badge = null; }
  }
}

function reportPointer(target) {
  const inside = Boolean(target?.closest?.(".bubble"));
  if (inside === pointerInside) return;
  pointerInside = inside;
  window.ccf.setCompanionBubblePointer(inside);
}

if (window.ccf) {
  document.addEventListener("mousemove", (event) => reportPointer(event.target));
  document.addEventListener("mouseleave", () => reportPointer(null));
  window.ccf.onCompanionBubbles((items) => render(items ?? []));
  window.ccf.getCompanionBubbles().then((items) => render(items ?? [])).catch(() => {});
}
