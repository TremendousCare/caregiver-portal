import { describe, it, expect } from 'vitest';
import { getChecklistProgress, getCardChecklistSummary } from '../checklistUtils';

describe('getChecklistProgress', () => {
  it('returns 0/0 for empty items', () => {
    expect(getChecklistProgress({ items: [] })).toEqual({ checked: 0, total: 0, pct: 0 });
  });

  it('returns 0/0 for null checklist', () => {
    expect(getChecklistProgress(null)).toEqual({ checked: 0, total: 0, pct: 0 });
  });

  it('counts checked items correctly', () => {
    const cl = {
      items: [
        { text: 'A', checked: true },
        { text: 'B', checked: false },
        { text: 'C', checked: true },
      ],
    };
    expect(getChecklistProgress(cl)).toEqual({ checked: 2, total: 3, pct: 67 });
  });

  it('returns 100 when all checked', () => {
    const cl = { items: [{ text: 'A', checked: true }, { text: 'B', checked: true }] };
    expect(getChecklistProgress(cl)).toEqual({ checked: 2, total: 2, pct: 100 });
  });

  it('returns 0 when none checked', () => {
    const cl = { items: [{ text: 'A', checked: false }, { text: 'B', checked: false }] };
    expect(getChecklistProgress(cl)).toEqual({ checked: 0, total: 2, pct: 0 });
  });
});

describe('getCardChecklistSummary', () => {
  it('returns null for no checklists', () => {
    expect(getCardChecklistSummary([])).toBeNull();
    expect(getCardChecklistSummary(undefined)).toBeNull();
    expect(getCardChecklistSummary(null)).toBeNull();
  });

  it('returns null for checklists with no items', () => {
    expect(getCardChecklistSummary([{ items: [] }])).toBeNull();
  });

  it('aggregates across multiple checklists', () => {
    const checklists = [
      { items: [{ text: 'A', checked: true }, { text: 'B', checked: false }] },
      { items: [{ text: 'C', checked: true }, { text: 'D', checked: true }] },
    ];
    expect(getCardChecklistSummary(checklists)).toEqual({ checked: 3, total: 4, pct: 75 });
  });

  it('handles single checklist', () => {
    const checklists = [
      { items: [{ text: 'A', checked: true }, { text: 'B', checked: true }, { text: 'C', checked: false }] },
    ];
    expect(getCardChecklistSummary(checklists)).toEqual({ checked: 2, total: 3, pct: 67 });
  });
});
