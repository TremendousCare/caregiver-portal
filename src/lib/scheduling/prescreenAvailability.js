// ═══════════════════════════════════════════════════════════════
// Survey → caregiver_availability row converter
//
// Pure function that turns a structured `availability_schedule` answer
// into the row shape that the shift matcher reads from
// `caregiver_availability`. Used by both the initial pre-screen import
// and any future recurring re-survey flow — the converter is agnostic
// to which survey produced the answer.
//
// Answer shape (from AvailabilityScheduleField on SurveyPage):
//   {
//     timezone?: string,              // best-effort IANA zone
//     slots: [
//       { day: 0..6, startTime: "HH:MM", endTime: "HH:MM" }
//     ]
//   }
//
// Output rows are in the camelCase shape expected by
// `availabilityToDb` in src/features/scheduling/storage.js — every
// row is type='available', recurring (dayOfWeek set), and carries
// source='survey' plus the optional sourceResponseId.
// ═══════════════════════════════════════════════════════════════

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertValidTime(value, label) {
  if (typeof value !== 'string' || !HHMM_RE.test(value)) {
    throw new Error(`Invalid ${label} "${value}" — expected "HH:MM" 24-hour format`);
  }
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Merge overlapping or adjacent [start, end) minute intervals on the
 * same day into the smallest set of disjoint intervals. Adjacent
 * intervals (e.g. 09:00-12:00 and 12:00-15:00) fold into one.
 */
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Convert a validated availability_schedule answer into rows ready for
 * insertion into caregiver_availability.
 *
 * @param {object} answer  — { slots: [{ day, startTime, endTime }] }
 * @param {object} opts
 * @param {string} opts.caregiverId
 * @param {string} [opts.sourceResponseId]  survey_responses.id
 * @param {string} [opts.createdBy]
 * @returns {Array} rows in camelCase (for availabilityToDb)
 * @throws on invalid times, day out of range, or start >= end
 */
export function convertAvailabilityAnswerToRows(answer, opts = {}) {
  if (!answer || typeof answer !== 'object') return [];
  const slots = Array.isArray(answer.slots) ? answer.slots : [];
  if (slots.length === 0) return [];

  const { caregiverId, sourceResponseId = null, createdBy = null } = opts;
  if (!caregiverId) throw new Error('caregiverId is required');

  // Group slots by day, validating each
  const byDay = new Map();
  for (const slot of slots) {
    const day = Number(slot?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`Invalid day "${slot?.day}" — must be integer 0-6`);
    }
    assertValidTime(slot?.startTime, 'startTime');
    assertValidTime(slot?.endTime, 'endTime');

    const start = toMinutes(slot.startTime);
    const end = toMinutes(slot.endTime);
    if (start >= end) {
      throw new Error(
        `Invalid range on day ${day}: ${slot.startTime}-${slot.endTime} (start must be before end; overnight wrap is not supported)`,
      );
    }

    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ start, end });
  }

  // Merge overlapping/adjacent intervals per day, then emit one row each
  const rows = [];
  for (const [day, intervals] of byDay) {
    const merged = mergeIntervals(intervals);
    for (const { start, end } of merged) {
      rows.push({
        caregiverId,
        type: 'available',
        dayOfWeek: day,
        startTime: fromMinutes(start),
        endTime: fromMinutes(end),
        source: 'survey',
        sourceResponseId,
        pinned: false,
        createdBy,
      });
    }
  }

  // Deterministic order: day ascending, then start time ascending
  rows.sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
    return a.startTime.localeCompare(b.startTime);
  });

  return rows;
}

/**
 * Check whether an answer contains any usable slots. Used to decide
 * whether to run the import at all — empty submissions are treated as
 * "no data" and skipped rather than wiping the caregiver's availability.
 */
export function hasAvailabilitySlots(answer) {
  if (!answer || typeof answer !== 'object') return false;
  return Array.isArray(answer.slots) && answer.slots.length > 0;
}

/**
 * Find the `availability_schedule` question in a survey template and
 * pull the caregiver's answer for it, if present.
 *
 * @param {Array} questions — survey_templates.questions
 * @param {Object} answers — survey_responses.answers (question_id → value)
 * @returns {object|null} the answer object or null if none
 */
export function extractAvailabilityAnswer(questions, answers) {
  if (!Array.isArray(questions) || !answers) return null;
  const q = questions.find((x) => x?.type === 'availability_schedule');
  if (!q) return null;
  const raw = answers[q.id];
  if (!hasAvailabilitySlots(raw)) return null;
  return raw;
}
