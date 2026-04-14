// ═══════════════════════════════════════════════════════════════
// Scheduling — Shift Helpers
//
// Pure functions used by the master calendar, create modal, and
// detail drawer. Keeping these separate from the React components
// lets us unit-test the tricky logic (event adapting, validation,
// skill parsing, default duration math) without mounting anything.
// ═══════════════════════════════════════════════════════════════

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
 * Format an ISO timestamp as "HH:MM" in local time for a form input.
 * Returns '' for missing input.
 */
export function isoToTimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format an ISO timestamp as "YYYY-MM-DD" in local time for a form input.
 */
export function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Combine a "YYYY-MM-DD" date input and a "HH:MM" time input into an
 * ISO timestamp in the local timezone. Returns null for invalid input.
 */
export function combineDateAndTimeToIso(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  const local = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

/**
 * Format a shift's time range for display.
 * Example: "Mon May 4 · 8:00a – 12:00p (4h)"
 */
export function formatShiftTimeRange(shift) {
  if (!shift || !shift.startTime || !shift.endTime) return '';
  const start = new Date(shift.startTime);
  const end = new Date(shift.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const dayLabel = start.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startLabel = formatLocalTimeShort(start);
  const endLabel = formatLocalTimeShort(end);
  const hours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
  const durationLabel =
    hours >= 1 ? `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h` : `${Math.round(hours * 60)}m`;
  return `${dayLabel} · ${startLabel} – ${endLabel} (${durationLabel})`;
}

/**
 * Format a Date as a short time label in local time.
 *   08:00 → "8:00a"
 *   13:30 → "1:30p"
 *   12:00 → "12:00p"
 *   00:30 → "12:30a"
 */
export function formatLocalTimeShort(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
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
    carePlanId: 'carePlanId',
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
