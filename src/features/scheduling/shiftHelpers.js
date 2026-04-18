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
export function shiftToCalendarEvent(shift, { clientsById = {}, caregiversById = {} } = {}) {
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
  const title = caregiverName ? `${clientName} · ${caregiverName}` : `${clientName} (open)`;

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
    },
    classNames: [`shift-status-${shift.status}`],
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
