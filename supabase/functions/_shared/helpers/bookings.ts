// Bookings integration helpers — pure functions, no DB calls, no side
// effects. Imported by execute-automation (Deno) and by Vitest tests
// (Node) to lock the contract on where the booking URL lives in
// organizations.settings.

// JSON path inside organizations.settings where the per-org bookings
// config lives. Keep in sync with the migration that seeds it
// (supabase/migrations/20260504000000_bookings_step2_org_config_and_seed_rule.sql).
export const BOOKINGS_SETTINGS_KEY = "bookings";
export const BOOKINGS_PUBLIC_URL_KEY = "public_url";

// Returns the public-facing Microsoft Bookings URL for an org, or empty
// string if not configured. Intentionally permissive on shape — accepts
// null/undefined settings and missing nested keys without throwing.
export function getBookingUrlFromOrgSettings(
  settings: Record<string, any> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "";
  const bookings = settings[BOOKINGS_SETTINGS_KEY];
  if (!bookings || typeof bookings !== "object") return "";
  const url = bookings[BOOKINGS_PUBLIC_URL_KEY];
  return typeof url === "string" ? url : "";
}
