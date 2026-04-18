// ═══════════════════════════════════════════════════════════════
// Scheduling — Broadcast Template Helpers
//
// Pure functions for building the SMS text that goes out when a
// scheduler broadcasts an open shift. Keeping template rendering
// as a pure function means:
//   - It's easy to test (no React, no DB, no RingCentral)
//   - The AI agent in Phase 8 can call the same function to
//     preview what a broadcast would look like before sending
//   - Tweaking the wording is a one-file change that lights up
//     every caller at once
//
// Timezone handling: `buildMergeFields` and the two render helpers
// below accept an optional `timezone` so outbound SMS renders shift
// times in a predictable zone regardless of where the scheduler
// happens to be. Production callers should pass DEFAULT_APP_TIMEZONE
// (see ../../lib/scheduling/timezone). Omitting it keeps the legacy
// runtime-local formatting so pre-existing tests pass unchanged.
// ═══════════════════════════════════════════════════════════════

import { utcMsToWallClockParts } from '../../lib/scheduling/timezone';

/**
 * Default SMS template used for shift offer broadcasts. Uses
 * double-curly merge field placeholders so the rendering logic
 * is trivial and AI-readable.
 *
 * Available placeholders:
 *   {{firstName}}         caregiver's first name
 *   {{clientName}}        client display name (first + last)
 *   {{careRecipient}}     care recipient name if different from client
 *   {{dayOfWeek}}         e.g. "Mon"
 *   {{dateLabel}}         e.g. "May 4"
 *   {{startTime}}         e.g. "8:00a"
 *   {{endTime}}           e.g. "12:00p"
 *   {{timeRange}}         e.g. "8:00a-12:00p"
 *   {{duration}}          e.g. "4h" or "30m"
 *   {{location}}          address (falls back to "their home")
 *   {{replyInstruction}}  "Reply YES to accept."
 */
export const DEFAULT_BROADCAST_TEMPLATE =
  'Hi {{firstName}}, we have a shift open: {{dayOfWeek}} {{dateLabel}}, {{timeRange}} with {{clientName}} at {{location}}. {{replyInstruction}}';

export const DEFAULT_REPLY_INSTRUCTION = 'Reply YES to accept.';

/**
 * Format a Date as a short day label ("Mon", "Tue", ...) in the given
 * timezone. Omit `timezone` to use the JS runtime's local zone.
 */
function formatDayOfWeek(d, timezone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/**
 * Format a Date as a compact date label ("May 4") in the given
 * timezone. Omit `timezone` to use the JS runtime's local zone.
 */
function formatDateLabel(d, timezone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/**
 * Format a Date as a short 12-hour time ("8:00a", "12:30p") in the
 * given timezone. Omit `timezone` to use the JS runtime's local zone.
 */
function formatTimeLabel(d, timezone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const h = timezone ? utcMsToWallClockParts(d, timezone).hour : d.getHours();
  const m = timezone ? utcMsToWallClockParts(d, timezone).minute : d.getMinutes();
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * Format shift duration between start and end as "4h", "1.5h", or "45m".
 */
function formatDuration(start, end) {
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return '';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${hours.toFixed(1)}h`;
}

/**
 * Build the merge-field values for a given shift + caregiver + client.
 * Returns a plain object you can pass to renderTemplate(). Pass
 * `timezone` (e.g. DEFAULT_APP_TIMEZONE) to pin date/time labels to a
 * specific IANA zone; otherwise uses the JS runtime's local zone.
 */
export function buildMergeFields({ shift, caregiver, client, timezone }) {
  const fields = {
    firstName: '',
    lastName: '',
    clientName: '',
    careRecipient: '',
    dayOfWeek: '',
    dateLabel: '',
    startTime: '',
    endTime: '',
    timeRange: '',
    duration: '',
    location: 'their home',
    replyInstruction: DEFAULT_REPLY_INSTRUCTION,
  };

  if (caregiver) {
    fields.firstName = caregiver.firstName || '';
    fields.lastName = caregiver.lastName || '';
  }

  if (client) {
    const clientFull = `${client.firstName || ''} ${client.lastName || ''}`.trim();
    fields.clientName = clientFull || 'your client';
    fields.careRecipient = client.careRecipientName || clientFull || fields.clientName;
  } else {
    fields.clientName = 'your client';
    fields.careRecipient = 'your client';
  }

  if (shift && shift.startTime && shift.endTime) {
    const start = new Date(shift.startTime);
    const end = new Date(shift.endTime);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      fields.dayOfWeek = formatDayOfWeek(start, timezone);
      fields.dateLabel = formatDateLabel(start, timezone);
      fields.startTime = formatTimeLabel(start, timezone);
      fields.endTime = formatTimeLabel(end, timezone);
      fields.timeRange = `${fields.startTime}-${fields.endTime}`;
      fields.duration = formatDuration(start, end);
    }
  }

  // Prefer the shift's explicit location override, then the client's
  // home address. Falls back to "their home" if neither is set.
  const shiftLocation = shift?.locationAddress?.trim();
  if (shiftLocation) {
    fields.location = shiftLocation;
  } else if (client) {
    const parts = [client.address, client.city, client.state, client.zip].filter(Boolean);
    if (parts.length > 0) fields.location = parts.join(', ');
  }

  return fields;
}

/**
 * Render a template string by replacing {{placeholder}} tokens with
 * values from a merge fields object. Unknown placeholders are left
 * as empty strings (defensive — we never want a literal "{{foo}}"
 * going out in a customer-facing SMS).
 */
export function renderTemplate(template, fields) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(fields || {}, key)) {
      const value = fields[key];
      return value == null ? '' : String(value);
    }
    return '';
  });
}

/**
 * Convenience: render the default template for a shift + caregiver + client.
 */
export function renderDefaultBroadcastMessage({
  shift,
  caregiver,
  client,
  template = DEFAULT_BROADCAST_TEMPLATE,
  timezone,
}) {
  const fields = buildMergeFields({ shift, caregiver, client, timezone });
  return renderTemplate(template, fields);
}

/**
 * Validate a broadcast draft before sending.
 * Returns null if OK, or an error string.
 */
export function validateBroadcastDraft(draft) {
  if (!draft) return 'Missing broadcast data.';
  if (!Array.isArray(draft.recipientIds) || draft.recipientIds.length === 0) {
    return 'Pick at least one caregiver to broadcast to.';
  }
  if (!draft.template || !draft.template.trim()) {
    return 'Message cannot be empty.';
  }
  if (draft.template.length > 1600) {
    return 'Message is too long — keep it under 1600 characters.';
  }
  return null;
}

// ─── YES/NO response parsing (Phase 5b) ────────────────────────
// Re-exports the single source of truth for keyword classification,
// living in the _shared Deno helpers so the edge function and the
// browser both use the exact same keyword sets. Prior to 2026-04,
// each side kept its own private copy with a "if you change one,
// change the other" comment — real drift risk.

export { parseYesNoResponse } from '../../../supabase/functions/_shared/helpers/yesNoKeywords.ts';

// ─── Confirmation template (sent when scheduler accepts a response) ─

export const DEFAULT_CONFIRMATION_TEMPLATE =
  "You're confirmed for {{dayOfWeek}} {{dateLabel}}, {{timeRange}} with {{clientName}} at {{location}}. Thanks {{firstName}}!";

/**
 * Render the confirmation SMS for an assigned caregiver. Same merge
 * fields as the broadcast template — by design, so the confirmation
 * reads like a natural follow-up to the original broadcast.
 */
export function renderConfirmationMessage({
  shift,
  caregiver,
  client,
  template = DEFAULT_CONFIRMATION_TEMPLATE,
  timezone,
}) {
  const fields = buildMergeFields({ shift, caregiver, client, timezone });
  return renderTemplate(template, fields);
}
