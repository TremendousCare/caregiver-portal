import { describe, it, expect, vi } from 'vitest';

// Mock supabase
vi.mock('../../lib/supabase', () => ({
  supabase: {},
  isSupabaseConfigured: () => false,
}));

// Mock storage (needed by utils.js transitive import)
vi.mock('../../features/clients/storage', () => ({
  getClientPhaseTasks: () => ({}),
}));

import {
  resolveClientMergeFields,
  normalizeSequenceAction,
  shouldAutoEnroll,
  buildEnrollmentRecord,
} from '../../features/clients/sequenceHelpers';

// ─── resolveClientMergeFields ───

describe('resolveClientMergeFields', () => {
  const client = {
    firstName: 'Maria',
    lastName: 'Garcia',
    phone: '555-1234',
    email: 'maria@test.com',
  };

  it('replaces all merge fields', () => {
    const template = 'Hi {{first_name}} {{last_name}}, call us at {{phone}} or email {{email}}';
    const result = resolveClientMergeFields(template, client);
    expect(result).toBe('Hi Maria Garcia, call us at 555-1234 or email maria@test.com');
  });

  it('handles missing fields gracefully', () => {
    const result = resolveClientMergeFields('Hi {{first_name}}', { firstName: '' });
    expect(result).toBe('Hi ');
  });

  it('returns template unchanged if no merge fields', () => {
    const result = resolveClientMergeFields('Hello there!', client);
    expect(result).toBe('Hello there!');
  });
});

// ─── normalizeSequenceAction ───

describe('normalizeSequenceAction', () => {
  it('normalizes sms variants', () => {
    expect(normalizeSequenceAction('sms')).toBe('send_sms');
    expect(normalizeSequenceAction('send_sms')).toBe('send_sms');
  });

  it('normalizes email variants', () => {
    expect(normalizeSequenceAction('email')).toBe('send_email');
    expect(normalizeSequenceAction('send_email')).toBe('send_email');
  });

  it('normalizes task variants', () => {
    expect(normalizeSequenceAction('task')).toBe('create_task');
    expect(normalizeSequenceAction('create_task')).toBe('create_task');
  });

  it('passes through unknown types', () => {
    expect(normalizeSequenceAction('unknown')).toBe('unknown');
  });
});

// ─── shouldAutoEnroll ───

describe('shouldAutoEnroll', () => {
  it('returns true when no active enrollment exists', () => {
    expect(shouldAutoEnroll([])).toBe(true);
  });

  it('returns false when active enrollment exists', () => {
    const existing = [{ id: 1, status: 'active' }];
    expect(shouldAutoEnroll(existing)).toBe(false);
  });

  it('returns true when only cancelled/completed enrollments exist', () => {
    const existing = [
      { id: 1, status: 'cancelled' },
      { id: 2, status: 'completed' },
    ];
    expect(shouldAutoEnroll(existing)).toBe(true);
  });
});

// ─── buildEnrollmentRecord ───

describe('buildEnrollmentRecord', () => {
  it('creates a record with correct defaults', () => {
    const record = buildEnrollmentRecord('client-1', 'seq-1', 'admin@test.com');
    expect(record.client_id).toBe('client-1');
    expect(record.sequence_id).toBe('seq-1');
    expect(record.status).toBe('active');
    expect(record.current_step).toBe(0);
    expect(record.started_by).toBe('admin@test.com');
    expect(record.start_from_step).toBe(0);
  });

  it('respects startFromStep parameter', () => {
    const record = buildEnrollmentRecord('client-1', 'seq-1', 'admin@test.com', 3);
    expect(record.current_step).toBe(3);
    expect(record.start_from_step).toBe(3);
  });
});
