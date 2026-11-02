// The cat's speech bubbles: one fixed-size transparent window holding the stack,
// bottom-anchored, the newest bubble's tail tip in its bottom-left corner
// (renderer/companion-bubble.css draws to these numbers). Empty space is click-through.
export const BUBBLE_SIZE = { width: 320, height: 470 };
export const BUBBLE_TAIL_TIP = { x: 14, y: BUBBLE_SIZE.height - 6 };
const EDGE = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The tail points at the cat's head: upper right of the mascot window.
export function placeCompanionBubble({ cat, workArea, size = BUBBLE_SIZE, tip = BUBBLE_TAIL_TIP }) {
  const target = { x: cat.x + cat.width * 0.62, y: cat.y + 14 };
  return {
    x: Math.round(clamp(target.x - tip.x, workArea.x + EDGE, workArea.x + workArea.width - EDGE - size.width)),
    y: Math.round(clamp(target.y - tip.y, workArea.y + EDGE, workArea.y + workArea.height - EDGE - size.height)),
    width: size.width,
    height: size.height
  };
}
