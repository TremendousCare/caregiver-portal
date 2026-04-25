// ═══════════════════════════════════════════════════════════════
// Scheduling — Shift Helpers
//
// Pure functions used by the master calendar, create modal, and
// detail drawer. Keeping these separate from the React components
// lets us unit-test the tricky logic (event adapting, validation,
// skill parsing, default duration math) without mounting anything.
//
// Timezone handling: the date/time helpers below convert between
// "YYYY-MM-DD" + "HH:MM" form inputs and UTC ISO strings, and format
// ISOs for display. Historically they implicitly used the JS
// runtime's local zone. Production callers should now pass an
// explicit `timezone` (DEFAULT_APP_TIMEZONE from ../../lib/scheduling/
// timezone) so a shift created on a non-PT laptop lines up with
// availability rows and recurrence instances that are already
// interpreted in PT. Omitting `timezone` keeps the legacy local-zone
// behavior so the pre-existing unit tests pass unchanged.
// ═══════════════════════════════════════════════════════════════

import {
  wallClockToUtcMs,
  utcMsToWallClockParts,
} from '../../lib/scheduling/timezone';

// Default shift duration for click-to-create on an empty slot.
export const DEFAULT_SHIFT_DURATION_HOURS = 4;

// Valid shift statuses (matches the DB CHECK constraint).
export const SHIFT_STATUSES = [
  'open',
  'offered',
  'assigned',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
];

// Cancel reason options shown in the drawer's cancel dropdown.
// Storage is freeform text, so we can add more later without a
// schema change.
export const SHIFT_CANCEL_REASONS = [
  'Client cancelled',
  'Caregiver cancelled',
  'Agency cancelled',
  'Weather',
  'Other',
];

/**
 * Human-readable label for a shift status.
 */
export function shiftStatusLabel(status) {
  switch (status) {
    case 'open':
      return 'Open';
    case 'offered':
      return 'Offered';
    case 'assigned':
      return 'Assigned';
    case 'confirmed':
      return 'Confirmed';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'no_show':
      return 'No-show';
    default:
      return status || 'Unknown';
  }
}

/**
 * Color scheme for a shift's calendar block and status pill.
 * Returns { bg, fg, border }.
 */
export function shiftStatusColors(status) {
  switch (status) {
    case 'open':
      return { bg: '#FEE2E2', fg: '#991B1B', border: '#F87171' };
    case 'offered':
      return { bg: '#FEF3C7', fg: '#92400E', border: '#FBBF24' };
    case 'assigned':
      return { bg: '#DBEAFE', fg: '#1E40AF', border: '#60A5FA' };
    case 'confirmed':
      return { bg: '#DCFCE7', fg: '#166534', border: '#4ADE80' };
    case 'in_progress':
      return { bg: '#E0E7FF', fg: '#3730A3', border: '#818CF8' };
    case 'completed':
      return { bg: '#F3F4F6', fg: '#374151', border: '#9CA3AF' };
    case 'cancelled':
      return { bg: '#F5F5F5', fg: '#737373', border: '#D4D4D4' };
    case 'no_show':
      return { bg: '#FEE2E2', fg: '#7F1D1D', border: '#DC2626' };
    default:
      return { bg: '#F5F8FC', fg: '#5A6B80', border: '#E1E7EF' };
  }
}

/**
 * Compute the default end time for a click-to-create shift.
 * Adds DEFAULT_SHIFT_DURATION_HOURS to the start time.
 *
 * @param {Date|string} start
 * @returns {Date}
 */
export function computeDefaultShiftEnd(start, hours = DEFAULT_SHIFT_DURATION_HOURS) {
  const d = start instanceof Date ? new Date(start.getTime()) : new Date(start);
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  return d;
}

/**
 * Format an ISO timestamp as "HH:MM" for a form input, in the given
 * timezone. Omit `timezone` to use the JS runtime's local zone.
 * Returns '' for missing input.
 */
export function isoToTimeInput(iso, timezone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (timezone) {
    const parts = utcMsToWallClockParts(date, timezone);
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  }
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format an ISO timestamp as "YYYY-MM-DD" for a form input, in the
 * given timezone. Omit `timezone` to use the JS runtime's local zone.
 */
export function isoToDateInput(iso, timezone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (timezone) {
    return utcMsToWallClockParts(date, timezone).dateOnly;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Combine a "YYYY-MM-DD" date input and a "HH:MM" time input into an
 * ISO timestamp, interpreting the clock time in the given timezone.
 * Omit `timezone` to use the JS runtime's local zone (legacy). Returns
 * null for invalid input.
 *
 * Production callers should pass DEFAULT_APP_TIMEZONE so a shift
 * created on a non-PT laptop still represents the intended PT
 * wall-clock moment, matching how availability rows and recurrence
 * patterns are interpreted.
 */
export function combineDateAndTimeToIso(dateStr, timeStr, timezone) {
  if (!dateStr || !timeStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  if (timezone) {
    const ms = wallClockToUtcMs(
      { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 },
      timezone,
    );
    return new Date(ms).toISOString();
  }
  const local = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

/**
 * Format a shift's time range for display, in the given timezone.
 * Example: "Mon May 4 · 8:00a – 12:00p (4h)". Omit `timezone` to use
 * the JS runtime's local zone (legacy).
 */
export function formatShiftTimeRange(shift, timezone) {
  if (!shift || !shift.startTime || !shift.endTime) return '';
  const start = new Date(shift.startTime);
  const end = new Date(shift.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const dayLabel = timezone
    ? start.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: timezone,
      })
    : start.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
  const startLabel = formatLocalTimeShort(start, timezone);
  const endLabel = formatLocalTimeShort(end, timezone);
  const hours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
  const durationLabel =
    hours >= 1 ? `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h` : `${Math.round(hours * 60)}m`;
  return `${dayLabel} · ${startLabel} – ${endLabel} (${durationLabel})`;
}

/**
 * Format a Date as a short time label, in the given timezone.
 * Omit `timezone` to use the JS runtime's local zone.
 *   08:00 → "8:00a"
 *   13:30 → "1:30p"
 *   12:00 → "12:00p"
 *   00:30 → "12:30a"
 */
export function formatLocalTimeShort(d, timezone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const h = timezone ? utcMsToWallClockParts(d, timezone).hour : d.getHours();
  const m = timezone ? utcMsToWallClockParts(d, timezone).minute : d.getMinutes();
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * Parse a freeform skill string ("Hoyer lift, dementia care, transfer")
 * into a clean array of trimmed, non-empty skills.
 */
export function parseSkillsInput(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Join a skills array back into a comma-separated string for input display.
 */
export function formatSkillsInput(skills) {
  if (!Array.isArray(skills)) return '';
  return skills.join(', ');
}

/**
 * Convert a shift row (from storage) into a FullCalendar event object.
 * The full shift is stashed on `extendedProps.shift` so the click
 * handler has access to it.
 */
export function shiftToCalendarEvent(
  shift,
  { clientsById = {}, caregiversById = {}, actuals = null } = {},
) {
  if (!shift || !shift.startTime || !shift.endTime) return null;
  const colors = shiftStatusColors(shift.status);
  const client = clientsById[shift.clientId];
  const caregiver = shift.assignedCaregiverId ? caregiversById[shift.assignedCaregiverId] : null;
  const clientName = client
    ? `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Client'
    : 'Client';
  const caregiverName = caregiver
    ? `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim()
    : '';
  const baseTitle = caregiverName ? `${clientName} · ${caregiverName}` : `${clientName} (open)`;

  // Variance is only computed when we have actuals — calendar only
  // bulk-loads them for the visible window, so events outside that
  // window simply skip the chip.
  const variance = actuals
    ? computeShiftVariance(shift, actuals)
    : { hasVariance: false, primaryFlag: null, primaryLabel: null };

  const title = variance.hasVariance ? `${baseTitle} · ${variance.primaryLabel}` : baseTitle;

  const classNames = [`shift-status-${shift.status}`];
  if (variance.hasVariance) classNames.push(`shift-variance-${variance.primaryFlag}`);

  return {
    id: shift.id,
    title,
    start: shift.startTime,
    end: shift.endTime,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    textColor: colors.fg,
    extendedProps: {
      shift,
      clientName,
      caregiverName,
      status: shift.status,
      variance,
    },
    classNames,
  };
}

/**
 * Validate a shift draft coming from the create/edit form.
 * Returns an error string or null.
 *
 * Required:
 *   - clientId
 *   - startTime (ISO)
 *   - endTime (ISO)
 *
 * Rules:
 *   - endTime must be strictly after startTime
 *   - hourlyRate / billableRate / mileage, if present, must be >= 0
 */
export function validateShiftDraft(draft) {
  if (!draft) return 'Missing shift data.';
  if (!draft.clientId) return 'Please choose a client.';
  if (!draft.startTime) return 'Please choose a start time.';
  if (!draft.endTime) return 'Please choose an end time.';
  const start = new Date(draft.startTime).getTime();
  const end = new Date(draft.endTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Invalid start or end time.';
  if (end <= start) return 'End time must be after start time.';
  for (const field of ['hourlyRate', 'billableRate', 'mileage']) {
    if (draft[field] != null && draft[field] !== '') {
      const n = Number(draft[field]);
      if (Number.isNaN(n) || n < 0) {
        return `${field.replace(/([A-Z])/g, ' $1').toLowerCase()} must be a non-negative number.`;
      }
    }
  }
  return null;
}

/**
 * Build a patch object to send to updateShift() given an edited draft
 * and the original shift. Only includes fields that actually changed.
 */
export function buildShiftUpdatePatch(original, draft) {
  const patch = {};
  if (!original || !draft) return patch;
  const map = {
    servicePlanId: 'servicePlanId',
    clientId: 'clientId',
    startTime: 'startTime',
    endTime: 'endTime',
    status: 'status',
    locationAddress: 'locationAddress',
    hourlyRate: 'hourlyRate',
    billableRate: 'billableRate',
    mileage: 'mileage',
    requiredSkills: 'requiredSkills',
    instructions: 'instructions',
    notes: 'notes',
    assignedCaregiverId: 'assignedCaregiverId',
  };
  for (const key of Object.keys(map)) {
    const a = original[key];
    const b = draft[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
        patch[key] = b;
      }
    } else if ((a ?? null) !== (b ?? null)) {
      patch[key] = b;
    }
  }
  return patch;
}

/**
 * Reduce a list of clock_events into the caregiver's actual start /
 * end / duration for a shift. Events should be passed in
 * chronological order (occurredAt ascending) — the storage helper
 * already sorts them that way.
 *
 *   - actualStart   ISO of the first 'in' event, or null
 *   - actualEnd     ISO of the last 'out' event, or null
 *   - durationMs    ms between actualStart and actualEnd, or null if
 *                   the shift is still open or only has one side
 *   - isOpen        true if there's an 'in' with no matching later 'out'
 *                   (caregiver is still on the clock)
 *   - eventCount    total number of events (display only)
 */
export function computeShiftActuals(events) {
  const list = Array.isArray(events) ? events : [];
  let actualStart = null;
  let actualEnd = null;
  let isOpen = false;
  for (const ev of list) {
    if (!ev || !ev.occurredAt) continue;
    if (ev.eventType === 'in') {
      if (!actualStart) actualStart = ev.occurredAt;
      // A new clock-in invalidates any earlier clock-out: the shift
      // is open again, so we don't want a stale end time on display.
      // Without this, an in→out→in sequence (possible via manual
      // entries) shows both "On the clock" and a closed-shift duration.
      actualEnd = null;
      isOpen = true;
    } else if (ev.eventType === 'out') {
      actualEnd = ev.occurredAt;
      isOpen = false;
    }
  }
  let durationMs = null;
  if (actualStart && actualEnd) {
    const a = new Date(actualStart).getTime();
    const b = new Date(actualEnd).getTime();
    if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) {
      durationMs = b - a;
    }
  }
  return { actualStart, actualEnd, durationMs, isOpen, eventCount: list.length };
}

/**
 * Format an ISO timestamp as a short clock-event label, in the given
 * timezone. Example: "Tue Apr 23 · 8:03a". Omit `timezone` to use the
 * runtime's local zone.
 */
export function formatClockEventTime(iso, timezone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dayLabel = timezone
    ? d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: timezone,
      })
    : d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
  return `${dayLabel} · ${formatLocalTimeShort(d, timezone)}`;
}

/**
 * Eligibility check for the "Mark no-show" quick action.
 *
 * A shift can be marked no-show when:
 *   - it's in 'assigned' or 'confirmed' state (caregiver was lined up
 *     but the system has no clock-in yet — clock-in flips status to
 *     'in_progress', which is a separate state and never a no-show)
 *   - the scheduled start time has passed
 *
 * 'open' and 'offered' shifts have no caregiver to no-show. 'in_progress',
 * 'completed', 'cancelled', and 'no_show' are terminal or already-acted
 * on, so the action does not apply.
 *
 * `now` is injectable so tests don't depend on Date.now().
 */
export function canMarkShiftNoShow(shift, now = new Date()) {
  if (!shift || !shift.startTime) return false;
  if (shift.status !== 'assigned' && shift.status !== 'confirmed') return false;
  const start = new Date(shift.startTime).getTime();
  if (Number.isNaN(start)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (Number.isNaN(nowMs)) return false;
  return start <= nowMs;
}

/**
 * Format a duration in milliseconds as "Xh Ym". Returns '' for null
 * / negative / NaN. Used for the "actual hours worked" readout.
 */
export function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Decide what shift status should result from inserting a manual
 * clock event. Mirrors the auto-transition that the caregiver-clock
 * edge function applies for real clock-ins / clock-outs:
 *
 *   - on 'in'  → 'in_progress' (unless already past that point)
 *   - on 'out' → 'completed'
 *
 * Returns the new status to apply, or null if nothing should change.
 *
 * Terminal statuses ('cancelled', 'no_show') are never overridden —
 * if office staff somehow add a clock event to a cancelled shift
 * (the panel's disabled gate normally prevents this), we don't want
 * to silently un-cancel it.
 */
export function nextStatusForManualClockEvent(currentStatus, eventType) {
  if (currentStatus === 'cancelled' || currentStatus === 'no_show') return null;
  if (eventType === 'in') {
    if (currentStatus === 'in_progress' || currentStatus === 'completed') return null;
    return 'in_progress';
  }
  if (eventType === 'out') {
    if (currentStatus === 'completed') return null;
    return 'completed';
  }
  return null;
}

// ─── Variance ──────────────────────────────────────────────────
//
// "Variance" is the gap between scheduled and actual time-on-shift.
// Office staff care about three patterns:
//   - LATE START   caregiver clocked in significantly after start
//   - OVERTIME     caregiver clocked out significantly after end
//   - UNDERTIME    caregiver clocked out significantly before end
//
// We surface a single threshold (default 15 min) so a 5-minute drift
// doesn't spam every shift. Below the threshold the shift counts as
// on-time and produces no chip.
//
// We do NOT compute variance for shifts in 'cancelled' or 'no_show'
// status — those have their own banners and any clock events were
// orphaned by the status flip.

export const VARIANCE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Compute the variance of a shift's actual time-on-shift relative to
 * its scheduled window.
 *
 * @param {object} shift  - { startTime, endTime, status }
 * @param {object} actuals - { actualStart, actualEnd } as ISO strings
 *                           (typically from computeShiftActuals)
 * @param {object} [opts]
 * @param {number} [opts.thresholdMs=VARIANCE_THRESHOLD_MS]
 * @returns {{
 *   hasVariance: boolean,
 *   primaryFlag: 'late_start' | 'overtime' | 'undertime' | null,
 *   primaryLabel: string | null,
 *   lateStartMinutes: number,
 *   overtimeMinutes: number,
 *   undertimeMinutes: number,
 * }}
 *
 * primaryFlag is the most operationally significant variance to
 * surface as the visible chip. Order of precedence: late_start →
 * undertime → overtime. The other fields are still populated in
 * case the UI wants to show the full detail.
 */
export function computeShiftVariance(shift, actuals, opts = {}) {
  const empty = {
    hasVariance: false,
    primaryFlag: null,
    primaryLabel: null,
    lateStartMinutes: 0,
    overtimeMinutes: 0,
    undertimeMinutes: 0,
  };

  if (!shift || !shift.startTime || !shift.endTime) return empty;
  if (shift.status === 'cancelled' || shift.status === 'no_show') return empty;
  if (!actuals) return empty;

  const threshold = opts.thresholdMs ?? VARIANCE_THRESHOLD_MS;
  const scheduledStart = new Date(shift.startTime).getTime();
  const scheduledEnd = new Date(shift.endTime).getTime();
  if (Number.isNaN(scheduledStart) || Number.isNaN(scheduledEnd)) return empty;

  let lateStartMs = 0;
  if (actuals.actualStart) {
    const ms = new Date(actuals.actualStart).getTime();
    if (!Number.isNaN(ms) && ms - scheduledStart > threshold) {
      lateStartMs = ms - scheduledStart;
    }
  }

  let overtimeMs = 0;
  let undertimeMs = 0;
  if (actuals.actualEnd) {
    const ms = new Date(actuals.actualEnd).getTime();
    if (!Number.isNaN(ms)) {
      if (ms - scheduledEnd > threshold) overtimeMs = ms - scheduledEnd;
      else if (scheduledEnd - ms > threshold) undertimeMs = scheduledEnd - ms;
    }
  }

  const lateStartMinutes = Math.round(lateStartMs / 60000);
  const overtimeMinutes = Math.round(overtimeMs / 60000);
  const undertimeMinutes = Math.round(undertimeMs / 60000);

  let primaryFlag = null;
  let primaryLabel = null;
  if (lateStartMinutes > 0) {
    primaryFlag = 'late_start';
    primaryLabel = `${lateStartMinutes} min late`;
  } else if (undertimeMinutes > 0) {
    primaryFlag = 'undertime';
    primaryLabel = `Left ${formatVarianceMinutes(undertimeMinutes)} early`;
  } else if (overtimeMinutes > 0) {
    primaryFlag = 'overtime';
    primaryLabel = `${formatVarianceMinutes(overtimeMinutes)} overtime`;
  }

  return {
    hasVariance: primaryFlag != null,
    primaryFlag,
    primaryLabel,
    lateStartMinutes,
    overtimeMinutes,
    undertimeMinutes,
  };
}

/**
 * Format a duration in minutes for variance labels. Keeps short
 * durations as "Nm" but rolls up to "Xh" / "Xh Ym" past 60 min so
 * the chip stays compact.
 */
function formatVarianceMinutes(minutes) {
  if (minutes == null || Number.isNaN(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

