import { describe, it, expect } from 'vitest';
import { shouldRender } from '../../features/care-plans/FieldRenderer';
import { FIELD_TYPES } from '../../features/care-plans/sections';

// Pure, DOM-free tests for the conditional resolver and field type
// coverage. The visual rendering (JSX) is covered by manual testing
// in the Vercel preview plus existing smoke tests at the panel level.

// ═══════════════════════════════════════════════════════════════
// shouldRender — conditional visibility
// ═══════════════════════════════════════════════════════════════

describe('shouldRender', () => {
  it('returns true when there is no conditional', () => {
    expect(shouldRender({ id: 'x', type: FIELD_TYPES.TEXT }, {})).toBe(true);
  });

  it('returns true for an "in" condition when sibling matches', () => {
    const field = {
      id: 'spouseName',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'maritalStatus', in: ['Married', 'Partnered'] },
    };
    expect(shouldRender(field, { maritalStatus: 'Married' })).toBe(true);
    expect(shouldRender(field, { maritalStatus: 'Partnered' })).toBe(true);
  });

  it('returns false for an "in" condition when sibling does not match', () => {
    const field = {
      id: 'spouseName',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'maritalStatus', in: ['Married', 'Partnered'] },
    };
    expect(shouldRender(field, { maritalStatus: 'Single' })).toBe(false);
    expect(shouldRender(field, {})).toBe(false);
    expect(shouldRender(field, { maritalStatus: null })).toBe(false);
  });

  it('returns true for "equals" match', () => {
    const field = {
      id: 'leftAloneDuration',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'canBeLeftAlone', equals: 'Short periods only' },
    };
    expect(shouldRender(field, { canBeLeftAlone: 'Short periods only' })).toBe(true);
  });

  it('returns false for "equals" miss', () => {
    const field = {
      id: 'leftAloneDuration',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'canBeLeftAlone', equals: 'Short periods only' },
    };
    expect(shouldRender(field, { canBeLeftAlone: 'Yes' })).toBe(false);
  });

  it('returns true for "notEquals" when sibling differs', () => {
    const field = {
      id: 'lastHospitalizationReason',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'lastHospitalizationDate', notEquals: '' },
    };
    expect(shouldRender(field, { lastHospitalizationDate: '2026-01-15' })).toBe(true);
  });

  it('returns false for "notEquals" when sibling matches (empty string)', () => {
    const field = {
      id: 'lastHospitalizationReason',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'lastHospitalizationDate', notEquals: '' },
    };
    expect(shouldRender(field, { lastHospitalizationDate: '' })).toBe(false);
    expect(shouldRender(field, {})).toBe(false);
    expect(shouldRender(field, { lastHospitalizationDate: null })).toBe(false);
  });

  it('handles boolean equals conditions', () => {
    const field = {
      id: 'medMgmt_timesPerDay',
      type: FIELD_TYPES.NUMBER,
      conditional: { field: 'medMgmt_needsReminders', equals: true },
    };
    expect(shouldRender(field, { medMgmt_needsReminders: true })).toBe(true);
    expect(shouldRender(field, { medMgmt_needsReminders: false })).toBe(false);
    expect(shouldRender(field, {})).toBe(false);
  });

  it('returns true when siblingValues is missing but no conditional', () => {
    const field = { id: 'x', type: FIELD_TYPES.TEXT };
    expect(shouldRender(field, undefined)).toBe(true);
    expect(shouldRender(field, null)).toBe(true);
  });

  it('returns false safely when conditional malformed (no match found)', () => {
    // Neither `in`, `equals`, nor `notEquals` — fall through to true.
    const field = {
      id: 'x',
      type: FIELD_TYPES.TEXT,
      conditional: { field: 'y' },
    };
    expect(shouldRender(field, { y: 'anything' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIELD_TYPES coverage — smoke check
// ═══════════════════════════════════════════════════════════════

describe('FIELD_TYPES coverage', () => {
  it('has 13 distinct field type values', () => {
    const values = Object.values(FIELD_TYPES);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(13);
  });

  it('every declared type is a non-empty string', () => {
    for (const v of Object.values(FIELD_TYPES)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
