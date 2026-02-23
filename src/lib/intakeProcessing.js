// ═══════════════════════════════════════════════════════════════
// Intake Processing Utilities
//
// Pure utility functions for mapping incoming form data to
// caregiver/client table columns. Used by the unified intake
// queue Edge Function processor.
// ═══════════════════════════════════════════════════════════════

// ─── Shared Constants ────────────────────────────────────────

/**
 * Fields to skip during mapping — form metadata, CAPTCHA, nonces, etc.
 * Shared between caregiver and client mappers.
 */
const SKIP_FIELDS = new Set([
  'api_key',
  '_field_map',
  'hub.mode',
  'hub.verify_token',
  'hub.challenge',
  'consent',
  'gdpr',
  'privacy',
  'terms',
  '_wp_nonce',
  'action',
  'form_id',
  'referer_url',
  'current_url',
  'entry',
  // Forminator/WordPress metadata fields
  'page_id',
  'form_type',
  'site_url',
  'referer',
  'submission_id',
  'submission_time',
  'date_created_sql',
  'entry_id',
  'captcha-1',
  'html-1',
  'section-1',
  'stripe-1',
  'paypal-1',
  'postdata-1',
  'upload-1',
  'signature-1',
  '_wp_http_referer',
  'nonce',
  'is_submit',
  'render_id',
  'form_module_id',
  // Forminator underscore-format metadata
  'checkbox_1',
  'consent_1',
  'form_title',
  'entry_time',
]);

/**
 * Placeholder values that indicate a test ping from Forminator.
 */
const PLACEHOLDER_VALUES = new Set([
  'first name',
  'last name',
  'first',
  'last',
  'name',
  'your name',
  'your first name',
  'your last name',
  'email address',
  'email',
  'your email',
  'phone',
  'phone number',
  'your phone',
  "i'm interested in home care services for:",
]);

// ─── Caregiver Field Map ─────────────────────────────────────
// Maps incoming field names to caregivers table columns.
// Special prefixes:
//   _full_name  → split into first_name / last_name
//   _note_subject → stored as noteSubject
//   _note_message → stored as noteMessage
//   _skip → silently dropped

const CAREGIVER_FIELD_MAP = {
  // Direct snake_case
  first_name: 'first_name',
  last_name: 'last_name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',

  // camelCase
  firstName: 'first_name',
  lastName: 'last_name',

  // Forminator hyphen format
  'name-1': '_full_name',
  'name-2': '_full_name',
  'email-1': 'email',
  'email-2': 'email',
  'phone-1': 'phone',
  'phone-2': 'phone',
  'text-1': 'first_name',
  'text-2': 'last_name',
  'address-1': 'address',

  // Forminator underscore format
  name_1_first_name: 'first_name',
  name_1_last_name: 'last_name',
  name_2_first_name: 'first_name',
  name_2_last_name: 'last_name',
  email_1: 'email',
  email_2: 'email',
  phone_1: 'phone',
  phone_2: 'phone',
  text_1: 'first_name',
  text_2: 'last_name',
  address_1_street_address: 'address',
  address_1_city: 'city',
  address_1_state: 'state',
  address_1_zip: 'zip',
  address_2_street_address: 'address',
  address_2_city: 'city',
  address_2_state: 'state',
  address_2_zip: 'zip',

  // Forminator sub-field names (when name field sends sub-properties)
  'first-name': 'first_name',
  'last-name': 'last_name',
  'middle-name': '_skip',

  // Common generic full-name fields
  name: '_full_name',
  full_name: '_full_name',
  fullname: '_full_name',

  // Subject — stored as noteSubject, NOT a column
  subject: '_note_subject',

  // Message/comments — stored as noteMessage, NOT a column (caregiver-specific)
  message: '_note_message',
  comments: '_note_message',
  notes: '_note_message',
  'textarea-1': '_note_message',
  textarea_1: '_note_message',
  your_message: '_note_message',

  // Google Ads Lead Form fields
  user_email: 'email',
  phone_number: 'phone',
  postal_code: 'zip',
  street_address: 'address',

  // Meta/Facebook Lead Ad fields
  email_fb: 'email',
  phone_number_fb: 'phone',
  zip_code: 'zip',
};

// ─── Client Field Map ────────────────────────────────────────
// Replicates the EXACT field mapping from client-intake-webhook/index.ts

const CLIENT_FIELD_MAP = {
  // Direct snake_case matches
  first_name: 'first_name',
  last_name: 'last_name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  care_recipient_name: 'care_recipient_name',
  care_recipient_age: 'care_recipient_age',
  relationship: 'relationship',
  care_needs: 'care_needs',
  hours_needed: 'hours_needed',
  start_date_preference: 'start_date_preference',
  budget_range: 'budget_range',
  insurance_info: 'insurance_info',
  priority: 'priority',
  contact_name: 'contact_name',

  // camelCase aliases
  firstName: 'first_name',
  lastName: 'last_name',
  careRecipientName: 'care_recipient_name',
  careRecipientAge: 'care_recipient_age',
  careNeeds: 'care_needs',
  hoursNeeded: 'hours_needed',
  startDatePreference: 'start_date_preference',
  budgetRange: 'budget_range',
  insuranceInfo: 'insurance_info',
  contactName: 'contact_name',

  // Forminator auto-generated field IDs — hyphen format
  'name-1': '_full_name',
  'name-2': '_full_name',
  'email-1': 'email',
  'email-2': 'email',
  'phone-1': 'phone',
  'phone-2': 'phone',
  'textarea-1': 'care_needs',
  'textarea-2': 'care_needs',
  'text-1': 'first_name',
  'text-2': 'last_name',
  'address-1': 'address',
  'select-1': 'care_needs',
  'radio-1': 'care_needs',

  // Forminator underscore format
  name_1_first_name: 'first_name',
  name_1_last_name: 'last_name',
  name_2_first_name: 'first_name',
  name_2_last_name: 'last_name',
  email_1: 'email',
  email_2: 'email',
  phone_1: 'phone',
  phone_2: 'phone',
  textarea_1: 'care_needs',
  textarea_2: 'care_needs',
  text_1: 'first_name',
  text_2: 'last_name',
  address_1_street_address: 'address',
  address_1_city: 'city',
  address_1_state: 'state',
  address_1_zip: 'zip',
  address_2_street_address: 'address',
  address_2_city: 'city',
  address_2_state: 'state',
  address_2_zip: 'zip',
  radio_1: 'care_needs',
  select_1: 'care_needs',

  // Forminator sub-field names
  'first-name': 'first_name',
  'last-name': 'last_name',
  'middle-name': '_skip',

  // Common generic names
  name: '_full_name',
  full_name: '_full_name',
  fullname: '_full_name',
  message: 'care_needs',
  comments: 'care_needs',
  notes: 'care_needs',

  // Google Ads Lead Form fields
  user_email: 'email',
  phone_number: 'phone',
  postal_code: 'zip',
  street_address: 'address',

  // Meta/Facebook Lead Ad fields
  email_fb: 'email',
  phone_number_fb: 'phone',
  zip_code: 'zip',
};

// ─── normalizePhone ──────────────────────────────────────────

/**
 * Strip non-digits from a phone string. If the result is 11 digits
 * and starts with "1" (US country code), remove the leading "1".
 *
 * @param {string} phone - Raw phone input
 * @returns {string} Digits-only phone string
 */
export function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// ─── isPlaceholderData ───────────────────────────────────────

/**
 * Returns true if ALL present identifying fields (first_name,
 * last_name, email, phone) are placeholder labels like
 * "First Name", "Email Address", etc.
 *
 * @param {Record<string, any>} data - Mapped data object
 * @returns {boolean}
 */
export function isPlaceholderData(data) {
  const fn = (data.first_name || '').toLowerCase().trim();
  const ln = (data.last_name || '').toLowerCase().trim();
  const em = (data.email || '').toLowerCase().trim();
  const ph = (data.phone || '').toLowerCase().trim();

  const fields = [fn, ln, em, ph].filter(Boolean);
  if (fields.length === 0) return true;
  return fields.every((f) => PLACEHOLDER_VALUES.has(f));
}

// ─── Internal Mapper ─────────────────────────────────────────

/**
 * Core field-mapping engine used by both caregiver and client mappers.
 *
 * @param {Record<string, any>} body - Raw form payload
 * @param {Record<string, string>} fieldMap - Field name → column mapping
 * @param {object} options
 * @param {boolean} options.normalizePhoneField - Whether to normalize phone values
 * @param {boolean} options.extractNoteFields - Whether to extract _note_subject / _note_message
 * @returns {{ mappedData, unmappedFields, noteSubject?, noteMessage? }}
 */
function mapFields(body, fieldMap, { normalizePhoneField = true, extractNoteFields = false } = {}) {
  const mappedData = {};
  const unmappedFields = {};
  let noteSubject = null;
  let noteMessage = null;

  for (const [key, value] of Object.entries(body)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;

    // Handle Forminator's Name field — may send as object with sub-fields
    // e.g. {"name-1": {"first-name": "Kevin", "last-name": "Nash"}}
    if (key.startsWith('name-') && typeof value === 'object' && value !== null) {
      const nameObj = value;
      if (nameObj['first-name'] && !mappedData.first_name) {
        mappedData.first_name = String(nameObj['first-name']).trim();
      }
      if (nameObj['last-name'] && !mappedData.last_name) {
        mappedData.last_name = String(nameObj['last-name']).trim();
      }
      if (nameObj['first_name'] && !mappedData.first_name) {
        mappedData.first_name = String(nameObj['first_name']).trim();
      }
      if (nameObj['last_name'] && !mappedData.last_name) {
        mappedData.last_name = String(nameObj['last_name']).trim();
      }
      // Fallback: if no sub-fields matched, try concatenation
      if (!mappedData.first_name && !mappedData.last_name) {
        const vals = Object.values(nameObj).filter(
          (v) => typeof v === 'string' && v.trim()
        );
        if (vals.length >= 2) {
          mappedData.first_name = String(vals[0]).trim();
          mappedData.last_name = String(vals.slice(1).join(' ')).trim();
        } else if (vals.length === 1) {
          const parts = String(vals[0]).trim().split(/\s+/);
          mappedData.first_name = parts[0] || '';
          mappedData.last_name = parts.slice(1).join(' ') || '';
        }
      }
      continue;
    }

    // Handle other Forminator object fields (e.g. address-1 as object)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal === null || subVal === undefined || subVal === '') continue;
        const subMapped = fieldMap[subKey];
        if (subMapped && subMapped !== '_skip' && subMapped !== '_full_name' && !mappedData[subMapped]) {
          mappedData[subMapped] = String(subVal).trim();
        }
      }
      continue;
    }

    const mappedField = fieldMap[key];

    if (mappedField === '_skip') continue;

    if (mappedField === '_full_name') {
      // Split full name into first + last
      const parts = String(value).trim().split(/\s+/);
      if (!mappedData.first_name) mappedData.first_name = parts[0] || '';
      if (!mappedData.last_name) mappedData.last_name = parts.slice(1).join(' ') || '';
    } else if (extractNoteFields && mappedField === '_note_subject') {
      if (!noteSubject) noteSubject = String(value).trim();
    } else if (extractNoteFields && mappedField === '_note_message') {
      if (!noteMessage) noteMessage = String(value).trim();
    } else if (mappedField) {
      // First match wins — normalize phone if needed
      if (!mappedData[mappedField]) {
        const trimmed = String(value).trim();
        if (normalizePhoneField && mappedField === 'phone') {
          mappedData[mappedField] = normalizePhone(trimmed);
        } else {
          mappedData[mappedField] = trimmed;
        }
      }
    } else {
      unmappedFields[key] = value;
    }
  }

  const result = { mappedData, unmappedFields };
  if (extractNoteFields) {
    result.noteSubject = noteSubject;
    result.noteMessage = noteMessage;
  }
  return result;
}

// ─── mapCaregiverFields ──────────────────────────────────────

/**
 * Map incoming form payload to caregivers table columns.
 *
 * @param {Record<string, any>} rawPayload - Raw form data
 * @returns {{
 *   caregiverData: Record<string, any>,
 *   unmappedFields: Record<string, any>,
 *   noteSubject: string|null,
 *   noteMessage: string|null
 * }}
 */
export function mapCaregiverFields(rawPayload) {
  const { mappedData, unmappedFields, noteSubject, noteMessage } = mapFields(
    rawPayload,
    CAREGIVER_FIELD_MAP,
    { normalizePhoneField: true, extractNoteFields: true }
  );

  return {
    caregiverData: mappedData,
    unmappedFields,
    noteSubject: noteSubject || null,
    noteMessage: noteMessage || null,
  };
}

// ─── mapClientFields ─────────────────────────────────────────

/**
 * Map incoming form payload to clients table columns.
 * Replicates the exact field mapping from client-intake-webhook/index.ts.
 *
 * @param {Record<string, any>} rawPayload - Raw form data
 * @returns {{
 *   clientData: Record<string, any>,
 *   unmappedFields: Record<string, any>
 * }}
 */
export function mapClientFields(rawPayload) {
  const { mappedData, unmappedFields } = mapFields(
    rawPayload,
    CLIENT_FIELD_MAP,
    { normalizePhoneField: true, extractNoteFields: false }
  );

  return {
    clientData: mappedData,
    unmappedFields,
  };
}

// ─── buildInitialNote ────────────────────────────────────────

/**
 * Build the initial auto-note for a newly created caregiver/client.
 *
 * @param {string} source - Source identifier (e.g. "wordpress", "google_ads")
 * @param {string|null} label - Optional label (e.g. "Contact Form")
 * @param {Record<string, any>|null} unmappedFields - Fields that didn't map
 * @param {string|null} extraText - Additional text (subject + message)
 * @returns {{ text: string, type: 'auto', timestamp: number, author: 'Intake Webhook' }}
 */
export function buildInitialNote(source, label, unmappedFields, extraText) {
  const labelPart = label ? ` (${label})` : '';
  let text = `Caregiver created via ${source}${labelPart}.`;

  if (extraText) {
    text += `\n\n${extraText}`;
  }

  if (unmappedFields && Object.keys(unmappedFields).length > 0) {
    const summary = Object.entries(unmappedFields)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    text += `\n\nAdditional form data:\n${summary}`;
  }

  return {
    text,
    type: 'auto',
    timestamp: Date.now(),
    author: 'Intake Webhook',
  };
}
