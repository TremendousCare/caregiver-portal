/**
 * Merge field resolution for bulk messaging.
 * Resolves {{field}} placeholders in message templates.
 */

/**
 * Resolve merge fields for a caregiver record.
 *
 * Supported placeholders (mirrors the server-side resolver in
 * supabase/functions/_shared/helpers/mergeFields.ts):
 *   snake_case: {{first_name}}, {{last_name}}, {{phone}}, {{email}}, {{phase}}
 *   camelCase:  {{firstName}},  {{lastName}},  {{fullName}}
 *
 * Used for the bulk SMS preview (one example recipient) — the server
 * does the per-recipient substitution at send time. Both naming
 * conventions exist because admin-managed Message Templates from the
 * `message_templates` table use camelCase, while legacy bulk SMS hint
 * text uses snake_case.
 */
export function resolveCaregiverMergeFields(template, caregiver) {
  if (!template) return '';
  const firstName = caregiver?.firstName || '';
  const lastName = caregiver?.lastName || '';
  const fullName = `${firstName} ${lastName}`.trim();
  return template
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{last_name\}\}/gi, lastName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{lastName\}\}/g, lastName)
    .replace(/\{\{fullName\}\}/g, fullName)
    .replace(/\{\{phone\}\}/gi, caregiver?.phone || '')
    .replace(/\{\{email\}\}/gi, caregiver?.email || '')
    .replace(/\{\{phase\}\}/gi, caregiver?.phaseOverride || '');
}

/**
 * Resolve merge fields for a client record.
 * Fields: {{firstName}}, {{lastName}}, {{phone}}, {{email}}, {{careRecipientName}}, {{contactName}}, {{phase}}
 */
export function resolveClientMergeFields(template, client) {
  if (!template) return '';
  return template
    .replace(/\{\{firstName\}\}/gi, client?.firstName || '')
    .replace(/\{\{lastName\}\}/gi, client?.lastName || '')
    .replace(/\{\{phone\}\}/gi, client?.phone || '')
    .replace(/\{\{email\}\}/gi, client?.email || '')
    .replace(/\{\{careRecipientName\}\}/gi, client?.careRecipientName || '')
    .replace(/\{\{contactName\}\}/gi, client?.contactName || '')
    .replace(/\{\{phase\}\}/gi, client?.phase || '');
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX).
 * Returns null if the number is invalid or missing.
 */
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
