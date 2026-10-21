export class InMemoryLogger {
  constructor(limit = 500) {
    this.limit = limit;
    this.entries = [];
  }

  log(level, category, message, context = {}) {
    this.entries.unshift({
      id: crypto.randomUUID(),
      timestamp: new Date(),
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
