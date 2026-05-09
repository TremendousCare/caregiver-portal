// Geometry helpers for the eSign template field editor.
// Pure functions — no DOM, no React. Easy to unit test.
//
// All field coordinates are in PDF units (the units that get persisted).
// Display = PDF * pageData.scale.

/**
 * Clamp a field rectangle so it stays fully inside the page.
 * If the field is larger than the page in either axis, we cap dimensions
 * to the page and pin the corner to 0 instead of allowing negative coords.
 */
export function clampFieldRect({ x, y, w, h, pageWidth, pageHeight }) {
  const safeW = Math.min(w, pageWidth);
  const safeH = Math.min(h, pageHeight);
  const maxX = Math.max(0, pageWidth - safeW);
  const maxY = Math.max(0, pageHeight - safeH);
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
    w: safeW,
    h: safeH,
  };
}

/**
 * Compute a field's new rectangle from a drag-in-progress pointer event,
 * using the delta from the captured drag-start position.
 *
 * This is layout-shift safe: clientX/clientY are viewport-relative, so the
 * delta is independent of where the page itself happens to be on screen.
 *
 * Inputs:
 *   startClientX/Y — pointer viewport coords at pointerdown
 *   clientX/Y      — pointer viewport coords for this pointermove
 *   startFieldX/Y  — field PDF coords at pointerdown
 *   scale          — display scale (display px per PDF unit)
 *   pageWidth/Height — page size in PDF units
 *   fieldW/H       — current field size in PDF units
 */
export function computeDraggedRect({
  startClientX,
  startClientY,
  clientX,
  clientY,
  startFieldX,
  startFieldY,
  scale,
  pageWidth,
  pageHeight,
  fieldW,
  fieldH,
}) {
  const dx = (clientX - startClientX) / scale;
  const dy = (clientY - startClientY) / scale;
  return clampFieldRect({
    x: Math.round(startFieldX + dx),
    y: Math.round(startFieldY + dy),
    w: fieldW,
    h: fieldH,
    pageWidth,
    pageHeight,
  });
}

/**
 * Compute the new rectangle for a field being resized via a corner/edge handle.
 * Same delta-from-start approach as drag, layout-shift safe.
 *
 * `handle` encodes which edges move: combinations of n/e/s/w (e.g. "ne", "s").
 */
export function computeResizedField({
  handle,
  startMouseX,
  startMouseY,
  mouseX,
  mouseY,
  scale,
  startW,
  startH,
  startX,
  startY,
  pageWidth,
  pageHeight,
  minW = 16,
  minH = 12,
}) {
  const dx = Math.round((mouseX - startMouseX) / scale);
  const dy = Math.round((mouseY - startMouseY) / scale);

  let w = startW;
  let h = startH;
  let x = startX;
  let y = startY;

  if (handle.includes('e')) w = Math.max(minW, startW + dx);
  if (handle.includes('w')) {
    w = Math.max(minW, startW - dx);
    x = startX + (startW - w);
  }
  if (handle.includes('s')) h = Math.max(minH, startH + dy);
  if (handle.includes('n')) {
    h = Math.max(minH, startH - dy);
    y = startY + (startH - h);
  }

  // Cap dimensions to the page so resizing can never push the field out of view.
  w = Math.max(minW, Math.min(w, pageWidth));
  h = Math.max(minH, Math.min(h, pageHeight));

  return clampFieldRect({ x, y, w, h, pageWidth, pageHeight });
}
