// ═══════════════════════════════════════════════════════════════
// voiceTaskSchema
//
// Phase 3 — voice-driven task proposals for ADLs and IADLs.
//
// Where Phase 1/2 voice fills the JSONB `data` field on a care plan
// version, this module handles the OTHER half of grouped sections:
// the rows in `care_plan_tasks` that describe what the caregiver
// actually does each shift.
//
// The frontend builds a portable "task schema" describing what
// shapes of tasks are valid for a section (allowed categories,
// shift options, day-of-week vocabulary, priorities). The edge
// function uses this to build a Claude tool whose input_schema is
// the exact contract — same defense-in-depth pattern as fields.
//
// Sections without tasks (Phase 1 flat sections) get a null schema
// here. The edge function then omits `tasks` from the tool entirely,
// so Claude can't even propose them.
// ═══════════════════════════════════════════════════════════════

import { TASK_CATEGORIES } from '../sections';


// Single source of truth for the canonical task vocabulary. The
// edge function and review UI both read these so a Phase-3 prompt
// can never get out of sync with the editor's allowed options.

export const TASK_SHIFTS = ['all', 'morning', 'afternoon', 'evening', 'overnight'];

export const TASK_DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TASK_PRIORITIES = ['standard', 'critical', 'optional'];


/**
 * Does this section have a care_plan_tasks side table that voice
 * should be able to propose into?
 *
 * Currently true for dailyLiving (ADLs) and homeAndLife (IADLs) —
 * the only two `usesTasksTable: true` sections in sections.js.
 * Other sections may add tasks in the future; this check
 * automatically picks them up.
 */
export function sectionSupportsTaskCapture(section) {
  if (!section) return false;
  return Boolean(section.usesTasksTable);
}


/**
 * Build the task-extraction schema for a section, suitable for
 * posting to the care-plan-voice-extract edge function. Returns
 * `null` for sections that don't have a tasks side table — the
 * edge function uses null to mean "don't include tasks in the
 * tool's input_schema, Claude shouldn't propose any."
 *
 * Output shape:
 *   {
 *     categories: [
 *       { key: 'adl.bathing', label: 'Bathing', groupHint?: 'bathing' },
 *       ...
 *     ],
 *     shifts: [...],
 *     daysOfWeek: [...],
 *     priorities: [...],
 *   }
 *
 * `groupHint` ties the category to the accordion group it belongs
 * to inside the section, so the review UI can render proposed tasks
 * under the same group header as the matching fields.
 */
export function buildVoiceTaskSchema(section) {
  if (!sectionSupportsTaskCapture(section)) return null;

  // Find the categories whose `section` matches this one.
  const categories = Object.entries(TASK_CATEGORIES)
    .filter(([, meta]) => meta.section === section.id)
    .map(([key, meta]) => {
      const out = { key, label: meta.label };
      // If any of the section's groups declared this category, copy
      // the group id forward so the review UI can render tasks under
      // the matching field bucket.
      const owningGroup = (section.groups || [])
        .find((g) => g.taskCategory === key);
      if (owningGroup) out.groupHint = owningGroup.id;
      return out;
    });

  if (categories.length === 0) return null;

  return {
    categories,
    shifts: [...TASK_SHIFTS],
    daysOfWeek: [...TASK_DAYS_OF_WEEK],
    priorities: [...TASK_PRIORITIES],
  };
}


/**
 * Convert validated day NAMES (Sun..Sat) into the integer day-of-week
 * indices the `care_plan_tasks.days_of_week` column stores (int[],
 * 0=Sun..6=Sat). Unknown names are dropped; a non-array yields [].
 *
 * Both the AI extractor and the manual voice flow speak day NAMES, but
 * the column is integer[] — inserting a name throws
 * `invalid input syntax for type integer: "Mon"`. This is the single
 * place the per-section voice apply path and the assessment-draft path
 * convert before writing tasks.
 */
export function dayNamesToIndices(names) {
  if (!Array.isArray(names)) return [];
  return names
    .map((n) => TASK_DAYS_OF_WEEK.indexOf(n))
    .filter((i) => i >= 0);
}
