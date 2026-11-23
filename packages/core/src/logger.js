export class InMemoryLogger {
  constructor(limit = 500) {
    this.limit = limit;
    this.entries = [];
  }

  // timestamp: kept for entries logged elsewhere first (main forwards its log lines to the core's log).
  log(level, category, message, context = {}, timestamp = null) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      timestamp: timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp : new Date(),
      level,
      category,
      message,
      context
    });

    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  info(category, message, context = {}) {
    this.log("info", category, message, context);
  }

  warn(category, message, context = {}) {
    this.log("warn", category, message, context);
  }

  error(category, message, context = {}) {
    this.log("error", category, message, context);
  }

  child() {
    return this;
  }
}
