// ─── Re-export from shared library ───
// Backward compatibility shim: ai-chat internal imports continue to work unchanged.
// Canonical source is now supabase/functions/_shared/helpers/ringcentral.ts

export {
  getRingCentralAccessToken,
  getRCFromNumber,
  fetchRCMessages,
  fetchRCCallLog,
} from "../../_shared/helpers/ringcentral.ts";
