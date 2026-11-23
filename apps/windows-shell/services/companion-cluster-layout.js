import { overlayWindowSizeForMode } from "./overlay-shell-mode.js";

const EDGE = 8;
const GAP = 8;
const COLUMN_GAP = 24;
const CONVERSATION = { width: 700, height: 500 };
const STATUS = { width: 520, height: 144 };
// The side panel: left of the conversation, same top and height (docs/ARCHITECTURE.md, "The side panel and the cluster
// menu"). Its right edge touches the conversation window's left edge; the two 8 DIP transparent insets make the gap.
export const PANEL = Object.freeze({ width: 320 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// panel ({width}) asks for the side panel: placement.panel, or null on a work area too narrow for it (the cluster
// then is laid out as without it). Without the option there is no placement.panel at all.
export function placeCompanionCluster({ cat, workArea, conversation = CONVERSATION, status = STATUS, panel = null }) {
  // Saved native bounds may include old badge space or a previous display's DPI.
  cat = { ...cat, ...overlayWindowSizeForMode("mascot") };
  const usableWidth = Math.max(1, workArea.width - EDGE * 2);
  const usableHeight = Math.max(1, workArea.height - EDGE * 2);
  const conversationWidth = Math.min(conversation.width, usableWidth);
  const alongside = conversationWidth >= cat.width + COLUMN_GAP + 320;
  const statusWidth = Math.min(status.width, alongside ? conversationWidth - cat.width - COLUMN_GAP : usableWidth);
  const statusHeight = Math.min(status.height, Math.max(1, usableHeight - cat.height - GAP * 2 - 180));
  const footerHeight = alongside ? Math.max(cat.height, statusHeight) : cat.height + GAP + statusHeight;
  const conversationHeight = Math.min(conversation.height, Math.max(1, usableHeight - footerHeight - GAP));
  const clusterWidth = Math.max(conversationWidth, alongside ? cat.width + COLUMN_GAP + statusWidth : statusWidth);
  const panelWidth = panel && workArea.width >= conversationWidth + panel.width + EDGE * 2 ? panel.width : 0;
  const left = clamp(cat.x, workArea.x + EDGE + panelWidth, workArea.x + workArea.width - EDGE - clusterWidth);
  const catY = clamp(cat.y,
    workArea.y + EDGE + conversationHeight + GAP,
    workArea.y + workArea.height - EDGE - footerHeight);

  const conversationBounds = {
    x: Math.round(left),
    y: Math.round(catY - GAP - conversationHeight),
    width: conversationWidth,
    height: conversationHeight
  };
  return {
    cat: { ...cat, x: Math.round(left), y: Math.round(catY) },
    conversation: conversationBounds,
    status: {
      x: Math.round(alongside ? left + cat.width + COLUMN_GAP : left),
      y: Math.round(alongside ? catY + (footerHeight - statusHeight) / 2 : catY + cat.height + GAP),
      width: statusWidth,
      height: statusHeight
    },
    ...(panel ? { panel: panelWidth ? { ...conversationBounds, x: conversationBounds.x - panelWidth, width: panelWidth } : null } : {})
  };
}
