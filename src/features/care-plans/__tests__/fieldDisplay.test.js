import { describe, it, expect } from 'vitest';
import {
  isEmptyValue,
  formatCarePlanFieldValue,
  sectionHasFieldContent,
} from '../fieldDisplay';
import { FIELD_TYPES, getSectionById } from '../sections';

// These helpers power the read-only ADL/IADL inline view on the client
// profile. They turn the structured field data stored in
// version.data[sectionId] into clean display text, and decide whether a
// section reads as "entered" (so it renders inline) vs empty.

describe('isEmptyValue', () => {
  it('treats null / undefined / blank strings as empty', () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue('')).toBe(true);
    expect(isEmptyValue('   ')).toBe(true);
  });

  it('treats empty arrays and empty objects as empty', () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue({})).toBe(true);
  });

  it('treats false boolean as empty (unchecked = not set) but true as present', () => {
    expect(isEmptyValue(false)).toBe(true);
    expect(isEmptyValue(true)).toBe(false);
  });

  it('keeps real scalar content', () => {
    expect(isEmptyValue('Partial assist')).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(['Walker'])).toBe(false);
  });

  it('inspects YN / PRN objects by their meaningful key', () => {
    expect(isEmptyValue({ answer: 'No' })).toBe(false);
    expect(isEmptyValue({ answer: '' })).toBe(true);
    expect(isEmptyValue({ flag: 'R' })).toBe(false);
    expect(isEmptyValue({ flag: '' })).toBe(true);
  });
});

describe('formatCarePlanFieldValue', () => {
  it('returns empty string for empty values', () => {
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.TEXT }, '')).toBe('');
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.MULTISELECT }, [])).toBe('');
  });

  it('renders plain text and level picks as-is', () => {
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.LEVEL_PICK }, 'Partial assist'))
      .toBe('Partial assist');
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.TEXT }, 'Daily')).toBe('Daily');
  });

  it('joins multiselect arrays with commas', () => {
    expect(formatCarePlanFieldValue(
      { type: FIELD_TYPES.MULTISELECT },
      ['Walker', 'Wheelchair'],
    )).toBe('Walker, Wheelchair');
  });

  it('renders booleans as Yes', () => {
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.BOOLEAN }, true)).toBe('Yes');
  });

  it('renders YN objects with an optional note', () => {
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.YN }, { answer: 'Yes' }))
      .toBe('Yes');
    expect(formatCarePlanFieldValue(
      { type: FIELD_TYPES.YN },
      { answer: 'Yes', note: 'while seated' },
    )).toBe('Yes — while seated');
  });

  it('renders PRN objects with a readable flag label', () => {
    expect(formatCarePlanFieldValue({ type: FIELD_TYPES.PRN }, { flag: 'R' }))
      .toBe('Required');
    expect(formatCarePlanFieldValue(
      { type: FIELD_TYPES.PRN },
      { flag: 'P', option: 'Female' },
    )).toBe('Preferred (Female)');
  });

  it('renders LIST rows using subfield order, one row per line', () => {
    const field = {
      type: FIELD_TYPES.LIST,
      subfields: [
        { id: 'method', type: FIELD_TYPES.SELECT },
        { id: 'level', type: FIELD_TYPES.LEVEL_PICK },
      ],
    };
    const value = [
      { method: 'Shower', level: 'Partial assist' },
      { method: 'Bed bath', level: 'Full assist' },
    ];
    expect(formatCarePlanFieldValue(field, value))
      .toBe('Shower · Partial assist\nBed bath · Full assist');
  });

  it('skips empty subfields within a LIST row', () => {
    const field = {
      type: FIELD_TYPES.LIST,
      subfields: [
        { id: 'method', type: FIELD_TYPES.SELECT },
        { id: 'level', type: FIELD_TYPES.LEVEL_PICK },
      ],
    };
    expect(formatCarePlanFieldValue(field, [{ method: 'Shower', level: '' }]))
      .toBe('Shower');
  });
});

describe('sectionHasFieldContent', () => {
  const dailyLiving = getSectionById('dailyLiving');

  it('returns false for empty / missing data', () => {
    expect(sectionHasFieldContent(dailyLiving, null)).toBe(false);
    expect(sectionHasFieldContent(dailyLiving, {})).toBe(false);
  });

  it('detects a populated grouped field', () => {
    expect(sectionHasFieldContent(dailyLiving, { ambulation_mobilityLevel: 'Partial assist' }))
      .toBe(true);
  });

  it('ignores values for fields not wired into any group', () => {
    // bathing_assistLevel is a legacy field kept in the schema but not
    // surfaced in any group — it must not flip the section to "entered".
    expect(sectionHasFieldContent(dailyLiving, { bathing_assistLevel: 'Full assist' }))
      .toBe(false);
  });

  it('treats an unchecked boolean as no content', () => {
    expect(sectionHasFieldContent(dailyLiving, { bathing_usesShowerBench: false }))
      .toBe(false);
  });
});
