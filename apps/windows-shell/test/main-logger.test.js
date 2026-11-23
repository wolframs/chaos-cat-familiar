// Main's log (process-split plan, steps 3 and 7): lines go to the core's log; what never reached it is written at the
// very end of a quit, without blocking main's event loop.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLogger } from "../services/main-logger.js";

function tempLog(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-main-logger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "logs", "ccf.log");
}

test("lines reach the core while it is attached and wait in a bounded queue while it is not", () => {
  const delivered = [];
  const logger = new MainLogger({ filePath: null, maxQueued: 2, stderr: () => {} });
  logger.info("a", "before the core");
  logger.attach((entries) => { delivered.push(...entries.map((entry) => entry.message)); });
  logger.info("a", "while attached");
  logger.detach();
  for (const message of ["one", "two", "three"]) logger.info("a", message);
  assert.deepEqual(delivered, ["before the core", "while attached"]);
  assert.deepEqual(logger.status().queued, 2);
  assert.equal(logger.status().droppedLines, 1);
});

test("leftover lines are appended asynchronously once, and an exit writes them to the console only", async (t) => {
  const file = tempLog(t);
  const console = [];
  const logger = new MainLogger({ filePath: file, stderr: (text) => console.push(text) });
  logger.info("shutdown", "after the core closed its log", { step: 1 });
  const pending = logger.writeQueuedToFile();
  assert.equal(typeof pending?.then, "function", "the write does not block");
  assert.equal(await pending, true);
  assert.match(fs.readFileSync(file, "utf8"), /\[info\] \[shutdown\] after the core closed its log/);
  assert.equal(await logger.writeQueuedToFile(), true, "nothing left to write");
  assert.equal(console.length, 1);

  logger.info("shutdown", "logged during exit");
  logger.writeQueuedToConsole();
  assert.match(console.at(-1), /logged during exit/);
  assert.equal(fs.readFileSync(file, "utf8").includes("logged during exit"), false, "an exit handler writes no file");
  assert.equal(logger.status().queued, 0);
});

test("a log folder that cannot be written reports the loss", async (t) => {
  const file = tempLog(t);
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.dirname(file), "a file where the folder should be");
  const logger = new MainLogger({ filePath: file, stderr: () => {} });
  logger.warn("shutdown", "nowhere to go");
  assert.equal(await logger.writeQueuedToFile(), false);
});
