// src/lib/trelloParser.js
// Trello card parsing utilities for import script.

// Known annotation keywords that indicate a dash-separated suffix is an
// annotation rather than a hyphenated surname component.
const ANNOTATION_KEYWORDS = [
  'on call', 'resigned', 'medical', 'moved', 'leave',
  'on hold', 'open shifts', 'only rn', 'withdrew',
];

/**
 * Parse a Trello card title into firstName, lastName, and optional annotation.
 *
 * Annotations may appear in parentheses at the end, e.g. "(Web)" or "(SL)",
 * or after a dash when the suffix matches a known keyword or contains a space.
 */
function parseName(cardTitle) {
  let name = (cardTitle || '').trim();
  let annotation = null;

  // 1. Strip parenthetical annotation at the end: "Name (annotation)"
  const parenMatch = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    name = parenMatch[1].trim();
    annotation = parenMatch[2].trim();
  }

  // 2. Check for dash-annotation. A dash separates an annotation (not a
  //    hyphenated surname) when the part after the dash contains a space OR
  //    matches a known annotation keyword (case-insensitive).
  if (!annotation) {
    const dashIdx = name.lastIndexOf('-');
    if (dashIdx > 0) {
      const afterDash = name.substring(dashIdx + 1);
      const afterDashLower = afterDash.toLowerCase();
      const isAnnotation =
        afterDash.includes(' ') ||
        ANNOTATION_KEYWORDS.some((kw) => afterDashLower.startsWith(kw));

      if (isAnnotation) {
        annotation = afterDash;
        name = name.substring(0, dashIdx).trim();
      }
    }
  }

  // 3. Split into first / last on the first space.
  const spaceIdx = name.indexOf(' ');
  let firstName, lastName;
  if (spaceIdx === -1) {
    firstName = name;
    lastName = '';
  } else {
    firstName = name.substring(0, spaceIdx);
    lastName = name.substring(spaceIdx + 1).trim();
  }

  return { firstName, lastName, annotation };
}

/**
 * Normalize a phone string to a 10-digit US number (no country code).
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.substring(1);
  }
  return digits;
}

/**
 * Extract structured fields from a Trello card description.
 *
 * Handles multiple formats:
 *   - Template: "**Full Address:** …", "**Phone No.** …", "**Email:** …"
 *   - Simple: "Phone: +15868720633"
 *   - Meta lead: "Email: foo@bar.com Phone: +17145489690 City: …"
 *   - HCA data: "**HCA PER ID:** …", "**HCA Expiration:** …"
 */
function parseDescription(desc) {
  if (!desc) return {};
  const result = {};

  // --- Email ---
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const emailMatch = desc.match(emailRegex);
  if (emailMatch) {
    result.email = emailMatch[0].toLowerCase();
  }

  // --- Phone ---
  // Try explicit "Phone" label first
  const phoneLabel = /Phone(?:\s*No)?\.?\*?\*?\s*[:*]*\s*(\+?[\d(][\d\s().+-]+\d)/i;
  const phoneLabelMatch = desc.match(phoneLabel);
  if (phoneLabelMatch) {
    result.phone = normalizePhone(phoneLabelMatch[1]);
  } else {
    // Fallback: any phone-like sequence of 9+ digit-chars
    const phoneFallback = /\+?\d[\d\s().+-]{8,}\d/;
    const fallbackMatch = desc.match(phoneFallback);
    if (fallbackMatch) {
      result.phone = normalizePhone(fallbackMatch[0]);
    }
  }

  // --- Address (template format) ---
  const addressLine = /Full\s+Address[:\s*]*(.+)/i;
  const addrMatch = desc.match(addressLine);
  if (addrMatch) {
    const raw = addrMatch[1].replace(/\*+/g, '').trim();

    // Work backward from state+zip at the end:
    //   "11609 Stamy Rd La Mirada CA, 90638"
    //   → zip=90638, state=CA, then split the rest into street + city
    const tailMatch = raw.match(/^(.+)\s+([A-Z]{2}),?\s*(\d{5})$/);
    if (tailMatch) {
      const beforeState = tailMatch[1].trim(); // "11609 Stamy Rd La Mirada"
      result.state = tailMatch[2];
      result.zip = tailMatch[3];

      // Find city boundary by locating the last street suffix word.
      // Everything up to and including the suffix = street address.
      // Everything after = city name.
      const streetSuffixes =
        /\b(Rd|St|Ave|Dr|Blvd|Way|Ct|Ln|Pl|Cir|Pkwy|Hwy|Street|Road|Avenue|Drive|Boulevard|Lane|Place|Court|Circle|Terrace|Ter|Trail|Trl)\.?\b/gi;
      let lastSuffixEnd = -1;
      let m;
      while ((m = streetSuffixes.exec(beforeState)) !== null) {
        // Also include any unit/apt suffix right after, e.g. "#4"
        lastSuffixEnd = m.index + m[0].length;
      }

      if (lastSuffixEnd > 0 && lastSuffixEnd < beforeState.length) {
        // Check for unit number after suffix, e.g. "Street #4,"
        let rest = beforeState.substring(lastSuffixEnd);
        const unitMatch = rest.match(/^(\s*#\S+,?|\s*,)/);
        if (unitMatch) {
          lastSuffixEnd += unitMatch[0].length;
          rest = beforeState.substring(lastSuffixEnd);
        }
        result.address = beforeState.substring(0, lastSuffixEnd).trim().replace(/,$/, '');
        result.city = rest.trim().replace(/,$/, '');
      } else {
        result.address = beforeState;
      }
    } else {
      // Store whole line as address
      result.address = raw;
    }
  }

  // --- HCA PER ID ---
  const perIdMatch = desc.match(/PER\s*ID[:\s*]*(\d{7,})/i);
  if (perIdMatch) {
    result.per_id = perIdMatch[1];
  }

  // --- HCA Expiration ---
  const expMatch = desc.match(
    /Expir(?:ation|es?)[:\s*]*([\d]{4}-[\d]{2}-[\d]{2})/i
  );
  if (expMatch) {
    result.hca_expiration = expMatch[1];
  } else {
    const expSlash = desc.match(
      /Expir(?:ation|es?)[:\s*]*(\d{2}\/\d{2}\/\d{4})/i
    );
    if (expSlash) {
      result.hca_expiration = expSlash[1];
    }
  }

  return result;
}

/**
 * Map Trello checklist items to portal task IDs using a mapping dictionary.
 *
 * @param {Array} checklists - Array of Trello checklist objects, each with
 *   `name` (string) and `checkItems` (array of {name, state}).
 * @param {Object} taskMap - Dict mapping Trello item name → portal task ID.
 * @returns {{ tasks: Object, unmapped: string[] }}
 */
function mapChecklists(checklists, taskMap) {
  const tasks = {};
  const unmapped = [];

  for (const checklist of checklists) {
    for (const item of checklist.checkItems) {
      const portalTaskId = taskMap[item.name];
      if (portalTaskId) {
        tasks[portalTaskId] = {
          completed: item.state === 'complete',
          completedBy: 'trello-import',
        };
      } else {
        unmapped.push(item.name);
      }
    }
  }

  return { tasks, unmapped };
}

/**
 * Convert Trello comment objects to the portal notes format.
 *
 * Portal notes are: { text, type, timestamp (ms), author }
 *
 * @param {Array} comments - Array of { text, date (ISO), by }
 * @returns {Array} Notes array, preserving original order.
 */
function convertComments(comments) {
  return comments.map((c) => ({
    text: c.text,
    type: 'note',
    timestamp: new Date(c.date).getTime(),
    author: c.by + ' (via Trello)',
  }));
}

module.exports = { parseName, parseDescription, mapChecklists, convertComments, normalizePhone };
