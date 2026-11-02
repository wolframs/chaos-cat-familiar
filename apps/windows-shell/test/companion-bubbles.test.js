import test from "node:test";
import assert from "node:assert/strict";
import { BUBBLE_STYLES, CompanionBubbles, MAX_KEPT_BUBBLES } from "../services/companion-bubbles.js";

test("bubbles stack in arrival order until each one is dismissed", () => {
  const bubbles = new CompanionBubbles({ random: () => 0.5 });
  const first = bubbles.add({ text: "one" });
  const second = bubbles.add({ text: "two" });
  assert.deepEqual(bubbles.list().map((item) => item.text), ["one", "two"]);
  assert.equal(bubbles.dismiss(first.id), true);
  assert.equal(bubbles.dismiss(first.id), false);
  assert.deepEqual(bubbles.list().map((item) => item.id), [second.id]);
});

test("each bubble rolls a style and a rare special entrance", () => {
  const rolls = [0, 0.99, 0.999, 0.1];
  const bubbles = new CompanionBubbles({ random: () => rolls.shift() });
  const first = bubbles.add({ text: "a" });
  const second = bubbles.add({ text: "b" });
  assert.equal(first.style, BUBBLE_STYLES[0]);
  assert.equal(first.special, false);
  assert.equal(second.style, BUBBLE_STYLES.at(-1));
  assert.equal(second.special, true);
});

test("explicit style and special win over the roll; unknown styles roll", () => {
  const bubbles = new CompanionBubbles({ random: () => 0 });
  assert.deepEqual((({ style, special }) => ({ style, special }))(bubbles.add({ text: "x", style: "comic", special: true })),
    { style: "comic", special: true });
  assert.equal(bubbles.add({ text: "y", style: "nope" }).style, BUBBLE_STYLES[0]);
});

test("a forgotten pile keeps only the newest bubbles", () => {
  const bubbles = new CompanionBubbles({ random: () => 0.5 });
  for (let index = 0; index < MAX_KEPT_BUBBLES + 5; index += 1) bubbles.add({ text: `n${index}` });
  assert.equal(bubbles.size, MAX_KEPT_BUBBLES);
  assert.equal(bubbles.list()[0].text, "n5");
});
