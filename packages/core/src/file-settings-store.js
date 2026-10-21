import { loadJsonWithRecovery, writeJsonAtomic } from "./atomic-json.js";

export class FileSettingsStore {
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
