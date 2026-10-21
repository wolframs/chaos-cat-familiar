import { companionGaugeRows, renderCompanionGaugeRows } from "./companion-status-gauges.js";

const root = document.getElementById("companionStatus");
let latestPayload = null;
let receivedPush = false;

function unwrap(message) {
  return message?.payload ?? message ?? null;
}

function render() {
  const rows = companionGaugeRows(latestPayload ?? {});
  root.innerHTML = renderCompanionGaugeRows(rows);
  root.hidden = rows.length === 0;
}

window.ccf?.onCompanionStatus?.((message) => {
  receivedPush = true;
  latestPayload = unwrap(message);
  render();
});

window.ccf?.getCompanionStatus?.().then((message) => {
  if (receivedPush) return;
  latestPayload = unwrap(message);
  render();
}).catch(() => {});

// Countdown chips remain current even between statusLine refreshes.
setInterval(() => {
  if (!document.hidden && latestPayload) render();
}, 15_000);

render();
