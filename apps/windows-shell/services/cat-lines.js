// What the cat says: the work companion's watcher names an event ("agent_idle") and its
// placeholders ({agent: "temp", mins: 16}); this picks the line from Wolfram's catalog
// (assets/cat-lines.json, his text, approved 2026-11-02). The catalog's meta block is the spec:
// tiers by weight, an empty tier falls back to the next lower one, lore can replace any bubble
// at legendary weight, night lines can replace a common line inside the night window.
import fs from "node:fs";

export const TIERS = ["common", "uncommon", "rare", "legendary"];
export const DEFAULT_WEIGHTS = { common: 70, uncommon: 22, rare: 7, legendary: 1 };
export const DEFAULT_NIGHT_WINDOW = { from: "22:00", to: "05:00", replace_chance: 0.33 };
const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function loadCatLinesCatalog(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// A line whose placeholders are not all supplied is not usable: "{agent} iz idle {mins} min"
// without mins would read "temp iz idle  min".
export function fillPlaceholders(line, values = {}) {
  let missing = false;
  const text = String(line).replace(PLACEHOLDER, (whole, name) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") { missing = true; return whole; }
    return String(value);
  });
  return missing ? null : text;
}

function minutesOf(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock ?? ""));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

// Local time; from > to wraps midnight (22:00-05:00). from is inside, to is outside.
export function inNightWindow(date, window = DEFAULT_NIGHT_WINDOW) {
  const from = minutesOf(window?.from);
  const to = minutesOf(window?.to);
  if (from === null || to === null || from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export class CatLines {
  constructor({ catalog, random = Math.random, now = Date.now } = {}) {
    this.catalog = catalog ?? { events: {} };
    this.random = random;
    this.now = now;
    const weights = this.catalog.meta?.tier_weights ?? DEFAULT_WEIGHTS;
    this.weights = TIERS.map((tier) => Math.max(0, Number(weights[tier]) || 0));
    this.nightWindow = { ...DEFAULT_NIGHT_WINDOW, ...(this.catalog.meta?.night_window ?? {}) };
  }

  has(event) {
    return Object.hasOwn(this.catalog.events ?? {}, event);
  }

  // Returns { text, tier, kind: "event" | "lore" | "night", special } or null when the event is
  // unknown or none of its lines can be filled. special: legendary rarity shows as the special entrance.
  pick(event, placeholders = {}) {
    if (!this.has(event)) return null;
    const entry = this.catalog.events[event];
    const usable = (tier) => (Array.isArray(entry[tier]) ? entry[tier] : [])
      .map((line) => fillPlaceholders(line, placeholders)).filter((line) => line !== null);
    const total = this.weights.reduce((sum, weight) => sum + weight, 0) || 1;

    const lore = Array.isArray(this.catalog.lore) ? this.catalog.lore : [];
    if (lore.length && this.random() < this.weights[TIERS.indexOf("legendary")] / total) {
      return { text: this.choose(lore), tier: "legendary", kind: "lore", special: true };
    }

    let roll = this.random() * total;
    let rolled = 0;
    while (rolled < TIERS.length - 1 && roll >= this.weights[rolled]) { roll -= this.weights[rolled]; rolled += 1; }
    // Down to the next lower tier first (the spec); upward only when nothing lower is usable,
    // e.g. every common line needs a placeholder the watcher did not send.
    const order = [...TIERS.slice(0, rolled + 1).reverse(), ...TIERS.slice(rolled + 1)];
    const tier = order.find((candidate) => usable(candidate).length);
    if (!tier) return null;

    const night = Array.isArray(this.catalog.time_flavor?.night) ? this.catalog.time_flavor.night : [];
    if (tier === "common" && night.length && inNightWindow(new Date(this.now()), this.nightWindow)
      && this.random() < Number(this.nightWindow.replace_chance)) {
      return { text: this.choose(night), tier, kind: "night", special: false };
    }
    return { text: this.choose(usable(tier)), tier, kind: "event", special: tier === "legendary" };
  }

  choose(list) {
    return list[Math.min(list.length - 1, Math.floor(this.random() * list.length))];
  }
}
