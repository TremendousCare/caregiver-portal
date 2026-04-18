// ─── Care Plan Snapshot ───
//
// Generates an AI narrative summary of a client's care plan, suitable
// for admin onboarding and as the basis for family-facing digests.
//
// PHASE 2b — STUB IMPLEMENTATION
// This function currently returns a canned placeholder string. The
// real Claude-powered generation lands in Phase 3, where it will:
//   1. Load the version + tasks + sections flagged for family tier
//   2. Build a prompt that instructs the model to write 2-4 paragraphs
//      in a warm, accurate, family-readable tone
//   3. Call Claude Sonnet and capture the narrative
//   4. Store the result on care_plan_versions.generated_summary
//
// Shipping the contract now forces section design to be narratable
// and avoids schema churn in Phase 3. The frontend button is gated
// behind VITE_FEATURE_CARE_PLAN_SNAPSHOT_AI so end users don't see
// the stub.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const STUB_NARRATIVE = [
  "Snapshot generation is coming in Phase 3 — this is a placeholder.",
  "Once enabled, this section will contain a warm, natural-language summary of the client, woven together from the care plan data and caregiver observations.",
].join("\n\n");

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "method not allowed" }),
      { status: 405, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  let body: { versionId?: string; regenerate?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const { versionId, regenerate = false } = body;
  if (!versionId) {
    return new Response(
      JSON.stringify({ error: "versionId is required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load the version to confirm it exists and inspect any cached summary.
  const { data: version, error: readErr } = await supabase
    .from("care_plan_versions")
    .select("id, care_plan_id, status, data, generated_summary")
    .eq("id", versionId)
    .maybeSingle();

  if (readErr) {
    return new Response(
      JSON.stringify({ error: readErr.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  if (!version) {
    return new Response(
      JSON.stringify({ error: "version not found" }),
      { status: 404, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // Return cached if present and not explicitly regenerating.
  if (!regenerate && version.generated_summary) {
    return new Response(
      JSON.stringify({
        narrative: version.generated_summary,
        cached: true,
        model: "stub",
        generatedAt: null,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // ── Stub generation ─────────────────────────────────────────
  // Phase 3 replaces this block with a real Claude call. The rest of
  // the function (auth, loading, persisting, event logging) is the
  // permanent shape.

  const narrative = STUB_NARRATIVE;
  const generatedAt = new Date().toISOString();

  // Persist to both the top-level column (fast read) and the jsonb
  // snapshot section (so the panel renders it without extra logic).
  const mergedData = { ...(version.data || {}), snapshot: { narrative } };
  const { error: updateErr } = await supabase
    .from("care_plan_versions")
    .update({ generated_summary: narrative, data: mergedData })
    .eq("id", versionId);

  if (updateErr) {
    return new Response(
      JSON.stringify({ error: updateErr.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // Fire-and-forget event. We don't block the response on this insert —
  // losing an event is less bad than the user seeing an error.
  supabase
    .from("events")
    .insert({
      event_type: "care_plan_snapshot_generated",
      entity_type: "care_plan",
      entity_id: version.care_plan_id,
      actor: "system:ai",
      payload: { versionId, model: "stub", cached: false, regenerate },
    })
    .then(({ error }) => {
      if (error) console.warn("[care-plan-snapshot] event log failed:", error.message);
    });

  return new Response(
    JSON.stringify({
      narrative,
      cached: false,
      model: "stub",
      generatedAt,
    }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
