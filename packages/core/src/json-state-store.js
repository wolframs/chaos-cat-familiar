import { loadJsonWithRecovery, writeJsonAtomic } from "./atomic-json.js";

export class FileJsonStateStore {
  constructor(filePath, defaults = {}, options = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.options = options;
  }

  load() {
    return loadJsonWithRecovery(this.filePath, this.defaults, this.options);
  }

  save(value) {
    writeJsonAtomic(this.filePath, value, this.options);
  }
}

export class InMemoryStateStore {
  constructor(initialValue = {}) {
    this.value = structuredClone(initialValue);
  }

  load() {
    return structuredClone(this.value);
  }

  save(value) {
    this.value = structuredClone(value);
  }
}
