// ─── Re-export from shared library ───
// Backward compatibility shim: ai-chat internal imports continue to work unchanged.
// Canonical source is now supabase/functions/_shared/helpers/client.ts

export {
  getClientPhase,
  getClientPhaseLabel,
  getClientLastActivity,
  buildClientSummary,
  buildClientProfile,
  resolveClient,
} from "../../_shared/helpers/client.ts";
