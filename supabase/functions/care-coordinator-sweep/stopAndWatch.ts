// ─── Stop-and-Watch taxonomy ───────────────────────────────────
//
// The validated early-warning categories the detector reasons against.
// Based on the INTERACT "Stop and Watch" tool (designed for non-clinical
// front-line staff), plus one home-care-relevant addition
// (medication_concern). Keeping a fixed, named taxonomy — rather than
// letting the model free-form categories — is what makes severity
// grading deterministic and the output auditable.
//
// Pure data + helpers only. No Deno/Supabase imports, so this module is
// unit-testable under vitest.

export interface StopAndWatchCategory {
  id: string;
  label: string;
  /** Plain-language cue the model maps observations onto. */
  description: string;
}

export const STOP_AND_WATCH_CATEGORIES: StopAndWatchCategory[] = [
  { id: 'seems_different', label: 'Seems different', description: 'Seems off, "not themselves," a general change family/caregiver noticed.' },
  { id: 'talks_less', label: 'Talks less', description: 'Talks less than usual, more withdrawn, less responsive.' },
  { id: 'overall_needs_more_help', label: 'Needs more help', description: 'Overall needs more help with tasks they usually manage.' },
  { id: 'pain', label: 'Pain', description: 'New or worsening pain, discomfort, or somatic complaints (e.g. stomach hurts).' },
  { id: 'ate_less', label: 'Ate less', description: 'Reduced food intake, skipped or refused meals.' },
  { id: 'no_bowel_movement', label: 'No bowel movement', description: 'Constipation, no BM, or new incontinence noted.' },
  { id: 'drank_less', label: 'Drank less', description: 'Reduced fluid intake; signs of dehydration.' },
  { id: 'weight_change', label: 'Weight change', description: 'Noticeable weight loss or gain.' },
  { id: 'agitated', label: 'Agitated / confused', description: 'More agitated, anxious, or confused than baseline; new disorientation.' },
  { id: 'tired_drowsy', label: 'Tired / drowsy', description: 'Unusually tired, drowsy, sleeping more, hard to wake.' },
  { id: 'skin_change', label: 'Change in skin', description: 'Skin breakdown, redness, new wound, bruising, or color change.' },
  { id: 'help_walking', label: 'Help walking / transfers', description: 'New or increased difficulty walking, transferring, or unsteadiness/falls risk.' },
  { id: 'medication_concern', label: 'Medication concern', description: 'Missed/refused meds, confusion about medications, or new side effects.' },
];

export const STOP_AND_WATCH_IDS: string[] = STOP_AND_WATCH_CATEGORIES.map((c) => c.id);

export function isValidCategory(id: unknown): boolean {
  return typeof id === 'string' && STOP_AND_WATCH_IDS.includes(id);
}

/** Render the taxonomy as a compact rubric block for the system prompt. */
export function categoriesRubric(): string {
  return STOP_AND_WATCH_CATEGORIES.map((c) => `- ${c.id}: ${c.label} — ${c.description}`).join('\n');
}
