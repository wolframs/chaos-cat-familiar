function normalizeBounds(bounds) {
  return {
    x: Number(bounds?.x ?? 0),
    y: Number(bounds?.y ?? 0),
    width: Number(bounds?.width ?? 0),
    height: Number(bounds?.height ?? 0)
  };
}

export function clampBoundsToWorkArea(bounds, workArea, padding = 24) {
  const rect = normalizeBounds(bounds);
  const area = normalizeBounds(workArea);
  const width = Math.min(rect.width, Math.max(area.width - padding * 2, 100));
  const height = Math.min(rect.height, Math.max(area.height - padding * 2, 100));
  const minX = area.x + padding;
  const minY = area.y + padding;
  const maxX = area.x + area.width - width - padding;
  const maxY = area.y + area.height - height - padding;

  return {
    x: Math.max(minX, Math.min(rect.x, maxX)),
    y: Math.max(minY, Math.min(rect.y, maxY)),
    width,
    height
  };
}

function pointInArea(point, area) {
  return (
    point.x >= area.x &&
    point.x < area.x + area.width &&
    point.y >= area.y &&
    point.y < area.y + area.height
  );
}

export function selectDisplay({
  displays,
  mode,
  lastDisplayId,
  savedBounds,
  cursorPoint,
  primaryDisplayId
}) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return null;
  }

  if (mode === "remember" && lastDisplayId != null) {
    const remembered = displays.find((display) => display.id === lastDisplayId);
    if (remembered) {
      return remembered;
    }
  }

  if (mode === "remember" && savedBounds) {
    const matching = displays.find((display) => pointInArea(savedBounds, display.workArea ?? display.bounds));
    if (matching) {
      return matching;
    }
  }

  if (mode === "cursor" && cursorPoint) {
    const hovered = displays.find((display) => pointInArea(cursorPoint, display.bounds));
    if (hovered) {
      return hovered;
    }
  }

  return (
    displays.find((display) => display.id === primaryDisplayId) ??
    displays.find((display) => display.primary) ??
    displays[0]
  );
}

export function deriveOverlayPlacement({
  displays,
  mode = "remember",
  lastDisplayId = null,
  savedBounds = null,
  cursorPoint = null,
  primaryDisplayId = null,
  width = 420,
  height = 320,
  padding = 24
}) {
  const display = selectDisplay({
    displays,
    mode,
    lastDisplayId,
    savedBounds,
    cursorPoint,
    primaryDisplayId
  });

  if (!display) {
    return {
      display: null,
      bounds: { x: 24, y: 24, width, height }
    };
  }

  const workArea = display.workArea ?? display.bounds;
  const fallback = {
    x: workArea.x + workArea.width - width - padding,
    y: workArea.y + padding,
    width,
    height
  };

  return {
    display,
    bounds: clampBoundsToWorkArea(savedBounds ?? fallback, workArea, padding)
  };
}

