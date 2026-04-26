// ─── Per-shift care-plan task filter ───
// Pure functions that decide which care_plan_tasks apply to a given
// shift, based on the task's `shifts` (time-of-day buckets) and
// `days_of_week` (DOW) metadata.
//
// The data model (care_plan_tasks):
//   shifts        text[]   — 'all', 'morning', 'afternoon', 'evening', 'overnight'
//   days_of_week  int[]    — 0=Sun .. 6=Sat. Empty array = every day.
//
// The caregiver PWA loads every task for the active version and
// then filters in JS so the DB query stays simple. Filtering happens
// at the user's local clock — Phase D will move tz selection into
// organizations.settings; for v1 we use the runtime's local tz.

const ALL = 'all';
const ALL_BUCKETS = ['morning', 'afternoon', 'evening', 'overnight'];

/**
 * Map a 24-hour clock hour to the matching shift bucket.
 *   05:00–11:59 → morning
 *   12:00–16:59 → afternoon
 *   17:00–20:59 → evening
 *   21:00–04:59 → overnight
 *
 * Edges chosen to match how schedulers describe shift slots in the
 * existing care plan editor (matches the values the admin can pick
 * when authoring a task).
 */
export function shiftPeriodFromHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'overnight';
}

/**
 * Resolve the shift bucket from the shift's start_time. Accepts an
 * ISO string, a Date, or a millisecond number. Returns null on bad
 * input so the caller can decide to fall through to "show all tasks".
 */
export function shiftPeriodFromStartTime(startTime) {
  if (startTime == null) return null;
  const d = startTime instanceof Date ? startTime : new Date(startTime);
  if (Number.isNaN(d.getTime())) return null;
  return shiftPeriodFromHour(d.getHours());
}

/**
 * Resolve the day-of-week (0=Sun..6=Sat) from a shift's start_time.
 * Mirrors the storage convention on care_plan_tasks.days_of_week.
 */
export function dayOfWeekFromStartTime(startTime) {
  if (startTime == null) return null;
  const d = startTime instanceof Date ? startTime : new Date(startTime);
  if (Number.isNaN(d.getTime())) return null;
  return d.getDay();
}

/**
 * True if a single task applies to the given shift period + DOW.
 * Exported so the UI can show a "this task applies to today's shift"
 * indicator in admin previews.
 */
export function taskAppliesToShift(task, shiftPeriod, dow) {
  if (!task) return false;

  const taskShifts = Array.isArray(task.shifts) ? task.shifts : [];
  const dows = Array.isArray(task.days_of_week ?? task.daysOfWeek)
    ? (task.days_of_week ?? task.daysOfWeek)
    : [];

  // Shift bucket gate — 'all' matches every period; otherwise exact match.
  // Defensive default: if a task has no shifts metadata, treat it as
  // applicable everywhere so admins don't accidentally hide tasks they
  // forgot to tag.
  const shiftMatch =
    taskShifts.length === 0
    || taskShifts.includes(ALL)
    || (shiftPeriod && taskShifts.includes(shiftPeriod));

  if (!shiftMatch) return false;

  // Day-of-week gate — empty array means every day.
  if (dows.length === 0) return true;
  if (dow == null) return true; // no shift-time → don't penalize, show task
  return dows.includes(dow);
}

/**
 * Filter a flat task list down to tasks that apply to the given shift.
 * Pure function — no I/O, no DB.
 *
 * Shape of `shift`: only `start_time` (or `startTime`) is read, so
 * callers can pass either the snake_case DB row or the camelCase app
 * shape. If the start time is unparseable the filter falls through
 * and returns every task — the caregiver should never see an empty
 * list because of a bad timestamp.
 */
export function filterTasksForShift(tasks, shift) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  if (!shift) return tasks.slice();

  const startTime = shift.start_time ?? shift.startTime ?? null;
  const period = shiftPeriodFromStartTime(startTime);
  const dow = dayOfWeekFromStartTime(startTime);

  // If we can't resolve the start time, return everything — better to
  // show the caregiver a few extra tasks than hide all of them.
  if (period == null && dow == null) return tasks.slice();

  return tasks.filter((t) => taskAppliesToShift(t, period, dow));
}

/**
 * Group filtered tasks by category, preserving each task's original
 * sort_order within its category. Returns an array of
 * { category, tasks } so the UI can render category headers.
 */
export function groupTasksByCategory(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const groups = new Map();
  for (const task of tasks) {
    const cat = task.category || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(task);
  }

  // Stable sort within each group by sort_order then task_name so a
  // missing sort_order doesn't shuffle the list between renders.
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ao = (a.sort_order ?? a.sortOrder ?? 0);
      const bo = (b.sort_order ?? b.sortOrder ?? 0);
      if (ao !== bo) return ao - bo;
      const an = (a.task_name ?? a.taskName ?? '').toString();
      const bn = (b.task_name ?? b.taskName ?? '').toString();
      return an.localeCompare(bn);
    });
  }

  return Array.from(groups, ([category, list]) => ({ category, tasks: list }));
}

// ─── Category labels for UI ────────────────────────────────────
// Maps the dotted DB categories to a friendly label shown above each
// group in the caregiver checklist. Falls back to a humanised version
// of the raw category for any value not in the map.
const CATEGORY_LABELS = {
  'adl.bathing': 'Bathing & Personal Care',
  'adl.dressing': 'Dressing',
  'adl.toileting': 'Toileting',
  'adl.transfers': 'Mobility & Transfers',
  'adl.eating': 'Eating',
  'adl.grooming': 'Grooming',
  'iadl.medication': 'Medications',
  'iadl.meals': 'Meals & Nutrition',
  'iadl.housework': 'Housework',
  'iadl.laundry': 'Laundry',
  'iadl.errands': 'Errands & Transport',
  'iadl.observation': 'Health Observations',
  'iadl.companionship': 'Companionship',
  'iadl.exercise': 'Exercise',
};

export function categoryLabel(category) {
  if (!category) return 'Other';
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  // Strip leading 'adl.' / 'iadl.' and Title Case the remainder.
  const rest = category.replace(/^(adl|iadl)\./, '');
  return rest
    .split(/[._-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Other';
}

export const __testing__ = { ALL_BUCKETS };
