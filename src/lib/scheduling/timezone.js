// ═══════════════════════════════════════════════════════════════
// Scheduling — Timezone helpers
//
// Small, dependency-free utilities for converting between wall-clock
// components and UTC milliseconds in a specified IANA timezone.
//
// WHY THIS EXISTS
// ---------------
// The scheduling stack originally used `new Date(y, m, d, h, m)` +
// `.toISOString()` to turn wall-clock patterns like "08:00" into UTC
// instants. That quietly depends on the JS runtime's local timezone,
// so the same recurrence pattern produced different ISO timestamps on
// a dev laptop (e.g. America/Chicago) vs the Vercel runtime (UTC), and
// silently misbehaved on DST boundaries because the Date constructor
// rounds non-existent wall-clocks (2:30 AM on spring-forward Sunday)
// in an implementation-defined way.
//
// These helpers encode the target timezone explicitly. The DST-safe
// two-pass algorithm in `wallClockToUtcMs` is the standard trick:
// compute a provisional UTC assuming the wall-clock is UTC, measure
// the zone's offset at that moment, subtract, then re-measure at the
// refined moment in case we crossed a DST boundary during the first
// pass. This handles both spring-forward and fall-back correctly.
// ═══════════════════════════════════════════════════════════════

/**
 * IANA timezone used for all scheduling wall-clock interpretation in
 * production. The ops team operates in Pacific time (cron at 14:00 UTC
 * is documented as "7am PT" in CLAUDE.md), and caregivers/clients are
 * regional. Override per-call by passing an explicit `timezone` option
 * when multi-zone support is added.
 */
export const DEFAULT_APP_TIMEZONE = 'America/Los_Angeles';

/**
 * Read a date's wall-clock components as seen in the given timezone.
 * Returns numeric year/month/day/hour/minute/second.
 *
 * Implementation detail: Intl.DateTimeFormat with hour12:false can emit
 * "24" for midnight on some engines — normalize to "00".
 */
function partsInZone(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  if (map.hour === '24') map.hour = '00';
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Offset of `timezone` from UTC at the moment `date` occurs, in minutes.
 * Positive means the zone is ahead of UTC (e.g. Asia/Tokyo = +540);
 * negative means behind (e.g. America/Los_Angeles = -420 or -480).
 */
function zoneOffsetMinutes(date, timezone) {
  const parts = partsInZone(date, timezone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/**
 * Convert wall-clock components in a given timezone to UTC milliseconds.
 *
 * @param {{year:number, month:number, day:number, hour?:number, minute?:number, second?:number}} wall
 *   Wall-clock components. `month` is 1-12. Hour/minute/second default to 0.
 * @param {string} [timezone] IANA timezone. Defaults to the runtime's local
 *   zone for backwards compatibility with callers that haven't been updated.
 * @returns {number} UTC milliseconds since epoch.
 *
 * DST behavior:
 *   - Spring-forward gap (e.g. 02:30 on DST morning) resolves to the
 *     same instant as 03:30 in the post-transition offset (standard
 *     `Date` constructor behavior).
 *   - Fall-back ambiguity (e.g. 01:30 on DST-end morning occurs twice)
 *     resolves to the FIRST occurrence (before the clock falls back).
 *     Callers that care about the second occurrence should adjust by
 *     subtracting one hour.
 */
export function wallClockToUtcMs(wall, timezone) {
  const tz = timezone || localTimezone();
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wall;

  // Provisional: treat components as if they were UTC, then correct by
  // the zone's offset at that provisional moment.
  const provisionalUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffsetMin = zoneOffsetMinutes(new Date(provisionalUtc), tz);
  const firstPassUtc = provisionalUtc - firstOffsetMin * 60000;

  if (partsMatchWall(firstPassUtc, tz, wall)) return firstPassUtc;

  // Offset changed between provisional and first pass → DST crossing.
  // Re-measure at the first-pass moment and apply.
  const secondOffsetMin = zoneOffsetMinutes(new Date(firstPassUtc), tz);
  const secondPassUtc = provisionalUtc - secondOffsetMin * 60000;

  if (partsMatchWall(secondPassUtc, tz, wall)) return secondPassUtc;

  // Neither result round-trips to the requested wall-clock: the
  // requested moment is inside a spring-forward gap (e.g. 02:30 on
  // DST-start Sunday in LA, which does not exist). Fall back to the
  // first-pass result, matching `new Date(...)`'s "shift forward"
  // convention — 02:30 is treated as 03:30 in the new offset.
  return firstPassUtc;
}

function partsMatchWall(utcMs, tz, wall) {
  const p = partsInZone(new Date(utcMs), tz);
  return (
    p.year === wall.year &&
    p.month === wall.month &&
    p.day === wall.day &&
    p.hour === (wall.hour ?? 0) &&
    p.minute === (wall.minute ?? 0) &&
    p.second === (wall.second ?? 0)
  );
}

/**
 * Decompose a UTC instant into wall-clock components as seen in the
 * target timezone, plus day-of-week (0=Sun..6=Sat) and a YYYY-MM-DD
 * date string. This is the single replacement for all scheduling code
 * that was calling `date.getHours()` / `date.getDay()` (which use the
 * JS runtime's local zone and silently misbehave across servers).
 *
 * @param {number|Date|string} value  UTC instant (ms, Date, or ISO string)
 * @param {string} [timezone]
 * @returns {{
 *   year:number, month:number, day:number,
 *   hour:number, minute:number, second:number,
 *   dayOfWeek:number, minutesOfDay:number, dateOnly:string, ms:number
 * }}
 */
export function utcMsToWallClockParts(value, timezone) {
  const tz = timezone || localTimezone();
  const date = value instanceof Date ? value : new Date(value);
  const p = partsInZone(date, tz);

  // Compute day-of-week without another Intl call by reconstructing a
  // UTC epoch from the wall-clock parts and asking that UTC date for
  // getUTCDay — since the wall-clock represents that moment in `tz`,
  // the weekday at wall-clock is the weekday in `tz`.
  const asUtcEpoch = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const dayOfWeek = new Date(asUtcEpoch).getUTCDay();

  const dateOnly =
    `${String(p.year).padStart(4, '0')}-` +
    `${String(p.month).padStart(2, '0')}-` +
    `${String(p.day).padStart(2, '0')}`;

  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    dayOfWeek,
    minutesOfDay: p.hour * 60 + p.minute,
    dateOnly,
    ms: date.getTime(),
  };
}

/**
 * The runtime's local timezone. Used only as a fallback when callers
 * don't specify one — the scheduling call sites that ship in production
 * should pass `DEFAULT_APP_TIMEZONE` explicitly.
 */
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
