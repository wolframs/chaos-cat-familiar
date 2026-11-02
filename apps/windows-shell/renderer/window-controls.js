// Keep window controls independent of each pane's data loading and feature code.
for (const button of document.querySelectorAll("[data-window-action]")) {
  button.addEventListener("click", () => window.ccf.windowAction(button.dataset.windowAction));
}
