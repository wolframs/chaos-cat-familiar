// The companion HUD consumes the same optional JSON fields as the dotfiles
// Claude Code status line. It never invokes the status-line script or CLI.
const CAUSES = {
  system_prompt_changed: "sys prompt",
  tools_changed: "tools",
  model_changed: "model",
  messages_rewritten: "rewrite",
  ttl_expired_5m: "ttl 5m",
  ttl_expired_1h: "ttl 1h",
  likely_server_side: "server",
  unknown: "?"
};

const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const round = (value) => Math.round(Number(value));
const clamp = (value) => Math.max(0, Math.min(100, round(value)));
const heat = (value) => value >= 80 ? "red" : value >= 50 ? "yellow" : "green";

function count(value) {
  if (!finite(value)) return "";
  const n = Number(value);
  if (n >= 999500) return `${Math.round(n / 100000) / 10}M`;
  if (n >= 1000) return `${round(n / 1000)}k`;
  return String(round(n));
}

function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor(s % 86400 / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

function localRunout(seconds) {
  const date = new Date(seconds * 1000);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${day} ${time}`;
}

function limit(label, data, length, nowSeconds) {
  if (!finite(data?.used_percentage)) return null;
  const used = clamp(data.used_percentage);
  const resetAt = finite(data.resets_at) ? Number(data.resets_at) : 0;
  const left = resetAt - nowSeconds;
  const elapsed = length - left;
  const chips = [];
  let detail = left > 0 ? `↺ ${duration(left)}` : "";

  if (left > 0 && elapsed > length * 0.05) {
    const pace = round(Number(data.used_percentage) - elapsed / length * 100);
    if (pace >= 3) chips.push({ text: `↑${pace}`, tone: pace >= 10 ? "red" : "yellow" });
    if (pace <= -3) chips.push({ text: `↓${-pace}`, tone: "green" });
    if (used >= 20 && used < 100) {
      const timeToEmpty = (100 - Number(data.used_percentage)) / (Number(data.used_percentage) / elapsed);
      if (timeToEmpty < left) {
        detail = "";
        chips.push({ text: `⚠ ${localRunout(nowSeconds + timeToEmpty)}`, tone: "red" });
      }
    }
  }
  return { label, value: `${used}%`, bar: used, tone: heat(used), detail, chips };
}

function cacheSegment(data, nowSeconds) {
  if (data?.caching_observed !== true) return null;
  const warm = data.warm === true;
  const left = warm && finite(data.expires_at) ? Math.floor(Number(data.expires_at) - nowSeconds) : 0;
  const ttl = data.ttl ? `/${String(data.ttl)}` : "";
  const cause = data.last_miss_cause?.causes?.[0];
  const causeLabel = cause ? (CAUSES[cause] ?? String(cause)) : "";
  const segment = {
    label: "Cache",
    value: warm ? `${left > 0 ? duration(left) : "warm"}${ttl}` : `cold${causeLabel ? ` · ${causeLabel}` : ""}`,
    tone: warm ? left < 60 ? "red" : left < 300 ? "yellow" : "orange" : "blue",
    chips: []
  };
  if (!warm && finite(data.recache_tokens_if_cold) && Number(data.recache_tokens_if_cold) > 0) {
    segment.chips.push({ text: `+${count(data.recache_tokens_if_cold)}`, tone: "yellow" });
  }
  if (finite(data.hit_ratio)) {
    const hit = clamp(Number(data.hit_ratio) * 100);
    segment.chips.push({ text: `${hit}%`, tone: hit >= 80 ? "green" : hit >= 50 ? "yellow" : "red" });
  }
  if (finite(data.misses) && Number(data.misses) > 0) {
    segment.chips.push({ text: `${round(data.misses)}x`, tone: "red" });
  }
  return segment;
}

export function companionGaugeRows(payload = {}, { nowMs = Date.now() } = {}) {
  const nowSeconds = nowMs / 1000;
  const rows = [];
  const context = payload.context_window ?? {};
  const cost = payload.cost ?? {};
  const rate = payload.rate_limits ?? {};

  const first = [];
  if (finite(context.used_percentage)) {
    const used = clamp(context.used_percentage);
    const tokens = count(context.total_input_tokens);
    const size = count(context.context_window_size);
    first.push({ label: "Context", value: `${used}%${tokens && size ? ` ${tokens}/${size}` : ""}`, bar: used, tone: heat(used), chips: [] });
  }
  if (finite(cost.total_duration_ms) && Number(cost.total_duration_ms) >= 60000) {
    first.push({ label: "Session", value: duration(Number(cost.total_duration_ms) / 1000), tone: "neutral", chips: [] });
  }
  if (finite(cost.total_cost_usd) && Number(cost.total_cost_usd) >= 0.005) {
    first.push({ label: "Cost", value: `$${(round(Number(cost.total_cost_usd) * 100) / 100).toFixed(2)}`, tone: "neutral", chips: [] });
  }
  if (first.length) rows.push({ id: "context", segments: first });

  const fiveHour = limit("5h", rate.five_hour, 18000, nowSeconds);
  if (fiveHour) rows.push({ id: "five-hour", segments: [fiveHour] });

  const sevenDay = limit("7d", rate.seven_day, 604800, nowSeconds);
  const spend = limit("$", rate.spend_limit, 0, nowSeconds);
  const third = [sevenDay, spend].filter(Boolean);
  if (third.length) rows.push({ id: "seven-day", segments: third });

  const fourth = [];
  const cache = cacheSegment(payload.prompt_cache, nowSeconds);
  if (cache) fourth.push(cache);
  const added = finite(cost.total_lines_added) && Number(cost.total_lines_added) > 0 ? round(cost.total_lines_added) : 0;
  const removed = finite(cost.total_lines_removed) && Number(cost.total_lines_removed) > 0 ? round(cost.total_lines_removed) : 0;
  if (added || removed) fourth.push({ label: "Changes", value: `+${added} −${removed}`, tone: "neutral", chips: [] });
  if (fourth.length) rows.push({ id: "cache", segments: fourth });
  return rows;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function renderCompanionGaugeRows(rows) {
  return rows.map((row) => `<div class="gauge-row" data-gauge-row="${escapeHtml(row.id)}">${row.segments.map((segment) => {
    const bar = finite(segment.bar) ? `<span class="gauge-bar" aria-hidden="true"><span class="gauge-bar-fill" style="width:${clamp(segment.bar)}%"></span></span>` : "";
    const detail = segment.detail ? `<span class="gauge-detail">${escapeHtml(segment.detail)}</span>` : "";
    const chips = (segment.chips ?? []).map((chip) => `<span class="gauge-chip tone-${escapeHtml(chip.tone)}">${escapeHtml(chip.text)}</span>`).join("");
    return `<span class="gauge-block tone-${escapeHtml(segment.tone)}"><span class="gauge-label">${escapeHtml(segment.label)}</span>${bar}<span class="gauge-value">${escapeHtml(segment.value)}</span>${detail}${chips}</span>`;
  }).join("")}</div>`).join("");
}
