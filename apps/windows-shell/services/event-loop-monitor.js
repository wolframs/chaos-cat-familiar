import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const NS_PER_MS = 1e6;
const RECENT_LIMIT = 60;
const round = (value) => Math.round(value * 100) / 100;

// Main event-loop delay, one summary per minute (process-split plan, step 1). Always on: a histogram sample every
// 10 ms costs next to nothing, and it is the number that shows whether a slow step still reaches the windows.
// Values are timer lateness including the resolution (on Windows ~15 ms when idle); max and p99 are what matter.
export class EventLoopMonitor {
  constructor({ logger = null, intervalMs = 60000, resolutionMs = 10,
    createHistogram = () => monitorEventLoopDelay({ resolution: resolutionMs }),
    now = () => performance.now(),
    setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval } = {}) {
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.resolutionMs = resolutionMs;
    this.createHistogram = createHistogram;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.histogram = null;
    this.timer = null;
    this.windowStartedAt = null;
    this.recent = [];
  }

  start() {
    if (this.timer !== null) return;
    this.histogram ??= this.createHistogram();
    this.histogram.reset();
    this.histogram.enable();
    this.windowStartedAt = this.now();
    this.timer = this.schedule(() => this.sample(), this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
    this.sample();
    this.histogram.disable();
  }

  // Summarizes and logs the current window, then starts a new one. An empty window is not logged.
  sample() {
    if (!this.histogram) return null;
    const summary = this.#summary();
    this.histogram.reset();
    this.windowStartedAt = this.now();
    if (!summary) return null;
    this.recent.push(summary);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    try {
      this.logger?.info?.("performance", "Main event-loop delay over the last window (ms)", summary);
    } catch { /* Diagnostics must not break the timer. */ }
    return summary;
  }

  snapshot() {
    return { running: this.timer !== null, intervalMs: this.intervalMs, resolutionMs: this.resolutionMs,
      current: this.histogram ? this.#summary() : null, recent: structuredClone(this.recent) };
  }

  #summary() {
    const histogram = this.histogram;
    if (!histogram || !histogram.count) return null;
    return {
      at: new Date().toISOString(),
      windowMs: round(this.now() - this.windowStartedAt),
      count: histogram.count,
      minMs: round(histogram.min / NS_PER_MS),
      meanMs: round(histogram.mean / NS_PER_MS),
      p50Ms: round(histogram.percentile(50) / NS_PER_MS),
      p90Ms: round(histogram.percentile(90) / NS_PER_MS),
      p99Ms: round(histogram.percentile(99) / NS_PER_MS),
      maxMs: round(histogram.max / NS_PER_MS)
    };
  }
}
