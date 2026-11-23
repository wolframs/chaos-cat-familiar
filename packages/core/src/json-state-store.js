// The controller's default store when none is injected (tests). CCF itself keeps its state in SQLite since the
// process split's step 6 (storage-client.js: SqliteStateStore); the JSON checkpoint that lived here is gone.
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
