// --- SMS Routing Helpers ---
// Pure functions for deciding which RingCentral route an outbound automation
// SMS should go through. Isolated here so they can be unit-tested without
// Deno / Supabase.
//
// Used by supabase/functions/execute-automation/index.ts.

/**
 * Category ID used when a rule has no explicit `Send from` selection.
 * Matches the row in `communication_routes` that is marked `is_default = true`.
 */
export const DEFAULT_SMS_CATEGORY = "general";

/**
 * Resolve the route category an automation SMS should be sent through.
 *
 * Rules:
 *  - If `action_config.category` is a non-empty string, use it.
 *  - Otherwise, fall back to the system default (`general`).
 *  - Non-string values (numbers, booleans, objects) are ignored and fall back.
 *
 * Note: this only decides the *category* string. The caller then looks up the
 * corresponding row in `communication_routes` (via the
 * `get_route_ringcentral_jwt` RPC) to get the actual from-number + JWT.
 */
export function resolveSmsCategory(
  actionConfig: Record<string, unknown> | null | undefined,
  fallback: string = DEFAULT_SMS_CATEGORY,
): string {
  const c = actionConfig?.category;
  if (typeof c === "string" && c.length > 0) return c;
  return fallback;
}
