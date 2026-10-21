import test from "node:test";
import assert from "node:assert/strict";
import { PerformanceSampler } from "../services/performance-sampler.js";

function fixture(loggerOverrides = {}) {
  let now = 1000;
  let metrics = [{ pid: 10, creationTime: 5, type: "Browser", cpu: { cumulativeCPUUsage: 1 }, memory: { privateBytes: 100, workingSetSize: 200 } }];
  let callback;
  let starts = 0;
  let clears = 0;
  let unrefs = 0;
  const logs = [];
  const sampler = new PerformanceSampler({
    app: { getAppMetrics: () => { if (metrics instanceof Error) throw metrics; return metrics; } },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), ...loggerOverrides },
    getCounts: () => ({ windows: 2, sessions: 3 }),
    intervalMs: 1000,
    now: () => now,
    memoryUsage: () => ({ heapUsed: 42, heapTotal: 84, rss: 128 }),
    setInterval: (fn, delay) => { assert.equal(delay, 1000); callback = fn; starts++; return { unref: () => unrefs++ }; },
    clearInterval: () => clears++
  });
  return { sampler, logs, tick: (ms = 1000) => { now += ms; callback(); }, setMetrics: value => { metrics = value; }, counters: () => ({ starts, clears, unrefs }) };
}

test("disabled sampler has no timer; enabling is idempotent and stop clears it", () => {
  const f = fixture();
  assert.deepEqual(f.sampler.snapshot().samples, []);
  f.sampler.configure(false);
  assert.equal(f.counters().starts, 0);
  f.sampler.configure(true);
  f.sampler.configure(true);
  assert.deepEqual(f.counters(), { starts: 1, clears: 0, unrefs: 1 });
  assert.equal(f.logs[0][0], "performance");
  f.sampler.stop();
  f.sampler.stop();
  assert.deepEqual(f.counters(), { starts: 1, clears: 1, unrefs: 1 });
  assert.equal(f.sampler.snapshot().enabled, false);
});

test("samples memory units, heap, counts, scheduling lag and CPU against matching process lifetime", () => {
  const f = fixture();
  f.sampler.configure(true);
  f.setMetrics([{ pid: 10, creationTime: 5, type: "Browser", cpu: { cumulativeCPUUsage: 1.5 }, memory: { privateBytes: 110, workingSetSize: 210 } }]);
  f.tick(1250);
  const sample = f.sampler.snapshot().samples.at(-1);
  assert.equal(sample.cpuPercentOfOneCore, 40);
  assert.equal(sample.processes[0].cpuPercentOfOneCore, 40);
  assert.equal(sample.privateMemoryKiB, 110);
  assert.equal(sample.workingSetKiB, 210);
  assert.deepEqual(sample.mainMemoryBytes, { heapUsed: 42, heapTotal: 84, rss: 128 });
  assert.deepEqual(sample.counts, { windows: 2, sessions: 3 });
  assert.equal(sample.eventLoopSchedulingLagMs, 250);
  f.setMetrics([{ pid: 10, creationTime: 6, cpu: { cumulativeCPUUsage: 10 }, memory: {} }]);
  f.tick();
  assert.equal(f.sampler.snapshot().samples.at(-1).cpuPercentOfOneCore, null);
});

test("retains twenty detached samples and resets CPU baseline when reenabled", () => {
  const f = fixture();
  f.sampler.configure(true);
  for (let i = 0; i < 25; i++) f.tick();
  const snapshot = f.sampler.snapshot();
  assert.equal(snapshot.samples.length, 20);
  snapshot.samples[0].counts.windows = 999;
  assert.equal(f.sampler.snapshot().samples[0].counts.windows, 2);
  f.sampler.configure(false);
  f.sampler.configure(true);
  assert.equal(f.sampler.snapshot().samples.at(-1).cpuPercentOfOneCore, null);
});

test("sampling failures do not escape timer or prevent later samples", () => {
  const f = fixture();
  f.sampler.configure(true);
  f.setMetrics(new Error("metrics unavailable"));
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.sampler.snapshot().samples.length, 1);
  assert.equal(f.sampler.snapshot().lastError, "metrics unavailable");
  f.tick();
  assert.equal(f.logs.filter(args => args[1] === "Performance sampling failed.").length, 1);
  f.setMetrics([]);
  f.tick();
  assert.equal(f.sampler.snapshot().samples.length, 2);
  assert.equal(f.sampler.snapshot().lastError, null);
});

test("CPU can exceed one core and never borrows a missing process baseline", () => {
  const f = fixture();
  f.sampler.configure(true);
  f.setMetrics([{ pid: 10, creationTime: 5, cpu: { cumulativeCPUUsage: 3.5 } }]);
  f.tick();
  assert.equal(f.sampler.snapshot().samples.at(-1).cpuPercentOfOneCore, 250);
  f.setMetrics([]);
  f.tick();
  f.setMetrics([{ pid: 10, creationTime: 5, cpu: { cumulativeCPUUsage: 7 } }]);
  f.tick();
  assert.equal(f.sampler.snapshot().samples.at(-1).cpuPercentOfOneCore, null);
});

test("queued timer callback after disabling records nothing", () => {
  const f = fixture();
  f.sampler.configure(true);
  f.sampler.stop();
  f.tick();
  assert.equal(f.sampler.snapshot().samples.length, 1);
});

test("error text is bounded and a failing warning logger cannot break sampling", () => {
  const f = fixture({ warn: () => { throw new Error("logger unavailable"); } });
  f.sampler.configure(true);
  f.setMetrics(new Error("x".repeat(2000)));
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.sampler.snapshot().lastError.length, 512);
  f.setMetrics([]);
  f.tick();
  assert.equal(f.sampler.snapshot().lastError, null);
  assert.equal(f.sampler.snapshot().samples.length, 2);
});
