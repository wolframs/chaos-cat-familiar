import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeLogger } from "../services/runtime-logger.js";

test("runtime logger writes to memory and file", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "ccf.log");
  const stdoutLines = [];
  const stderrLines = [];
  const logger = new RuntimeLogger({
    filePath,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line)
  });

  logger.info("startup", "Logger online", { port: 49152 });
  logger.error("renderer", "Renderer crashed", { window: "overlay" });

  const logFile = fs.readFileSync(filePath, "utf8");
  assert.equal(logger.entries.length, 2);
  assert.equal(stdoutLines.length, 1);
  assert.equal(stderrLines.length, 1);
  assert.match(logFile, /\[info\] \[startup\] Logger online/);
  assert.match(logFile, /\[error\] \[renderer\] Renderer crashed/);
});

test("debug logging is opt-in across all sinks and can be switched off again", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "ccf.log");
  const lines = [];
  const logger = new RuntimeLogger({ filePath, stdout: (line) => lines.push(line) });
  logger.debug("test", "hidden");
  assert.equal(logger.entries.length, 0);
  assert.equal(lines.length, 0);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(logger.status().debugLogging, false);
  logger.configure({ debugLogging: true });
  logger.debug("test", "visible");
  logger.configure({ debugLogging: false });
  logger.log("debug", "test", "hidden again");
  assert.equal(logger.entries.length, 1);
  assert.equal(lines.length, 1);
  assert.match(fs.readFileSync(filePath, "utf8"), /visible/);
  assert.equal(logger.status().filePath, filePath);
});

test("redacts nested sensitive context and bounds retained data without keeping source references", () => {
  const lines = [];
  const logger = new RuntimeLogger({ stdout: (line) => lines.push(line) });
  const context = { token: "secret-token", nested: { authorization: "secret-auth", password: "secret-pass", tool_input: "secret-input", tool_response: "secret-output", prompt: "secret-prompt", answers: "secret-answer" }, large: "x".repeat(100000), array: Array(10000).fill("item") };
  context.circular = context;
  logger.info("test", "m".repeat(100000), context);
  context.nested.authorization = "changed";
  const retained = JSON.stringify(logger.entries[0]);
  assert.doesNotMatch(retained, /secret-|changed/);
  assert.doesNotMatch(lines[0], /secret-/);
  assert.match(retained, /REDACTED/);
  assert.ok(retained.length < 20000);
  assert.ok(lines[0].length < 20000);
});

test("rotates bounded files keeping only one previous file", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "ccf.log");
  const logger = new RuntimeLogger({ filePath, maxFileBytes: 1024, stdout: () => {} });
  for (let i = 0; i < 30; i += 1) logger.info("test", `${i} ${"ä".repeat(10000)}`);
  assert.ok(fs.statSync(filePath).size <= 1024);
  assert.ok(fs.statSync(`${filePath}.1`).size <= 1024);
  assert.deepEqual(fs.readdirSync(tempDir).sort(), ["ccf.log", "ccf.log.1"]);
});

test("sink failures never escape and file errors are visible in status", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const blocker = path.join(tempDir, "blocker");
  fs.writeFileSync(blocker, "file");
  const logger = new RuntimeLogger({ filePath: path.join(blocker, "ccf.log"), stdout: () => { throw new Error("console failed"); }, stderr: () => { throw new Error("console failed"); } });
  assert.doesNotThrow(() => logger.info("test", "still retained"));
  assert.doesNotThrow(() => logger.error("test", "also retained"));
  assert.equal(logger.entries.length, 2);
  assert.equal(typeof logger.status().lastWriteError, "string");
  fs.unlinkSync(blocker);
  logger.info("test", "recovered");
  assert.equal(logger.status().lastWriteError, null);
});

test("oversized legacy logs are discarded and memory keeps its configured entry limit", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "ccf.log");
  fs.writeFileSync(filePath, "x".repeat(2048));
  fs.writeFileSync(`${filePath}.1`, "y".repeat(2048));
  const logger = new RuntimeLogger({ limit: 2, filePath, maxFileBytes: 1024, stdout: () => {} });
  logger.info("test", "fresh");
  assert.ok(fs.statSync(filePath).size <= 1024);
  assert.equal(fs.existsSync(`${filePath}.1`), false);
  logger.info("test", "second");
  logger.info("test", "third");
  assert.equal(logger.entries.length, 2);
  assert.equal(logger.entries[0].message, "third");
  assert.equal(logger.entries[1].message, "second");
});

test("ordinary appends reuse directory and byte-count state", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const mkdir = t.mock.method(fs, "mkdirSync");
  const stat = t.mock.method(fs, "statSync");
  const logger = new RuntimeLogger({ filePath: path.join(tempDir, "ccf.log"), stdout: () => {} });
  for (let i = 0; i < 20; i += 1) logger.info("test", "small entry");
  assert.equal(mkdir.mock.callCount(), 1);
  assert.ok(stat.mock.callCount() <= 2);
});

test("recreates logs after directory cleanup and after file removal before rotation", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const logDir = path.join(tempDir, "logs");
  const filePath = path.join(logDir, "ccf.log");
  const logger = new RuntimeLogger({ filePath, maxFileBytes: 256, stdout: () => {} });
  logger.info("test", "first");
  fs.rmSync(logDir, { recursive: true });
  logger.info("test", "after directory cleanup");
  assert.match(fs.readFileSync(filePath, "utf8"), /after directory cleanup/);
  assert.equal(logger.status().lastWriteError, null);
  fs.unlinkSync(filePath);
  logger.info("test", "x".repeat(512));
  assert.ok(fs.statSync(filePath).size <= 256);
  assert.equal(logger.status().lastWriteError, null);
});

test("initialization removes an oversized previous log even when the current log is small", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-runtime-logger-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "ccf.log");
  fs.writeFileSync(filePath, "small");
  fs.writeFileSync(`${filePath}.1`, "x".repeat(2048));
  const logger = new RuntimeLogger({ filePath, maxFileBytes: 1024, stdout: () => {} });
  logger.info("test", "first");
  assert.equal(fs.existsSync(`${filePath}.1`), false);
  assert.ok(fs.statSync(filePath).size <= 1024);
});
