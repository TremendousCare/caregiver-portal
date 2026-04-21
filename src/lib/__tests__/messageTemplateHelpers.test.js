import { describe, it, expect } from 'vitest';
import {
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_CATEGORY_LABELS,
  isValidCategory,
  buildCaregiverMergeFields,
  renderCaregiverTemplate,
  validateTemplateDraft,
  groupTemplatesByCategory,
  searchTemplates,
  CAREGIVER_TEMPLATE_PLACEHOLDERS,
} from '../../features/caregivers/caregiver/messageTemplateHelpers';

// ─── Category constants ─────────────────────────────────────────

describe('MESSAGE_TEMPLATE_CATEGORIES', () => {
  it('contains exactly the three approved categories in canonical order', () => {
    expect(MESSAGE_TEMPLATE_CATEGORIES).toEqual(['onboarding', 'scheduling', 'general']);
  });

  it('has a display label for every category', () => {
    for (const cat of MESSAGE_TEMPLATE_CATEGORIES) {
      expect(MESSAGE_TEMPLATE_CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });
});

describe('isValidCategory', () => {
  it('accepts approved categories', () => {
    expect(isValidCategory('onboarding')).toBe(true);
    expect(isValidCategory('scheduling')).toBe(true);
    expect(isValidCategory('general')).toBe(true);
  });

  it('rejects unknown categories', () => {
    expect(isValidCategory('random')).toBe(false);
    expect(isValidCategory('')).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory(undefined)).toBe(false);
  });

  it('is case-sensitive — stored values are always lowercase', () => {
    expect(isValidCategory('Onboarding')).toBe(false);
    expect(isValidCategory('GENERAL')).toBe(false);
  });
});

// ─── Merge fields ───────────────────────────────────────────────

describe('buildCaregiverMergeFields', () => {
  it('pulls firstName, lastName, and a trimmed fullName from the caregiver', () => {
    const fields = buildCaregiverMergeFields({ firstName: 'Maria', lastName: 'Garcia' });
    expect(fields).toEqual({ firstName: 'Maria', lastName: 'Garcia', fullName: 'Maria Garcia' });
  });

  it('returns empty strings when caregiver is missing fields', () => {
    expect(buildCaregiverMergeFields({})).toEqual({ firstName: '', lastName: '', fullName: '' });
  });

  it('trims fullName when only one name is present', () => {
    expect(buildCaregiverMergeFields({ firstName: 'Cher' }).fullName).toBe('Cher');
    expect(buildCaregiverMergeFields({ lastName: 'Morrison' }).fullName).toBe('Morrison');
  });

  it('tolerates null/undefined caregiver', () => {
    expect(buildCaregiverMergeFields(null)).toEqual({ firstName: '', lastName: '', fullName: '' });
    expect(buildCaregiverMergeFields(undefined)).toEqual({ firstName: '', lastName: '', fullName: '' });
  });
});

// ─── Rendering ──────────────────────────────────────────────────

describe('renderCaregiverTemplate', () => {
  const caregiver = { firstName: 'Maria', lastName: 'Garcia' };

  it('substitutes known placeholders', () => {
    expect(renderCaregiverTemplate('Hi {{firstName}}!', caregiver)).toBe('Hi Maria!');
    expect(renderCaregiverTemplate('{{fullName}} — welcome.', caregiver)).toBe('Maria Garcia — welcome.');
  });

  it('handles multiple placeholders in one string', () => {
    expect(
      renderCaregiverTemplate('Hello {{firstName}} {{lastName}}, thanks!', caregiver),
    ).toBe('Hello Maria Garcia, thanks!');
  });

  it('strips unknown placeholders (never leaks literal {{foo}} to customers)', () => {
    expect(renderCaregiverTemplate('Hi {{firstName}} {{unknownField}}!', caregiver)).toBe('Hi Maria !');
  });

  it('returns empty string for null/undefined template', () => {
    expect(renderCaregiverTemplate(null, caregiver)).toBe('');
    expect(renderCaregiverTemplate(undefined, caregiver)).toBe('');
  });

  it('tolerates whitespace inside placeholder braces', () => {
    expect(renderCaregiverTemplate('Hi {{ firstName }}!', caregiver)).toBe('Hi Maria!');
  });

  it('renders placeholders as empty string when caregiver has no name', () => {
    expect(renderCaregiverTemplate('Hi {{firstName}}, welcome!', {})).toBe('Hi , welcome!');
  });

  it('leaves non-placeholder text untouched', () => {
    expect(renderCaregiverTemplate('No placeholders here.', caregiver)).toBe('No placeholders here.');
  });
});

// ─── Validation ─────────────────────────────────────────────────

describe('validateTemplateDraft', () => {
  const valid = { name: 'Welcome', category: 'onboarding', body: 'Hi {{firstName}}!' };

  it('returns null for a valid draft', () => {
    expect(validateTemplateDraft(valid)).toBeNull();
  });

  it('rejects missing draft entirely', () => {
    expect(validateTemplateDraft(null)).toBe('Missing template data.');
    expect(validateTemplateDraft(undefined)).toBe('Missing template data.');
  });

  it('rejects blank name', () => {
    expect(validateTemplateDraft({ ...valid, name: '' })).toBe('Name is required.');
    expect(validateTemplateDraft({ ...valid, name: '   ' })).toBe('Name is required.');
  });

  it('rejects names over 80 chars', () => {
    const longName = 'x'.repeat(81);
    expect(validateTemplateDraft({ ...valid, name: longName })).toMatch(/80 characters/);
  });

  it('accepts names at the 80-char boundary', () => {
    const boundary = 'x'.repeat(80);
    expect(validateTemplateDraft({ ...valid, name: boundary })).toBeNull();
  });

  it('rejects unknown categories', () => {
    expect(validateTemplateDraft({ ...valid, category: 'urgent' })).toBe('Pick a category.');
    expect(validateTemplateDraft({ ...valid, category: '' })).toBe('Pick a category.');
  });

  it('rejects blank body', () => {
    expect(validateTemplateDraft({ ...valid, body: '' })).toBe('Message body cannot be empty.');
    expect(validateTemplateDraft({ ...valid, body: '   ' })).toBe('Message body cannot be empty.');
  });

  it('rejects body over 1600 chars', () => {
    const longBody = 'x'.repeat(1601);
    expect(validateTemplateDraft({ ...valid, body: longBody })).toMatch(/1600 characters/);
  });

  it('accepts body at the 1600-char boundary', () => {
    const boundary = 'x'.repeat(1600);
    expect(validateTemplateDraft({ ...valid, body: boundary })).toBeNull();
  });
});

// ─── Grouping ───────────────────────────────────────────────────

describe('groupTemplatesByCategory', () => {
  const templates = [
    { id: 'a', name: 'Welcome', category: 'onboarding', body: 'x' },
    { id: 'b', name: 'Shift Check-In', category: 'scheduling', body: 'x' },
    { id: 'c', name: 'Onboarding Reminder', category: 'onboarding', body: 'x' },
    { id: 'd', name: 'Follow-Up', category: 'general', body: 'x' },
  ];

  it('groups templates by category in canonical order', () => {
    const grouped = groupTemplatesByCategory(templates);
    expect(grouped.map((g) => g.category)).toEqual(['onboarding', 'scheduling', 'general']);
    expect(grouped[0].templates.map((t) => t.id)).toEqual(['a', 'c']);
    expect(grouped[1].templates.map((t) => t.id)).toEqual(['b']);
    expect(grouped[2].templates.map((t) => t.id)).toEqual(['d']);
  });

  it('attaches the display label to each group', () => {
    const grouped = groupTemplatesByCategory(templates);
    expect(grouped[0].label).toBe('Onboarding');
    expect(grouped[1].label).toBe('Scheduling');
    expect(grouped[2].label).toBe('General');
  });

  it('omits categories with no templates', () => {
    const grouped = groupTemplatesByCategory([{ id: 'a', name: 'x', category: 'general', body: 'y' }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].category).toBe('general');
  });

  it('handles empty/null input gracefully', () => {
    expect(groupTemplatesByCategory([])).toEqual([]);
    expect(groupTemplatesByCategory(null)).toEqual([]);
    expect(groupTemplatesByCategory(undefined)).toEqual([]);
  });
});

// ─── Search ─────────────────────────────────────────────────────

describe('searchTemplates', () => {
  const templates = [
    { id: 'a', name: 'Welcome Aboard', category: 'onboarding', body: 'Hi {{firstName}}!' },
    { id: 'b', name: 'Shift Reminder', category: 'scheduling', body: 'Your shift is tomorrow.' },
    { id: 'c', name: 'Follow-Up', category: 'general', body: 'Just checking in.' },
  ];

  it('returns all templates when query is empty', () => {
    expect(searchTemplates(templates, '')).toHaveLength(3);
    expect(searchTemplates(templates, '   ')).toHaveLength(3);
  });

  it('matches on name (case-insensitive)', () => {
    const result = searchTemplates(templates, 'WELCOME');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('matches on body text', () => {
    const result = searchTemplates(templates, 'tomorrow');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('returns empty array when nothing matches', () => {
    expect(searchTemplates(templates, 'xyznomatch')).toEqual([]);
  });

  it('handles empty/null template list', () => {
    expect(searchTemplates([], 'anything')).toEqual([]);
    expect(searchTemplates(null, 'anything')).toEqual([]);
  });
});

// ─── Placeholder chips ──────────────────────────────────────────

describe('CAREGIVER_TEMPLATE_PLACEHOLDERS', () => {
  it('exposes the three supported placeholders with labels', () => {
    expect(CAREGIVER_TEMPLATE_PLACEHOLDERS.map((p) => p.key)).toEqual([
      'firstName',
      'lastName',
      'fullName',
    ]);
    for (const p of CAREGIVER_TEMPLATE_PLACEHOLDERS) {
      expect(p.label).toBeTruthy();
    }
  });
});
