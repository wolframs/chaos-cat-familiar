import test from "node:test";
import assert from "node:assert/strict";
import { PANEL, placeCompanionCluster } from "../services/companion-cluster-layout.js";

test("the cat sits at the left of a shared footer row with status alongside", () => {
  const layout = placeCompanionCluster({
    cat: { x: 900, y: 600, width: 168, height: 184 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  });
  assert.equal(layout.conversation.x, layout.cat.x);
  assert.equal(layout.status.x, layout.cat.x + layout.cat.width + 24);
  assert.equal(layout.status.y + layout.status.height / 2, layout.cat.y + layout.cat.height / 2);
  assert.ok(layout.conversation.y + layout.conversation.height < layout.cat.y);
  assert.ok(layout.status.x + layout.status.width <= layout.conversation.x + layout.conversation.width);
  assert.equal(layout.cat.y + layout.cat.height - layout.conversation.y, 652);
  assert.equal(layout.conversation.width, 700);
});

test("the whole anchored cluster stays inside a smaller display while the cat moves", () => {
  const area = { x: 1920, y: 0, width: 900, height: 768 };
  const layout = placeCompanionCluster({
    cat: { x: 1940, y: 50, width: 168, height: 184 },
    workArea: area
  });
  for (const bounds of Object.values(layout)) {
    assert.ok(bounds.x >= area.x + 8);
    assert.ok(bounds.y >= area.y + 8);
    assert.ok(bounds.x + bounds.width <= area.x + area.width - 8);
    assert.ok(bounds.y + bounds.height <= area.y + area.height - 8);
  }
  assert.equal(layout.conversation.height, 500, "the shared footer leaves room for the full conversation");
});

test("a narrow display stacks the footer without pushing any window off screen", () => {
  const area = { x: -400, y: 100, width: 400, height: 600 };
  const layout = placeCompanionCluster({ cat: { x: -10, y: 30, width: 168, height: 184 }, workArea: area });
  assert.ok(layout.status.y >= layout.cat.y + layout.cat.height);
  for (const bounds of Object.values(layout)) {
    assert.ok(bounds.x >= area.x + 8 && bounds.y >= area.y + 8);
    assert.ok(bounds.x + bounds.width <= area.x + area.width - 8);
    assert.ok(bounds.y + bounds.height <= area.y + area.height - 8);
  }
});

test("a larger saved cat window still keeps the footer within the conversation width", () => {
  const layout = placeCompanionCluster({ cat: { x: 2900, y: 750, width: 230, height: 269 },
    workArea: { x: 2328, y: 259, width: 1746, height: 939 } });
  assert.equal(layout.cat.x, layout.conversation.x);
  assert.ok(layout.status.x + layout.status.width <= layout.conversation.x + layout.conversation.width);
  assert.equal(layout.cat.width, 168);
  assert.equal(layout.cat.height, 144);
  assert.equal(layout.status.width, 508);
});

test("the side panel sits left of the conversation with the same top and height", () => {
  const layout = placeCompanionCluster({ cat: { x: 900, y: 600, width: 168, height: 144 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }, panel: PANEL });
  assert.equal(PANEL.width, 320);
  assert.deepEqual(layout.panel, { x: layout.conversation.x - 320, y: layout.conversation.y, width: 320,
    height: layout.conversation.height });
  assert.equal(layout.panel.x + layout.panel.width, layout.conversation.x);
  const without = placeCompanionCluster({ cat: { x: 900, y: 600, width: 168, height: 144 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  assert.equal(Object.hasOwn(without, "panel"), false, "no panel asked, no panel key");
  assert.deepEqual({ ...layout, panel: undefined }, { ...without, panel: undefined });
});

test("at the screen's left edge the cat is clamped right by the panel's width", () => {
  const area = { x: 1920, y: 0, width: 1920, height: 1040 };
  const layout = placeCompanionCluster({ cat: { x: 1900, y: 600, width: 168, height: 144 }, workArea: area, panel: PANEL });
  const without = placeCompanionCluster({ cat: { x: 1900, y: 600, width: 168, height: 144 }, workArea: area });
  assert.equal(without.cat.x, area.x + 8);
  assert.equal(layout.cat.x, area.x + 8 + 320);
  assert.equal(layout.panel.x, area.x + 8);
});

test("a work area narrower than conversation + panel + 16 has no panel", () => {
  const area = { x: 0, y: 0, width: 1035, height: 900 };
  const layout = placeCompanionCluster({ cat: { x: 0, y: 600, width: 168, height: 144 }, workArea: area, panel: PANEL });
  assert.equal(layout.panel, null);
  assert.equal(layout.cat.x, 8, "laid out as without the panel");
  assert.ok(placeCompanionCluster({ cat: { x: 0, y: 600, width: 168, height: 144 },
    workArea: { ...area, width: 1036 }, panel: PANEL }).panel);
});
