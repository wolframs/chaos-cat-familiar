import { sessionActivationTarget } from "./session-activation.js";

const statsPill = document.getElementById("statsPill");

let latestState = null;
let latestSettings = null;

function mascotModeEnabled() {
  return latestSettings?.appShellMode === "mascot";
}

function render() {
  if (!latestState || !mascotModeEnabled()) {
    statsPill.classList.remove("visible");
    statsPill.innerHTML = "";
    return;
  }

  const active = latestState.sessions.filter((item) => item.status === "active");
  const activeSubagents = active.reduce((count, item) => count + (item.activeSubagentCount ?? 0), 0);
  const compacting = active.filter((item) => item.isCompacting).length;
  const running = active.filter((item) => item.phase === "running").length;
  const pending = latestState.approvals.length;
  const visible = active.length > 0 || activeSubagents > 0 || compacting > 0 || running > 0 || pending > 0;

  statsPill.classList.toggle("visible", visible);
  statsPill.innerHTML = visible
    ? `
      <span>${active.length} sessions</span>
      ${activeSubagents > 0 ? `<span>${activeSubagents} subagents</span>` : ""}
      ${compacting > 0 ? `<span>${compacting} compacting</span>` : ""}
      ${pending > 0 ? `<span>${pending} approvals</span>` : ""}
      ${running > 0 ? `<span>${running} running</span>` : ""}
    `
    : "";
}

statsPill.addEventListener("click", async () => {
  const active = latestState?.sessions?.filter((item) => item.status === "active") ?? [];
  if (active.length === 1) {
    await window.ccf.activateTerminal(sessionActivationTarget(active[0]));
    return;
  }
  await window.ccf.openDashboard();
});

window.ccf.onState((value) => {
  latestState = value;
  render();
});

window.ccf.onSettings((value) => {
  latestSettings = value;
  render();
});

async function refresh() {
  latestState = await window.ccf.getState();
  latestSettings = await window.ccf.getSettings();
  render();
}

refresh().catch(() => {});
