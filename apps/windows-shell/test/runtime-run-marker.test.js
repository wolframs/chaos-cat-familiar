import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeRunMarker } from "../services/runtime-run-marker.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-run-marker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "running.json");
}

test("run marker records startup once, reports prior unclean exit, and removes only on clean stop", (t) => {
  const filePath = fixture(t);
  const first = new RuntimeRunMarker({ filePath, pid: 123 });
  assert.equal(first.start().previousUncleanExit, false);
  const marker = fs.readFileSync(filePath, "utf8");
  first.start();
  assert.equal(fs.readFileSync(filePath, "utf8"), marker);
  const second = new RuntimeRunMarker({ filePath, pid: 456 });
  const status = second.start();
  assert.equal(status.previousUncleanExit, true);
  assert.equal(status.previousRun.pid, 123);
  assert.equal(status.active, true);
  assert.equal(first.markClean(), false, "an older runtime cannot remove another runtime's marker");
  assert.equal(second.markClean(), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(second.markClean(), true);
  assert.equal(new RuntimeRunMarker({ filePath }).start().previousUncleanExit, false);
});

test("malformed or oversized previous marker still permits startup without reading oversized content", (t) => {
  const filePath = fixture(t);
  for (const previous of ["{broken", "x".repeat(5000)]) {
    fs.writeFileSync(filePath, previous);
    const marker = new RuntimeRunMarker({ filePath });
    assert.equal(marker.start().previousUncleanExit, true);
    assert.equal(marker.status().active, true);
    assert.equal(marker.markClean(), true);
  }
});

test("unreadable previous marker is reported and left intact without blocking startup caller", (t) => {
  const filePath = fixture(t);
  fs.writeFileSync(filePath, "keep");
  const marker = new RuntimeRunMarker({ filePath, fsImpl: { ...fs,
    readFileSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); }
  } });
  assert.doesNotThrow(() => marker.start());
  assert.match(marker.status().lastError, /denied/);
  assert.equal(marker.status().active, false);
  assert.equal(marker.markClean(), false);
  assert.equal(fs.readFileSync(filePath, "utf8"), "keep");
});
