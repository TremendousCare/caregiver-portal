// ═══════════════════════════════════════════════════════════════
// mycnajobs Resume Parser
//
// Maps the structured JSON returned by the parse-resume-pdf edge
// function into the `caregiverData` shape used by the existing
// addCaregiver flow (mirrors src/lib/indeedCsvParser.js).
//
// Edge function returns ExtractedResume; this module handles:
//   - Field mapping into caregiverData
//   - Validation (need name + (phone || email) at minimum)
//   - Note generation from the rich resume content
//   - Duplicate detection vs existing caregivers
// ═══════════════════════════════════════════════════════════════

import { normalizePhone } from './intakeProcessing';

// ─── State normalization ─────────────────────────────────────

const US_STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

/**
 * Normalize a state value to its 2-letter US abbreviation when possible.
 * Returns the input untouched if it's already 2 chars or unrecognized.
 *
 * @param {string} state
 * @returns {string}
 */
export function normalizeState(state) {
  if (!state) return '';
  const trimmed = state.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  return US_STATE_ABBR[lower] || trimmed;
}

// ─── Mapping ─────────────────────────────────────────────────

/**
 * Map a Claude-extracted resume into the caregiverData shape consumed
 * by addCaregiver. Mirrors src/lib/indeedCsvParser.js → mapIndeedRow.
 *
 * @param {object} extracted - Output of parse-resume-pdf edge function
 * @param {object} [opts]
 * @param {string} [opts.fileName] - Original filename, included in the note for traceability
 * @returns {{ caregiverData: object, noteText: string }}
 */
export function mapResumeToCaregiver(extracted, opts = {}) {
  const fileName = opts.fileName || '';
  const e = extracted || {};

  const caregiverData = {
    firstName: (e.firstName || '').trim(),
    lastName: (e.lastName || '').trim(),
    phone: normalizePhone(e.phone || ''),
    email: (e.email || '').trim(),
    city: (e.city || '').trim(),
    state: normalizeState(e.state || ''),
    source: 'mycnajobs',
    sourceDetail: 'mycnajobs.com',
    applicationDate: new Date().toISOString().slice(0, 10),
  };

  const noteText = buildNoteText(e, fileName);

  return { caregiverData, noteText };
}

/**
 * Build a structured, human-readable note from the extracted resume.
 * Includes everything that doesn't fit on the caregiver record itself
 * (years experience, certifications, specializations, free-text essays).
 *
 * @param {object} e - Extracted resume
 * @param {string} fileName
 * @returns {string}
 */
export function buildNoteText(e, fileName = '') {
  const lines = [];

  lines.push(`Imported from mycnajobs.com${fileName ? ` (${fileName})` : ''}.`);

  if (typeof e.yearsExperience === 'number' && e.yearsExperience > 0) {
    lines.push(`Experience: ${e.yearsExperience} year${e.yearsExperience === 1 ? '' : 's'}`);
  }
  if (e.lastEmployer) {
    lines.push(`Last employer: ${e.lastEmployer}`);
  }
  if (typeof e.willingToTravelMiles === 'number' && e.willingToTravelMiles > 0) {
    lines.push(`Willing to travel: ${e.willingToTravelMiles} miles`);
  }
  if (e.canLegallyDrive) {
    lines.push('Can legally drive: yes');
  }

  if (Array.isArray(e.availability) && e.availability.length > 0) {
    lines.push(`Availability: ${e.availability.join(', ')}`);
  }

  if (Array.isArray(e.certifications) && e.certifications.length > 0) {
    lines.push('');
    lines.push('Certifications:');
    e.certifications.forEach((c) => {
      const parts = [`  • ${c.type || 'Unknown'}`];
      const sub = [];
      if (c.attended) sub.push(`Attended: ${c.attended}`);
      if (c.date) sub.push(`Date: ${c.date}`);
      if (c.licenseNumber) sub.push(`License #: ${c.licenseNumber}`);
      if (sub.length > 0) parts.push(`(${sub.join(' | ')})`);
      lines.push(parts.join(' '));
    });
  }

  if (Array.isArray(e.specializations) && e.specializations.length > 0) {
    lines.push('');
    lines.push(`Specializations: ${e.specializations.join(', ')}`);
  }

  if (e.whyHireMe) {
    lines.push('');
    lines.push('Why Hire Me?');
    lines.push(e.whyHireMe);
  }

  if (e.whyCaregiver) {
    lines.push('');
    lines.push('Why I Want To Be A Caregiver:');
    lines.push(e.whyCaregiver);
  }

  return lines.join('\n');
}

/**
 * Build the note object stored on the caregiver record.
 * Matches the shape used by buildIndeedNote.
 *
 * @param {string} noteText
 * @returns {{ text: string, type: string, timestamp: number, author: string }}
 */
export function buildResumeNote(noteText) {
  return {
    text: noteText,
    type: 'auto',
    timestamp: Date.now(),
    author: 'mycnajobs Import',
  };
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate that a mapped record has minimum required data.
 * Mirrors src/lib/indeedCsvParser.js → validateIndeedRow.
 *
 * @param {{ firstName: string, lastName: string, phone: string, email: string }} data
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateResume(data) {
  if (!data.firstName && !data.lastName) {
    return { valid: false, reason: 'Missing name' };
  }
  if (!data.phone && !data.email) {
    return { valid: false, reason: 'Missing phone and email' };
  }
  return { valid: true };
}

// ─── Duplicate detection ─────────────────────────────────────

/**
 * Annotate each pending record with isDuplicate / dupReason flags
 * based on phone or email match against the existing caregiver list.
 * Mirrors the pattern in IndeedImport.jsx → findDuplicates.
 *
 * @param {Array<{ caregiverData: object }>} records
 * @param {Array<object>} existingCaregivers
 * @returns {Array<object>} Records with isDuplicate/dupReason added
 */
export function findDuplicates(records, existingCaregivers) {
  const existingPhones = new Set();
  const existingEmails = new Set();

  existingCaregivers.forEach((cg) => {
    if (cg.phone) existingPhones.add(normalizePhone(cg.phone));
    if (cg.email) existingEmails.add(cg.email.toLowerCase());
  });

  return records.map((r) => {
    const phone = r.caregiverData.phone;
    const email = r.caregiverData.email?.toLowerCase();
    const dupByPhone = phone && existingPhones.has(phone);
    const dupByEmail = email && existingEmails.has(email);
    return {
      ...r,
      isDuplicate: dupByPhone || dupByEmail,
      dupReason: dupByPhone ? 'Phone already exists' : dupByEmail ? 'Email already exists' : null,
    };
  });
}

// ─── End-to-end pipeline ─────────────────────────────────────

/**
 * Process one extracted resume into a preview-ready record.
 * Returns either { record } or { skipped }.
 *
 * @param {object} extracted - Output of parse-resume-pdf
 * @param {string} fileName
 * @returns {{ record?: object, skipped?: { fileName: string, reason: string } }}
 */
export function processExtractedResume(extracted, fileName) {
  const { caregiverData, noteText } = mapResumeToCaregiver(extracted, { fileName });
  const validation = validateResume(caregiverData);

  if (!validation.valid) {
    return {
      skipped: {
        fileName: fileName || '(unnamed)',
        reason: validation.reason,
      },
    };
  }

  return {
    record: {
      caregiverData,
      note: buildResumeNote(noteText),
      fileName: fileName || '',
      // Keep the raw extraction around so the preview UI can show the rich
      // fields without re-fetching, and the user can edit before import.
      extracted,
    },
  };
}
