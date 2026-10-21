import { performance } from "node:perf_hooks";

const finite = value => typeof value === "number" && Number.isFinite(value);
const nonnegative = value => finite(value) ? Math.max(0, value) : 0;

/** Opt-in telemetry using Electron's existing process metrics, without subprocesses. */
export class PerformanceSampler {
  constructor({ app, logger, getCounts = () => ({}), intervalMs = 30000,
    now = () => performance.now(), memoryUsage = () => process.memoryUsage(),
    setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval }) {
    this.app = app;
    this.logger = logger;
    this.getCounts = getCounts;
    this.intervalMs = finite(intervalMs) && intervalMs > 0 ? intervalMs : 30000;
    this.now = now;
    this.memoryUsage = memoryUsage;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.enabled = false;
    this.samples = [];
    this.previous = new Map();
    this.previousTime = null;
    this.lastTick = null;
    this.lastError = null;
  }

  configure(enabled) {
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    this.sample(0);
    this.lastTick = this.now();
    this.timer = this.schedule(() => {
      if (!this.enabled) return;
      const tick = this.now();
      // Scheduling lag is a low-overhead main-process responsiveness proxy.
      const lag = Math.max(0, tick - this.lastTick - this.intervalMs);
      this.lastTick = tick;
      this.sample(lag);
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.enabled = false;
    this.previous.clear();
    this.previousTime = null;
    this.lastTick = null;
  }

  snapshot() {
    return { enabled: this.enabled, intervalMs: this.intervalMs, lastError: this.lastError, samples: structuredClone(this.samples) };
  }

  sample(eventLoopSchedulingLagMs) {
    try {
      const time = this.now();
      const elapsedMs = this.previousTime === null ? null : time - this.previousTime;
      const metrics = this.app.getAppMetrics();
      const next = new Map();
      const processes = metrics.map(metric => {
        const key = `${metric.pid}:${metric.creationTime}`;
        const cumulative = metric.cpu?.cumulativeCPUUsage;
        const prior = this.previous.get(key);
        // A missing creation time cannot safely identify a reused PID.
        const identifiable = metric.creationTime !== undefined && metric.creationTime !== null;
        const cpuPercentOfOneCore = identifiable && elapsedMs > 0 && finite(cumulative) && finite(prior) && cumulative >= prior
          ? (cumulative - prior) * 100000 / elapsedMs : null;
        if (identifiable && finite(cumulative)) next.set(key, cumulative);
        return {
          pid: metric.pid, creationTime: metric.creationTime, type: metric.type,
          cpuPercentOfOneCore,
          privateMemoryKiB: nonnegative(metric.memory?.privateBytes),
          workingSetKiB: nonnegative(metric.memory?.workingSetSize)
        };
      });
      const knownCpu = processes.filter(item => item.cpuPercentOfOneCore !== null);
      const sample = {
        timestamp: new Date().toISOString(), elapsedMs,
        cpuPercentOfOneCore: knownCpu.length ? knownCpu.reduce((sum, item) => sum + item.cpuPercentOfOneCore, 0) : null,
        privateMemoryKiB: processes.reduce((sum, item) => sum + item.privateMemoryKiB, 0),
        workingSetKiB: processes.reduce((sum, item) => sum + item.workingSetKiB, 0),
        mainMemoryBytes: this.memoryUsage(), eventLoopSchedulingLagMs,
        counts: this.getCounts(), processes
      };
      this.previous = next;
      this.previousTime = time;
      this.samples.push(structuredClone(sample));
      if (this.samples.length > 20) this.samples.shift();
      this.logger?.info("performance", "Process resource sample (CPU: percent of one logical core; Electron memory: KiB).", sample);
      this.lastError = null;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 512);
      const changed = this.lastError !== message;
      this.lastError = message;
      // Suppress repeated failures until the error changes or sampling recovers.
      if (changed) {
        try {
          this.logger?.warn?.("performance", "Performance sampling failed.", { error: message });
        } catch {
          // A failing logger must not interrupt the companion's timer either.
        }
      }
    }
  }
}
