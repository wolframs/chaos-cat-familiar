// The cat's speech bubbles: they stack until the user clicks each one away.
// Style ids match renderer/companion-bubble.css; "plum" is Wolfram's own mock-up.
export const BUBBLE_STYLES = ["plum", "lilac", "neon", "comic", "flame", "pixel"];
export const SPECIAL_CHANCE = 1 / 7;
export const MAX_KEPT_BUBBLES = 50;

export class CompanionBubbles {
  constructor({ random = Math.random, now = Date.now } = {}) {
    this.random = random;
    this.now = now;
    this.items = [];
    this.nextId = 1;
  }

  // style/special override the roll (tests and trying a look); an unknown style rolls.
  add({ text, style = null, special = null }) {
    const bubble = {
      id: `bubble-${this.nextId++}`,
      text,
      style: BUBBLE_STYLES.includes(style) ? style
        : BUBBLE_STYLES[Math.min(BUBBLE_STYLES.length - 1, Math.floor(this.random() * BUBBLE_STYLES.length))],
      special: typeof special === "boolean" ? special : this.random() < SPECIAL_CHANCE,
      at: this.now()
    };
    this.items.push(bubble);
    // A forgotten pile must not grow without bound: the oldest go first.
    if (this.items.length > MAX_KEPT_BUBBLES) this.items.splice(0, this.items.length - MAX_KEPT_BUBBLES);
    return bubble;
  }

  dismiss(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return this.items.length !== before;
  }

  list() {
    return this.items.map((item) => ({ ...item }));
  }

  get size() {
    return this.items.length;
  }
}
