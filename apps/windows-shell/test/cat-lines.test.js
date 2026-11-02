import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { CatLines, TIERS, fillPlaceholders, inNightWindow, loadCatLinesCatalog } from "../services/cat-lines.js";

const catalog = loadCatLinesCatalog(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "cat-lines.json"));
const DAY = new Date(2026, 10, 2, 14, 0).getTime();
const NIGHT = new Date(2026, 10, 2, 23, 30).getTime();

// Rolls in call order: lore check, tier roll, [night check when common at night], line choice.
function picker(rolls, { now = DAY, data = catalog } = {}) {
  const queue = [...rolls];
  return new CatLines({ catalog: data, now: () => now,
    random: () => { assert.ok(queue.length, "picker asked for more rolls than the test gave"); return queue.shift(); } });
}

test("the shipped catalog is his: every event has four tiers, placeholders are the documented ones", () => {
  assert.deepEqual(catalog.meta.tier_weights, { common: 70, uncommon: 22, rare: 7, legendary: 1 });
  const known = Object.keys(catalog.meta.placeholders).map((key) => key.slice(1, -1));
  for (const [event, entry] of Object.entries(catalog.events)) {
    assert.deepEqual(Object.keys(entry), TIERS, event);
    assert.ok(entry.common.length > 0, `${event} has common lines`);
    for (const line of TIERS.flatMap((tier) => entry[tier])) {
      for (const [, name] of line.matchAll(/\{([a-z_]+)\}/g)) assert.ok(known.includes(name), `${event}: {${name}}`);
    }
  }
  assert.equal(catalog.events.agent_idle.common[0], "Meow! {agent} is like \"dude, i can haz input plx?!\"");
  assert.equal(catalog.events.error.legendary[0], "That's not a bug. That's a \\r. It was always a \\r.");
  assert.equal(catalog.lore.length, 5);
  assert.equal(catalog.time_flavor.night.length, 3);
});

test("the tier roll follows the 70/22/7/1 weights", () => {
  const tierAt = (roll) => picker([0.5, roll, 0]).pick("task_done", { agent: "temp" }).tier;
  assert.equal(tierAt(0), "common");
  assert.equal(tierAt(0.699), "common");
  assert.equal(tierAt(0.70), "uncommon");
  assert.equal(tierAt(0.919), "uncommon");
  assert.equal(tierAt(0.92), "rare");
  assert.equal(tierAt(0.989), "rare");
  assert.equal(tierAt(0.99), "legendary");
  assert.equal(tierAt(0.9999), "legendary");
});

test("a line is chosen within its tier and its placeholders are filled", () => {
  assert.deepEqual(picker([0.5, 0, 0.2]).pick("agent_idle", { agent: "temp", mins: 16 }),
    { text: "temp iz idle 16 min. Iz sad. Plz feed.", tier: "common", kind: "event", special: false });
  assert.equal(picker([0.5, 0.95, 0.99]).pick("agent_idle", { agent: "api-1 and temp" }).text,
    "api-1 and temp asked if you're still alive. I said \"probably.\"");
  assert.equal(fillPlaceholders("+{added} −{removed}.", { added: 12, removed: 3 }), "+12 −3.");
  assert.equal(fillPlaceholders("{agent} at {pct}%", { agent: "x" }), null, "a missing placeholder makes the line unusable");
});

test("legendary lines come with the special entrance", () => {
  const line = picker([0.5, 0.995, 0]).pick("task_done", { agent: "temp" });
  assert.deepEqual(line, { text: "temp finished on the first try. The prophecy is fulfilled.", tier: "legendary",
    kind: "event", special: true });
});

test("an empty tier falls back to the next lower one", () => {
  // agent_question has no legendary line; rare has one.
  assert.deepEqual(picker([0.5, 0.995, 0]).pick("agent_question", { agent: "temp", mins: 4 }),
    { text: "temp has rephrased its question twice. In its head. I can tell.", tier: "rare", kind: "event", special: false });
  // A tier whose every line needs a placeholder that was not sent counts as empty, too.
  assert.deepEqual(picker([0.5, 0.8, 0]).pick("context_high", {}),
    { text: "So many tokens. So little room.", tier: "common", kind: "event", special: false });
  // Nothing at or below the roll: the next higher tier rather than no bubble.
  const data = { meta: catalog.meta, events: { x: { common: ["{agent} only"], uncommon: ["plain"], rare: [], legendary: [] } } };
  assert.equal(picker([0.5, 0, 0], { data }).pick("x", {}).text, "plain");
  assert.equal(picker([0.5, 0], { data: { events: { x: { common: ["{agent}"] } } } }).pick("x", {}), null);
});

test("an unknown event has no line", () => {
  assert.equal(picker([]).pick("nap_time", { agent: "temp" }), null);
  assert.equal(picker([]).pick("constructor", {}), null);
  assert.equal(new CatLines({ catalog }).has("agent_idle"), true);
});

test("lore replaces any bubble at legendary weight", () => {
  assert.deepEqual(picker([0.005, 0.3]).pick("error", { agent: "temp" }),
    { text: "Somewhere a JSON register still thinks I'm working.", tier: "legendary", kind: "lore", special: true });
  assert.equal(picker([0.01, 0, 0]).pick("error", { agent: "temp" }).kind, "event", "1 in 100, not more");
});

test("night lines can replace a common line inside the night window", () => {
  assert.deepEqual(picker([0.5, 0, 0.1, 0.5], { now: NIGHT }).pick("agent_idle", { agent: "temp" }),
    { text: "Prime hours. The daemons work best in the dark.", tier: "common", kind: "night", special: false });
  assert.equal(picker([0.5, 0, 0.5, 0], { now: NIGHT }).pick("agent_idle", { agent: "temp" }).kind, "event",
    "past the replace chance the event line stays");
  assert.equal(picker([0.5, 0.8, 0], { now: NIGHT }).pick("agent_idle", { agent: "temp" }).tier, "uncommon",
    "only common lines are replaced");
  assert.equal(picker([0.5, 0, 0], { now: DAY }).pick("agent_idle", { agent: "temp" }).kind, "event", "no night check by day");
});

test("the night window wraps midnight and is configurable", () => {
  const at = (h, m = 0) => new Date(2026, 10, 2, h, m);
  const window = { from: "22:00", to: "05:00" };
  assert.equal(inNightWindow(at(21, 59), window), false);
  assert.equal(inNightWindow(at(22, 0), window), true);
  assert.equal(inNightWindow(at(0, 30), window), true);
  assert.equal(inNightWindow(at(4, 59), window), true);
  assert.equal(inNightWindow(at(5, 0), window), false);
  assert.equal(inNightWindow(at(2), { from: "01:00", to: "03:00" }), true);
  assert.equal(inNightWindow(at(3), { from: "01:00", to: "03:00" }), false);
  assert.equal(inNightWindow(at(2), { from: "nope", to: "03:00" }), false);
  assert.deepEqual(catalog.meta.night_window && { from: catalog.meta.night_window.from, to: catalog.meta.night_window.to },
    { from: "22:00", to: "05:00" });
  const data = { ...catalog, meta: { ...catalog.meta, night_window: { from: "13:00", to: "15:00", replace_chance: 1 } } };
  assert.equal(picker([0.5, 0, 0.99, 0], { now: DAY, data }).pick("agent_idle", { agent: "temp" }).kind, "night");
});
