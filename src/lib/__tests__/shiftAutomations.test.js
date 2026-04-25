import { describe, it, expect } from 'vitest';
import {
  diffShiftForEvents,
  formatShiftDateTime,
  buildShiftTriggerContext,
} from '../shiftAutomations';

// Common starting state — an assigned, confirmed shift for caregiver A.
const baseShift = {
  id: 'shift_1',
  clientId: 'client_1',
  assignedCaregiverId: 'cg_A',
  startTime: '2026-04-26T14:00:00Z',
  endTime: '2026-04-26T18:00:00Z',
  status: 'assigned',
};

describe('diffShiftForEvents — assignment paths', () => {
  it('returns nothing when nothing relevant changed', () => {
    const events = diffShiftForEvents(baseShift, { ...baseShift });
    expect(events).toEqual([]);
  });

  it('fires shift_assigned when an open shift is assigned to a caregiver', () => {
    const oldShift = { ...baseShift, assignedCaregiverId: null, status: 'open' };
    const newShift = { ...baseShift, assignedCaregiverId: 'cg_A', status: 'assigned' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_assigned', caregiverId: 'cg_A' }]);
  });

  it('fires shift_assigned on creation (oldShift = null)', () => {
    const newShift = { ...baseShift, assignedCaregiverId: 'cg_A', status: 'assigned' };
    const events = diffShiftForEvents(null, newShift);
    expect(events).toEqual([{ type: 'shift_assigned', caregiverId: 'cg_A' }]);
  });

  it('does NOT fire shift_assigned on creation when no caregiver is set', () => {
    const newShift = { ...baseShift, assignedCaregiverId: null, status: 'open' };
    const events = diffShiftForEvents(null, newShift);
    expect(events).toEqual([]);
  });

  it('fires shift_canceled then shift_assigned on reassignment A → B', () => {
    const oldShift = { ...baseShift, assignedCaregiverId: 'cg_A', status: 'assigned' };
    const newShift = { ...baseShift, assignedCaregiverId: 'cg_B', status: 'assigned' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([
      { type: 'shift_canceled', caregiverId: 'cg_A' },
      { type: 'shift_assigned', caregiverId: 'cg_B' },
    ]);
  });

  it('fires shift_canceled when caregiver is removed (A → null)', () => {
    const oldShift = { ...baseShift, assignedCaregiverId: 'cg_A', status: 'assigned' };
    const newShift = { ...baseShift, assignedCaregiverId: null, status: 'open' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_canceled', caregiverId: 'cg_A' }]);
  });

  it('does not fire shift_assigned for an inactive new status', () => {
    // Reassigning to a caregiver but status is somehow 'completed' — shouldn't fire
    const oldShift = { ...baseShift, assignedCaregiverId: null, status: 'open' };
    const newShift = { ...baseShift, assignedCaregiverId: 'cg_A', status: 'completed' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });
});

describe('diffShiftForEvents — cancellation paths', () => {
  it('fires shift_canceled when status flips assigned → cancelled', () => {
    const oldShift = { ...baseShift, status: 'assigned', assignedCaregiverId: 'cg_A' };
    const newShift = { ...baseShift, status: 'cancelled', assignedCaregiverId: 'cg_A' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_canceled', caregiverId: 'cg_A' }]);
  });

  it('fires shift_canceled when status flips confirmed → cancelled', () => {
    const oldShift = { ...baseShift, status: 'confirmed', assignedCaregiverId: 'cg_A' };
    const newShift = { ...baseShift, status: 'cancelled', assignedCaregiverId: 'cg_A' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_canceled', caregiverId: 'cg_A' }]);
  });

  it('does NOT fire shift_canceled when an unassigned open shift is cancelled', () => {
    const oldShift = { ...baseShift, status: 'open', assignedCaregiverId: null };
    const newShift = { ...baseShift, status: 'cancelled', assignedCaregiverId: null };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });

  it('does NOT re-fire shift_canceled when status was already cancelled', () => {
    const oldShift = { ...baseShift, status: 'cancelled', assignedCaregiverId: 'cg_A' };
    const newShift = { ...baseShift, status: 'cancelled', assignedCaregiverId: 'cg_A', notes: 'updated note' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });
});

describe('diffShiftForEvents — change paths', () => {
  it('fires shift_changed when start_time changes on an assigned shift', () => {
    const oldShift = { ...baseShift, startTime: '2026-04-26T14:00:00Z' };
    const newShift = { ...baseShift, startTime: '2026-04-26T15:00:00Z' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_changed', caregiverId: 'cg_A' }]);
  });

  it('fires shift_changed when end_time changes', () => {
    const oldShift = { ...baseShift, endTime: '2026-04-26T18:00:00Z' };
    const newShift = { ...baseShift, endTime: '2026-04-26T19:00:00Z' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_changed', caregiverId: 'cg_A' }]);
  });

  it('fires shift_changed when client_id changes', () => {
    const oldShift = { ...baseShift, clientId: 'client_1' };
    const newShift = { ...baseShift, clientId: 'client_2' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([{ type: 'shift_changed', caregiverId: 'cg_A' }]);
  });

  it('does NOT fire shift_changed when only an irrelevant field changes', () => {
    const oldShift = { ...baseShift, notes: 'old note' };
    const newShift = { ...baseShift, notes: 'new note' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });

  it('does NOT fire shift_changed when status moves to in_progress (caregiver-driven)', () => {
    const oldShift = { ...baseShift, status: 'confirmed' };
    const newShift = { ...baseShift, status: 'in_progress' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });

  it('does NOT fire shift_changed when status moves to completed', () => {
    const oldShift = { ...baseShift, status: 'in_progress' };
    const newShift = { ...baseShift, status: 'completed' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });

  it('does NOT fire shift_changed when no caregiver is assigned', () => {
    const oldShift = { ...baseShift, assignedCaregiverId: null, status: 'open', startTime: '2026-04-26T14:00:00Z' };
    const newShift = { ...baseShift, assignedCaregiverId: null, status: 'open', startTime: '2026-04-26T15:00:00Z' };
    const events = diffShiftForEvents(oldShift, newShift);
    expect(events).toEqual([]);
  });
});

describe('diffShiftForEvents — defensive edges', () => {
  it('returns empty when newShift is null', () => {
    expect(diffShiftForEvents(baseShift, null)).toEqual([]);
  });
});

describe('formatShiftDateTime', () => {
  it('formats a valid ISO timestamp into a friendly Eastern-Time string', () => {
    const text = formatShiftDateTime('2026-04-26T14:00:00Z');
    // Don't pin every byte; just confirm it includes the expected pieces.
    expect(text).toMatch(/Apr/);
    expect(text).toMatch(/26/);
    expect(text).toMatch(/(AM|PM)/);
    expect(text).toMatch(/(EDT|EST|ET)/);
  });

  it('returns empty string for null/undefined input', () => {
    expect(formatShiftDateTime(null)).toBe('');
    expect(formatShiftDateTime(undefined)).toBe('');
    expect(formatShiftDateTime('')).toBe('');
  });

  it('returns empty string for unparsable input', () => {
    expect(formatShiftDateTime('not-a-date')).toBe('');
  });

  it('honors a custom timezone parameter', () => {
    const east = formatShiftDateTime('2026-04-26T14:00:00Z', 'America/New_York');
    const pacific = formatShiftDateTime('2026-04-26T14:00:00Z', 'America/Los_Angeles');
    // 14:00 UTC = 10 AM EDT vs 7 AM PDT — the formatted strings must differ.
    expect(east).not.toBe(pacific);
  });
});

describe('buildShiftTriggerContext', () => {
  it('produces every shift merge field the resolver supports', () => {
    const shift = {
      id: 'shift_1',
      clientId: 'client_1',
      startTime: '2026-04-26T14:00:00Z',
      endTime: '2026-04-26T18:00:00Z',
    };
    const client = {
      id: 'client_1',
      first_name: 'Eleanor',
      last_name: 'Doe',
      address: '123 Main St',
      city: 'Boston',
      state: 'MA',
      zip: '02118',
    };
    const ctx = buildShiftTriggerContext(shift, client);
    expect(ctx.shift_id).toBe('shift_1');
    expect(ctx.shift_start).toBe('2026-04-26T14:00:00Z');
    expect(ctx.shift_end).toBe('2026-04-26T18:00:00Z');
    expect(ctx.shift_start_text).toMatch(/Apr/);
    expect(ctx.shift_end_text).toMatch(/Apr/);
    expect(ctx.shift_address).toBe('123 Main St, Boston, MA, 02118');
    expect(ctx.client_id).toBe('client_1');
    expect(ctx.client_first_name).toBe('Eleanor');
    expect(ctx.client_last_name).toBe('Doe');
    expect(ctx.client_full_name).toBe('Eleanor Doe');
  });

  it('handles a missing client gracefully', () => {
    const shift = { id: 'shift_2', clientId: 'client_x', startTime: '2026-04-26T14:00:00Z', endTime: '2026-04-26T18:00:00Z' };
    const ctx = buildShiftTriggerContext(shift, null);
    expect(ctx.client_full_name).toBe('');
    expect(ctx.shift_address).toBe('');
    expect(ctx.client_id).toBe('client_x');
  });

  it('omits address parts that are missing', () => {
    const shift = { id: 's1', clientId: 'c1', startTime: '2026-04-26T14:00:00Z', endTime: '2026-04-26T18:00:00Z' };
    const client = { id: 'c1', first_name: 'A', last_name: 'B', address: '1 Main St', city: 'Boston', state: null, zip: null };
    const ctx = buildShiftTriggerContext(shift, client);
    expect(ctx.shift_address).toBe('1 Main St, Boston');
  });

  it('accepts snake_case client fields too (fallback for cron path)', () => {
    const shift = { id: 's1', client_id: 'c1', start_time: '2026-04-26T14:00:00Z', end_time: '2026-04-26T18:00:00Z' };
    const client = { id: 'c1', first_name: 'A', last_name: 'B', address: '1 Main St' };
    const ctx = buildShiftTriggerContext(shift, client);
    expect(ctx.shift_start).toBe('2026-04-26T14:00:00Z');
    expect(ctx.client_id).toBe('c1');
    expect(ctx.shift_address).toBe('1 Main St');
  });
});
