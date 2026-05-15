// Parser for the structured contact section in BD Trello card
// descriptions. The board uses a consistent template:
//
//   **Name, Title | Phone | Email | LinkedIn**
//   - Ashley Kroslin, RSD | (949)854-9500 (c) | [EMAIL]
//   - Melissa Goldman, Director of Nursing | (949)509-2216 | melissa.goldman@humangood.org
//   - Sheila [LAST NAME], [TITLE] | [PHONE] | [EMAIL] | [LinkedIn]
//
// Empty fields appear as the literal placeholder words ("Phone",
// "Email", "Title", "[PHONE]", "[EMAIL]", etc.). Phone numbers carry
// optional kind suffixes: "(c)" = cell, "(o)" = office, "x123" = office
// extension. Emails may be wrapped in markdown links.
//
// All exports are pure functions so the same module powers both the
// vitest suite and the bd-trello-enrich-contacts edge function via the
// cross-tree import pattern documented in service-plan-extend-ongoing.

const PLACEHOLDER_TITLE = /^\[?\s*title\s*\]?$/i;
const PLACEHOLDER_PHONE = /^\[?\s*phone\s*\]?$/i;
const PLACEHOLDER_EMAIL = /^\[?\s*email\s*\]?$/i;
const PLACEHOLDER_LINKEDIN = /^\[?\s*linkedin\s*\]?$/i;
const NAME_BRACKET_TOKENS = /\[(?:last\s*name|first\s*name|name)\]/gi;

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_DIGITS_REGEX = /\d[\d\s().+\-x]{7,}\d/;

// Match a markdown link [text](url "optional title") and return the
// inner text. Used to unwrap email values like
// [foo@bar.com](mailto:foo@bar.com).
function unwrapMarkdownLink(s) {
  const m = s.match(/^\[([^\]]+)\]\([^)]*\)$/);
  return m ? m[1].trim() : s;
}

// Strip leading markdown bullet markers (`-`, `*`, `+`).
function stripBullet(line) {
  return line.replace(/^\s*[-*+]\s+/, "");
}

// Strip surrounding bold/italic markers so a header line like
// "**Name, Title | Phone | Email | LinkedIn**" is recognizable.
function stripEmphasis(s) {
  return s.replace(/^\**(.*?)\**$/, "$1").trim();
}

function isHeaderLine(firstSegment) {
  // The card template's header has the literal words "Name" or
  // "Contact" in the name slot and "Title" in the title slot.
  const cleaned = stripEmphasis(firstSegment);
  const [namePart, titlePart] = cleaned.split(",").map((p) => (p ?? "").trim());
  if (!namePart || !titlePart) return false;
  const isNameWord  = /^(name|contact)$/i.test(namePart);
  const isTitleWord = /^title$/i.test(titlePart);
  return isNameWord && isTitleWord;
}

export function normalizeContactName(name) {
  if (!name) return "";
  return name
    .replace(NAME_BRACKET_TOKENS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Parse a phone segment into { value, kind }.
//   value: cleaned display string with the kind hint stripped, or null
//   kind:  'mobile' | 'office' | null
function parsePhoneSegment(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { value: null, kind: null };
  if (PLACEHOLDER_PHONE.test(trimmed)) return { value: null, kind: null };

  // Verify there's actually a phone-like sequence, not just stray text.
  if (!PHONE_DIGITS_REGEX.test(trimmed)) return { value: null, kind: null };

  let kind = null;
  let working = trimmed;

  // Detect kind hints anywhere in the string.
  if (/\(\s*c\s*\)/i.test(working) || /\b(cell|mobile|cellular)\b/i.test(working)) {
    kind = "mobile";
  } else if (/\(\s*o\s*\)/i.test(working) || /\b(office|work|landline|desk)\b/i.test(working)) {
    kind = "office";
  } else if (/\sx\s*\d+/i.test(working)) {
    kind = "office";
  }

  // Strip the kind-hint annotations so the saved value is just the number.
  working = working.replace(/\(\s*[co]\s*\)/gi, "").trim();
  working = working.replace(/\s{2,}/g, " ");

  return { value: working, kind };
}

function parseEmailSegment(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_EMAIL.test(trimmed)) return null;
  const unwrapped = unwrapMarkdownLink(trimmed);
  const match = unwrapped.match(EMAIL_REGEX);
  return match ? match[0] : null;
}

function parseTitleSegment(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_TITLE.test(trimmed)) return null;
  if (PLACEHOLDER_LINKEDIN.test(trimmed)) return null;
  return trimmed;
}

function parseNameSegment(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(NAME_BRACKET_TOKENS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  // Reject lines whose "name" is clearly not a person.
  if (/^(name|contact)$/i.test(cleaned)) return null;
  return cleaned;
}

// Parse a single bullet line into a contact record, or null if the
// line isn't a contact entry.
function parseBulletLine(rawLine) {
  const stripped = stripBullet(rawLine).trim();
  if (!stripped) return null;

  const segments = stripped.split("|").map((s) => s.trim());
  const firstSegment = segments[0];
  if (!firstSegment) return null;

  // Skip the table header if it shows up as a bullet (defensive).
  if (isHeaderLine(firstSegment)) return null;

  // First segment is "Name, Title" — split on the FIRST comma.
  const commaIdx = firstSegment.indexOf(",");

  // A bullet is only a contact if it follows the template — either it
  // has the full pipe layout, or it's a name-only bullet with the
  // "Name, Title" comma (e.g. "- Luis, Security"). Free-text bullets
  // like "- Best to visit Wednesday after 2PM" have neither and must
  // be ignored.
  if (segments.length < 2 && commaIdx < 0) return null;
  let nameRaw = firstSegment;
  let titleRaw = "";
  if (commaIdx >= 0) {
    nameRaw  = firstSegment.slice(0, commaIdx);
    titleRaw = firstSegment.slice(commaIdx + 1);
  }

  const name = parseNameSegment(stripEmphasis(nameRaw));
  if (!name) return null;

  const title = parseTitleSegment(stripEmphasis(titleRaw));

  // Subsequent pipe-separated segments: phone, email, linkedin.
  // Some bullets are name-only ("- Luis, Security") — that's fine,
  // we still emit name + title with no phone/email.
  const phoneSeg = segments[1];
  const emailSeg = segments[2];

  const { value: phone, kind: phoneKind } = parsePhoneSegment(phoneSeg ?? "");
  const email = parseEmailSegment(emailSeg ?? "");

  return { name, title, phone, phoneKind, email };
}

/**
 * Parse the contact bullets out of a Trello BD card description.
 *
 * Returns an array of { name, title, phone, phoneKind, email } where:
 *   - title, phone, email default to null when missing or placeholder.
 *   - phoneKind is 'mobile' | 'office' | null  (null = unspecified;
 *     callers default to phone_mobile per the BD enrichment agreement).
 *
 * Bullets that don't look like contacts (no name, header rows, free
 * text like "- Best to visit Wednesday after 2PM") are skipped.
 */
export function parseTrelloCardContacts(description) {
  if (!description || typeof description !== "string") return [];

  const lines = description.split(/\r?\n/);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    if (!/^\s*[-*+]\s+/.test(line)) continue;
    const parsed = parseBulletLine(line);
    if (!parsed) continue;
    // Dedupe within a single description on normalized name (some
    // cards list the same person twice).
    const key = normalizeContactName(parsed.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}

/**
 * Find an existing contact whose name matches a parsed contact.
 *
 * Match priority:
 *   1. Exact normalized full-name match.
 *   2. First-token (first name) match, only if exactly one candidate
 *      shares that first token. Multiple matches → ambiguous → null.
 *
 * Returns the matched record or null.
 */
export function matchContactByName(parsedName, existingContacts) {
  const target = normalizeContactName(parsedName);
  if (!target) return null;

  const normalized = existingContacts.map((c) => ({
    contact: c,
    full: normalizeContactName(c.name),
  }));

  const exact = normalized.find((n) => n.full === target);
  if (exact) return exact.contact;

  const targetFirst = target.split(" ")[0];
  if (!targetFirst) return null;

  const firstTokenMatches = normalized.filter((n) => n.full.split(" ")[0] === targetFirst);
  if (firstTokenMatches.length === 1) return firstTokenMatches[0].contact;

  return null;
}

/**
 * Build a patch that fills NULL fields on an existing contact from a
 * parsed contact, never overwriting non-null values. The phoneKind
 * decides which column the number lands in; null kind defaults to
 * phone_mobile per the BD enrichment agreement.
 *
 * Returns null when no fields would change.
 */
export function buildEnrichmentPatch(existing, parsed) {
  const patch = {};

  if (!existing.title && parsed.title) patch.title = parsed.title;
  if (!existing.email && parsed.email) patch.email = parsed.email;

  if (parsed.phone) {
    const target = parsed.phoneKind === "office" ? "phone_office" : "phone_mobile";
    if (!existing[target]) patch[target] = parsed.phone;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
