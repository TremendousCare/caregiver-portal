// Geometry helpers for the eSign template field editor.
// Pure functions — no DOM, no React. Easy to unit test.
//
// All inputs/outputs are in PDF coordinates (the units that get persisted).
// The visual editor multiplies by `pageData.scale` for rendering.

/**
 * Clamp a field rectangle so it stays fully inside the page.
 * If the field is larger than the page in either axis, we still keep the
 * top-left corner at 0 rather than allowing negative coords.
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
 * Compute a new field position from a drag-in-progress mouse event.
 * mouseX/mouseY are page-relative display coordinates.
 * offsetX/offsetY were captured at drag start (display coords, mouse-to-field).
 */
export function computeDraggedPosition({
  mouseX,
  mouseY,
  offsetX,
  offsetY,
  scale,
  pageWidth,
  pageHeight,
  fieldW,
  fieldH,
}) {
  const rawX = Math.round((mouseX - offsetX) / scale);
  const rawY = Math.round((mouseY - offsetY) / scale);
  const clamped = clampFieldRect({
    x: rawX,
    y: rawY,
    w: fieldW,
    h: fieldH,
    pageWidth,
    pageHeight,
  });
  return { x: clamped.x, y: clamped.y };
}

/**
 * Compute the new rectangle for a field being resized via a corner/edge handle.
 * Mirrors the pattern in ESignFieldEditor: the handle name encodes which edges
 * are moving (n/e/s/w; corners are two letters like "ne").
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
