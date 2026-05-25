import { describe, it, expect } from 'vitest';
import {
  formatValueForDisplay,
  sameValue,
  buildProposalRows,
  defaultSelectedIds,
} from '../../features/care-plans/voice/voiceExtractDiff';


describe('formatValueForDisplay', () => {
  it('renders empty / null as em-dash', () => {
    expect(formatValueForDisplay(null)).toBe('—');
    expect(formatValueForDisplay(undefined)).toBe('—');
    expect(formatValueForDisplay('')).toBe('—');
    expect(formatValueForDisplay([])).toBe('—');
  });

  it('passes through plain strings and numbers', () => {
    expect(formatValueForDisplay('hello')).toBe('hello');
    expect(formatValueForDisplay(42)).toBe('42');
  });

  it('renders booleans as Yes/No', () => {
    expect(formatValueForDisplay(true)).toBe('Yes');
    expect(formatValueForDisplay(false)).toBe('No');
  });

  it('joins string arrays (multiselect) with commas', () => {
    expect(formatValueForDisplay(['English', 'Spanish'])).toBe('English, Spanish');
  });

  it('summarizes list rows (object arrays) inline', () => {
    const meds = [
      { name: 'Metformin', dose: '500mg' },
      { name: 'Lisinopril', dose: '10mg' },
    ];
    const out = formatValueForDisplay(meds);
    expect(out).toContain('name: Metformin');
    expect(out).toContain('Lisinopril');
  });

  it('renders YN shape with note', () => {
    expect(formatValueForDisplay({ answer: 'Yes', note: 'while seated' }))
      .toBe('Yes — while seated');
    expect(formatValueForDisplay({ answer: 'No' })).toBe('No');
  });

  it('renders PRN shape with flag label and optional option', () => {
    expect(formatValueForDisplay({ flag: 'R' })).toBe('Required');
    expect(formatValueForDisplay({ flag: 'P', option: 'Female' }))
      .toBe('Preferred (Female)');
    expect(formatValueForDisplay({ flag: 'N' })).toBe('Not needed');
  });
});


describe('sameValue', () => {
  it('handles primitives', () => {
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 'a')).toBe(false);
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(true, true)).toBe(true);
  });

  it('handles arrays element-wise', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameValue([], [])).toBe(true);
  });

  it('handles nested objects', () => {
    expect(sameValue({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});


describe('buildProposalRows', () => {
  const claims = [
    {
      id: 'fullName', fieldLabel: 'Full legal name', fieldType: 'text',
      value: 'Mary Johnson', confidence: 'high',
      quote: 'her name is Mary Johnson', quoteVerified: true,
    },
    {
      id: 'gender', fieldLabel: 'Gender', fieldType: 'select',
      value: 'Female', confidence: 'high',
      quote: 'she is female', quoteVerified: true,
    },
  ];

  it('joins claims with current values and flags unchanged rows', () => {
    const rows = buildProposalRows(claims, { gender: 'Female' });
    expect(rows).toHaveLength(2);

    const name = rows.find((r) => r.id === 'fullName');
    expect(name.currentValue).toBeUndefined();
    expect(name.proposedValue).toBe('Mary Johnson');
    expect(name.isUnchanged).toBe(false);

    const gender = rows.find((r) => r.id === 'gender');
    expect(gender.currentValue).toBe('Female');
    expect(gender.proposedValue).toBe('Female');
    expect(gender.isUnchanged).toBe(true);
  });

  it('tolerates empty claims and empty current values', () => {
    expect(buildProposalRows([], {})).toEqual([]);
    expect(buildProposalRows(null, null)).toEqual([]);
  });

  it('carries through confidence + quote + verification flag', () => {
    const rows = buildProposalRows(claims, {});
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].quote).toBe('her name is Mary Johnson');
    expect(rows[0].quoteVerified).toBe(true);
  });
});


describe('defaultSelectedIds', () => {
  it('pre-selects high-confidence, verified, changed rows', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: true,  confidence: 'high' },
      { id: 'b', isUnchanged: false, quoteVerified: true,  confidence: 'medium' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(true);
    expect(sel.has('b')).toBe(true);
  });

  it('skips unchanged rows', () => {
    const rows = [
      { id: 'a', isUnchanged: true,  quoteVerified: true, confidence: 'high' },
      { id: 'b', isUnchanged: false, quoteVerified: true, confidence: 'high' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
    expect(sel.has('b')).toBe(true);
  });

  it('skips unverified-quote rows (likely hallucinations)', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: false, confidence: 'high' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
  });

  it('skips low-confidence rows (force opt-in)', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: true, confidence: 'low' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
  });
});
