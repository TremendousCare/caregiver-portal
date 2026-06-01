// ═══════════════════════════════════════════════════════════════
// fieldDisplay
//
// Pure, field-type-aware helpers for rendering care-plan section
// VALUES read-only (the client profile panel, future caregiver /
// family views). Separated from the React components so the
// formatting logic can be unit-tested without rendering.
//
// These helpers read the field definitions from sections.js so a
// stored value (which may be a string, array, or a typed object like
// YN {answer, note} / PRN {flag, option} / a LIST of subfield rows)
// renders as clean human-readable text instead of a raw JSON dump.
//
// Display-only: nothing here writes data or affects the editor.
// ═══════════════════════════════════════════════════════════════

import { FIELD_TYPES, getFieldsForGroup, sectionHasGroups } from './sections';

const PRN_LABELS = { P: 'Preferred', R: 'Required', N: 'Not needed' };

/**
 * Is this stored value "empty" for read-only display purposes?
 *
 * Mirrors the editor's notion of unset so the panel hides fields the
 * team never filled in. A `false` boolean is treated as empty — for
 * the BOOLEAN/checkbox fields used in these sections, unchecked means
 * "not set", and we don't want a wall of "No" rows. Explicit yes/no
 * answers are stored as YN objects ({answer: 'No'}), which are NOT
 * empty and still render.
 */
export function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'boolean') return value === false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    if ('answer' in value) return isEmptyValue(value.answer);
    if ('flag' in value) return isEmptyValue(value.flag);
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Format a single scalar field value (or multiselect array) using the
 * field definition for type context. Returns a display string.
 */
function formatScalarValue(field, value) {
  if (isEmptyValue(value)) return '';

  // PRN — {flag: 'P'|'R'|'N', option?}
  if (value && typeof value === 'object' && 'flag' in value) {
    const label = PRN_LABELS[value.flag] || value.flag;
    return value.option ? `${label} (${value.option})` : String(label);
  }

  // YN — {answer: 'Yes'|'No'|'Unknown', note?}
  if (value && typeof value === 'object' && 'answer' in value) {
    return value.note ? `${value.answer} — ${value.note}` : String(value.answer);
  }

  // MULTISELECT and any other string array
  if (Array.isArray(value)) {
    return value.filter((v) => v != null && String(v).trim() !== '').join(', ');
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  return String(value);
}

/**
 * Format one LIST row ({subfieldId: value, ...}) using the parent
 * field's subfield definitions so values appear in declaration order
 * with sensible separators. Falls back to raw entry order for any
 * keys the definition doesn't know about (e.g. legacy data).
 */
function formatListRow(field, row) {
  if (!row || typeof row !== 'object') return '';
  const subfields = Array.isArray(field?.subfields) ? field.subfields : [];

  const seen = new Set();
  const parts = [];

  for (const sf of subfields) {
    seen.add(sf.id);
    const v = row[sf.id];
    if (isEmptyValue(v)) continue;
    parts.push(formatScalarValue(sf, v));
  }
  // Preserve any extra keys not covered by the definition.
  for (const [k, v] of Object.entries(row)) {
    if (seen.has(k) || isEmptyValue(v)) continue;
    parts.push(formatScalarValue({ type: FIELD_TYPES.TEXT }, v));
  }

  return parts.join(' · ');
}

/**
 * Format a care-plan field value for read-only display, using the
 * field definition for type context. Returns a display string;
 * multi-row LIST values are joined with newlines (the panel renders
 * the value cell with `white-space: pre-wrap`).
 */
export function formatCarePlanFieldValue(field, value) {
  if (isEmptyValue(value)) return '';

  if (field?.type === FIELD_TYPES.LIST) {
    if (!Array.isArray(value)) return '';
    return value.map((row) => formatListRow(field, row)).filter(Boolean).join('\n');
  }

  return formatScalarValue(field, value);
}

/**
 * Does a section have any non-empty field values in `data`? Used to
 * decide whether a section reads as "entered" (Edit) vs "empty" (Add)
 * and whether to render its inline field view. For grouped sections
 * (ADL/IADL) only fields wired into a group are considered — matching
 * exactly what the editor and the read-only panel surface.
 */
export function sectionHasFieldContent(section, data) {
  if (!section || !data || typeof data !== 'object') return false;
  if (sectionHasGroups(section)) {
    return section.groups.some((group) =>
      getFieldsForGroup(section, group.id).some((f) => !isEmptyValue(data[f.id])));
  }
  return (section.fields || []).some((f) => !isEmptyValue(data[f.id]));
}
