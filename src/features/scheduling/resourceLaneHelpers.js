// ─────────────────────────────────────────────────────────────
// Resource-lane (timeline) view helpers
//
// Pure, framework-free logic for the "lane" calendar view, where each
// row is a resource (a caregiver or a client) and shifts are laid out as
// horizontal bars along a time axis. Keeping the math here — out of the
// React component — means it is unit-testable and the component stays a
// thin presentational shell.
//
// Time is always handled as UTC epoch milliseconds so DST, overnight
// shifts, and partial-overlap clipping all fall out of plain arithmetic.
// The agency-local wall clock only matters when we turn a calendar day +
// display band into a window, which is what computeDayWindowMs does using
// the shared timezone utilities.
// ─────────────────────────────────────────────────────────────

import {
  DEFAULT_APP_TIMEZONE,
  utcMsToWallClockParts,
  wallClockToUtcMs,
} from '../../lib/scheduling/timezone';
import { isShiftHiddenFromCalendar } from './shiftHelpers';

// Which entities can sit in the rows of the lane view.
export const RESOURCE_MODES = Object.freeze(['caregiver', 'client']);

// Synthetic row id for open / unassigned shifts in caregiver mode. These
// are the shifts that most need attention, so they get a dedicated lane
// pinned to the top of the board rather than being scattered or dropped.
export const UNASSIGNED_ROW_ID = '__unassigned__';

// Default daytime band shown when a day has no shifts (or only shifts
// inside these hours). The window expands outward to include any shift
// that falls outside the band, so nothing is ever hidden.
export const DEFAULT_DAY_START_HOUR = 6;
export const DEFAULT_DAY_END_HOUR = 22;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Human label for a caregiver row.
 * @param {object} caregiver
 * @returns {string}
 */
export function caregiverRowLabel(caregiver) {
  if (!caregiver) return 'Unknown caregiver';
  const name = `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim();
  return name || 'Unnamed caregiver';
}

/**
 * Human label for a client row. Mirrors how clients are named elsewhere
 * (first + last); falls back gracefully.
 * @param {object} client
 * @returns {string}
 */
export function clientRowLabel(client) {
  if (!client) return 'Unknown client';
  const name = `${client.firstName || ''} ${client.lastName || ''}`.trim();
  return name || 'Unnamed client';
}

/**
 * Compute the [start, end] window for a single calendar day, in epoch ms,
 * for the agency-local day that `date` falls in.
 *
 * `startHour` / `endHour` are agency-local hours (0–24). endHour === 24 is
 * treated as local midnight at the end of the day.
 *
 * @param {object} args
 * @param {Date|number|string} args.date  Any instant within the target local day.
 * @param {number} [args.startHour]
 * @param {number} [args.endHour]
 * @param {string} [args.timezone]
 * @returns {{ startMs:number, endMs:number, startHour:number, endHour:number }}
 */
export function computeDayWindowMs({
  date,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR,
  timezone = DEFAULT_APP_TIMEZONE,
} = {}) {
  const parts = utcMsToWallClockParts(date ?? Date.now(), timezone);
  const base = { year: parts.year, month: parts.month, day: parts.day, minute: 0, second: 0 };
  const startMs = wallClockToUtcMs({ ...base, hour: startHour }, timezone);
  const endMs =
    endHour >= 24
      ? wallClockToUtcMs({ ...base, hour: 23, minute: 59, second: 59 }, timezone) + 1000
      : wallClockToUtcMs({ ...base, hour: endHour }, timezone);
  return { startMs, endMs, startHour, endHour };
}

/**
 * Given the day's shifts, return the display band [startHour, endHour]
 * that comfortably contains every shift, never narrower than the default
 * daytime band. Lets the board collapse dead overnight hours while still
 * guaranteeing nothing is clipped out of view.
 *
 * @param {Array} shifts            Shift objects with startTime/endTime ISO.
 * @param {object} [opts]
 * @param {Date|number|string} [opts.date]  The local day to frame.
 * @param {number} [opts.defaultStartHour]
 * @param {number} [opts.defaultEndHour]
 * @param {number} [opts.padHours]   Hours of breathing room around shifts.
 * @param {string} [opts.timezone]
 * @returns {{ startHour:number, endHour:number }}
 */
export function computeDisplayBand(
  shifts,
  {
    date,
    defaultStartHour = DEFAULT_DAY_START_HOUR,
    defaultEndHour = DEFAULT_DAY_END_HOUR,
    padHours = 1,
    timezone = DEFAULT_APP_TIMEZONE,
  } = {},
) {
  let startHour = defaultStartHour;
  let endHour = defaultEndHour;
  const dayRef = date != null ? utcMsToWallClockParts(date, timezone).dateOnly : null;

  for (const shift of shifts || []) {
    if (!shift?.startTime || !shift?.endTime) continue;
    const start = utcMsToWallClockParts(shift.startTime, timezone);
    const end = utcMsToWallClockParts(shift.endTime, timezone);
    // Frame against the requested day when given: a shift's start sets the
    // lower bound only if it begins on this day; its end sets the upper
    // bound only if it ends on this day. Overnight spillover stays pinned
    // to the band edge rather than blowing the window open.
    if (!dayRef || start.dateOnly === dayRef) {
      startHour = Math.min(startHour, start.hour);
    } else {
      startHour = 0;
    }
    if (!dayRef || end.dateOnly === dayRef) {
      // Round the end hour up so a shift ending at 22:30 shows the 23:00 tick.
      const endH = end.minute > 0 || end.second > 0 ? end.hour + 1 : end.hour;
      endHour = Math.max(endHour, endH);
    } else {
      endHour = 24;
    }
  }

  startHour = Math.max(0, Math.min(startHour, defaultStartHour) - 0);
  // Apply padding without crossing the 0–24 bounds.
  startHour = Math.max(0, startHour - padHours);
  endHour = Math.min(24, endHour + padHours);
  if (endHour <= startHour) endHour = Math.min(24, startHour + 1);
  return { startHour, endHour };
}

/**
 * Geometry for one shift bar within a time window, as percentages of the
 * window width. Returns null when the shift does not overlap the window.
 *
 * @param {number} startMs       Shift start (epoch ms).
 * @param {number} endMs         Shift end (epoch ms).
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @returns {null | { leftPct:number, widthPct:number, clippedStartMs:number,
 *                    clippedEndMs:number, startsBeforeWindow:boolean,
 *                    endsAfterWindow:boolean }}
 */
export function computeBarGeometry(startMs, endMs, windowStartMs, windowEndMs) {
  const span = windowEndMs - windowStartMs;
  if (!(span > 0)) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const clippedStart = Math.max(startMs, windowStartMs);
  const clippedEnd = Math.min(endMs, windowEndMs);
  if (clippedEnd <= clippedStart) return null; // no overlap
  return {
    leftPct: ((clippedStart - windowStartMs) / span) * 100,
    widthPct: ((clippedEnd - clippedStart) / span) * 100,
    clippedStartMs: clippedStart,
    clippedEndMs: clippedEnd,
    startsBeforeWindow: startMs < windowStartMs,
    endsAfterWindow: endMs > windowEndMs,
  };
}

/**
 * Greedy interval-graph packing: assign each interval to the lowest
 * sub-lane that is free, so overlapping shifts in the same row stack
 * vertically instead of drawing on top of each other.
 *
 * Mutates a shallow copy of each interval to add `lane` (0-based). Returns
 * the sorted intervals plus the total number of sub-lanes used.
 *
 * @param {Array<{startMs:number, endMs:number}>} intervals
 * @returns {{ intervals:Array, laneCount:number }}
 */
export function assignLanes(intervals) {
  const sorted = [...(intervals || [])]
    .filter((iv) => iv && Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const laneEnds = []; // laneEnds[i] = end ms of the last interval placed in lane i
  const out = sorted.map((iv) => {
    let lane = -1;
    for (let i = 0; i < laneEnds.length; i += 1) {
      if (iv.startMs >= laneEnds[i]) {
        lane = i;
        laneEnds[i] = iv.endMs;
        break;
      }
    }
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(iv.endMs);
    }
    return { ...iv, lane };
  });
  return { intervals: out, laneCount: Math.max(1, laneEnds.length) };
}

/**
 * Group a day's shifts into resource rows for the lane view.
 *
 * Caregiver mode: one row per caregiver who has a shift, plus a pinned
 * "Unassigned" row at the top holding every open/unassigned shift.
 * Client mode: one row per client who has a shift.
 *
 * Rows are sorted by label; the Unassigned row (when present) is always
 * first. Cancelled shifts (and anything isShiftHiddenFromCalendar flags)
 * are dropped so the board matches the rest of the calendar.
 *
 * @param {object} args
 * @param {'caregiver'|'client'} args.mode
 * @param {Array} [args.shifts]
 * @param {Array} [args.caregivers]
 * @param {Array} [args.clients]
 * @param {boolean} [args.includeEmptyRows]  Include resources with no shifts.
 * @returns {Array<{ id:string, label:string, type:string, entity:object|null, shifts:Array }>}
 */
export function buildResourceRows({
  mode = 'caregiver',
  shifts = [],
  caregivers = [],
  clients = [],
  includeEmptyRows = false,
} = {}) {
  const visible = (shifts || []).filter((s) => s && !isShiftHiddenFromCalendar(s));

  if (mode === 'client') {
    const clientsById = indexById(clients);
    const byClient = new Map();
    for (const shift of visible) {
      const key = shift.clientId;
      if (!key) continue;
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key).push(shift);
    }
    const rows = [];
    const seen = new Set();
    for (const client of clients || []) {
      const rowShifts = byClient.get(client.id) || [];
      if (rowShifts.length === 0 && !includeEmptyRows) continue;
      rows.push(makeRow(client.id, clientRowLabel(client), 'client', client, rowShifts));
      seen.add(client.id);
    }
    // Shifts pointing at a client not in the provided list still deserve a row.
    for (const [key, rowShifts] of byClient) {
      if (seen.has(key)) continue;
      rows.push(makeRow(key, clientRowLabel(clientsById[key]), 'client', clientsById[key] || null, rowShifts));
    }
    return sortRows(rows);
  }

  // caregiver mode (default)
  const caregiversById = indexById(caregivers);
  const byCaregiver = new Map();
  const unassigned = [];
  for (const shift of visible) {
    const key = shift.assignedCaregiverId;
    if (!key) {
      unassigned.push(shift);
      continue;
    }
    if (!byCaregiver.has(key)) byCaregiver.set(key, []);
    byCaregiver.get(key).push(shift);
  }

  const rows = [];
  const seen = new Set();
  for (const caregiver of caregivers || []) {
    const rowShifts = byCaregiver.get(caregiver.id) || [];
    if (rowShifts.length === 0 && !includeEmptyRows) continue;
    rows.push(makeRow(caregiver.id, caregiverRowLabel(caregiver), 'caregiver', caregiver, rowShifts));
    seen.add(caregiver.id);
  }
  for (const [key, rowShifts] of byCaregiver) {
    if (seen.has(key)) continue;
    rows.push(makeRow(key, caregiverRowLabel(caregiversById[key]), 'caregiver', caregiversById[key] || null, rowShifts));
  }

  const sorted = sortRows(rows);
  if (unassigned.length > 0) {
    sorted.unshift(makeRow(UNASSIGNED_ROW_ID, 'Unassigned', 'unassigned', null, unassigned));
  }
  return sorted;
}

// ─── internal helpers ──────────────────────────────────────────

function makeRow(id, label, type, entity, shifts) {
  return { id, label, type, entity, shifts };
}

function indexById(list) {
  const map = {};
  for (const item of list || []) {
    if (item && item.id != null) map[item.id] = item;
  }
  return map;
}

function sortRows(rows) {
  return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * Build the array of hour ticks (for gridlines + axis labels) spanning a
 * display band. Each tick carries the left offset as a percentage.
 *
 * @param {number} startHour
 * @param {number} endHour
 * @returns {Array<{ hour:number, leftPct:number }>}
 */
export function buildHourTicks(startHour, endHour) {
  const ticks = [];
  const span = endHour - startHour;
  if (!(span > 0)) return ticks;
  for (let h = startHour; h <= endHour; h += 1) {
    ticks.push({ hour: h % 24, leftPct: ((h - startHour) / span) * 100 });
  }
  return ticks;
}

export const __test = { HOUR_MS };
