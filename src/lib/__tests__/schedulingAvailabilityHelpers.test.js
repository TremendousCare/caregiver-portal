import { describe, it, expect } from 'vitest';
import {
  emptyGrid,
  slotToTime,
  slotToDisplayTime,
  timeToSlot,
  rowsToGrid,
  gridToRows,
  slotsToBlocks,
  formatClockLabel,
  summarizeWeeklyAvailability,
  diffAvailabilityRows,
  SLOTS_PER_DAY,
  DAYS_PER_WEEK,
} from '../../features/scheduling/availabilityHelpers';

// ─── Constants ─────────────────────────────────────────────────

describe('constants', () => {
  it('has 48 slots per day (30-min granularity)', () => {
    expect(SLOTS_PER_DAY).toBe(48);
  });

  it('has 7 days per week', () => {
    expect(DAYS_PER_WEEK).toBe(7);
  });
});

// ─── emptyGrid ─────────────────────────────────────────────────

describe('emptyGrid', () => {
  it('returns a 7x48 grid of all false', () => {
    const g = emptyGrid();
    expect(g).toHaveLength(7);
    for (const day of g) {
      expect(day).toHaveLength(48);
      expect(day.every((v) => v === false)).toBe(true);
    }
  });
});

// ─── slotToTime / slotToDisplayTime / timeToSlot ───────────────

describe('slotToTime', () => {
  it('returns midnight for slot 0', () => {
    expect(slotToTime(0)).toBe('00:00');
  });

  it('returns 00:30 for slot 1', () => {
    expect(slotToTime(1)).toBe('00:30');
  });

  it('returns 08:00 for slot 16', () => {
    expect(slotToTime(16)).toBe('08:00');
  });

  it('returns 23:30 for slot 47', () => {
    expect(slotToTime(47)).toBe('23:30');
  });

  it('returns null for out-of-range slots', () => {
    expect(slotToTime(-1)).toBeNull();
    expect(slotToTime(48)).toBeNull();
  });
});

describe('slotToDisplayTime', () => {
  it('formats midnight as 12:00a', () => {
    expect(slotToDisplayTime(0)).toBe('12:00a');
  });

  it('formats 8am as 8:00a', () => {
    expect(slotToDisplayTime(16)).toBe('8:00a');
  });

  it('formats noon as 12:00p', () => {
    expect(slotToDisplayTime(24)).toBe('12:00p');
  });

  it('formats 2pm as 2:00p', () => {
    expect(slotToDisplayTime(28)).toBe('2:00p');
  });

  it('formats 2:30pm as 2:30p', () => {
    expect(slotToDisplayTime(29)).toBe('2:30p');
  });
});

describe('timeToSlot', () => {
  it('parses 00:00 to slot 0', () => {
    expect(timeToSlot('00:00')).toBe(0);
  });

  it('parses 08:00 to slot 16', () => {
    expect(timeToSlot('08:00')).toBe(16);
  });

  it('parses 23:30 to slot 47', () => {
    expect(timeToSlot('23:30')).toBe(47);
  });

  it('parses 08:00:00 (with seconds) to slot 16', () => {
    expect(timeToSlot('08:00:00')).toBe(16);
  });

  it('rounds DOWN by default (07:15 → slot 14, which is 07:00)', () => {
    expect(timeToSlot('07:15')).toBe(14);
  });

  it('rounds UP when rounding=up (07:15 → slot 15, which is 07:30)', () => {
    expect(timeToSlot('07:15', 'up')).toBe(15);
  });

  it('rounding=up for 16:00 is still slot 32 (exact boundary)', () => {
    expect(timeToSlot('16:00', 'up')).toBe(32);
  });

  it('returns null for invalid input', () => {
    expect(timeToSlot('bogus')).toBeNull();
    expect(timeToSlot('')).toBeNull();
    expect(timeToSlot(null)).toBeNull();
  });
});

// ─── slotsToBlocks ─────────────────────────────────────────────

describe('slotsToBlocks', () => {
  it('returns empty array for an empty day', () => {
    const row = new Array(48).fill(false);
    expect(slotsToBlocks(row)).toEqual([]);
  });

  it('returns one block for a contiguous range', () => {
    const row = new Array(48).fill(false);
    for (let i = 16; i < 32; i++) row[i] = true;
    expect(slotsToBlocks(row)).toEqual([[16, 32]]);
  });

  it('returns multiple blocks for separated ranges', () => {
    const row = new Array(48).fill(false);
    for (let i = 16; i < 20; i++) row[i] = true;
    for (let i = 28; i < 32; i++) row[i] = true;
    expect(slotsToBlocks(row)).toEqual([
      [16, 20],
      [28, 32],
    ]);
  });

  it('handles a block ending at slot 48', () => {
    const row = new Array(48).fill(false);
    row[46] = true;
    row[47] = true;
    expect(slotsToBlocks(row)).toEqual([[46, 48]]);
  });

  it('handles single-slot blocks', () => {
    const row = new Array(48).fill(false);
    row[20] = true;
    expect(slotsToBlocks(row)).toEqual([[20, 21]]);
  });
});

// ─── rowsToGrid ────────────────────────────────────────────────

describe('rowsToGrid', () => {
  it('returns an empty grid for empty/null rows', () => {
    const r1 = rowsToGrid([]);
    expect(r1.grid).toEqual(emptyGrid());
    expect(r1.oneOffRows).toEqual([]);

    const r2 = rowsToGrid(null);
    expect(r2.grid).toEqual(emptyGrid());
    expect(r2.oneOffRows).toEqual([]);
  });

  it('converts a recurring available row into grid slots', () => {
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    const { grid, oneOffRows } = rowsToGrid(rows);
    // slots 16..24 (8am..12pm) should be true on Monday (dow=1)
    for (let s = 16; s < 24; s++) {
      expect(grid[1][s]).toBe(true);
    }
    // slots outside the range should be false
    expect(grid[1][15]).toBe(false);
    expect(grid[1][24]).toBe(false);
    // other days untouched
    expect(grid[0].every((v) => v === false)).toBe(true);
    expect(grid[2].every((v) => v === false)).toBe(true);
    expect(oneOffRows).toEqual([]);
  });

  it('puts recurring unavailable rows into oneOffRows (not the grid)', () => {
    const rows = [
      { type: 'unavailable', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    const { grid, oneOffRows } = rowsToGrid(rows);
    expect(grid[1].every((v) => v === false)).toBe(true);
    expect(oneOffRows).toHaveLength(1);
  });

  it('puts date-range (one-off) rows into oneOffRows', () => {
    const rows = [
      {
        type: 'unavailable',
        start_date: '2026-07-04',
        end_date: '2026-07-11',
        reason: 'vacation',
      },
    ];
    const { grid, oneOffRows } = rowsToGrid(rows);
    expect(grid).toEqual(emptyGrid());
    expect(oneOffRows).toHaveLength(1);
    expect(oneOffRows[0].reason).toBe('vacation');
  });

  it('ignores rows with invalid clock strings', () => {
    const rows = [
      { type: 'available', day_of_week: 1, start_time: 'bogus', end_time: '12:00' },
    ];
    const { grid } = rowsToGrid(rows);
    expect(grid).toEqual(emptyGrid());
  });

  it('ignores rows with end_time <= start_time', () => {
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '12:00', end_time: '08:00' },
    ];
    const { grid } = rowsToGrid(rows);
    expect(grid).toEqual(emptyGrid());
  });

  it('skips malformed rows without crashing', () => {
    const rows = [null, undefined, {}, { type: 'available' }];
    const { grid, oneOffRows } = rowsToGrid(rows);
    expect(grid).toEqual(emptyGrid());
    // {} and {type: 'available'} land in oneOffRows since they're not recurring-available
    expect(oneOffRows.length).toBeGreaterThan(0);
  });
});

// ─── gridToRows ────────────────────────────────────────────────

describe('gridToRows', () => {
  it('returns empty array for empty grid', () => {
    expect(gridToRows(emptyGrid())).toEqual([]);
  });

  it('returns a single row for one contiguous block', () => {
    const grid = emptyGrid();
    for (let s = 16; s < 24; s++) grid[1][s] = true;
    expect(gridToRows(grid)).toEqual([
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ]);
  });

  it('returns multiple rows for non-contiguous blocks on one day', () => {
    const grid = emptyGrid();
    for (let s = 16; s < 20; s++) grid[1][s] = true; // 8-10
    for (let s = 28; s < 32; s++) grid[1][s] = true; // 2-4
    const rows = gridToRows(grid);
    expect(rows).toEqual([
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '10:00' },
      { type: 'available', day_of_week: 1, start_time: '14:00', end_time: '16:00' },
    ]);
  });

  it('returns rows for multiple days', () => {
    const grid = emptyGrid();
    for (let s = 16; s < 24; s++) grid[1][s] = true;
    for (let s = 16; s < 24; s++) grid[3][s] = true;
    for (let s = 16; s < 24; s++) grid[5][s] = true;
    const rows = gridToRows(grid);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.day_of_week)).toEqual([1, 3, 5]);
  });

  it('handles a block ending at midnight (end of day)', () => {
    const grid = emptyGrid();
    for (let s = 46; s < 48; s++) grid[0][s] = true;
    expect(gridToRows(grid)).toEqual([
      { type: 'available', day_of_week: 0, start_time: '23:00', end_time: '24:00' },
    ]);
  });
});

// ─── round-trip ────────────────────────────────────────────────

describe('rowsToGrid / gridToRows round-trip', () => {
  it('preserves a simple weekly schedule', () => {
    const input = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '16:00' },
      { type: 'available', day_of_week: 2, start_time: '08:00', end_time: '16:00' },
      { type: 'available', day_of_week: 3, start_time: '08:00', end_time: '16:00' },
      { type: 'available', day_of_week: 4, start_time: '08:00', end_time: '16:00' },
      { type: 'available', day_of_week: 5, start_time: '08:00', end_time: '16:00' },
    ];
    const { grid } = rowsToGrid(input);
    const output = gridToRows(grid);
    expect(output).toEqual(input);
  });

  it('preserves a split-shift day', () => {
    const input = [
      { type: 'available', day_of_week: 2, start_time: '08:00', end_time: '12:00' },
      { type: 'available', day_of_week: 2, start_time: '14:00', end_time: '18:00' },
    ];
    const { grid } = rowsToGrid(input);
    const output = gridToRows(grid);
    expect(output).toEqual(input);
  });
});

// ─── formatClockLabel ──────────────────────────────────────────

describe('formatClockLabel', () => {
  it('formats AM hours', () => {
    expect(formatClockLabel('08:00')).toBe('8:00a');
    expect(formatClockLabel('00:30')).toBe('12:30a');
  });

  it('formats PM hours', () => {
    expect(formatClockLabel('13:30')).toBe('1:30p');
    expect(formatClockLabel('23:00')).toBe('11:00p');
  });

  it('formats noon as 12:00p', () => {
    expect(formatClockLabel('12:00')).toBe('12:00p');
  });

  it('formats end-of-day as 12:00a', () => {
    expect(formatClockLabel('24:00')).toBe('12:00a');
  });

  it('returns empty string for missing input', () => {
    expect(formatClockLabel('')).toBe('');
    expect(formatClockLabel(null)).toBe('');
  });
});

// ─── summarizeWeeklyAvailability ───────────────────────────────

describe('summarizeWeeklyAvailability', () => {
  it('says "no availability" for empty grid', () => {
    expect(summarizeWeeklyAvailability(emptyGrid())).toBe('No weekly availability entered.');
  });

  it('produces a day-by-day summary string', () => {
    const grid = emptyGrid();
    // Mon 8-4, Wed 9-5
    for (let s = 16; s < 32; s++) grid[1][s] = true;
    for (let s = 18; s < 34; s++) grid[3][s] = true;
    const summary = summarizeWeeklyAvailability(grid);
    expect(summary).toContain('Mon 8:00a-4:00p');
    expect(summary).toContain('Wed 9:00a-5:00p');
    expect(summary).toContain('Tue off');
  });
});

// ─── diffAvailabilityRows ──────────────────────────────────────

describe('diffAvailabilityRows', () => {
  const row = (id, dow, start, end) => ({
    id,
    type: 'available',
    day_of_week: dow,
    start_time: start,
    end_time: end,
  });

  it('reports empty diff for identical sets', () => {
    const previous = [row('a', 1, '08:00', '16:00')];
    const next = [row(null, 1, '08:00', '16:00')];
    const { toAdd, toRemove } = diffAvailabilityRows(previous, next);
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  it('reports additions when next has a new block', () => {
    const previous = [row('a', 1, '08:00', '16:00')];
    const next = [
      row(null, 1, '08:00', '16:00'),
      row(null, 2, '08:00', '16:00'),
    ];
    const { toAdd, toRemove } = diffAvailabilityRows(previous, next);
    expect(toAdd).toHaveLength(1);
    expect(toAdd[0].day_of_week).toBe(2);
    expect(toRemove).toEqual([]);
  });

  it('reports removals when a previous block is gone', () => {
    const previous = [
      row('a', 1, '08:00', '16:00'),
      row('b', 2, '08:00', '16:00'),
    ];
    const next = [row(null, 1, '08:00', '16:00')];
    const { toAdd, toRemove } = diffAvailabilityRows(previous, next);
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual(['b']);
  });

  it('ignores non-recurring rows in previous', () => {
    const previous = [
      row('a', 1, '08:00', '16:00'),
      // a date-range row (no day_of_week) should not appear in diff
      {
        id: 'vac',
        type: 'unavailable',
        start_date: '2026-07-04',
        end_date: '2026-07-11',
      },
    ];
    const next = [row(null, 1, '08:00', '16:00')];
    const { toAdd, toRemove } = diffAvailabilityRows(previous, next);
    expect(toRemove).toEqual([]);
    expect(toAdd).toEqual([]);
  });
});
