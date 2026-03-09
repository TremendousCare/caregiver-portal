// ─── Re-export from shared library ───
// Backward compatibility shim: ai-chat internal imports continue to work unchanged.
// Canonical source is now supabase/functions/_shared/constants.ts

export { CAREGIVER_PHASES, CAREGIVER_PHASE_LABELS, CLIENT_PHASE_LABELS, CLIENT_PHASES } from "../_shared/constants.ts";
export type { CaregiverPhase, ClientPhase } from "../_shared/constants.ts";
