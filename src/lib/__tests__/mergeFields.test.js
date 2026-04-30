/**
 * Tests for the SMS merge-field resolver. Pure function — Vitest can run it
 * directly even though it lives under `supabase/functions/_shared`.
 */

import { describe, it, expect } from 'vitest';
import { resolveMergeFields } from '../../../supabase/functions/_shared/helpers/mergeFields.ts';

describe('resolveMergeFields', () => {
  it('substitutes caregiver merge fields', () => {
    const out = resolveMergeFields(
      'Hi {{first_name}} {{last_name}}, your number is {{phone}}.',
      {
        first_name: 'Sam',
        last_name: 'Reed',
        phone: '+15555550123',
        email: 'sam@example.com',
      },
    );
    expect(out).toBe('Hi Sam Reed, your number is +15555550123.');
  });

  it('substitutes client merge fields the same way', () => {
    const out = resolveMergeFields(
      'Hi {{first_name}}, please reply to {{email}}.',
      {
        first_name: 'Pat',
        last_name: 'Garcia',
        phone: '5550000',
        email: 'pat@example.com',
      },
    );
    expect(out).toBe('Hi Pat, please reply to pat@example.com.');
  });

  it('renders {{phase}} from caregiver phase_override', () => {
    const out = resolveMergeFields(
      '{{first_name}} is currently in {{phase}}.',
      { first_name: 'Sam', last_name: '', phase_override: 'onboarding' },
    );
    expect(out).toBe('Sam is currently in onboarding.');
  });

  it('renders {{phase}} from client phase column', () => {
    const out = resolveMergeFields(
      '{{first_name}} is currently in {{phase}}.',
      { first_name: 'Pat', last_name: '', phase: 'won' },
    );
    expect(out).toBe('Pat is currently in won.');
  });

  it('prefers caregiver phase_override over a phase field if both are present', () => {
    // Defensive: a future generic entity that exposes both should resolve
    // to phase_override so caregiver behavior stays byte-identical.
    const out = resolveMergeFields('{{phase}}', {
      phase_override: 'active',
      phase: 'won',
    });
    expect(out).toBe('active');
  });

  it('renders empty strings for missing fields', () => {
    const out = resolveMergeFields(
      'Hi {{first_name}} {{last_name}} ({{email}})',
      { first_name: 'Sam' },
    );
    expect(out).toBe('Hi Sam  ()');
  });

  it('is case-insensitive for placeholder names', () => {
    const out = resolveMergeFields('Hi {{First_Name}} {{LAST_NAME}}', {
      first_name: 'Sam',
      last_name: 'Reed',
    });
    expect(out).toBe('Hi Sam Reed');
  });

  it('replaces all occurrences of a placeholder', () => {
    const out = resolveMergeFields('{{first_name}} {{first_name}}', {
      first_name: 'Sam',
    });
    expect(out).toBe('Sam Sam');
  });

  it('leaves unknown placeholders untouched', () => {
    const out = resolveMergeFields('Hi {{first_name}} {{unknown_field}}', {
      first_name: 'Sam',
    });
    expect(out).toBe('Hi Sam {{unknown_field}}');
  });

  it('treats null fields as empty', () => {
    const out = resolveMergeFields('{{first_name}}{{phone}}', {
      first_name: null,
      phone: null,
    });
    expect(out).toBe('');
  });
});
