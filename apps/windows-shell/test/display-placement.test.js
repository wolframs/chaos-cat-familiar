import test from "node:test";
import assert from "node:assert/strict";
import {
  clampBoundsToWorkArea,
  deriveOverlayPlacement,
  selectDisplay
} from "../services/display-placement.js";

const displays = [
  {
    id: 1,
    primary: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  },
  {
    id: 2,
    primary: false,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 }
  }
];

test("clampBoundsToWorkArea keeps overlay inside the chosen display work area", () => {
  const clamped = clampBoundsToWorkArea(
    { x: 4400, y: -50, width: 420, height: 320 },
    displays[1].workArea,
    24
  );

  assert.equal(clamped.x <= 4036, true);
  assert.equal(clamped.y >= 24, true);
  assert.equal(clamped.width, 420);
  assert.equal(clamped.height, 320);
});

test("selectDisplay prefers remembered display when available", () => {
  const display = selectDisplay({
    displays,
    mode: "remember",
    lastDisplayId: 2,
    savedBounds: null,
    cursorPoint: { x: 100, y: 100 },
    primaryDisplayId: 1
  });

  assert.equal(display.id, 2);
});

test("selectDisplay falls back to cursor display when configured", () => {
  const display = selectDisplay({
    displays,
    mode: "cursor",
    lastDisplayId: null,
    savedBounds: null,
    cursorPoint: { x: 2400, y: 400 },
    primaryDisplayId: 1
  });

  assert.equal(display.id, 2);
});

test("deriveOverlayPlacement restores saved bounds on the remembered monitor", () => {
  const placement = deriveOverlayPlacement({
    displays,
    mode: "remember",
    lastDisplayId: 2,
    savedBounds: { x: 2100, y: 100, width: 420, height: 320 },
    cursorPoint: { x: 200, y: 200 },
    primaryDisplayId: 1,
    width: 420,
    height: 320
  });

  assert.equal(placement.display.id, 2);
  assert.equal(placement.bounds.x, 2100);
  assert.equal(placement.bounds.y, 100);
});

test("deriveOverlayPlacement falls back cleanly when the remembered monitor is missing", () => {
  const placement = deriveOverlayPlacement({
    displays: [displays[0]],
    mode: "remember",
    lastDisplayId: 2,
    savedBounds: { x: 2600, y: 200, width: 420, height: 320 },
    cursorPoint: { x: 2400, y: 400 },
    primaryDisplayId: 1,
    width: 420,
    height: 320
  });

  assert.equal(placement.display.id, 1);
  assert.equal(placement.bounds.x >= 24, true);
  assert.equal(placement.bounds.x <= 1476, true);
});

