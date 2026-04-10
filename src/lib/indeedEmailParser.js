// ═══════════════════════════════════════════════════════════════
// Indeed Email Parser
//
// Pure utility functions for extracting applicant data from
// Indeed notification emails. Used by the indeed-email-parser
// Edge Function.
//
// Indeed sends employer notification emails when someone applies.
// This module parses those emails into structured applicant data
// that can be pushed into the intake_queue.
// ═══════════════════════════════════════════════════════════════

/**
 * Known Indeed sender addresses. Emails from these addresses
 * are treated as Indeed application notifications.
 */
export const INDEED_SENDERS = [
  'indeedapply@indeed.com',
  'alert@indeed.com',
  'noreply@indeed.com',
];

/**
 * Check whether an email address is from Indeed.
 * @param {string} sender - The from/sender email address
 * @returns {boolean}
 */
export function isIndeedEmail(sender) {
  if (!sender) return false;
  const lower = sender.toLowerCase().trim();
  return lower.endsWith('@indeed.com');
}

/**
 * Parse the subject line of an Indeed notification email.
 *
 * Known formats:
 *   "Indeed Application: {Job Title} - {Applicant Name}"
 *   "{Applicant Name} applied to your {Job Title} job"
 *   "New application: {Job Title}"
 *
 * @param {string} subject
 * @returns {{ applicantName: string|null, jobTitle: string|null }}
 */
export function parseSubject(subject) {
  if (!subject) return { applicantName: null, jobTitle: null };

  // Format 1: "Indeed Application: Job Title - Applicant Name"
  const fmt1 = subject.match(/Indeed Application:\s*(.+?)\s*-\s*([^-]+)$/i);
  if (fmt1) {
    return {
      jobTitle: fmt1[1].trim(),
      applicantName: fmt1[2].trim(),
    };
  }

  // Format 2: "Applicant Name applied to your Job Title job"
  const fmt2 = subject.match(/^(.+?)\s+applied to (?:your\s+)?(.+?)(?:\s+job)?$/i);
  if (fmt2) {
    return {
      applicantName: fmt2[1].trim(),
      jobTitle: fmt2[2].trim(),
    };
  }

  // Format 3: "New application: Job Title"
  const fmt3 = subject.match(/New application:\s*(.+)$/i);
  if (fmt3) {
    return {
      applicantName: null,
      jobTitle: fmt3[1].trim(),
    };
  }

  return { applicantName: null, jobTitle: null };
}

/**
 * Split a full name into first and last name.
 * @param {string} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
export function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Extract a labeled value from HTML text content.
 * Looks for patterns like "Email: value" or "Email value" in text.
 *
 * @param {string} text - Plain text extracted from HTML
 * @param {string[]} labels - Labels to look for (e.g., ['Email', 'E-mail'])
 * @returns {string|null}
 */
function extractLabeledValue(text, labels) {
  // Sort labels longest-first so "Phone Number" matches before "Phone"
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  for (const label of sorted) {
    // Pattern: "Label: value" or "Label value" on same or next line
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      escaped + '\\s*:\\s*([^\\n<]+)',
      'i'
    );
    const m = text.match(re);
    if (m && m[1].trim()) {
      return m[1].trim();
    }
  }
  return null;
}

/**
 * Extract email address from text using regex.
 * @param {string} text
 * @returns {string|null}
 */
export function extractEmail(text) {
  if (!text) return null;
  // Look for labeled email first
  const labeled = extractLabeledValue(text, ['Email', 'E-mail', 'Email Address']);
  if (labeled) {
    // Validate it looks like an email
    const emailMatch = labeled.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    if (emailMatch) return emailMatch[0].toLowerCase();
  }
  // Fallback: find any email address in the text (exclude indeed.com addresses)
  const allEmails = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/g);
  if (allEmails) {
    const nonIndeed = allEmails.find(e => !e.toLowerCase().endsWith('@indeed.com'));
    if (nonIndeed) return nonIndeed.toLowerCase();
  }
  return null;
}

/**
 * Extract phone number from text.
 * @param {string} text
 * @returns {string|null} - Raw phone string (not normalized)
 */
export function extractPhone(text) {
  if (!text) return null;
  // Look for labeled phone first
  const labeled = extractLabeledValue(text, ['Phone', 'Phone Number', 'Tel', 'Mobile', 'Cell']);
  if (labeled) {
    // Validate it looks like a phone number (at least 7 digits)
    const digits = labeled.replace(/\D/g, '');
    if (digits.length >= 7) return labeled;
  }
  // Fallback: find phone-like patterns
  const phonePatterns = [
    /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
    /\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  ];
  for (const pattern of phonePatterns) {
    const m = text.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/**
 * Extract location (city, state) from text.
 * @param {string} text
 * @returns {{ city: string|null, state: string|null }}
 */
export function extractLocation(text) {
  if (!text) return { city: null, state: null };

  // Look for labeled location
  const labeled = extractLabeledValue(text, ['Location', 'City', 'Address']);
  if (labeled) {
    return parseLocation(labeled);
  }

  // Look for "City, ST" pattern anywhere in text (2-letter state abbreviation)
  // Use [^\n,]+ to avoid spanning across newlines
  const cityState = text.match(/([A-Z][a-zA-Z ]+),\s*([A-Z]{2})\b/);
  if (cityState) {
    return {
      city: cityState[1].trim(),
      state: cityState[2].trim(),
    };
  }

  return { city: null, state: null };
}

/**
 * Parse a location string like "Houston, TX" or "Santa Ana, CA 92705"
 * @param {string} locationStr
 * @returns {{ city: string|null, state: string|null }}
 */
export function parseLocation(locationStr) {
  if (!locationStr) return { city: null, state: null };

  // "City, ST" or "City, ST ZIP"
  const m = locationStr.match(/^([^,]+),\s*([A-Z]{2})\b/i);
  if (m) {
    return {
      city: m[1].trim(),
      state: m[2].trim().toUpperCase(),
    };
  }

  // Just a state abbreviation
  const stateOnly = locationStr.match(/^([A-Z]{2})$/i);
  if (stateOnly) {
    return { city: null, state: stateOnly[1].toUpperCase() };
  }

  // Just a city name (no comma)
  return { city: locationStr.trim(), state: null };
}

/**
 * Strip HTML tags and decode common entities to get plain text.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html) return '';
  return html
    // Replace <br>, <br/>, <br /> with newlines
    .replace(/<br\s*\/?>/gi, '\n')
    // Replace </p>, </div>, </tr> with newlines
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    // Collapse multiple newlines
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/**
 * Normalize a phone number to 10 digits.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * Parse an Indeed notification email into structured applicant data.
 *
 * @param {object} options
 * @param {string} options.subject - Email subject line
 * @param {string} options.body - Email body (HTML or plain text)
 * @param {string} [options.sender] - Sender email address
 * @param {string} [options.receivedAt] - ISO timestamp when email was received
 * @param {string} [options.messageId] - Unique email message ID (for dedup)
 * @returns {{ success: boolean, data: object|null, error: string|null }}
 */
export function parseIndeedEmail({ subject, body, sender, receivedAt, messageId }) {
  // Verify this is from Indeed
  if (sender && !isIndeedEmail(sender)) {
    return { success: false, data: null, error: 'Not an Indeed email' };
  }

  // Parse subject line
  const { applicantName, jobTitle } = parseSubject(subject);

  // Strip HTML to get plain text for extraction
  const plainText = stripHtml(body || '');

  // Extract name (prefer body, fall back to subject)
  let firstName = '';
  let lastName = '';

  if (applicantName) {
    const split = splitName(applicantName);
    firstName = split.firstName;
    lastName = split.lastName;
  }

  // Extract contact info from body
  const email = extractEmail(plainText);
  const rawPhone = extractPhone(plainText);
  const phone = normalizePhone(rawPhone || '');
  const { city, state } = extractLocation(plainText);

  // We need at minimum a name or email to create a useful record
  const hasMinimum = firstName || email;
  if (!hasMinimum) {
    return {
      success: false,
      data: null,
      error: 'Could not extract applicant name or email from Indeed notification',
    };
  }

  return {
    success: true,
    data: {
      first_name: firstName,
      last_name: lastName,
      email: email || '',
      phone: phone,
      city: city || '',
      state: state || '',
      source: 'Indeed',
      source_detail: jobTitle || '',
      // Metadata for intake queue note
      _jobTitle: jobTitle || '',
      _receivedAt: receivedAt || '',
      _messageId: messageId || '',
    },
    error: null,
  };
}
