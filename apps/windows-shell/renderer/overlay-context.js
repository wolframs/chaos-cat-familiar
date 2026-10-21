const contextPanel = document.getElementById("contextPanel");

let latestState = null;
let latestSettings = null;

function mascotModeEnabled() {
  return latestSettings?.appShellMode === "mascot";
}

function bindMainActions() {
  contextPanel.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.dispatchCommand(button.dataset.command, {
        minutes: Number(button.dataset.minutes ?? 0)
      });
    });
  });

  contextPanel.querySelectorAll("[data-shell-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.updateSettings({ appShellMode: button.dataset.shellMode });
    });
  });

  contextPanel.querySelectorAll("[data-context-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      await window.ccf.dispatchCommand("set-context-mode", { mode: button.dataset.contextMode });
    });
  });

  contextPanel.querySelector("[data-open-dashboard]")?.addEventListener("click", async () => {
    await window.ccf.openDashboard();
    await window.ccf.dispatchCommand("close-context-menu");
  });

  contextPanel.querySelector("[data-close-overlay]")?.addEventListener("click", async () => {
    await window.ccf.updateSettings({ overlayVisible: false });
  });
}

function bindRangeMode(key) {
  const input = contextPanel.querySelector("input");
  const valueEl = contextPanel.querySelector("span");
  input?.addEventListener("input", async () => {
    valueEl.textContent = input.value;
    await window.ccf.updateSettings({
      [key]: Number(input.value)
    });
  });
  contextPanel.querySelector(".back-context")?.addEventListener("click", async () => {
    await window.ccf.dispatchCommand("set-context-mode", { mode: "main" });
  });
}

function render() {
  if (!latestState || !mascotModeEnabled()) {
    contextPanel.classList.remove("visible");
    contextPanel.innerHTML = "";
    return;
  }

  const context = latestState.ui?.overlay?.contextMenu ?? { isOpen: false, mode: "closed" };
  contextPanel.classList.toggle("visible", Boolean(context.isOpen));
  contextPanel.innerHTML = "";
  if (!context.isOpen) {
    return;
  }

  if (context.mode === "opacity" || context.mode === "scale") {
    const label = context.mode === "opacity" ? "Overlay opacity" : "Permission panel scale";
    const key = context.mode === "opacity" ? "overlayOpacity" : "permissionPanelScale";
    const min = context.mode === "opacity" ? "0.1" : "0.8";
    const max = context.mode === "opacity" ? "1" : "2.5";
    const step = context.mode === "opacity" ? "0.05" : "0.1";
    contextPanel.innerHTML = `
      <div class="row">
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Windows overlay control.</div>
        </div>
        <button class="back-context">Back</button>
      </div>
      <div class="range-row">
        <input type="range" min="${min}" max="${max}" step="${step}" value="${latestSettings?.[key] ?? 1}" />
        <span>${latestSettings?.[key] ?? 1}</span>
      </div>
    `;
    bindRangeMode(key);
    return;
  }

  contextPanel.innerHTML = `
    <div class="row">
      <div>
        <div class="title">Overlay Controls</div>
        <div class="subtitle">Snooze, shell mode, appearance, and dashboard shortcuts.</div>
      </div>
      <div class="pill">${latestSettings?.appShellMode ?? "developer"}</div>
    </div>
    <div class="actions">
      <button data-command="snooze-overlay" data-minutes="15">15m</button>
      <button data-command="snooze-overlay" data-minutes="30">30m</button>
      <button data-command="snooze-overlay" data-minutes="60">1h</button>
      <button data-command="snooze-overlay" data-minutes="120">2h</button>
      <button data-command="snooze-overlay" data-minutes="0">Until resumed</button>
      <button data-command="resume-overlay">Resume</button>
      <button data-shell-mode="mascot">Mascot mode</button>
      <button data-shell-mode="developer">Developer mode</button>
      <button data-context-mode="opacity">Opacity</button>
      <button data-context-mode="scale">Panel scale</button>
      <button data-open-dashboard="true">Open dashboard</button>
      <button data-close-overlay="true">Close overlay</button>
    </div>
  `;
  bindMainActions();
}

window.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    await window.ccf.dispatchCommand("close-context-menu");
  }
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
