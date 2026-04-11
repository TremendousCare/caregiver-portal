// ═══════════════════════════════════════════════════════════════
// Indeed CSV Parser
//
// Parses CSV files exported from Indeed's employer dashboard
// and maps them to caregiver records for bulk import.
// ═══════════════════════════════════════════════════════════════

import { normalizePhone } from './intakeProcessing';

// ─── CSV Parsing ─────────────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the header row as keys.
 * Handles quoted fields (including fields with commas and newlines inside quotes).
 *
 * @param {string} csvText - Raw CSV file content
 * @returns {Record<string, string>[]} Array of row objects
 */
export function parseCsv(csvText) {
  const rows = [];
  const lines = splitCsvLines(csvText.trim());
  if (lines.length < 2) return rows;

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.every((v) => !v.trim())) continue; // skip empty rows
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim();
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Split CSV text into logical lines, respecting quoted fields that may
 * contain newlines.
 */
function splitCsvLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++; // skip \r\n
      if (current.length > 0) lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Parse a single CSV line into an array of field values.
 * Handles double-quoted fields and escaped quotes ("").
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ─── Indeed Row Mapping ──────────────────────────────────────

/**
 * Split a full name into first and last name.
 * Handles single names, multi-part last names, etc.
 *
 * @param {string} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
export function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

/**
 * Split "City, ST" or "City, ST ZIP" into city and state.
 *
 * @param {string} location - e.g. "Anaheim, CA" or "Huntington Beach, CA"
 * @returns {{ city: string, state: string }}
 */
export function splitLocation(location) {
  if (!location) return { city: '', state: '' };
  const parts = location.split(',').map((p) => p.trim());
  if (parts.length < 2) return { city: location.trim(), state: '' };
  // State might have a zip appended — take just the state abbreviation
  const statePart = parts[1].split(/\s+/)[0] || '';
  return {
    city: parts[0],
    state: statePart,
  };
}

/**
 * Map a single parsed Indeed CSV row to caregiver data.
 *
 * @param {Record<string, string>} row - Parsed CSV row
 * @returns {{ caregiverData: object, noteText: string }}
 */
export function mapIndeedRow(row) {
  const { firstName, lastName } = splitName(row.name || '');
  const { city, state } = splitLocation(row['candidate location'] || '');
  const phone = normalizePhone(row.phone || '');

  const caregiverData = {
    firstName,
    lastName,
    phone,
    email: row.email || '',
    city,
    state,
    source: 'Indeed',
    sourceDetail: row.source || 'Indeed',
    applicationDate: row.date || new Date().toISOString().slice(0, 10),
  };

  // Build a note with the extra info from Indeed
  const noteParts = ['Imported from Indeed CSV.'];
  if (row['relevant experience']) noteParts.push(`Experience: ${row['relevant experience']}`);
  if (row.education) noteParts.push(`Education: ${row.education}`);
  if (row['job title']) noteParts.push(`Applied for: ${row['job title']}`);
  if (row['job location']) noteParts.push(`Job location: ${row['job location']}`);
  if (row.source) noteParts.push(`Source: ${row.source}`);
  if (row.date) noteParts.push(`Application date: ${row.date}`);

  const noteText = noteParts.join('\n');

  return { caregiverData, noteText };
}

/**
 * Build a note object from the Indeed import note text.
 *
 * @param {string} noteText
 * @returns {{ text: string, type: string, timestamp: number, author: string }}
 */
export function buildIndeedNote(noteText) {
  return {
    text: noteText,
    type: 'auto',
    timestamp: Date.now(),
    author: 'Indeed Import',
  };
}

/**
 * Validate that a mapped row has minimum required data.
 * Needs at least a name and either phone or email.
 *
 * @param {{ firstName: string, lastName: string, phone: string, email: string }} data
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateIndeedRow(data) {
  if (!data.firstName && !data.lastName) {
    return { valid: false, reason: 'Missing name' };
  }
  if (!data.phone && !data.email) {
    return { valid: false, reason: 'Missing phone and email' };
  }
  return { valid: true };
}

/**
 * Process an entire Indeed CSV string into an array of import-ready records.
 *
 * @param {string} csvText - Raw CSV file content
 * @returns {{ records: Array<{ caregiverData: object, note: object }>, skipped: Array<{ row: number, name: string, reason: string }> }}
 */
export function processIndeedCsv(csvText) {
  const rows = parseCsv(csvText);
  const records = [];
  const skipped = [];

  rows.forEach((row, index) => {
    const { caregiverData, noteText } = mapIndeedRow(row);
    const validation = validateIndeedRow(caregiverData);

    if (!validation.valid) {
      skipped.push({
        row: index + 2, // +2 for 1-based + header row
        name: row.name || '(empty)',
        reason: validation.reason,
      });
      return;
    }

    records.push({
      caregiverData,
      note: buildIndeedNote(noteText),
    });
  });

  return { records, skipped };
}
