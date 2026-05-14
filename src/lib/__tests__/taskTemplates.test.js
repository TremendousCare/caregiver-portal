import { describe, it, expect } from 'vitest';
import {
  ALL_TEMPLATES_BY_CATEGORY,
  getTemplatesForCategory,
  templateToFormState,
} from '../../features/care-plans/taskTemplates';
import { TASK_CATEGORIES } from '../../features/care-plans/sections';

// ─── Catalog shape ────────────────────────────────────────────────

describe('ALL_TEMPLATES_BY_CATEGORY catalog', () => {
  it('covers every ADL category', () => {
    const adlCategories = Object.keys(TASK_CATEGORIES).filter((k) =>
      k.startsWith('adl.'),
    );
    for (const key of adlCategories) {
      expect(
        ALL_TEMPLATES_BY_CATEGORY[key],
        `missing templates for ${key}`,
      ).toBeDefined();
      expect(ALL_TEMPLATES_BY_CATEGORY[key].length).toBeGreaterThanOrEqual(4);
    }
  });

  it('covers every IADL category', () => {
    const iadlCategories = Object.keys(TASK_CATEGORIES).filter((k) =>
      k.startsWith('iadl.'),
    );
    for (const key of iadlCategories) {
      expect(
        ALL_TEMPLATES_BY_CATEGORY[key],
        `missing templates for ${key}`,
      ).toBeDefined();
      expect(ALL_TEMPLATES_BY_CATEGORY[key].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every category key in the catalog maps to a real TASK_CATEGORIES entry', () => {
    for (const key of Object.keys(ALL_TEMPLATES_BY_CATEGORY)) {
      expect(TASK_CATEGORIES[key], `unknown category ${key}`).toBeDefined();
    }
  });

  it('keeps each category under twelve templates (signal-to-noise discipline)', () => {
    for (const [key, list] of Object.entries(ALL_TEMPLATES_BY_CATEGORY)) {
      expect(list.length, `${key} has ${list.length} templates`).toBeLessThanOrEqual(12);
    }
  });

  it('every template has a non-empty name and no duplicate names within a category', () => {
    for (const [key, list] of Object.entries(ALL_TEMPLATES_BY_CATEGORY)) {
      const names = list.map((t) => t.name);
      for (const n of names) {
        expect(typeof n).toBe('string');
        expect(n.trim()).toBe(n);
        expect(n.length).toBeGreaterThan(0);
      }
      expect(new Set(names).size, `duplicate template names in ${key}`).toBe(names.length);
    }
  });

  it('optional template fields, when present, use the right shape', () => {
    const validPriorities = new Set(['standard', 'critical', 'optional']);
    const validShifts = new Set(['all', 'morning', 'afternoon', 'evening', 'overnight']);
    for (const list of Object.values(ALL_TEMPLATES_BY_CATEGORY)) {
      for (const t of list) {
        if (t.description !== undefined) expect(typeof t.description).toBe('string');
        if (t.safetyNotes !== undefined) expect(typeof t.safetyNotes).toBe('string');
        if (t.priority !== undefined) {
          expect(validPriorities.has(t.priority), `bad priority on "${t.name}"`).toBe(true);
        }
        if (t.shifts !== undefined) {
          expect(Array.isArray(t.shifts)).toBe(true);
          for (const sh of t.shifts) {
            expect(validShifts.has(sh), `bad shift "${sh}" on "${t.name}"`).toBe(true);
          }
        }
      }
    }
  });

  it('mobility / PT / OT / speech templates exist under adl.ambulation', () => {
    const lc = ALL_TEMPLATES_BY_CATEGORY['adl.ambulation'].map((t) => t.name.toLowerCase());
    expect(lc.some((n) => n.includes('walk'))).toBe(true);
    expect(lc.some((n) => n.includes('pt'))).toBe(true);
    expect(lc.some((n) => n.includes('ot'))).toBe(true);
    expect(lc.some((n) => n.includes('speech'))).toBe(true);
  });
});

// ─── Lookup helpers ───────────────────────────────────────────────

describe('getTemplatesForCategory', () => {
  it('returns the templates for a known category', () => {
    const got = getTemplatesForCategory('adl.bathing');
    expect(Array.isArray(got)).toBe(true);
    expect(got.length).toBeGreaterThan(0);
  });

  it('returns an empty array for an unknown category', () => {
    expect(getTemplatesForCategory('adl.unknown_category')).toEqual([]);
  });

  it('returns an empty array for nullish input', () => {
    expect(getTemplatesForCategory(null)).toEqual([]);
    expect(getTemplatesForCategory(undefined)).toEqual([]);
    expect(getTemplatesForCategory('')).toEqual([]);
  });
});

describe('templateToFormState', () => {
  it('fills required defaults when the template omits optional fields', () => {
    const got = templateToFormState('adl.bathing', { name: 'Foo' });
    expect(got).toEqual({
      category: 'adl.bathing',
      taskName: 'Foo',
      description: '',
      shifts: ['all'],
      priority: 'standard',
      safetyNotes: '',
      daysOfWeek: [],
    });
  });

  it('passes through description, shifts, priority, safetyNotes', () => {
    const got = templateToFormState('adl.feeding', {
      name: 'Aspiration precautions',
      description: 'Sit upright during meals.',
      shifts: ['morning', 'afternoon', 'evening'],
      priority: 'critical',
      safetyNotes: 'Call 911 on choking.',
    });
    expect(got.taskName).toBe('Aspiration precautions');
    expect(got.description).toBe('Sit upright during meals.');
    expect(got.shifts).toEqual(['morning', 'afternoon', 'evening']);
    expect(got.priority).toBe('critical');
    expect(got.safetyNotes).toBe('Call 911 on choking.');
  });

  it('copies the shifts array so callers cannot mutate the catalog by reference', () => {
    const tpl = { name: 'X', shifts: ['morning'] };
    const got = templateToFormState('adl.bathing', tpl);
    got.shifts.push('overnight');
    expect(tpl.shifts).toEqual(['morning']);
  });

  it('falls back to [all] when the template provides an empty shifts array', () => {
    const got = templateToFormState('adl.bathing', { name: 'X', shifts: [] });
    expect(got.shifts).toEqual(['all']);
  });
});
