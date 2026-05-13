// ═══════════════════════════════════════════════════════════════
// listHelpers — small pure functions for LIST-type field rows.
//
// Kept dependency-free so the row-mutation logic can be unit-tested
// in isolation from the React renderer.
// ═══════════════════════════════════════════════════════════════

export function moveRowUp(rows, idx) {
  if (!Array.isArray(rows) || idx <= 0 || idx >= rows.length) return rows;
  const next = rows.slice();
  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
  return next;
}

export function moveRowDown(rows, idx) {
  if (!Array.isArray(rows) || idx < 0 || idx >= rows.length - 1) return rows;
  const next = rows.slice();
  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
  return next;
}
