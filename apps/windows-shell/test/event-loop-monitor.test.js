import test from "node:test";
import assert from "node:assert/strict";
import { EventLoopMonitor } from "../services/event-loop-monitor.js";

// A histogram double with the perf_hooks surface the monitor reads (values in nanoseconds).
function fakeHistogram() {
  const values = [];
  return {
    enabled: false,
    values,
    enable() { this.enabled = true; },
    disable() { this.enabled = false; },
    reset() { values.length = 0; },
    record(ms) { values.push(ms * 1e6); },
    get count() { return values.length; },
    get min() { return values.length ? Math.min(...values) : 9223372036854776000; },
    get max() { return values.length ? Math.max(...values) : 0; },
    get mean() { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN; },
    percentile(p) {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
    }
  };
}

function fixture() {
  const histogram = fakeHistogram();
  const logs = [];
  let tick = null;
  let cleared = 0;
  let unrefs = 0;
  let now = 0;
  const monitor = new EventLoopMonitor({
    logger: { info: (...args) => logs.push(args) },
    createHistogram: () => histogram,
    intervalMs: 60000,
    now: () => now,
    setInterval: (fn, ms) => { assert.equal(ms, 60000); tick = fn; return { unref: () => unrefs++ }; },
    clearInterval: () => { cleared++; tick = null; }
  });
  return { monitor, histogram, logs, advance: (ms) => { now += ms; tick?.(); }, counters: () => ({ cleared, unrefs }) };
}

test("the event-loop monitor logs one delay summary per minute and starts each minute afresh", () => {
  const f = fixture();
  f.monitor.start();
  f.monitor.start();
  assert.equal(f.histogram.enabled, true);
  assert.equal(f.counters().unrefs, 1, "one unref'd timer however often start is called");
  for (const ms of [11, 12, 15, 16, 250]) f.histogram.record(ms);
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  const [category, message, sample] = f.logs[0];
  assert.equal(category, "performance");
  assert.match(message, /event-loop delay/i);
  assert.equal(sample.count, 5);
  assert.equal(sample.maxMs, 250);
  assert.equal(sample.p50Ms, 15);
  assert.equal(sample.p99Ms, 250);
  assert.equal(sample.minMs, 11);
  assert.equal(sample.windowMs, 60000);
  assert.equal(f.histogram.count, 0, "each minute is its own window");

  f.advance(60000);
  assert.equal(f.logs.length, 1, "an empty minute is not logged");
  assert.equal(f.monitor.snapshot().recent.length, 1);
});

test("stopping logs the last partial minute and releases the timer and histogram", () => {
  const f = fixture();
  f.monitor.start();
  f.histogram.record(40);
  f.advance(0);
  f.logs.length = 0;
  f.histogram.record(90);
  f.monitor.stop();
  f.monitor.stop();
  assert.equal(f.histogram.enabled, false);
  assert.equal(f.counters().cleared, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0][2].maxMs, 90);
  assert.equal(f.monitor.snapshot().running, false);
});

test("the snapshot keeps the last hour of summaries and the current window", () => {
  const f = fixture();
  f.monitor.start();
  for (let minute = 0; minute < 65; minute++) {
    f.histogram.record(minute + 1);
    f.advance(60000);
  }
  f.histogram.record(7);
  const snapshot = f.monitor.snapshot();
  assert.equal(snapshot.recent.length, 60);
  assert.equal(snapshot.recent.at(-1).maxMs, 65);
  assert.equal(snapshot.current.maxMs, 7);
  assert.equal(snapshot.running, true);
});

test("a logger failure does not break the timer", () => {
  const histogram = fakeHistogram();
  let tick;
  const monitor = new EventLoopMonitor({ logger: { info() { throw new Error("disk full"); } },
    createHistogram: () => histogram, setInterval: (fn) => { tick = fn; return {}; }, clearInterval() {} });
  monitor.start();
  histogram.record(20);
  assert.doesNotThrow(() => tick());
  assert.equal(monitor.snapshot().recent.length, 1);
});

test("the runtime runs the monitor from start to stop and reports it in the diagnostics summary", async (t) => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createWindowsShellRuntime } = await import("../runtime/windows-shell-runtime.js");
  const { createFakeElectron } = await import("../test-support/fake-electron.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-event-loop-"));
  const electron = createFakeElectron({ home: root, appData: root });
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1", CCF_TEST_TOKEN: "event-loop" }, argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true } }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} }
    }
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await runtime.start();
  const response = await fetch(`http://127.0.0.1:${started.runtime.controlPort}/diagnostics-summary`,
    { headers: { "x-ccf-test-token": "event-loop" } });
  const summary = await response.json();
  assert.equal(summary.eventLoop.running, true);
  assert.equal(summary.eventLoop.intervalMs, 60000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await runtime.stop();
  const log = fs.readFileSync(started.runtime.logPath, "utf8");
  assert.match(log, /Main event-loop delay/, "the last partial minute is logged at shutdown");
});
