// ═══════════════════════════════════════════════════════════════
// Scheduling — Recurrence Expansion
//
// Expands a recurring shift pattern into individual shift instances.
// Used by Phase 7 (recurring shift generation from care plans) and
// anywhere a pattern needs to be projected into a date range.
//
// Supported pattern shape (simple weekly):
//   {
//     frequency: 'weekly',
//     days_of_week: [1, 3, 5],   // 0=Sun, 6=Sat
//     start_time: '08:00',        // local clock time
//     end_time: '12:00',
//     start_date: '2026-05-01',   // first eligible date (inclusive)
//     end_date: '2026-12-31',     // last eligible date (inclusive, optional)
//     exceptions: ['2026-07-04']  // optional skip dates (YYYY-MM-DD)
//   }
//
// Keeping the pattern schema simple and explicit (rather than jumping
// straight to RFC 5545 rrule) means Phase 7 can drop in rrule later
// without breaking anything — the returned shape (array of instances)
// stays identical.
//
// Timezone handling: wall-clock times in the pattern are resolved via
// the `timezone` option (see src/lib/scheduling/timezone.js). Passing
// DEFAULT_APP_TIMEZONE makes the output stable across runtimes and
// DST-correct; omitting it falls back to the JS runtime's local zone
// to preserve behavior for legacy callers.
// ═══════════════════════════════════════════════════════════════

import { wallClockToUtcMs } from './timezone';

/**
 * Parse an ISO date string (YYYY-MM-DD) or Date into a UTC midnight Date.
 */
function toUTCDate(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === 'string') {
    // Accept 'YYYY-MM-DD' or full ISO
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, y, m, d] = match;
      return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    }
  }
  return null;
}

/**
 * Format a Date as YYYY-MM-DD (UTC).
 */
function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build an ISO timestamp for a given date + clock time in `timezone`.
 *
 * Clock times in recurrence patterns represent the user's local wall-
 * clock intent: "08:00" means 8 AM in the scheduler's timezone, not
 * 8 AM UTC. Resolving against an explicit IANA timezone keeps the
 * output stable across runtimes and DST-correct.
 */
function buildIsoTimestamp(date, clock, timezone) {
  // clock is "HH:MM" or "HH:MM:SS"
  const parts = clock.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  const utcMs = wallClockToUtcMs(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: h,
      minute: m,
      second: s,
    },
    timezone,
  );
  return new Date(utcMs).toISOString();
}

/**
 * Validate that a pattern is expandable. Returns an error string or null.
 */
function validatePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') return 'pattern is missing';
  if (pattern.frequency !== 'weekly') return `unsupported frequency: ${pattern.frequency}`;
  if (!Array.isArray(pattern.days_of_week) || pattern.days_of_week.length === 0) {
    return 'days_of_week must be a non-empty array';
  }
  for (const d of pattern.days_of_week) {
    if (typeof d !== 'number' || d < 0 || d > 6) return `invalid day_of_week: ${d}`;
  }
  if (typeof pattern.start_time !== 'string') return 'start_time is required';
  if (typeof pattern.end_time !== 'string') return 'end_time is required';
  return null;
}

/**
 * Expand a weekly recurrence pattern into an array of concrete shift
 * instances that fall within [windowStart, windowEnd].
 *
 * The window is used to limit how far into the future we generate. A
 * caller generating 4 weeks of shifts would pass windowStart = today
 * and windowEnd = today + 28 days.
 *
 * Each output entry looks like:
 *   {
 *     start_time: '2026-05-04T08:00:00.000Z',
 *     end_time:   '2026-05-04T12:00:00.000Z',
 *     date:       '2026-05-04',
 *   }
 *
 * The caller is responsible for attaching client_id, care_plan_id,
 * recurrence_group_id, etc. before inserting into the shifts table.
 *
 * @param {object}  pattern
 * @param {string|Date} windowStart  Earliest allowed date (inclusive)
 * @param {string|Date} windowEnd    Latest allowed date (inclusive)
 * @param {{ timezone?: string }} [options]
 *   `timezone` is an IANA zone (e.g. 'America/Los_Angeles'). Production
 *   callers should pass DEFAULT_APP_TIMEZONE from `./timezone`. Omit to
 *   use the JS runtime's local zone (legacy behavior).
 * @returns {object[]}  instances (empty array if nothing qualifies)
 */
export function expandRecurrence(pattern, windowStart, windowEnd, options = {}) {
  const error = validatePattern(pattern);
  if (error) return [];

  const timezone = options.timezone;

  const winStart = toUTCDate(windowStart);
  const winEnd = toUTCDate(windowEnd);
  if (!winStart || !winEnd) return [];
  if (winEnd.getTime() < winStart.getTime()) return [];

  const patternStart = pattern.start_date ? toUTCDate(pattern.start_date) : winStart;
  const patternEnd = pattern.end_date ? toUTCDate(pattern.end_date) : null;

  // Effective range is intersection of window and pattern bounds.
  const effectiveStart = patternStart.getTime() > winStart.getTime() ? patternStart : winStart;
  const effectiveEnd = patternEnd && patternEnd.getTime() < winEnd.getTime() ? patternEnd : winEnd;

  if (effectiveEnd.getTime() < effectiveStart.getTime()) return [];

  const daysOfWeek = new Set(pattern.days_of_week);
  const exceptions = new Set(pattern.exceptions || []);

  const results = [];
  const cursor = new Date(effectiveStart.getTime());
  while (cursor.getTime() <= effectiveEnd.getTime()) {
    const dayOfWeek = cursor.getUTCDay();
    if (daysOfWeek.has(dayOfWeek)) {
      const dateStr = formatDate(cursor);
      if (!exceptions.has(dateStr)) {
        results.push({
          date: dateStr,
          start_time: buildIsoTimestamp(cursor, pattern.start_time, timezone),
          end_time: buildIsoTimestamp(cursor, pattern.end_time, timezone),
        });
      }
    }
    // Advance one day (UTC-safe)
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return results;
}
