// Natural-language due-date parsing for the Quick Capture modal.
//
// Wraps chrono-node (https://github.com/wanasit/chrono) so the team
// can type "tomorrow 9am", "fri 2pm", "next monday", "in 3 days" and
// get a Date back. The modal echoes the parsed value beneath the
// input so users get instant feedback that what they typed worked.
//
// Pure exports — straightforward to unit-test against a pinned `now`.

import * as chrono from 'chrono-node';

const DEFAULT_HOUR = 17; // Tasks land on the dashboard at end-of-day
                         // if the user didn't specify a time — that's
                         // when "tonight" feels right for a follow-up.

/**
 * Parse a free-text due string into a Date or null. If the string is
 * empty / whitespace, returns null so the caller can apply its own
 * default. If chrono can't parse, returns null as well.
 *
 * @param {string} input
 * @param {Date} [refDate] reference "now" — exposed for tests
 * @returns {Date | null}
 */
export function parseTaskDue(input, refDate = new Date()) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const ref = refDate instanceof Date && !Number.isNaN(refDate.getTime())
    ? refDate
    : new Date();

  // forwardDate: true — for partial matches ("monday"), prefer the
  // *upcoming* monday over a past one. Better default for follow-ups.
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results || results.length === 0) return null;

  const result = results[0];
  // If the user didn't include a time, the start component returns
  // certain=hour=false. Push to DEFAULT_HOUR so the task lands at a
  // reasonable time instead of midnight (which renders as "tomorrow"
  // → "yesterday" in some timezones for borderline tasks).
  const hourCertain = result.start?.isCertain?.('hour') === true;
  const date = result.start?.date?.();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  if (!hourCertain) {
    date.setHours(DEFAULT_HOUR, 0, 0, 0);
  }
  return date;
}

/**
 * Default `dueAt` for the modal when the user leaves the input blank:
 * today at DEFAULT_HOUR local. If it's already past that hour, push
 * to tomorrow so the task isn't already overdue at creation time.
 *
 * @param {Date} [refDate]
 * @returns {Date}
 */
export function defaultTaskDue(refDate = new Date()) {
  const ref = refDate instanceof Date && !Number.isNaN(refDate.getTime())
    ? refDate
    : new Date();
  const d = new Date(ref.getTime());
  d.setHours(DEFAULT_HOUR, 0, 0, 0);
  if (d.getTime() <= ref.getTime()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Short-format a Date for the "parsed: ..." echo beneath the input.
 * Uses the visitor's locale + timezone so the time matches the clock
 * on their wall. Returns '' for invalid input.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatTaskDueEcho(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const datePart = date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}
