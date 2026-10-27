import test from "node:test";
import assert from "node:assert/strict";
import { createMascotDrag } from "../renderer/mascot-drag.js";

function fixture({ deferred = false } = {}) {
  const sent = [];
  const states = [];
  const frames = new Map();
  const bounds = { x: 100, y: 200, width: 168, height: 144 };
  let resolveBounds;
  let reads = 0;
  const pendingBounds = deferred ? new Promise((resolve) => { resolveBounds = resolve; }) : Promise.resolve(bounds);
  const drag = createMascotDrag({
    element: { setPointerCapture() {}, releasePointerCapture() {} },
    enabled: () => true,
    getBounds() { reads++; return pendingBounds; },
    setBounds: (value) => sent.push(value), setDragging: (value) => states.push(value),
    requestFrame(callback) { const id = {}; frames.set(id, callback); return id; },
    cancelFrame(id) { frames.delete(id); }
  });
  return { drag, sent, states, frames, reads: () => reads, resolve: () => resolveBounds(bounds),
    frame() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); } };
}
const pointer = (x, y, extra = {}) => ({ pointerId: 1, button: 0, screenX: x, screenY: y, ...extra });

test("drag coalesces pointer moves, marks held frames, and commits the actual release point once", async () => {
  const f = fixture();
  await f.drag.begin(pointer(10, 20));
  for (let i = 1; i <= 100; i++) f.drag.move(pointer(10 + i, 20 + i));
  assert.equal(f.frames.size, 1);
  assert.equal(f.reads(), 1);
  f.frame();
  assert.deepEqual(f.sent, [{ x: 200, y: 300, width: 168, height: 144, dragging: true }]);
  f.drag.move(pointer(111, 122));
  f.drag.end(pointer(115, 125, { type: "pointerup" }));
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.sent.at(-1), { x: 205, y: 305, width: 168, height: 144, dragging: false });
  f.drag.end(pointer(115, 125, { type: "lostpointercapture" }));
  assert.equal(f.sent.length, 2, "capture release cannot commit a second time");
  assert.deepEqual(f.states, [true, false]);
});

test("release while bounds IPC is pending cannot start a late phantom drag", async () => {
  const f = fixture({ deferred: true });
  const beginning = f.drag.begin(pointer(10, 20));
  f.drag.end(pointer(10, 20, { type: "pointerup" }));
  f.resolve();
  await beginning;
  f.drag.move(pointer(100, 200));
  assert.equal(f.sent.length, 0);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.states, []);
});

test("pending movement survives IPC delay; another pointer cannot cancel the drag", async () => {
  const f = fixture({ deferred: true });
  const beginning = f.drag.begin(pointer(10, 20));
  f.drag.move(pointer(30, 45));
  f.drag.end(pointer(0, 0, { pointerId: 2 }));
  f.resolve();
  await beginning;
  f.frame();
  assert.equal(f.sent[0].x, 120);
  assert.equal(f.sent[0].y, 225);
  f.drag.end(pointer(0, 0, { type: "pointercancel" }));
  assert.equal(f.sent.at(-1).dragging, false);
  assert.equal(f.sent.at(-1).x, 120, "cancellation retains last valid coordinates");
});
