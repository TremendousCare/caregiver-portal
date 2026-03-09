// ─── Re-export from shared library ───
// Backward compatibility shim: ai-chat internal imports continue to work unchanged.
// Canonical source is now supabase/functions/_shared/helpers/caregiver.ts

export {
  detectPhase,
  getPhaseLabel,
  getPhase,
  getLastActivity,
  buildCaregiverSummary,
  buildCaregiverProfile,
  resolveCaregiver,
} from "../../_shared/helpers/caregiver.ts";
