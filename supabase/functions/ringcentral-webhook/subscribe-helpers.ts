// Pure helpers for the per-route webhook subscribe loop.
// Kept free of Deno imports so they can be unit-tested under Node/Vitest
// in addition to running inside the edge function.

export type RouteRow = {
  category: string;
  label: string;
  subscription_id: string | null;
};

export type RouteResult = {
  category: string;
  label: string;
  action: "renewed" | "created" | "failed";
  subscription_id?: string;
  expires_at?: string;
  error?: string;
};

// Build the summary payload written to app_settings.ringcentral_webhook_subscription
// so the legacy Admin UI WebhookStatus component keeps rendering a status dot.
// The `subscription_id` top-level field preserves the old read shape —
// `per_route` and counts carry the new multi-route data.
export function summarizeRouteResults(
  results: RouteResult[],
  nowIso: string = new Date().toISOString(),
): {
  subscription_id: string | null;
  total_routes: number;
  subscribed_routes: number;
  failed_routes: number;
  last_run_at: string;
  per_route: RouteResult[];
} {
  const succeeded = results.filter((r) => r.action !== "failed");
  const failed = results.filter((r) => r.action === "failed");
  return {
    subscription_id: succeeded[0]?.subscription_id ?? null,
    total_routes: results.length,
    subscribed_routes: succeeded.length,
    failed_routes: failed.length,
    last_run_at: nowIso,
    per_route: results,
  };
}
