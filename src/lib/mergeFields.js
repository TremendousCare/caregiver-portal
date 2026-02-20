/**
 * Merge field resolution for bulk messaging.
 * Resolves {{field}} placeholders in message templates.
 */

/**
 * Resolve merge fields for a caregiver record.
 * Fields: {{first_name}}, {{last_name}}, {{phone}}, {{email}}, {{phase}}
 */
export function resolveCaregiverMergeFields(template, caregiver) {
  if (!template) return '';
  return template
    .replace(/\{\{first_name\}\}/gi, caregiver?.firstName || '')
    .replace(/\{\{last_name\}\}/gi, caregiver?.lastName || '')
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
