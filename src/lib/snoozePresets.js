// Pure helpers for the snooze popover. Each preset returns a Date.
// Exported so the UI can render labels and unit tests can pin
// behavior across timezones.
//
// Convention: "tonight" = 6 PM local, "morning" = 9 AM local, "next
// Monday" = the next Monday strictly after `now`. If a preset would
// resolve to a time in the past relative to `now` (e.g. "tonight" at
// 8 PM), the helper rolls forward to the next day's morning so the
// snooze always pushes the task into the future.

const HOUR_MS = 60 * 60 * 1000;

function rollIfPast(target, now) {
  if (target.getTime() > now.getTime()) return target;
  // Past target → next morning at 9am.
  const next = new Date(target.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

function setLocalTime(date, hour, minute = 0) {
  const d = new Date(date.getTime());
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function snoozeOneHour(now = new Date()) {
  return new Date(now.getTime() + HOUR_MS);
}

export function snoozeTonight(now = new Date()) {
  // Today at 6pm local — but if it's already past 6pm, go to
  // tomorrow morning at 9am rather than "tonight in the past".
  const target = setLocalTime(now, 18, 0);
  return rollIfPast(target, now);
}

export function snoozeTomorrowMorning(now = new Date()) {
  const target = new Date(now.getTime());
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target;
}

export function snoozeNextMondayMorning(now = new Date()) {
  // 0=Sun, 1=Mon, ..., 6=Sat. Days until next Monday: (8 - day) % 7,
  // with the "next" rule meaning if today is Monday, jump 7 days.
  const day = now.getDay();
  const daysUntilMonday = day === 1 ? 7 : ((8 - day) % 7);
  const target = new Date(now.getTime());
  target.setDate(target.getDate() + daysUntilMonday);
  target.setHours(9, 0, 0, 0);
  return target;
}

/**
 * Canonical preset list rendered by the popover. Each entry is
 * { id, label, compute } — the popover calls compute(now) on click.
 */
export const SNOOZE_PRESETS = [
  { id: '1h', label: '1 hour',         compute: snoozeOneHour },
  { id: 'tonight', label: 'Tonight 6pm', compute: snoozeTonight },
  { id: 'tomorrow', label: 'Tomorrow 9am', compute: snoozeTomorrowMorning },
  { id: 'monday', label: 'Next Monday 9am', compute: snoozeNextMondayMorning },
];
