// ─── Re-export from shared library ───
// Backward compatibility shim: ai-chat internal imports continue to work unchanged.
// Canonical source is now supabase/functions/_shared/helpers/phone.ts

export { normalizePhoneNumber } from "../../_shared/helpers/phone.ts";
