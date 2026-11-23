// What a collection looked like at its last commit, so the next commit carries only rows that changed (process-split
// plan, step 6). One shadow per table. The caller's array is the truth; diff() turns it into upserts, removals and new
// positions, and the shadow moves only when the caller says the commit landed.
//
// Positions: "desc" collections are newest first (new entities are unshifted: core events, notifications, sessions),
// "asc" ones in array order (new entities are pushed: companion delivery). A new entity on the growing end gets the
// next position; any other change of order renumbers the whole table (rare: nothing reorders today).
// Immutable collections (events) are compared by object identity, so an unchanged event is never serialized again;
// the others by their JSON.

export class RowShadow {
  constructor({ direction = "desc", immutable = false, key = (entity) => entity?.id } = {}) {
    if (!["asc", "desc"].includes(direction)) throw new Error(`Unknown direction ${direction}.`);
    Object.assign(this, { direction, immutable, key });
    this.rows = new Map();      // id -> { pos, json, ref }
  }

  // Rows as read from the database ({id, pos, json}), with the loaded entities when known (for identity checks).
  reset(rows = [], entities = []) {
    this.rows = new Map(rows.map((row, index) => [String(row.id), { pos: row.pos, json: row.json, ref: entities[index] ?? null }]));
    return this;
  }

  // Returns { change: {upsert, reposition, remove} | null, commit() }.
  diff(list = []) {
    const ids = [];
    const seen = new Set();
    const entities = [];
    for (const entity of list) {
      const id = String(this.key(entity));
      if (seen.has(id)) continue;   // a duplicate id cannot be two rows: the first one (the newest) wins
      seen.add(id);
      ids.push(id);
      entities.push(entity);
    }
    const remove = [...this.rows.keys()].filter((id) => !seen.has(id));
    const positions = this.#positions(ids);
    const next = new Map();
    const upsert = [];
    const reposition = [];
    ids.forEach((id, index) => {
      const entity = entities[index];
      const known = this.rows.get(id);
      const pos = positions.get(id);
      let json = known?.json ?? null;
      if (!known || !this.immutable || known.ref !== entity) {
        const fresh = JSON.stringify(entity);
        if (fresh !== json) {
          json = fresh;
          upsert.push({ id, pos, json });
        } else if (known.pos !== pos) reposition.push({ id, pos });
      } else if (known.pos !== pos) reposition.push({ id, pos });
      next.set(id, { pos, json, ref: entity });
    });
    const changed = upsert.length || reposition.length || remove.length;
    return {
      change: changed ? { upsert, reposition, remove } : null,
      commit: () => { this.rows = next; }
    };
  }

  #positions(ids) {
    const positions = new Map();
    const known = ids.filter((id) => this.rows.has(id));
    // Keep existing positions when they already run in order and new rows only appear on the growing end.
    const ordered = known.every((id, index) => index === 0
      || (this.direction === "desc" ? this.rows.get(known[index - 1]).pos > this.rows.get(id).pos
        : this.rows.get(known[index - 1]).pos < this.rows.get(id).pos));
    const growing = this.direction === "desc" ? ids.slice(0, ids.length - known.length) : ids.slice(known.length);
    const onEnd = growing.every((id) => !this.rows.has(id));
    if (ordered && onEnd) {
      let top = Math.max(0, ...[...this.rows.values()].map((row) => row.pos));
      for (const id of known) positions.set(id, this.rows.get(id).pos);
      const fresh = this.direction === "desc" ? [...growing].reverse() : growing;
      for (const id of fresh) positions.set(id, ++top);
      return positions;
    }
    ids.forEach((id, index) => positions.set(id, this.direction === "desc" ? ids.length - index : index + 1));
    return positions;
  }
}
