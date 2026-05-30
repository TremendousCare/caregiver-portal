// ─── Caregiver shift history helpers (pure) ───
// Grouping/formatting for the caregiver's past-shift list. Pure so the
// date-bucketing logic is unit-tested without a DOM or DB.

// A shift is "past" once its end_time is before `now`.
export function isPastShift(shift, now = new Date()) {
  const end = Date.parse(shift?.end_time);
  if (!Number.isFinite(end)) return false;
  return end < now.getTime();
}

// Group shifts into day buckets keyed by local calendar date, most recent
// day first and most recent shift first within a day. Input order is not
// assumed.
export function groupShiftsByDay(shifts = []) {
  const buckets = new Map();
  for (const sh of shifts) {
    const start = Date.parse(sh?.start_time);
    if (!Number.isFinite(start)) continue;
    const d = new Date(start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!buckets.has(key)) buckets.set(key, { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), shifts: [] });
    buckets.get(key).shifts.push(sh);
  }
  const groups = Array.from(buckets.values());
  for (const g of groups) {
    g.shifts.sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
  }
  groups.sort((a, b) => b.date.getTime() - a.date.getTime());
  return groups;
}
