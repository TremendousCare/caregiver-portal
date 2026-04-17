// ═══════════════════════════════════════════════════════════════
// Scheduling — Recurrence Pattern Helpers (Phase 7)
//
// Pure helpers for working with care plan recurrence patterns.
// Stored shape (on care_plans.recurrence_pattern JSONB):
//
//   {
//     frequency: 'weekly',
//     days_of_week: [1, 3, 5],     // 0=Sun, 6=Sat
//     start_time: '08:00',          // local clock
//     end_time: '12:00',
//     start_date: '2026-05-01',     // optional; pattern effective from
//     end_date: null,               // optional; pattern effective through
//     exceptions: [],               // optional array of YYYY-MM-DD skip days
//   }
//
// Phase 2's expandRecurrence(pattern, windowStart, windowEnd) already
// knows how to project this shape into concrete shift instances.
// ═══════════════════════════════════════════════════════════════

export const DAY_OF_WEEK_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_OF_WEEK_LABELS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const GENERATE_WEEKS_OPTIONS = [2, 4, 8, 12];
export const GENERATE_WEEKS_DEFAULT = 4;

/**
 * Create an empty pattern draft. Used when the user first toggles
 * "Use a recurring weekly pattern" on a care plan that doesn't have
 * one yet.
 */
export function emptyRecurrencePattern() {
  return {
    frequency: 'weekly',
    days_of_week: [],
    start_time: '08:00',
    end_time: '12:00',
    start_date: null,
    end_date: null,
    exceptions: [],
  };
}

/**
 * Is the given value a non-empty recurrence pattern that should be
 * treated as "enabled"? Used to toggle the editor between empty and
 * populated state, and to decide whether to show the Generate button.
 */
export function hasRecurrencePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') return false;
  if (pattern.frequency !== 'weekly') return false;
  if (!Array.isArray(pattern.days_of_week) || pattern.days_of_week.length === 0) {
    return false;
  }
  if (typeof pattern.start_time !== 'string' || !pattern.start_time) return false;
  if (typeof pattern.end_time !== 'string' || !pattern.end_time) return false;
  return true;
}

/**
 * Validate a recurrence pattern. Returns an error string or null.
 *
 * Rules:
 *   - frequency must be 'weekly'
 *   - days_of_week must be a non-empty array of integers 0..6
 *   - start_time and end_time required; end must be after start
 *   - if both dates set, end_date must not precede start_date
 */
export function validateRecurrencePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') return 'Missing pattern.';
  if (pattern.frequency !== 'weekly') {
    return 'Only weekly patterns are supported.';
  }
  if (!Array.isArray(pattern.days_of_week) || pattern.days_of_week.length === 0) {
    return 'Pick at least one day of the week.';
  }
  for (const d of pattern.days_of_week) {
    if (typeof d !== 'number' || d < 0 || d > 6) {
      return `Invalid day of week: ${d}.`;
    }
  }
  if (!pattern.start_time || !pattern.end_time) {
    return 'Start time and end time are required.';
  }
  const startMinutes = clockToMinutes(pattern.start_time);
  const endMinutes = clockToMinutes(pattern.end_time);
  if (startMinutes === null || endMinutes === null) {
    return 'Invalid time format.';
  }
  if (endMinutes <= startMinutes) {
    return 'End time must be after start time.';
  }
  if (pattern.start_date && pattern.end_date && pattern.end_date < pattern.start_date) {
    return 'End date cannot be before start date.';
  }
  return null;
}

function clockToMinutes(clock) {
  if (!clock || typeof clock !== 'string') return null;
  const parts = clock.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Format a HH:MM string as a short 12-hour label: "8:00a", "1:30p".
 */
export function formatClockLabel(clock) {
  const minutes = clockToMinutes(clock);
  if (minutes === null) return '';
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'a' : 'p';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * Build a plain-English summary of a recurrence pattern.
 *
 * Examples:
 *   "Every Mon, Wed, Fri from 8:00a to 12:00p"
 *   "Every weekday from 8:00a to 4:00p"
 *   "Every day from 6:00a to 10:00p"
 *   "No recurrence set"
 */
export function describeRecurrencePattern(pattern) {
  if (!hasRecurrencePattern(pattern)) return 'No recurrence set';
  const sorted = [...pattern.days_of_week].sort((a, b) => a - b);

  let daysLabel;
  if (sorted.length === 7) {
    daysLabel = 'Every day';
  } else if (
    sorted.length === 5 &&
    sorted[0] === 1 &&
    sorted[1] === 2 &&
    sorted[2] === 3 &&
    sorted[3] === 4 &&
    sorted[4] === 5
  ) {
    daysLabel = 'Every weekday';
  } else if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) {
    daysLabel = 'Every weekend';
  } else {
    const labels = sorted.map((d) => DAY_OF_WEEK_LABELS_SHORT[d]);
    daysLabel = `Every ${labels.join(', ')}`;
  }

  const start = formatClockLabel(pattern.start_time);
  const end = formatClockLabel(pattern.end_time);
  return `${daysLabel} from ${start} to ${end}`;
}

/**
 * Toggle a day in a pattern's days_of_week. Returns a new array.
 * Keeps the array sorted ascending.
 */
export function toggleDayInPattern(daysOfWeek, dow) {
  const set = new Set(Array.isArray(daysOfWeek) ? daysOfWeek : []);
  if (set.has(dow)) set.delete(dow);
  else set.add(dow);
  return [...set].sort((a, b) => a - b);
}

/**
 * Given a list of existing shifts and a proposed list of expanded
 * recurrence instances, return only the instances that don't already
 * have a matching shift (same start_time, same care_plan_id).
 *
 * Used to make "Generate" idempotent — clicking it twice shouldn't
 * create duplicates.
 */
export function filterOutExistingInstances(instances, existingShifts) {
  if (!Array.isArray(instances) || instances.length === 0) return [];
  if (!Array.isArray(existingShifts) || existingShifts.length === 0) return instances;

  const existingTimes = new Set();
  for (const shift of existingShifts) {
    if (shift && shift.startTime) {
      existingTimes.add(new Date(shift.startTime).getTime());
    }
  }
  return instances.filter((inst) => {
    if (!inst || !inst.start_time) return false;
    return !existingTimes.has(new Date(inst.start_time).getTime());
  });
}
