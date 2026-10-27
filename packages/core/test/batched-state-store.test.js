import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileJsonStateStore } from "../src/json-state-store.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-state-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const callbacks = new Map();
  let id = 0;
  return { filePath: path.join(root, "state.json"), callbacks, timers: {
    setTimeout(fn) { callbacks.set(++id, fn); return id; },
    clearTimeout(key) { callbacks.delete(key); }
  } };
}

test("batched state saves keep just the latest value and serialize only at flush", (t) => {
  const { filePath, callbacks, timers } = fixture(t);
  let serializations = 0;
  const store = new FileJsonStateStore(filePath, {}, { flushDelayMs: 250, timers });
  for (let i = 0; i < 100; i++) store.save({ count: i, toJSON() { serializations++; return { count: i }; } });
  assert.equal(serializations, 0);
  assert.equal(callbacks.size, 1);
  assert.equal(fs.existsSync(filePath), false);
  [...callbacks.values()][0]();
  assert.equal(serializations, 1);
  assert.deepEqual(store.load(), { count: 99 });
  assert.equal(store.status().pending, false);
  assert.equal(store.flush(), true);
});

test("failed scheduled state flush retains latest value, reports error, and never spins retries", (t) => {
  const { filePath, callbacks, timers } = fixture(t);
  fs.writeFileSync(filePath, '{"previous":true}');
  let fail = true;
  let attempts = 0;
  const errors = [];
  const store = new FileJsonStateStore(filePath, {}, { flushDelayMs: 250, timers,
    onError(error) { errors.push(error.message); throw new Error("reporting failed"); },
    fsImpl: { ...fs, renameSync(...args) { attempts++; if (fail) throw new Error("locked"); return fs.renameSync(...args); } }
  });
  store.save({ count: 1 });
  const callback = [...callbacks.values()][0];
  callbacks.clear();
  assert.doesNotThrow(callback);
  assert.equal(callbacks.size, 0);
  assert.equal(attempts, 1);
  assert.equal(store.status().pending, true);
  assert.match(store.status().lastWriteError, /locked/);
  assert.deepEqual(store.load(), { previous: true });
  store.save({ count: 1.5 });
  assert.equal(store.flush(), false);
  assert.deepEqual(errors, ["locked"], "unchanged write errors are reported once until recovery");
  store.save({ count: 2 });
  fail = false;
  assert.equal(store.close(), true);
  assert.equal(callbacks.size, 0);
  assert.deepEqual(store.load(), { count: 2 });
  assert.deepEqual(errors, ["locked"]);
  assert.equal(store.status().lastWriteError, null);
  assert.throws(() => store.save({ count: 3 }), /closed/);
});

test("failed close preserves pending state for an explicit retry", (t) => {
  const { filePath, timers } = fixture(t);
  let fail = true;
  const store = new FileJsonStateStore(filePath, {}, { flushDelayMs: 250, timers,
    fsImpl: { ...fs, renameSync(...args) { if (fail) throw new Error("locked"); return fs.renameSync(...args); } }
  });
  store.save({ final: true });
  assert.equal(store.close(), false);
  assert.equal(store.status().pending, true);
  fail = false;
  assert.equal(store.flush(), true);
  assert.deepEqual(store.load(), { final: true });
});

test("native failures with randomized temporary paths report once per code/syscall until recovery", (t) => {
  const { filePath, timers } = fixture(t);
  const errors = [];
  let failureCode = "EPERM";
  let attempts = 0;
  const store = new FileJsonStateStore(filePath, {}, { flushDelayMs: 250, timers,
    onError(error) { errors.push(error.code); },
    fsImpl: { ...fs, renameSync(...args) {
      attempts++;
      if (failureCode) throw Object.assign(new Error(`${failureCode}: rename random-temp-${attempts}.tmp`), {
        code: failureCode, syscall: "rename"
      });
      return fs.renameSync(...args);
    } }
  });
  store.save({ count: 1 });
  assert.equal(store.flush(), false);
  assert.equal(store.flush(), false);
  assert.deepEqual(errors, ["EPERM"]);
  assert.match(store.status().lastWriteError, /random-temp-2/, "status keeps the latest diagnostic detail");
  failureCode = "ENOSPC";
  assert.equal(store.flush(), false);
  assert.deepEqual(errors, ["EPERM", "ENOSPC"], "a materially different error is reported");
  failureCode = null;
  assert.equal(store.flush(), true);
  failureCode = "EPERM";
  store.save({ count: 2 });
  assert.equal(store.flush(), false);
  assert.deepEqual(errors, ["EPERM", "ENOSPC", "EPERM"], "successful recovery resets deduplication");
  failureCode = null;
  assert.equal(store.close(), true);
});
