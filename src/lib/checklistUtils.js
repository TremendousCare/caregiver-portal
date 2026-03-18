/**
 * Calculate progress for a single checklist.
 * @param {{ items: Array<{ checked: boolean }> }} checklist
 * @returns {{ checked: number, total: number, pct: number }}
 */
export function getChecklistProgress(checklist) {
  const items = checklist?.items || [];
  const total = items.length;
  const checked = items.filter((i) => i.checked).length;
  const pct = total === 0 ? 0 : Math.round((checked / total) * 100);
  return { checked, total, pct };
}

/**
 * Aggregate checklist progress across all checklists on a card.
 * Returns null if no checklists exist.
 * @param {Array} checklists
 * @returns {{ checked: number, total: number, pct: number } | null}
 */
export function getCardChecklistSummary(checklists) {
  if (!checklists || checklists.length === 0) return null;
  let checked = 0;
  let total = 0;
  for (const cl of checklists) {
    for (const item of cl.items || []) {
      total++;
      if (item.checked) checked++;
    }
  }
  if (total === 0) return null;
  const pct = Math.round((checked / total) * 100);
  return { checked, total, pct };
}
