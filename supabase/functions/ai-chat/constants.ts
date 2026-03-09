// ─── Pure Constants (no Deno/runtime dependencies) ───
// These are extracted from config.ts so they can be imported by both
// Deno Edge Functions and Node/Vitest test suites.

/** Caregiver pipeline phase IDs (must match frontend PHASES in src/lib/constants.js) */
export const CAREGIVER_PHASES = ["intake", "interview", "onboarding", "verification", "orientation"] as const;
export type CaregiverPhase = typeof CAREGIVER_PHASES[number];

/** Human-readable labels for pipeline phases */
export const CAREGIVER_PHASE_LABELS: Record<string, string> = {
  intake: "Intake & Screen",
  interview: "Interview & Offer",
  onboarding: "Onboarding Packet",
  verification: "Verification & Handoff",
  orientation: "Orientation",
};
