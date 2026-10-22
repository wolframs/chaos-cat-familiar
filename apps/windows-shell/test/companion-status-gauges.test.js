import test from "node:test";
import assert from "node:assert/strict";
import { companionGaugeRows, renderCompanionGaugeRows } from "../renderer/companion-status-gauges.js";

const nowMs = Date.parse("2026-10-20T18:00:00Z");

function payload() {
  return {
    context_window: { used_percentage: 11, total_input_tokens: 109000, context_window_size: 1000000 },
    rate_limits: {
      five_hour: { used_percentage: 28, resets_at: (nowMs + 2 * 60 * 60 * 1000) / 1000 },
      seven_day: { used_percentage: 98, resets_at: (nowMs + 3 * 24 * 60 * 60 * 1000) / 1000 },
      spend_limit: { used_percentage: 31, resets_at: (nowMs + 12 * 60 * 60 * 1000) / 1000 }
    },
    prompt_cache: { caching_observed: true, warm: true, ttl: "1h", expires_at: (nowMs + 38 * 60 * 1000) / 1000, hit_ratio: 0.98, misses: 1 },
    cost: { total_duration_ms: 164 * 60 * 1000, total_lines_added: 15, total_lines_removed: 2, total_cost_usd: 1.54 }
  };
}

test("companion gauge model preserves the dotfiles status line's second-row metrics in four rows", () => {
  const rows = companionGaugeRows(payload(), { nowMs });
  assert.deepEqual(rows.map((row) => row.id), ["context", "five-hour", "seven-day", "cache"]);
  assert.equal(rows[0].segments[0].label, "Context");
  assert.equal(rows[0].segments[0].value, "11% 109k/1M");
  assert.equal(rows[0].segments[0].bar, 11);
  assert.equal(rows[0].segments[1].value, "2h44m");
  assert.equal(rows[0].segments[2].value, "$1.54");
  assert.equal(rows[1].segments[0].label, "5h");
  assert.equal(rows[1].segments[0].value, "28%");
  assert.equal(rows[2].segments[0].label, "7d");
  assert.equal(rows[2].segments[0].tone, "red");
  assert.equal(rows[2].segments[1].label, "$");
  assert.equal(rows[3].segments[0].label, "Cache");
  assert.equal(rows[3].segments[0].value, "38m/1h");
  assert.deepEqual(rows[3].segments[0].chips.map((chip) => chip.text), ["98%", "1x"]);
  assert.equal(rows[3].segments[1].value, "+15 −2");
});

test("gauge pace, run-out warning, and cache urgency follow the dotfiles thresholds", () => {
  const sample = payload();
  sample.rate_limits.five_hour = { used_percentage: 75, resets_at: (nowMs + 2 * 60 * 60 * 1000) / 1000 };
  sample.prompt_cache.expires_at = (nowMs + 50 * 1000) / 1000;
  const rows = companionGaugeRows(sample, { nowMs });
  const fiveHour = rows[1].segments[0];
  assert.deepEqual(fiveHour.chips.map((chip) => chip.tone), ["red", "red"]);
  assert.match(fiveHour.chips[0].text, /^↑\d+$/);
  assert.match(fiveHour.chips[1].text, /^⚠ /);
  assert.equal(rows[3].segments[0].tone, "red");
  assert.equal(rows[3].segments[0].value, "50s/1h");
});

test("missing payload fields leave the HUD empty and cold cache keeps its diagnostic chips", () => {
  assert.deepEqual(companionGaugeRows({}, { nowMs }), []);
  const rows = companionGaugeRows({
    prompt_cache: {
      caching_observed: true,
      warm: false,
      last_miss_cause: { causes: ["tools_changed"] },
      recache_tokens_if_cold: 184000,
      hit_ratio: 0.43,
      misses: 2
    }
  }, { nowMs });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "cache");
  assert.equal(rows[0].segments[0].value, "cold · tools");
  assert.deepEqual(rows[0].segments[0].chips.map((chip) => chip.text), ["+184k", "43%", "2x"]);
});

test("a reset 5h window stays visible at 0 %, whether Claude Code sends the old window or none", () => {
  const stale = payload();
  stale.rate_limits.five_hour = { used_percentage: 61, resets_at: (nowMs - 10 * 60 * 1000) / 1000 };
  const missing = payload();
  delete missing.rate_limits.five_hour;
  for (const sample of [stale, missing]) {
    const rows = companionGaugeRows(sample, { nowMs });
    assert.deepEqual(rows.map((row) => row.id), ["context", "five-hour", "seven-day", "cache"]);
    assert.equal(rows[1].segments[0].value, "0%");
    assert.equal(rows[1].segments[0].bar, 0);
    assert.deepEqual(rows[1].segments[0].chips, []);
  }
});

test("HTML renderer has transparent rows, coloured connected blocks, and escapes payload text", () => {
  const sample = payload();
  sample.prompt_cache.ttl = '<img src=x onerror="bad()">';
  const html = renderCompanionGaugeRows(companionGaugeRows(sample, { nowMs }));
  assert.equal((html.match(/class="gauge-row"/g) ?? []).length, 4);
  assert.match(html, /class="gauge-block tone-green"/);
  assert.match(html, /class="gauge-chip tone-red"/);
  assert.match(html, /class="gauge-bar-fill"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
