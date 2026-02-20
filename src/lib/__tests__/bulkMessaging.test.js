import { describe, it, expect } from 'vitest';
import {
  resolveCaregiverMergeFields,
  resolveClientMergeFields,
  normalizePhone,
} from '../mergeFields';

// ─── resolveCaregiverMergeFields ─────────────────────────────

describe('resolveCaregiverMergeFields', () => {
  const caregiver = {
    firstName: 'Jane',
    lastName: 'Doe',
    phone: '(604) 555-1234',
    email: 'jane@example.com',
    phaseOverride: 'documents',
  };

  it('replaces {{first_name}}', () => {
    expect(resolveCaregiverMergeFields('Hi {{first_name}}!', caregiver)).toBe('Hi Jane!');
  });

  it('replaces {{last_name}}', () => {
    expect(resolveCaregiverMergeFields('Dear {{last_name}}', caregiver)).toBe('Dear Doe');
  });

  it('replaces all fields in a full template', () => {
    const template = 'Hi {{first_name}} {{last_name}}, call {{phone}} or email {{email}}. Phase: {{phase}}.';
    const expected = 'Hi Jane Doe, call (604) 555-1234 or email jane@example.com. Phase: documents.';
    expect(resolveCaregiverMergeFields(template, caregiver)).toBe(expected);
  });

  it('is case-insensitive for field names', () => {
    expect(resolveCaregiverMergeFields('{{FIRST_NAME}} {{First_Name}}', caregiver)).toBe('Jane Jane');
  });

  it('handles missing fields gracefully with empty string', () => {
    const partial = { firstName: 'John' };
    expect(resolveCaregiverMergeFields('{{first_name}} {{last_name}}', partial)).toBe('John ');
  });

  it('leaves unknown merge fields untouched', () => {
    expect(resolveCaregiverMergeFields('{{unknown_field}}', caregiver)).toBe('{{unknown_field}}');
  });

  it('returns empty string for null template', () => {
    expect(resolveCaregiverMergeFields(null, caregiver)).toBe('');
  });

  it('handles null caregiver gracefully', () => {
    expect(resolveCaregiverMergeFields('Hi {{first_name}}', null)).toBe('Hi ');
  });
});

// ─── resolveClientMergeFields ────────────────────────────────

describe('resolveClientMergeFields', () => {
  const client = {
    firstName: 'Robert',
    lastName: 'Smith',
    phone: '310-555-9876',
    email: 'robert@family.com',
    careRecipientName: 'Mary Smith',
    contactName: 'Robert Smith',
    phase: 'consultation',
  };

  it('replaces {{firstName}}', () => {
    expect(resolveClientMergeFields('Dear {{firstName}}', client)).toBe('Dear Robert');
  });

  it('replaces {{careRecipientName}}', () => {
    expect(resolveClientMergeFields('Care for {{careRecipientName}}', client)).toBe('Care for Mary Smith');
  });

  it('replaces multiple fields in one template', () => {
    const template = '{{firstName}} {{lastName}} — {{careRecipientName}}';
    expect(resolveClientMergeFields(template, client)).toBe('Robert Smith — Mary Smith');
  });

  it('handles missing optional fields', () => {
    const partial = { firstName: 'Alice', lastName: 'Wong' };
    expect(resolveClientMergeFields('{{firstName}} — {{careRecipientName}}', partial)).toBe('Alice — ');
  });

  it('is case-insensitive for field names', () => {
    expect(resolveClientMergeFields('{{FIRSTNAME}} {{firstname}}', client)).toBe('Robert Robert');
  });

  it('returns empty string for null template', () => {
    expect(resolveClientMergeFields(null, client)).toBe('');
  });
});

// ─── normalizePhone ──────────────────────────────────────────

describe('normalizePhone', () => {
  it('handles 10-digit number', () => {
    expect(normalizePhone('6045551234')).toBe('+16045551234');
  });

  it('handles 11-digit with leading 1', () => {
    expect(normalizePhone('16045551234')).toBe('+16045551234');
  });

  it('handles number with dashes', () => {
    expect(normalizePhone('604-555-1234')).toBe('+16045551234');
  });

  it('handles number with parentheses and spaces', () => {
    expect(normalizePhone('(604) 555-1234')).toBe('+16045551234');
  });

  it('handles number with dots', () => {
    expect(normalizePhone('604.555.1234')).toBe('+16045551234');
  });

  it('returns null for empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(normalizePhone(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('returns null for invalid short number', () => {
    expect(normalizePhone('12345')).toBeNull();
  });

  it('returns null for 9-digit number', () => {
    expect(normalizePhone('604555123')).toBeNull();
  });

  it('returns null for 12-digit number', () => {
    expect(normalizePhone('116045551234')).toBeNull();
  });
});
