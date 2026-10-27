import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeLogger } from "../services/runtime-logger.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-log-batch-"));
  const callbacks = new Map();
  let id = 0;
  const filePath = path.join(root, "ccf.log");
  const logger = new RuntimeLogger({ filePath, stdout() {}, stderr() {}, flushDelayMs: 250,
    timers: { setTimeout(fn) { callbacks.set(++id, fn); return id; }, clearTimeout(key) { callbacks.delete(key); } }, ...options });
  t.after(() => { logger.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, filePath, logger, callbacks };
}

test("log burst writes once at its deadline; memory/redaction/debug semantics remain immediate", (t) => {
  const { filePath, logger, callbacks } = fixture(t);
  const append = t.mock.method(fs, "appendFileSync");
  logger.debug("test", "hidden");
  assert.equal(callbacks.size, 0);
  for (let i = 0; i < 100; i++) logger.info("test", `line ${i}`, { password: "private" });
  assert.equal(logger.entries.length, 100);
  assert.equal(append.mock.callCount(), 0);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assert.equal(append.mock.callCount(), 1);
  assert.equal(logger.status().bufferedBytes, 0);
  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /line 0/);
  assert.match(content, /line 99/);
  assert.doesNotMatch(content, /private|hidden/);
  assert.match(content, /REDACTED/);
});

test("warning/error and close flush earlier info lines, canceling timers", (t) => {
  const { filePath, logger, callbacks } = fixture(t);
  logger.info("test", "before warning");
  logger.warn("test", "warning");
  assert.equal(callbacks.size, 0);
  assert.match(fs.readFileSync(filePath, "utf8"), /before warning[\s\S]*warning/);
  logger.info("test", "before error");
  logger.error("test", "error");
  assert.equal(callbacks.size, 0);
  logger.info("test", "final info");
  assert.equal(logger.close(), true);
  assert.equal(callbacks.size, 0);
  assert.match(fs.readFileSync(filePath, "utf8"), /final info/);
  logger.info("test", "late info");
  assert.equal(logger.status().bufferedBytes, 0);
  assert.equal(callbacks.size, 0);
});

test("batch rotation respects both file bounds and chronological order", (t) => {
  const { root, filePath, logger } = fixture(t, { maxFileBytes: 512, maxBufferedBytes: 65536 });
  for (let i = 0; i < 40; i++) logger.info("test", `message-${i} ${"ä".repeat(30)}`);
  assert.equal(logger.flush(), true);
  assert.ok(fs.statSync(filePath).size <= 512);
  assert.ok(fs.statSync(`${filePath}.1`).size <= 512);
  assert.deepEqual(fs.readdirSync(root).sort(), ["ccf.log", "ccf.log.1"]);
  const content = fs.readFileSync(`${filePath}.1`, "utf8") + fs.readFileSync(filePath, "utf8");
  const indices = [...content.matchAll(/message-(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(indices, indices.slice().sort((a, b) => a - b));
  assert.equal(indices.at(-1), 39);
});

test("disk failures never escape, buffers stay bounded, and explicit retry recovers", (t) => {
  const { filePath, logger, callbacks } = fixture(t, { maxBufferedBytes: 512 });
  let failed = true;
  let attempts = 0;
  const append = fs.appendFileSync;
  t.mock.method(fs, "appendFileSync", (...args) => {
    attempts++;
    if (failed) throw new Error("locked");
    return append(...args);
  });
  assert.doesNotThrow(() => {
    for (let i = 0; i < 500; i++) logger.info("test", `line-${i} ${"x".repeat(100)}`);
  });
  assert.equal(logger.close(), false);
  assert.equal(attempts, 2, "overflow retries once, then close retries; new lines cannot hammer a failed disk");
  assert.equal(callbacks.size, 0);
  assert.ok(logger.status().bufferedBytes <= 512);
  assert.ok(logger.status().droppedLines > 0);
  assert.match(logger.status().lastWriteError, /locked/);
  failed = false;
  assert.equal(logger.flush(), true);
  assert.equal(logger.status().lastWriteError, null);
  assert.match(fs.readFileSync(filePath, "utf8"), /line-499/);
});
