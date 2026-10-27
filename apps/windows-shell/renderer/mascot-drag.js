export function createMascotDrag({ element, enabled, getBounds, setBounds, setDragging,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let pending = null;
  let active = null;
  let frame = null;

  function release(pointerId) {
    try { element.releasePointerCapture(pointerId); } catch { /* Already released/cancelled. */ }
  }

  function boundsAt(drag, point) {
    return { ...drag.startBounds,
      x: Math.round(drag.startBounds.x + point.screenX - drag.startScreenX),
      y: Math.round(drag.startBounds.y + point.screenY - drag.startScreenY) };
  }

  function move(event) {
    if (pending?.pointerId === event.pointerId) {
      pending.latestPoint = { screenX: event.screenX, screenY: event.screenY };
    }
    if (!active || active.pointerId !== event.pointerId) return;
    active.latestBounds = boundsAt(active, event);
    if (frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      if (active) setBounds({ ...active.latestBounds, dragging: true });
    });
  }

  async function begin(event) {
    if (event.button !== 0 || !enabled() || pending || active) return;
    const attempt = { pointerId: event.pointerId, startScreenX: event.screenX, startScreenY: event.screenY };
    pending = attempt;
    try {
      // Capture before IPC so quick release/cancel cannot create a late drag.
      element.setPointerCapture(event.pointerId);
      const bounds = await getBounds();
      if (pending !== attempt) return;
      pending = null;
      if (!bounds) { release(attempt.pointerId); return; }
      active = { ...attempt, startBounds: bounds, latestBounds: bounds };
      setDragging(true);
      if (attempt.latestPoint) move({ ...attempt.latestPoint, pointerId: attempt.pointerId });
    } catch (error) {
      if (pending === attempt) { pending = null; release(attempt.pointerId); }
      throw error;
    }
  }

  function end(event) {
    if (pending?.pointerId === event.pointerId) {
      pending = null;
      release(event.pointerId);
    }
    if (!active || active.pointerId !== event.pointerId) return;
    const finalBounds = event.type === "pointerup" ? boundsAt(active, event) : active.latestBounds;
    active = null;
    if (frame !== null) { cancelFrame(frame); frame = null; }
    setDragging(false);
    setBounds({ ...finalBounds, dragging: false });
    release(event.pointerId);
  }

  return { begin, move, end };
}
