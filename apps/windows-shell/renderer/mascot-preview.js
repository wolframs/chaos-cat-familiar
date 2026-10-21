import { MascotStateMachine, mascotInputsFromState } from "./mascot-state-machine.js";

const previewVideo = document.getElementById("previewVideo");
const previewFallback = document.getElementById("previewFallback");
const mascotName = document.getElementById("mascotName");
const mascotDescription = document.getElementById("mascotDescription");
const currentScenario = document.getElementById("currentScenario");
const currentNode = document.getElementById("currentNode");
const currentMedia = document.getElementById("currentMedia");
const mascotSelect = document.getElementById("mascotSelect");
const scenarioButtons = document.getElementById("scenarioButtons");
const cycleButton = document.getElementById("cycleButton");
const syncButton = document.getElementById("syncButton");
const openManager = document.getElementById("openManager");
const statusText = document.getElementById("statusText");
const libraryList = document.getElementById("libraryList");
const windowMinimize = document.getElementById("windowMinimize");
const windowClose = document.getElementById("windowClose");

function logUi(level, message, context = {}) {
  window.ccf?.log?.({
    level,
    category: "mascot-preview-ui",
    message,
    context
  });
}

const scenarios = [
  {
    id: "idle",
    label: "Idle",
    description: "Claude is connected and waiting.",
    state: {
      approvals: [],
      sessions: [{ id: "session", status: "active", phase: "idle", isCompacting: false, projectName: "chaos-cat-familiar" }]
    }
  },
  {
    id: "working",
    label: "Working",
    description: "Claude is actively working inside the current project.",
    state: {
      approvals: [],
      sessions: [{ id: "session", status: "active", phase: "running", isCompacting: false, projectName: "chaos-cat-familiar" }]
    }
  },
  {
    id: "attention",
    label: "Needs Attention",
    description: "A permission request is waiting for approval.",
    state: {
      approvals: [{ id: "approval", collapsed: false, event: { toolName: "Bash", cwd: "C:\\Users\\dev\\repos\\chaos-cat-familiar" } }],
      sessions: [{ id: "session", status: "active", phase: "running", isCompacting: false, projectName: "chaos-cat-familiar" }]
    }
  },
  {
    id: "thinking",
    label: "Thinking",
    description: "Claude is compacting context and reorganizing its workspace.",
    state: {
      approvals: [],
      sessions: [{ id: "session", status: "active", phase: "idle", isCompacting: true, projectName: "chaos-cat-familiar" }]
    }
  }
];

let mascotLibrary = null;
let mascot = null;
let activeMascotId = null;
let activeScenarioId = "idle";
let lastMediaUrl = null;
let videoReady = false;
let cycleTimer = null;
let cycleIndex = 0;

function currentMascot() {
  return mascotLibrary?.mascots?.find((item) => item.id === activeMascotId)
    ?? mascotLibrary?.mascots?.find((item) => item.id === mascotLibrary?.currentMascotId)
    ?? mascotLibrary?.mascots?.[0]
    ?? null;
}

function currentScenarioDef() {
  return scenarios.find((item) => item.id === activeScenarioId) ?? scenarios[0];
}

function ensureRuntime() {
  const selectedMascot = currentMascot();
  if (!selectedMascot) {
    return null;
  }
  if (!mascot || mascot.config !== selectedMascot.config) {
    mascot = new MascotStateMachine(selectedMascot.config);
    lastMediaUrl = null;
    videoReady = false;
  }
  return selectedMascot;
}

function renderScenarioButtons() {
  scenarioButtons.innerHTML = scenarios.map((scenario) => `
    <button class="state-button ${scenario.id === activeScenarioId ? "active" : ""}" data-scenario="${scenario.id}">
      <strong>${scenario.label}</strong><br />
      <span class="meta">${scenario.description}</span>
    </button>
  `).join("");

  scenarioButtons.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      activeScenarioId = button.dataset.scenario;
      stopAutoCycle();
      render();
    });
  });
}

function renderLibrary() {
  mascotSelect.innerHTML = (mascotLibrary?.mascots ?? []).map((item) => `
    <option value="${item.id}" ${item.id === activeMascotId ? "selected" : ""}>${item.name}${item.slug ? ` (${item.slug})` : ""}</option>
  `).join("");

  libraryList.innerHTML = (mascotLibrary?.mascots ?? []).map((item) => {
    const thumbnail = item.config?.nodes?.find((node) => node.transparentThumbnailUrl)?.transparentThumbnailUrl ?? "";
    return `
      <article class="library-item ${item.id === activeMascotId ? "active" : ""}" data-mascot-id="${item.id}" tabindex="0" role="button" aria-label="Preview ${item.name}">
        <img src="${thumbnail}" alt="${item.name}" />
        <div style="min-width:0;">
          <div><strong>${item.name}</strong></div>
          <div class="meta">${item.slug ? `slug: ${item.slug}` : "bundled preset"} · ${item.config?.nodes?.length ?? 0} states</div>
        </div>
      </article>
    `;
  }).join("");

  libraryList.querySelectorAll("[data-mascot-id]").forEach((item) => {
    const selectMascot = () => {
      activeMascotId = item.dataset.mascotId;
      mascotSelect.value = activeMascotId;
      logUi("info", "Preview mascot selected from library list", {
        mascotId: activeMascotId
      });
      render();
    };

    item.addEventListener("click", selectMascot);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectMascot();
      }
    });
  });
}

function applySnapshot(snapshot) {
  const scenario = currentScenarioDef();
  currentScenario.textContent = scenario.label;
  currentNode.textContent = snapshot.nodeName;
  currentMedia.textContent = snapshot.phase === "transition" ? "Transition clip" : "Loop clip";
  mascotDescription.textContent = scenario.description;

  if (snapshot.thumbnailUrl) {
    previewFallback.src = snapshot.thumbnailUrl;
  }

  if (!snapshot.media?.url) {
    videoReady = false;
    previewVideo.removeAttribute("src");
    previewVideo.load();
    previewFallback.style.display = "block";
    return;
  }

  if (snapshot.media.url !== lastMediaUrl) {
    lastMediaUrl = snapshot.media.url;
    videoReady = false;
    previewVideo.loop = Boolean(snapshot.media.loop);
    previewVideo.src = snapshot.media.url;
    previewVideo.load();
    previewVideo.play().catch(() => {
      previewFallback.style.display = "block";
      statusText.textContent = "Video playback failed; showing the fallback frame instead.";
    });
  } else if (previewVideo.loop !== Boolean(snapshot.media.loop)) {
    previewVideo.loop = Boolean(snapshot.media.loop);
  }

  previewFallback.style.display = videoReady ? "none" : "block";
}

function render() {
  renderScenarioButtons();
  renderLibrary();
  const selectedMascot = ensureRuntime();
  const scenario = currentScenarioDef();
  if (!selectedMascot || !mascot) {
    statusText.textContent = "No mascot library is available yet.";
    return;
  }

  mascotName.textContent = selectedMascot.name;
  const snapshot = mascot.applyInputs(mascotInputsFromState(scenario.state));
  applySnapshot(snapshot);
  statusText.textContent = `Previewing ${selectedMascot.name} in ${scenario.label.toLowerCase()} mode.`;
}

function stopAutoCycle() {
  if (cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
  cycleButton.textContent = "Auto cycle";
}

function startAutoCycle() {
  stopAutoCycle();
  cycleButton.textContent = "Stop cycle";
  cycleTimer = setInterval(() => {
    cycleIndex = (cycleIndex + 1) % scenarios.length;
    activeScenarioId = scenarios[cycleIndex].id;
    render();
  }, 5200);
}

mascotSelect.addEventListener("change", () => {
  activeMascotId = mascotSelect.value;
  render();
});

cycleButton.addEventListener("click", () => {
  logUi("info", "Toggle mascot cycle clicked", {
    cycling: !cycleTimer
  });
  if (cycleTimer) {
    stopAutoCycle();
    return;
  }
  startAutoCycle();
});

syncButton.addEventListener("click", async () => {
  logUi("info", "Sync mascot to overlay clicked", {
    mascotId: activeMascotId
  });
  if (!activeMascotId) {
    return;
  }
  const result = await window.ccf.selectMascot(activeMascotId);
  statusText.textContent = result.ok
    ? `Selected ${result.mascot.name} for the actual overlay.`
    : "Could not apply that mascot to the overlay.";
});

openManager.addEventListener("click", async () => {
  logUi("info", "Open mascot manager clicked from preview");
  await window.ccf.openMascotManager();
});

windowMinimize?.addEventListener("click", async () => {
  logUi("info", "Mascot preview minimize clicked");
  await window.ccf.windowAction("minimize");
});

windowClose?.addEventListener("click", async () => {
  logUi("info", "Mascot preview close clicked");
  await window.ccf.windowAction("close");
});

previewVideo.addEventListener("loadeddata", () => {
  videoReady = true;
  previewFallback.style.display = "block";
});

previewVideo.addEventListener("playing", () => {
  videoReady = true;
  previewFallback.style.display = "none";
});

previewVideo.addEventListener("ended", () => {
  if (!mascot) {
    return;
  }
  const snapshot = mascot.handleVideoEnded();
  if (snapshot.media?.url && snapshot.media.url !== lastMediaUrl) {
    lastMediaUrl = null;
    applySnapshot(snapshot);
  }
});

previewVideo.addEventListener("error", () => {
  videoReady = false;
  previewFallback.style.display = "block";
  statusText.textContent = "The preview video could not be played; fallback art is still available.";
});

window.ccf.onMascotLibrary((value) => {
  mascotLibrary = value;
  activeMascotId = activeMascotId && mascotLibrary?.mascots?.some((item) => item.id === activeMascotId)
    ? activeMascotId
    : mascotLibrary?.currentMascotId ?? mascotLibrary?.mascots?.[0]?.id ?? null;
  render();
});

(async () => {
  mascotLibrary = await window.ccf.getMascotLibrary();
  activeMascotId = mascotLibrary?.currentMascotId ?? mascotLibrary?.mascots?.[0]?.id ?? null;
  cycleIndex = scenarios.findIndex((item) => item.id === activeScenarioId);
  render();
})().catch((error) => {
  logUi("error", "Initial mascot preview load failed", {
    error: String(error?.message ?? error)
  });
});
