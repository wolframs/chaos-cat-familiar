import { featuredMascots as featuredCatalog } from "./featured-mascots.js";

const mascotSlug = document.getElementById("mascotSlug");
const installMascot = document.getElementById("installMascot");
const openPreview = document.getElementById("openPreview");
const openDiagnostics = document.getElementById("openDiagnostics");
const mascotStatus = document.getElementById("mascotStatus");
const currentMascotImage = document.getElementById("currentMascotImage");
const currentMascotName = document.getElementById("currentMascotName");
const currentMascotMeta = document.getElementById("currentMascotMeta");
const mascotLibraryEl = document.getElementById("mascotLibrary");
const featuredMascotsEl = document.getElementById("featuredMascots");
const librarySearch = document.getElementById("librarySearch");
const libraryFilter = document.getElementById("libraryFilter");
const windowMinimize = document.getElementById("windowMinimize");
const windowClose = document.getElementById("windowClose");
const viewStateKey = "ccf.mascots.viewState";

function logUi(level, message, context = {}) {
  window.ccf?.log?.({
    level,
    category: "mascots-ui",
    message,
    context
  });
}

function firstThumbnail(mascot) {
  return mascot?.config?.nodes?.find((node) => node.transparentThumbnailUrl)?.transparentThumbnailUrl ?? "";
}

function currentMascot(library) {
  return library?.mascots?.find((item) => item.id === library.currentMascotId) ?? library?.mascots?.[0] ?? null;
}

function loadViewState() {
  try {
    return JSON.parse(localStorage.getItem(viewStateKey) ?? "{}");
  } catch {
    return {};
  }
}

function saveViewState() {
  localStorage.setItem(viewStateKey, JSON.stringify({
    search: librarySearch.value,
    filter: libraryFilter.value
  }));
}

function filteredMascots(library) {
  const search = librarySearch.value.trim().toLowerCase();
  const filter = libraryFilter.value;
  return (library?.mascots ?? []).filter((mascot) => {
    if (filter !== "all" && mascot.source !== filter) {
      return false;
    }
    if (!search) {
      return true;
    }
    const haystack = [
      mascot.name,
      mascot.slug,
      mascot.source
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });
}

function renderLibrary(library) {
  const active = currentMascot(library);
  currentMascotName.textContent = active?.name ?? "Masko";
  currentMascotMeta.textContent = active?.slug
    ? `${active.source === "remote" ? "Installed from masko.ai" : "Bundled"} · slug: ${active.slug}`
    : "Bundled default mascot";
  currentMascotImage.src = firstThumbnail(active);

  const mascots = filteredMascots(library);
  mascotLibraryEl.innerHTML = mascots.map((mascot) => `
    <article class="card mascot-card">
      <img src="${firstThumbnail(mascot)}" alt="${mascot.name}" />
      <div class="eyebrow">${library.currentMascotId === mascot.id ? "Active now" : mascot.source}</div>
      <div style="margin-top:10px;"><strong>${mascot.name}</strong></div>
      <div class="meta">${mascot.slug ? `slug: ${mascot.slug}` : "bundled default"}<br />${mascot.config?.nodes?.length ?? 0} states<br />added ${new Date(mascot.addedAt).toLocaleDateString()}</div>
      <div class="actions" style="margin-top:12px;">
        <button class="${library.currentMascotId === mascot.id ? "primary" : "secondary"}" data-mascot-id="${mascot.id}">
          ${library.currentMascotId === mascot.id ? "Selected" : "Use mascot"}
        </button>
      </div>
    </article>
  `).join("");

  mascotLibraryEl.querySelectorAll("[data-mascot-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await window.ccf.selectMascot(button.dataset.mascotId);
      mascotStatus.textContent = result.ok ? `Selected ${result.mascot.name}.` : "Could not select mascot.";
      const nextLibrary = await window.ccf.getMascotLibrary();
      renderLibrary(nextLibrary);
    });
  });
}

async function refresh() {
  renderLibrary(await window.ccf.getMascotLibrary());
}

function installStatusText(result, slug) {
  if (result.ok) {
    if (result.action === "selected_existing") {
      return `Already installed. Switched to ${result.mascot.name}.`;
    }
    return `Installed ${result.mascot.name}. The overlay will switch immediately.`;
  }

  switch (result.error) {
    case "invalid_slug":
      return "That slug is not valid. Try a short mascot name like masko or rusty.";
    case "fetch_failed":
      if (result.status === 404) {
        return `No mascot was found for “${slug}”. Check the slug and try again.`;
      }
      return `Could not download that mascot from masko.ai right now${result.status ? ` (${result.status})` : ""}.`;
    default:
      return `Install failed: ${result.error}${result.status ? ` (${result.status})` : ""}`;
  }
}

async function installSlug(slug) {
  if (!slug) {
    mascotStatus.textContent = "Enter a mascot slug first.";
    return;
  }
  mascotStatus.textContent = `Installing ${slug}...`;
  const result = await window.ccf.installMascot(slug);
  mascotStatus.textContent = installStatusText(result, slug);
  if (result.ok) {
    mascotSlug.value = "";
  }
  await refresh();
}

function renderFeaturedChips() {
  featuredMascotsEl.innerHTML = featuredCatalog.map((item) => `
    <button class="chip" data-featured-slug="${item.slug}">
      <strong>${item.name}</strong><br />
      <span class="meta">${item.vibe}</span>
    </button>
  `).join("");

  featuredMascotsEl.querySelectorAll("[data-featured-slug]").forEach((button) => {
    button.addEventListener("click", async () => {
      const slug = button.dataset.featuredSlug;
      mascotSlug.value = slug;
      await installSlug(slug);
    });
  });
}

installMascot.addEventListener("click", async () => {
  const slug = mascotSlug.value.trim();
  logUi("info", "Install mascot clicked", { slug });
  await installSlug(slug);
});

openDiagnostics.addEventListener("click", async () => {
  logUi("info", "Open diagnostics clicked from mascots");
  await window.ccf.openDiagnostics();
});

openPreview.addEventListener("click", async () => {
  logUi("info", "Open preview clicked from mascots");
  await window.ccf.openMascotPreview();
});

windowMinimize?.addEventListener("click", async () => {
  logUi("info", "Mascot manager minimize clicked");
  await window.ccf.windowAction("minimize");
});

windowClose?.addEventListener("click", async () => {
  logUi("info", "Mascot manager close clicked");
  await window.ccf.windowAction("close");
});

window.ccf.onMascotLibrary((library) => {
  renderLibrary(library);
});

const viewState = loadViewState();
librarySearch.value = viewState.search ?? "";
libraryFilter.value = viewState.filter ?? "all";
librarySearch.addEventListener("input", async () => {
  saveViewState();
  await refresh();
});
libraryFilter.addEventListener("change", async () => {
  saveViewState();
  await refresh();
});

renderFeaturedChips();
refresh().catch((error) => {
  logUi("error", "Initial mascots refresh failed", {
    error: String(error?.message ?? error)
  });
});
