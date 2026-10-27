import test from "node:test";
import assert from "node:assert/strict";
import { OverlayPlacementPersistence } from "../services/overlay-placement-persistence.js";

function fixture({ code = "EPERM" } = {}) {
  const scheduled = new Map();
  const warnings = [];
  const writes = [];
  let locked = true;
  const store = new OverlayPlacementPersistence({
    save(patch) {
      writes.push(patch);
      if (locked) throw Object.assign(new Error(`locked temporary file ${writes.length}`), { code, syscall: "rename" });
    },
    logger: { warn: (...args) => warnings.push(args), info() {} },
    timers: {
      setTimeout(callback, delay) { const handle = {}; scheduled.set(handle, { callback, delay }); return handle; },
      clearTimeout(handle) { scheduled.delete(handle); }
    }
  });
  function tick() {
    const entry = scheduled.entries().next().value;
    assert.ok(entry, "a retry is scheduled");
    scheduled.delete(entry[0]);
    entry[1].callback();
    return entry[1].delay;
  }
  return { store, warnings, writes, scheduled, tick, unlock() { locked = false; } };
}

const patch = (x) => ({ overlayBounds: { x, y: 20, width: 168, height: 144 }, overlayDisplayId: 1 });

test("locked placement retains only latest coordinates and retries without throwing or flooding diagnostics", () => {
  const f = fixture();
  assert.equal(f.store.save(patch(1)), false);
  for (let i = 2; i <= 100; i++) f.store.save(patch(i));
  assert.equal(f.writes.length, 1, "moves during a pending retry cause no file operations");
  assert.equal(f.tick(), 250);
  assert.equal(f.writes.at(-1).overlayBounds.x, 100);
  assert.equal(f.warnings.length, 1, "changing temporary paths do not repeat warnings");
  f.unlock();
  assert.equal(f.tick(), 1000);
  assert.equal(f.store.status().pending, false);
  assert.equal(f.store.status().lastWriteError, null);
  assert.equal(f.scheduled.size, 0);
});

test("retries stop after three delays; close makes one final attempt and cancels timers", () => {
  const f = fixture();
  f.store.save(patch(1));
  assert.deepEqual([f.tick(), f.tick(), f.tick()], [250, 1000, 3000]);
  assert.equal(f.writes.length, 4);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.store.status().pending, true);
  assert.equal(f.store.close(), false);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.store.save(patch(9)), false, "closed stores cannot enqueue new work");
});

test("nontransient failure never starts an idle retry loop", () => {
  const f = fixture({ code: "ENOSPC" });
  assert.equal(f.store.save(patch(1)), false);
  assert.equal(f.scheduled.size, 0);
  f.unlock();
  assert.equal(f.store.save(patch(2)), true, "later activity can recover");
  assert.equal(f.store.close(), true);
});

test("a drag holds only its latest position, performs no writes or retries, and saves on release", () => {
  const f = fixture();
  f.unlock();
  f.store.beginDrag();
  for (let i = 1; i <= 100; i++) f.store.save(patch(i));
  assert.equal(f.writes.length, 0);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.store.endDrag(), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].overlayBounds.x, 100);
});

test("starting a drag suspends an existing lock retry; shutdown still flushes a held position", () => {
  const f = fixture();
  f.store.save(patch(1));
  f.store.beginDrag();
  assert.equal(f.scheduled.size, 0);
  f.store.save(patch(2));
  f.unlock();
  assert.equal(f.store.close(), true);
  assert.equal(f.writes.at(-1).overlayBounds.x, 2);
});
