// ═══════════════════════════════════════════════════════════════
// Scheduling — Availability Editor Helpers
//
// Pure functions for converting between the two ways we represent
// a caregiver's weekly availability:
//
//   A. Database rows (caregiver_availability)
//      - recurring:   { day_of_week, start_time, end_time, type }
//      - one-off:     { start_date, end_date, reason, type }
//
//   B. UI grid state
//      - grid:        2D boolean matrix [day][slot]
//                     7 days × 48 half-hour slots (00:00-23:30)
//      - oneOffList:  array of one-off rows (rendered separately)
//
// The grid is only used for recurring "available" blocks. One-off
// entries and unavailability are handled with a list UI below the
// grid. This keeps the grid simple and focused.
//
// Slots are half-hour increments:
//   slot 0  = 00:00-00:30
//   slot 1  = 00:30-01:00
//   ...
//   slot 47 = 23:30-24:00
// ═══════════════════════════════════════════════════════════════

export const SLOTS_PER_DAY = 48;
export const DAYS_PER_WEEK = 7;
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_LABELS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Build an empty 7×48 boolean grid (all false).
 */
export function emptyGrid() {
  return Array.from({ length: DAYS_PER_WEEK }, () =>
    Array.from({ length: SLOTS_PER_DAY }, () => false),
  );
}

/**
 * Convert a slot index (0..47) to a "HH:MM" clock string.
 */
export function slotToTime(slot) {
  if (slot < 0 || slot >= SLOTS_PER_DAY) return null;
  const minutes = slot * 30;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Convert a slot index to a display-friendly 12-hour label.
 * Used for the time column in the grid.
 *   slot 0  -> "12:00a"
 *   slot 16 -> "8:00a"
 *   slot 28 -> "2:00p"
 */
export function slotToDisplayTime(slot) {
  if (slot < 0 || slot >= SLOTS_PER_DAY) return '';
  const minutes = slot * 30;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'a' : 'p';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * Parse a "HH:MM" or "HH:MM:SS" clock string to a slot index.
 * Rounds DOWN for start times and UP for end times so the UI captures
 * the full declared availability window even if the user entered times
 * that don't land on a 30-minute boundary.
 *
 * Returns null if unparseable.
 *
 * @param {string} clock
 * @param {'down' | 'up'} rounding  how to snap to 30-min boundaries
 */
export function timeToSlot(clock, rounding = 'down') {
  if (!clock || typeof clock !== 'string') return null;
  const parts = clock.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const totalMinutes = h * 60 + m;
  if (totalMinutes < 0) return null;
  if (rounding === 'up') {
    return Math.min(SLOTS_PER_DAY, Math.ceil(totalMinutes / 30));
  }
  return Math.min(SLOTS_PER_DAY - 1, Math.floor(totalMinutes / 30));
}

/**
 * Convert an array of caregiver_availability rows into:
 *   {
 *     grid: boolean[7][48],      // recurring AVAILABLE cells
 *     oneOffRows: Row[],         // everything else (kept as-is)
 *   }
 *
 * Only recurring rows with type='available' contribute to the grid.
 * Recurring 'unavailable' rows and all one-off rows are returned
 * separately so the caller can render them in the time-off section.
 */
export function rowsToGrid(rows) {
  const grid = emptyGrid();
  const oneOffRows = [];
  if (!Array.isArray(rows)) return { grid, oneOffRows };

  for (const row of rows) {
    if (!row) continue;
    const isRecurring = row.day_of_week !== null && row.day_of_week !== undefined;
    if (isRecurring && row.type === 'available') {
      const dow = row.day_of_week;
      if (dow < 0 || dow > 6) continue;
      const start = timeToSlot(row.start_time, 'down');
      const end = timeToSlot(row.end_time, 'up');
      if (start === null || end === null || end <= start) continue;
      for (let s = start; s < end; s++) {
        grid[dow][s] = true;
      }
    } else {
      // one-off entry OR recurring unavailable — show in list below
      oneOffRows.push(row);
    }
  }

  return { grid, oneOffRows };
}

/**
 * Collapse a single day's slot row into contiguous [startSlot, endSlot] blocks.
 * endSlot is exclusive.
 *
 * Example: [F,F,T,T,T,F,T,T,F,...] → [[2,5],[6,8]]
 */
export function slotsToBlocks(slotRow) {
  const blocks = [];
  if (!Array.isArray(slotRow)) return blocks;
  let i = 0;
  while (i < slotRow.length) {
    if (slotRow[i]) {
      const start = i;
      while (i < slotRow.length && slotRow[i]) i++;
      blocks.push([start, i]);
    } else {
      i++;
    }
  }
  return blocks;
}

/**
 * Convert the grid back into caregiver_availability rows. Each contiguous
 * block of selected slots on a day becomes one row of type='available'.
 *
 * The returned rows do NOT have `id` or `caregiver_id` set — the caller
 * attaches those before insert.
 */
export function gridToRows(grid) {
  const rows = [];
  if (!Array.isArray(grid)) return rows;
  for (let dow = 0; dow < grid.length; dow++) {
    const dayBlocks = slotsToBlocks(grid[dow]);
    for (const [startSlot, endSlot] of dayBlocks) {
      rows.push({
        type: 'available',
        day_of_week: dow,
        start_time: slotToTime(startSlot),
        end_time: endSlot === SLOTS_PER_DAY ? '24:00' : slotToTime(endSlot),
      });
    }
  }
  return rows;
}

/**
 * Format a "HH:MM" or "HH:MM:SS" string into a friendly 12-hour label.
 * "08:00" → "8:00a", "13:30" → "1:30p", "24:00" → "12:00a" (midnight).
 */
export function formatClockLabel(clock) {
  if (!clock) return '';
  const parts = clock.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return clock;
  if (h === 24 && m === 0) return '12:00a';
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * Build a plain-English summary of the current weekly availability.
 * Used in the live preview underneath the grid.
 *
 * Example output:
 *   "Mon 8:00a-4:00p · Tue 8:00a-4:00p · Wed off · Thu 9:00a-5:00p · ..."
 *
 * If no availability is set: "No weekly availability entered."
 */
export function summarizeWeeklyAvailability(grid) {
  if (!Array.isArray(grid)) return 'No weekly availability entered.';
  const parts = [];
  let hasAny = false;
  for (let dow = 0; dow < grid.length; dow++) {
    const blocks = slotsToBlocks(grid[dow]);
    if (blocks.length === 0) {
      parts.push(`${DAY_LABELS[dow]} off`);
      continue;
    }
    hasAny = true;
    const blockStrs = blocks.map(([s, e]) => {
      const startLabel = formatClockLabel(slotToTime(s));
      const endLabel = e === SLOTS_PER_DAY ? '12:00a' : formatClockLabel(slotToTime(e));
      return `${startLabel}-${endLabel}`;
    });
    parts.push(`${DAY_LABELS[dow]} ${blockStrs.join(', ')}`);
  }
  if (!hasAny) return 'No weekly availability entered.';
  return parts.join(' · ');
}

/**
 * Diff two arrays of recurring availability rows and return:
 *   {
 *     toAdd:    rows present in `next` but not `previous`
 *     toRemove: IDs of rows in `previous` but not `next`
 *   }
 *
 * Rows are matched by normalized (day_of_week, start_time, end_time).
 * This is what the storage layer calls on save: delete the removed rows,
 * insert the new ones. No update path needed because recurring
 * availability rows are immutable in shape — a changed block is a delete + insert.
 *
 * Both inputs should be pre-filtered to type='available' recurring rows.
 */
export function diffAvailabilityRows(previous, next) {
  const key = (row) => `${row.day_of_week}|${row.start_time}|${row.end_time}`;
  const prevMap = new Map();
  for (const r of previous || []) {
    if (r.day_of_week !== null && r.day_of_week !== undefined && r.type === 'available') {
      prevMap.set(key(r), r);
    }
  }
  const nextMap = new Map();
  for (const r of next || []) {
    nextMap.set(key(r), r);
  }
  const toAdd = [];
  const toRemove = [];
  for (const [k, r] of nextMap) {
    if (!prevMap.has(k)) toAdd.push(r);
  }
  for (const [k, r] of prevMap) {
    if (!nextMap.has(k)) toRemove.push(r.id);
  }
  return { toAdd, toRemove };
}
