import { describe, it, expect } from 'vitest';
import {
  migrateLegacyBathingMethod,
  migrateSectionData,
} from '../../features/care-plans/carePlanMigrations';

// Care plan editor-time data migrations.
// These run on load and never write back unless the user edits.

describe('migrateLegacyBathingMethod', () => {
  it('converts an array of method strings into {method, level} rows', () => {
    const input = {
      bathing_method: ['Shower', 'Bed bath'],
      bathing_assistLevel: 'Partial assist',
    };
    const out = migrateLegacyBathingMethod(input);
    expect(out.bathing_method).toEqual([
      { method: 'Shower', level: 'Partial assist' },
      { method: 'Bed bath', level: 'Partial assist' },
    ]);
  });

  it('uses null for the seed level when no legacy bathing_assistLevel exists', () => {
    const out = migrateLegacyBathingMethod({ bathing_method: ['Shower'] });
    expect(out.bathing_method).toEqual([{ method: 'Shower', level: null }]);
  });

  it('leaves already-migrated data untouched (identity by reference)', () => {
    const input = {
      bathing_method: [{ method: 'Shower', level: 'Partial assist' }],
    };
    const out = migrateLegacyBathingMethod(input);
    expect(out).toBe(input);
  });

  it('preserves other fields in the section data', () => {
    const input = {
      bathing_method: ['Shower'],
      bathing_assistLevel: 'Full assist',
      bathing_frequency: 'Daily',
      bathing_notes: 'Prefers mornings',
    };
    const out = migrateLegacyBathingMethod(input);
    expect(out.bathing_frequency).toBe('Daily');
    expect(out.bathing_notes).toBe('Prefers mornings');
    expect(out.bathing_assistLevel).toBe('Full assist');
  });

  it('handles missing or empty bathing_method gracefully', () => {
    expect(migrateLegacyBathingMethod({})).toEqual({});
    expect(migrateLegacyBathingMethod({ bathing_method: [] })).toEqual({ bathing_method: [] });
    expect(migrateLegacyBathingMethod({ bathing_method: null })).toEqual({ bathing_method: null });
  });

  it('returns input unchanged when not an object', () => {
    expect(migrateLegacyBathingMethod(null)).toBeNull();
    expect(migrateLegacyBathingMethod(undefined)).toBeUndefined();
  });

  it('handles mixed shapes (string + object) by passing objects through and wrapping strings', () => {
    const input = {
      bathing_method: ['Shower', { method: 'Bed bath', level: 'Full assist' }],
      bathing_assistLevel: 'Partial assist',
    };
    const out = migrateLegacyBathingMethod(input);
    expect(out.bathing_method).toEqual([
      { method: 'Shower', level: 'Partial assist' },
      { method: 'Bed bath', level: 'Full assist' },
    ]);
  });
});

describe('migrateSectionData dispatcher', () => {
  it('applies bathing migration to dailyLiving sections', () => {
    const out = migrateSectionData('dailyLiving', {
      bathing_method: ['Shower'],
      bathing_assistLevel: 'Setup only',
    });
    expect(out.bathing_method).toEqual([
      { method: 'Shower', level: 'Setup only' },
    ]);
  });

  it('passes through section data for sections with no migrations', () => {
    const data = { fullName: 'Jane Doe', dob: '1944-03-12' };
    expect(migrateSectionData('whoTheyAre', data)).toEqual(data);
  });

  it('returns empty object for null / undefined input', () => {
    expect(migrateSectionData('dailyLiving', null)).toEqual({});
    expect(migrateSectionData('dailyLiving', undefined)).toEqual({});
  });

  it('handles unknown sectionId gracefully', () => {
    const data = { x: 1 };
    expect(migrateSectionData('nope', data)).toEqual(data);
  });
});
