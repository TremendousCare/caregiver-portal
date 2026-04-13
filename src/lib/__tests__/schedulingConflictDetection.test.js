import { describe, it, expect } from 'vitest';
import {
  detectConflicts,
  hasConflict,
  rangesOverlap,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
} from '../scheduling/conflictDetection';

// Helper: build an ISO time from a reference date + hour
const REF_DATE = '2026-05-04'; // arbitrary Monday for all tests
function t(hours, minutes = 0) {
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  return `${REF_DATE}T${h}:${m}:00.000Z`;
}

// Helper: build a shift with sensible defaults
function mkShift(overrides = {}) {
  return {
    id: overrides.id || 'shift-' + Math.random().toString(36).slice(2, 8),
    client_id: overrides.client_id || 'client-A',
    assigned_caregiver_id: 'cg-1',
    start_time: overrides.start_time || t(8),
    end_time: overrides.end_time || t(12),
    status: overrides.status || 'confirmed',
    ...overrides,
  };
}

// ─── rangesOverlap ─────────────────────────────────────────────

describe('rangesOverlap', () => {
  it('returns true for fully overlapping ranges', () => {
    expect(rangesOverlap(10, 20, 12, 18)).toBe(true);
  });

  it('returns true for partially overlapping ranges', () => {
    expect(rangesOverlap(10, 20, 15, 25)).toBe(true);
  });

  it('returns false for disjoint ranges', () => {
    expect(rangesOverlap(10, 20, 30, 40)).toBe(false);
  });

  it('returns false for touching edges (A.end === B.start)', () => {
    // Back-to-back with zero gap should not be considered overlap;
    // same-client touching shifts are legal.
    expect(rangesOverlap(10, 20, 20, 30)).toBe(false);
  });
});

// ─── detectConflicts: basic cases ──────────────────────────────

describe('detectConflicts — basic cases', () => {
  it('returns empty array when no existing shifts', () => {
    const proposed = mkShift();
    expect(detectConflicts(proposed, [])).toEqual([]);
  });

  it('returns empty array when existingShifts is null/undefined', () => {
    expect(detectConflicts(mkShift(), null)).toEqual([]);
    expect(detectConflicts(mkShift(), undefined)).toEqual([]);
  });

  it('returns empty array when proposed is null', () => {
    expect(detectConflicts(null, [mkShift()])).toEqual([]);
  });

  it('finds exact overlap (same time)', () => {
    const existing = mkShift({ id: 'A', client_id: 'client-X' });
    const proposed = mkShift({ client_id: 'client-Y' });
    const conflicts = detectConflicts(proposed, [existing]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('A');
  });

  it('finds partial overlap at end of existing', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(11),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('finds partial overlap at start of existing', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(12),
      end_time: t(16),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(10),
      end_time: t(13),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('finds containment (existing inside proposed)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(10),
      end_time: t(11),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(8),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('finds containment (proposed inside existing)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(14),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(10),
      end_time: t(11),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('returns no conflicts for shifts on different days', () => {
    const existing = mkShift({
      start_time: '2026-05-04T08:00:00.000Z',
      end_time: '2026-05-04T12:00:00.000Z',
    });
    const proposed = mkShift({
      start_time: '2026-05-05T08:00:00.000Z',
      end_time: '2026-05-05T12:00:00.000Z',
    });
    expect(detectConflicts(proposed, [existing])).toEqual([]);
  });
});

// ─── detectConflicts: travel buffer ────────────────────────────

describe('detectConflicts — travel buffer', () => {
  it('allows back-to-back shifts with the SAME client (no buffer needed)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-X',
      start_time: t(12),
      end_time: t(16),
    });
    expect(detectConflicts(proposed, [existing])).toEqual([]);
  });

  it('blocks back-to-back shifts with DIFFERENT clients (30 min default)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12),
      end_time: t(16),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('blocks different-client shifts with 15 min gap (less than 30 min buffer)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12, 15),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('blocks different-client shifts with exactly 29 min gap', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12, 29),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('allows different-client shifts with exactly 30 min gap', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12, 30),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toEqual([]);
  });

  it('allows different-client shifts with 31 min gap', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12, 31),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toEqual([]);
  });

  it('applies travel buffer on the BEFORE side too', () => {
    // proposed shift is before existing shift, gap is 15 min
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(12),
      end_time: t(16),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(10),
      end_time: t(11, 45),
    });
    expect(detectConflicts(proposed, [existing])).toHaveLength(1);
  });

  it('respects custom travelBufferMinutes option (60 min)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    // 45 min gap is fine under 30 min buffer but not under 60 min
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12, 45),
      end_time: t(14),
    });
    expect(detectConflicts(proposed, [existing])).toEqual([]);
    expect(
      detectConflicts(proposed, [existing], { travelBufferMinutes: 60 })
    ).toHaveLength(1);
  });

  it('respects zero travelBufferMinutes (allows all back-to-back)', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(12),
      end_time: t(16),
    });
    expect(
      detectConflicts(proposed, [existing], { travelBufferMinutes: 0 })
    ).toEqual([]);
  });
});

// ─── detectConflicts: status filtering ─────────────────────────

describe('detectConflicts — status filtering', () => {
  const baseExisting = {
    id: 'A',
    client_id: 'client-X',
    start_time: t(8),
    end_time: t(12),
  };
  const baseProposed = {
    client_id: 'client-Y',
    start_time: t(10),
    end_time: t(14),
  };

  it('ignores cancelled shifts', () => {
    const existing = mkShift({ ...baseExisting, status: 'cancelled' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toEqual([]);
  });

  it('ignores completed shifts', () => {
    const existing = mkShift({ ...baseExisting, status: 'completed' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toEqual([]);
  });

  it('ignores no_show shifts', () => {
    const existing = mkShift({ ...baseExisting, status: 'no_show' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toEqual([]);
  });

  it('ignores open shifts (not assigned to anyone)', () => {
    const existing = mkShift({ ...baseExisting, status: 'open' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toEqual([]);
  });

  it('ignores offered shifts', () => {
    const existing = mkShift({ ...baseExisting, status: 'offered' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toEqual([]);
  });

  it('flags assigned shifts as blocking', () => {
    const existing = mkShift({ ...baseExisting, status: 'assigned' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toHaveLength(1);
  });

  it('flags confirmed shifts as blocking', () => {
    const existing = mkShift({ ...baseExisting, status: 'confirmed' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toHaveLength(1);
  });

  it('flags in_progress shifts as blocking', () => {
    const existing = mkShift({ ...baseExisting, status: 'in_progress' });
    expect(detectConflicts(mkShift(baseProposed), [existing])).toHaveLength(1);
  });
});

// ─── detectConflicts: excludeShiftId ───────────────────────────

describe('detectConflicts — excludeShiftId', () => {
  it('ignores the shift being updated when detecting conflicts', () => {
    const existing = mkShift({
      id: 'updating-this',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    // Updating the shift to a new time; should not conflict with itself.
    const proposed = mkShift({
      id: 'updating-this',
      client_id: 'client-X',
      start_time: t(9),
      end_time: t(13),
    });
    expect(
      detectConflicts(proposed, [existing], { excludeShiftId: 'updating-this' })
    ).toEqual([]);
  });

  it('still detects conflicts with OTHER shifts when excludeShiftId is set', () => {
    const shifts = [
      mkShift({
        id: 'updating-this',
        client_id: 'client-X',
        start_time: t(8),
        end_time: t(12),
      }),
      mkShift({
        id: 'other',
        client_id: 'client-Z',
        start_time: t(13),
        end_time: t(16),
      }),
    ];
    const proposed = mkShift({
      id: 'updating-this',
      client_id: 'client-X',
      start_time: t(12),
      end_time: t(15),
    });
    const conflicts = detectConflicts(shifts[0] === proposed ? [] : [shifts[1]], []);
    // The update should only conflict with 'other' (via travel buffer)
    const detected = detectConflicts(proposed, shifts, {
      excludeShiftId: 'updating-this',
    });
    expect(detected).toHaveLength(1);
    expect(detected[0].id).toBe('other');
  });
});

// ─── hasConflict convenience wrapper ───────────────────────────

describe('hasConflict', () => {
  it('returns false when there are no conflicts', () => {
    expect(hasConflict(mkShift(), [])).toBe(false);
  });

  it('returns true when at least one conflict exists', () => {
    const existing = mkShift({
      id: 'A',
      client_id: 'client-X',
      start_time: t(8),
      end_time: t(12),
    });
    const proposed = mkShift({
      client_id: 'client-Y',
      start_time: t(10),
      end_time: t(14),
    });
    expect(hasConflict(proposed, [existing])).toBe(true);
  });
});

// ─── Sanity: DEFAULT_TRAVEL_BUFFER_MINUTES ─────────────────────

describe('DEFAULT_TRAVEL_BUFFER_MINUTES', () => {
  it('is 30 minutes (matches user decision)', () => {
    expect(DEFAULT_TRAVEL_BUFFER_MINUTES).toBe(30);
  });
});
