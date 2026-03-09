/**
 * Tests for AI Chat Edge Function pure helper functions.
 *
 * These test the logic in supabase/functions/ai-chat/helpers/ — pure functions
 * with no Deno runtime dependency (constants extracted to constants.ts).
 */
import { describe, it, expect } from 'vitest';

// Import pure helpers directly from the Edge Function source
import { normalizePhoneNumber } from '../../../supabase/functions/ai-chat/helpers/phone.ts';
import {
  detectPhase,
  getPhase,
  getPhaseLabel,
  getLastActivity,
  buildCaregiverSummary,
  resolveCaregiver,
} from '../../../supabase/functions/ai-chat/helpers/caregiver.ts';

// ── normalizePhoneNumber ──

describe('normalizePhoneNumber', () => {
  it('normalizes a 10-digit number', () => {
    expect(normalizePhoneNumber('5551234567')).toBe('+15551234567');
  });

  it('normalizes a formatted 10-digit number', () => {
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('normalizes an 11-digit number starting with 1', () => {
    expect(normalizePhoneNumber('15551234567')).toBe('+15551234567');
  });

  it('normalizes a number with dots', () => {
    expect(normalizePhoneNumber('555.123.4567')).toBe('+15551234567');
  });

  it('normalizes a number with dashes and country code', () => {
    expect(normalizePhoneNumber('1-555-123-4567')).toBe('+15551234567');
  });

  it('returns null for too-short numbers', () => {
    expect(normalizePhoneNumber('55512')).toBeNull();
  });

  it('returns null for too-long numbers', () => {
    expect(normalizePhoneNumber('155512345678')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizePhoneNumber('')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(normalizePhoneNumber(null)).toBeNull();
    expect(normalizePhoneNumber(undefined)).toBeNull();
  });
});

// ── detectPhase ──

describe('detectPhase', () => {
  it('returns intake for no timestamps', () => {
    expect(detectPhase({})).toBe('intake');
    expect(detectPhase({ phase_timestamps: {} })).toBe('intake');
  });

  it('returns the latest phase with a timestamp', () => {
    expect(detectPhase({
      phase_timestamps: { intake: 1000, interview: 2000 },
    })).toBe('interview');
  });

  it('detects phases in order regardless of timestamp values', () => {
    // Even though intake has a higher timestamp, onboarding is later in the pipeline
    expect(detectPhase({
      phase_timestamps: { intake: 9999, interview: 1, onboarding: 1 },
    })).toBe('onboarding');
  });

  it('detects the final phase', () => {
    expect(detectPhase({
      phase_timestamps: {
        intake: 1, interview: 2, onboarding: 3, verification: 4, orientation: 5,
      },
    })).toBe('orientation');
  });
});

// ── getPhase ──

describe('getPhase', () => {
  it('uses phase_override when present', () => {
    expect(getPhase({
      phase_override: 'verification',
      phase_timestamps: { intake: 1 },
    })).toBe('verification');
  });

  it('falls back to detectPhase when no override', () => {
    expect(getPhase({
      phase_timestamps: { intake: 1, interview: 2 },
    })).toBe('interview');
  });
});

// ── getPhaseLabel ──

describe('getPhaseLabel', () => {
  it('returns human-readable label for known phases', () => {
    expect(getPhaseLabel('intake')).toBe('Intake & Screen');
    expect(getPhaseLabel('orientation')).toBe('Orientation');
  });

  it('returns the raw ID for unknown phases', () => {
    expect(getPhaseLabel('unknown_phase')).toBe('unknown_phase');
  });
});

// ── getLastActivity ──

describe('getLastActivity', () => {
  it('returns created_at when no notes or tasks', () => {
    expect(getLastActivity({ created_at: 1000 })).toBe(1000);
  });

  it('returns 0 when no data at all', () => {
    expect(getLastActivity({})).toBe(0);
  });

  it('finds latest note timestamp', () => {
    expect(getLastActivity({
      created_at: 1000,
      notes: [
        { timestamp: 2000, text: 'a' },
        { timestamp: 5000, text: 'b' },
        { timestamp: 3000, text: 'c' },
      ],
    })).toBe(5000);
  });

  it('finds latest task completedAt', () => {
    expect(getLastActivity({
      created_at: 1000,
      tasks: {
        task1: { completed: true, completedAt: 8000 },
        task2: { completed: true, completedAt: 3000 },
      },
    })).toBe(8000);
  });

  it('returns the overall latest across notes and tasks', () => {
    expect(getLastActivity({
      created_at: 1000,
      notes: [{ timestamp: 5000, text: 'a' }],
      tasks: { task1: { completed: true, completedAt: 3000 } },
    })).toBe(5000);
  });

  it('handles string notes (legacy format)', () => {
    expect(getLastActivity({
      created_at: 1000,
      notes: ['some old string note'],
    })).toBe(1000);
  });
});

// ── buildCaregiverSummary ──

describe('buildCaregiverSummary', () => {
  it('builds a summary string with key fields', () => {
    const cg = {
      first_name: 'Sarah',
      last_name: 'Johnson',
      phone: '555-1234',
      city: 'Seattle',
      phase_timestamps: { intake: 1, interview: 2 },
      tasks: {
        task1: { completed: true },
        task2: { completed: false },
        task3: true,
      },
    };
    const summary = buildCaregiverSummary(cg);
    expect(summary).toContain('Sarah Johnson');
    expect(summary).toContain('Interview & Offer');
    expect(summary).toContain('2/3');
    expect(summary).toContain('555-1234');
    expect(summary).toContain('Seattle');
  });

  it('shows [ARCHIVED] for archived caregivers', () => {
    const cg = {
      first_name: 'Jane',
      last_name: 'Doe',
      archived: true,
      tasks: {},
    };
    expect(buildCaregiverSummary(cg)).toContain('[ARCHIVED]');
  });

  it('shows N/A for missing fields', () => {
    const cg = { first_name: 'A', last_name: 'B', tasks: {} };
    const summary = buildCaregiverSummary(cg);
    expect(summary).toContain('Phone: N/A');
    expect(summary).toContain('City: N/A');
  });
});

// ── resolveCaregiver ──

describe('resolveCaregiver', () => {
  const caregivers = [
    { id: 'cg1', first_name: 'Sarah', last_name: 'Johnson', phone: '555-1111', email: 'sarah@test.com' },
    { id: 'cg2', first_name: 'Mike', last_name: 'Smith', phone: '555-2222', email: 'mike@test.com' },
    { id: 'cg3', first_name: 'Sarah', last_name: 'Williams', phone: '555-3333', email: 'sw@test.com' },
  ];
  const mockSupabase = {}; // Not used for in-memory resolution

  it('resolves by exact ID', async () => {
    const result = await resolveCaregiver(mockSupabase, { caregiver_id: 'cg2' }, caregivers);
    expect(result).not.toBeNull();
    expect(result.first_name).toBe('Mike');
  });

  it('returns null for unknown ID', async () => {
    const result = await resolveCaregiver(mockSupabase, { caregiver_id: 'unknown' }, caregivers);
    expect(result).toBeNull();
  });

  it('resolves by unique name match', async () => {
    const result = await resolveCaregiver(mockSupabase, { name: 'Mike' }, caregivers);
    expect(result).not.toBeNull();
    expect(result.id).toBe('cg2');
  });

  it('resolves by full name', async () => {
    const result = await resolveCaregiver(mockSupabase, { name: 'Sarah Johnson' }, caregivers);
    expect(result).not.toBeNull();
    expect(result.id).toBe('cg1');
  });

  it('returns ambiguous result for non-unique name', async () => {
    const result = await resolveCaregiver(mockSupabase, { name: 'Sarah' }, caregivers);
    expect(result._ambiguous).toBe(true);
    expect(result.matches).toHaveLength(2);
  });

  it('returns null when no name or ID provided', async () => {
    const result = await resolveCaregiver(mockSupabase, {}, caregivers);
    expect(result).toBeNull();
  });

  it('matches case-insensitively', async () => {
    const result = await resolveCaregiver(mockSupabase, { name: 'MIKE' }, caregivers);
    expect(result).not.toBeNull();
    expect(result.id).toBe('cg2');
  });

  it('matches partial last name', async () => {
    const result = await resolveCaregiver(mockSupabase, { name: 'Smith' }, caregivers);
    expect(result).not.toBeNull();
    expect(result.id).toBe('cg2');
  });
});
