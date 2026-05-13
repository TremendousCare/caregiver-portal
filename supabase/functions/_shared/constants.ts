// ─── Shared Pure Constants (no Deno/runtime dependencies) ───
// These can be imported by both Deno Edge Functions and Node/Vitest test suites.
// Canonical source of truth for pipeline phase definitions.

/** Caregiver pipeline phase IDs (must match frontend PHASES in src/lib/constants.js) */
export const CAREGIVER_PHASES = ["intake", "interview", "onboarding", "verification", "orientation"] as const;
export type CaregiverPhase = typeof CAREGIVER_PHASES[number];

/** Human-readable labels for caregiver pipeline phases */
export const CAREGIVER_PHASE_LABELS: Record<string, string> = {
  intake: "Intake & Screen",
  interview: "Interview & Offer",
  onboarding: "Onboarding Packet",
  verification: "Verification & Handoff",
  orientation: "Orientation",
};

/**
 * Sub-phase override ids → parent main phase id. Operators can put a
 * caregiver into one of these wait states via the dropdown; server-side
 * phase comparisons (automations, surveys, availability, merge fields)
 * must normalize the override back to the parent main phase before
 * evaluating any phase-scoped filter. Must mirror SUB_PHASES in
 * src/lib/constants.js.
 */
export const CAREGIVER_SUB_PHASE_PARENTS: Record<string, string> = {
  intake_pending: "intake",
  intake_pending_non_hca: "intake",
  interview_pending_hca: "interview",
};

/**
 * Normalize a stored phase id (which may be a sub-phase override) to
 * its parent main phase id. Pass-through for main phase ids and
 * unknown values, returns "" for null/undefined.
 */
export function normalizeCaregiverPhase(phaseId: unknown): string {
  if (!phaseId || typeof phaseId !== "string") return "";
  return CAREGIVER_SUB_PHASE_PARENTS[phaseId] || phaseId;
}

/** Client pipeline phase IDs */
export const CLIENT_PHASES = [
  "new_lead", "initial_contact", "consultation", "assessment",
  "proposal", "won", "lost", "nurture",
] as const;
export type ClientPhase = typeof CLIENT_PHASES[number];

/** Human-readable labels for client pipeline phases */
export const CLIENT_PHASE_LABELS: Record<string, string> = {
  new_lead: "New Lead",
  initial_contact: "Initial Contact",
  consultation: "Consultation",
  assessment: "In-Home Assessment",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
  nurture: "Nurture",
};
