// ═══════════════════════════════════════════════════════════════
// voiceExtractDiff
//
// Pure helpers for the VoiceCaptureModal's review screen.
// Separated from the component so they can be unit-tested without
// rendering React.
//
//   - formatValueForDisplay  → renders a stored value (string, array,
//                              boolean, object) as human-readable text
//   - sameValue              → deep equality (mirrors storage.js's
//                              sameValue), used to detect no-op
//                              proposals where current === proposed
//   - buildProposalRows      → joins the extractor's claims with the
//                              current section values into a list
//                              ready to render in the review UI
// ═══════════════════════════════════════════════════════════════


/**
 * Render a stored field value as a short, readable string for the
 * "current vs proposed" diff. Long values are NOT truncated here —
 * the UI does any clamping it needs.
 */
export function formatValueForDisplay(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    // List rows (objects) → summary lines; multiselect (strings) → joined
    if (value.every((v) => typeof v === 'string')) return value.join(', ');
    return value.map(formatListRow).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    if ('answer' in value) {
      // YN: {answer, note?}
      return value.note ? `${value.answer} — ${value.note}` : String(value.answer);
    }
    if ('flag' in value) {
      // PRN: {flag, option?}
      const flagLabel = ({ P: 'Preferred', R: 'Required', N: 'Not needed' })[value.flag] || value.flag;
      return value.option ? `${flagLabel} (${value.option})` : flagLabel;
    }
    return JSON.stringify(value);
  }
  return String(value);
}


function formatListRow(row) {
  if (!row || typeof row !== 'object') return '';
  const entries = Object.entries(row)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${formatValueForDisplay(v)}`);
  return entries.length > 0 ? `{${entries.join(', ')}}` : '';
}


/**
 * Deep-equal-ish comparison for primitives, arrays, and plain objects.
 * Mirrors storage.js's `sameValue` so the diff calculation matches
 * what saveDraft would actually consider a change.
 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!sameValue(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}


/**
 * Join the extractor's accepted claims with the section's current
 * values to produce a list of rows ready to render in the review UI.
 *
 * One row per claim:
 *   {
 *     id, fieldLabel, fieldType,
 *     groupId?, groupLabel?,        // present for grouped sections
 *     currentValue,                 // already in the form
 *     proposedValue,                // what the extractor wants to set
 *     confidence, quote, quoteVerified,
 *     isUnchanged,                  // proposed === current
 *   }
 *
 * Rows are returned in input order — the modal can resort if needed
 * (e.g., put unchanged or low-confidence rows last).
 */
export function buildProposalRows(claims, currentValues) {
  const cv = currentValues || {};
  return (claims || []).map((claim) => {
    const currentValue = cv[claim.id];
    const row = {
      id: claim.id,
      fieldLabel: claim.fieldLabel,
      fieldType: claim.fieldType,
      currentValue,
      proposedValue: claim.value,
      confidence: claim.confidence,
      quote: claim.quote,
      quoteVerified: claim.quoteVerified,
      isUnchanged: sameValue(currentValue, claim.value),
    };
    if (claim.groupId)    row.groupId    = claim.groupId;
    if (claim.groupLabel) row.groupLabel = claim.groupLabel;
    return row;
  });
}


/**
 * Bucket rows by groupId, preserving group order from the schema's
 * `groups` array. Rows with no groupId land in a single ungrouped
 * bucket (returned with `groupId: null`).
 *
 * Returns: [{ groupId, groupLabel, rows: [] }, ...]
 *
 * Used by the review UI to render an accordion-style breakdown for
 * grouped sections without breaking the flat list for Phase 1 sections.
 */
export function groupProposalRows(rows, schemaGroups) {
  const groups = Array.isArray(schemaGroups) ? schemaGroups : [];
  const byGroup = new Map();
  // Seed groups in declaration order so empty groups stay in
  // position if all rows for a group were rejected.
  for (const g of groups) {
    byGroup.set(g.id, { groupId: g.id, groupLabel: g.label, rows: [] });
  }
  // Catch-all bucket for rows whose groupId isn't in the schema, or
  // for flat (non-grouped) sections.
  const ungrouped = { groupId: null, groupLabel: null, rows: [] };

  for (const row of rows || []) {
    const bucket = row.groupId && byGroup.has(row.groupId)
      ? byGroup.get(row.groupId)
      : ungrouped;
    bucket.rows.push(row);
  }

  const result = [];
  for (const g of groups) {
    const bucket = byGroup.get(g.id);
    if (bucket.rows.length > 0) result.push(bucket);
  }
  if (ungrouped.rows.length > 0) result.push(ungrouped);
  return result;
}


/**
 * Default which proposals are pre-selected for apply. Rule:
 *   - Skip unchanged proposals (no-op).
 *   - Skip unverified-quote proposals (likely hallucinations).
 *   - Skip low-confidence proposals (force the user to opt in).
 *   - Pre-select everything else.
 */
export function defaultSelectedIds(rows) {
  const selected = new Set();
  for (const r of rows) {
    if (r.isUnchanged) continue;
    if (!r.quoteVerified) continue;
    if (r.confidence === 'low') continue;
    selected.add(r.id);
  }
  return selected;
}
