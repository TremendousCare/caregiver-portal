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
// ═══════════════════════════════════════════════════════════════

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
 * Format a Date as a short local day label: "Mon", "Tue", ...
 */
function formatDayOfWeek(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Format a Date as a compact local date label: "May 4".
 */
function formatDateLabel(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a Date as a short 12-hour local time: "8:00a", "12:30p".
 * (Duplicates the logic from shiftHelpers on purpose — keeping broadcast
 * helpers standalone so they're easy to reuse from the AI layer later.)
 */
function formatTimeLabel(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
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
 * Returns a plain object you can pass to renderTemplate().
 */
export function buildMergeFields({ shift, caregiver, client }) {
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
      fields.dayOfWeek = formatDayOfWeek(start);
      fields.dateLabel = formatDateLabel(start);
      fields.startTime = formatTimeLabel(start);
      fields.endTime = formatTimeLabel(end);
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
export function renderDefaultBroadcastMessage({ shift, caregiver, client, template = DEFAULT_BROADCAST_TEMPLATE }) {
  const fields = buildMergeFields({ shift, caregiver, client });
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
//
// When a caregiver replies to a broadcast SMS with "YES", "no", "sure",
// etc., we need to classify it to update the shift_offer. The rules
// are intentionally simple and predictable:
//
//   YES   — first word matches any of the accept keywords
//   NO    — first word matches any of the decline keywords
//   MAYBE — anything else (scheduler reviews manually)
//
// Case-insensitive, strips basic punctuation from the first word
// so "Yes!" and "YES." still match.

const YES_KEYWORDS = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'accept', 'accepted',
  'yeahh', 'ya', 'affirmative', 'absolutely', 'yesyes',
]);

const NO_KEYWORDS = new Set([
  'no', 'n', 'nope', 'nah', 'cant', "can't", 'cannot', 'decline', 'declined',
  'pass', 'unable', 'busy',
]);

/**
 * Parse a caregiver's SMS reply into 'yes' | 'no' | 'maybe'.
 *
 * Returns 'maybe' for empty / null / ambiguous input, so the scheduler
 * can review manually without auto-mismatching.
 */
export function parseYesNoResponse(text) {
  if (!text || typeof text !== 'string') return 'maybe';
  const trimmed = text.trim();
  if (!trimmed) return 'maybe';
  // First "word" is everything up to the first whitespace or punctuation
  // other than apostrophes (to keep "can't" intact).
  const firstWordMatch = trimmed.match(/^[a-zA-Z']+/);
  if (!firstWordMatch) return 'maybe';
  const firstWord = firstWordMatch[0].toLowerCase();
  if (YES_KEYWORDS.has(firstWord)) return 'yes';
  if (NO_KEYWORDS.has(firstWord)) return 'no';
  return 'maybe';
}

// ─── Confirmation template (sent when scheduler accepts a response) ─

export const DEFAULT_CONFIRMATION_TEMPLATE =
  "You're confirmed for {{dayOfWeek}} {{dateLabel}}, {{timeRange}} with {{clientName}} at {{location}}. Thanks {{firstName}}!";

/**
 * Render the confirmation SMS for an assigned caregiver. Same merge
 * fields as the broadcast template — by design, so the confirmation
 * reads like a natural follow-up to the original broadcast.
 */
export function renderConfirmationMessage({ shift, caregiver, client, template = DEFAULT_CONFIRMATION_TEMPLATE }) {
  const fields = buildMergeFields({ shift, caregiver, client });
  return renderTemplate(template, fields);
}
