import { overlayWindowSizeForMode } from "./overlay-shell-mode.js";

const EDGE = 8;
const GAP = 8;
const COLUMN_GAP = 24;
const CONVERSATION = { width: 700, height: 500 };
const STATUS = { width: 520, height: 144 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function placeCompanionCluster({ cat, workArea, conversation = CONVERSATION, status = STATUS }) {
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
  const left = clamp(cat.x, workArea.x + EDGE, workArea.x + workArea.width - EDGE - clusterWidth);
  const catY = clamp(cat.y,
    workArea.y + EDGE + conversationHeight + GAP,
    workArea.y + workArea.height - EDGE - footerHeight);

  return {
    cat: { ...cat, x: Math.round(left), y: Math.round(catY) },
    conversation: {
      x: Math.round(left),
      y: Math.round(catY - GAP - conversationHeight),
      width: conversationWidth,
      height: conversationHeight
    },
    status: {
      x: Math.round(alongside ? left + cat.width + COLUMN_GAP : left),
      y: Math.round(alongside ? catY + (footerHeight - statusHeight) / 2 : catY + cat.height + GAP),
      width: statusWidth,
      height: statusHeight
    }
  };
}
