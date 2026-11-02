import test from "node:test";
import assert from "node:assert/strict";
import { BUBBLE_SIZE, BUBBLE_TAIL_TIP, placeCompanionBubble } from "../services/companion-bubble-layout.js";

const area = { x: 0, y: 0, width: 1920, height: 1040 };

test("the bubble sits above the cat with its tail tip on the cat's head", () => {
  const cat = { x: 100, y: 700, width: 168, height: 144 };
  const bubble = placeCompanionBubble({ cat, workArea: area });
  assert.deepEqual({ width: bubble.width, height: bubble.height }, BUBBLE_SIZE);
  const tip = { x: bubble.x + BUBBLE_TAIL_TIP.x, y: bubble.y + BUBBLE_TAIL_TIP.y };
  assert.ok(tip.x > cat.x + cat.width / 2 && tip.x < cat.x + cat.width, "tip over the cat's right half");
  assert.ok(tip.y >= cat.y && tip.y < cat.y + cat.height / 3, "tip at the top of the cat");
  assert.ok(bubble.y + bubble.height <= cat.y + cat.height / 3, "the bubble body stays above the cat");
});

test("the bubble stays on the work area when the cat sits at its edge", () => {
  const top = placeCompanionBubble({ cat: { x: 1800, y: 10, width: 168, height: 144 }, workArea: area });
  assert.equal(top.y, 8);
  assert.equal(top.x, area.width - 8 - BUBBLE_SIZE.width);
  const offset = placeCompanionBubble({ cat: { x: -3000, y: 500, width: 168, height: 144 },
    workArea: { x: -3840, y: 0, width: 1920, height: 1040 } });
  assert.equal(offset.x, -3000 + Math.round(168 * 0.62) - BUBBLE_TAIL_TIP.x);
});
