// ─── Caregiver Clock In / Clock Out ───
// Called from the caregiver PWA when the caregiver taps the clock
// button on a shift. This function is the authoritative place where
// the geofence rule is enforced — we do NOT trust the client-reported
// `distance_from_client_m`. We recompute it server-side from the
// caregiver's GPS fix and the client's geocoded coordinates.
//
// Request:
//   POST
//   Authorization: Bearer <caregiver JWT>
//   body: {
//     shift_id:        uuid,
//     event_type:      "in" | "out",
//     latitude:        number,
//     longitude:       number,
//     accuracy_m:      number,
//     override_reason: string | undefined  (only meaningful on failed geofence)
//   }
//
// Response:
//   200 { success: true, geofence_passed, distance_from_client_m, clock_event_id }
//   403 { error: "...", geofence_passed: false, distance_from_client_m }
//   4xx/5xx { error }
//
// On success we insert a clock_events row AND update the shift status:
//   - "in"  → shifts.status becomes 'in_progress'
//   - "out" → shifts.status becomes 'completed'
//
// This is the first Phase 1 function written specifically to be
// caregiver-JWT-callable. The caller MUST be a caregiver linked to
// `shift.assigned_caregiver_id` — we verify that server-side.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Haversine in meters ───
// Same formula as the client-side src/lib/geofence.js. Server is the
// authoritative check; client compute is just for UX feedback.
const EARTH_RADIUS_M = 6_371_000;
const toRadians = (deg: number) => (deg * Math.PI) / 180;
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return EARTH_RADIUS_M * c;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST required." }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization." }, 401);

    // Resolve the calling user from the JWT.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Not authenticated." }, 401);
    }
    const uid = userData.user.id;

    // Parse + validate body.
    const body = await req.json();
    const { shift_id, event_type, latitude, longitude, accuracy_m, override_reason } = body ?? {};
    if (!shift_id || typeof shift_id !== "string") {
      return jsonResponse({ error: "Missing shift_id." }, 400);
    }
    if (event_type !== "in" && event_type !== "out") {
      return jsonResponse({ error: "event_type must be 'in' or 'out'." }, 400);
    }
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return jsonResponse({ error: "Missing or invalid caregiver GPS coordinates." }, 400);
    }
    const accuracy = Number.isFinite(Number(accuracy_m)) ? Number(accuracy_m) : null;

    // Use service role for everything else — we've already verified
    // auth and we need to read across caregiver + shift + clients.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Which caregiver is this? (Must be linked to an auth user.)
    const { data: cgRow, error: cgErr } = await admin
      .from("caregivers")
      .select("id, first_name, last_name")
      .eq("user_id", uid)
      .maybeSingle();
    if (cgErr || !cgRow) {
      return jsonResponse({ error: "No caregiver record linked to this login." }, 403);
    }
    const caregiverId: string = cgRow.id;

    // Load the shift + joined client geocode.
    const { data: shift, error: shiftErr } = await admin
      .from("shifts")
      .select("id, client_id, assigned_caregiver_id, status, start_time, end_time")
      .eq("id", shift_id)
      .maybeSingle();
    if (shiftErr || !shift) return jsonResponse({ error: "Shift not found." }, 404);
    if (shift.assigned_caregiver_id !== caregiverId) {
      return jsonResponse({ error: "This shift is not assigned to you." }, 403);
    }

    const { data: client, error: clientErr } = await admin
      .from("clients")
      .select("id, first_name, last_name, latitude, longitude, geofence_radius_m")
      .eq("id", shift.client_id)
      .maybeSingle();
    if (clientErr || !client) return jsonResponse({ error: "Client not found." }, 404);

    // Enforce simple status transitions so a caregiver can't clock
    // in twice in a row or clock out before clocking in.
    if (event_type === "in" && !["assigned", "confirmed"].includes(shift.status)) {
      return jsonResponse({
        error: `Can't clock in — shift is already ${shift.status}.`,
      }, 409);
    }
    if (event_type === "out" && shift.status !== "in_progress") {
      return jsonResponse({
        error: `Can't clock out — shift is ${shift.status}, not in_progress.`,
      }, 409);
    }

    // Server-side geofence compute.
    let distanceM: number | null = null;
    let geofencePassed = false;
    if (client.latitude != null && client.longitude != null) {
      distanceM = haversineMeters(
        lat,
        lng,
        Number(client.latitude),
        Number(client.longitude),
      );
      const radius = Number(client.geofence_radius_m ?? 150);
      // Subtract GPS accuracy (capped) as a grace allowance — same
      // logic as the client-side evaluateGeofence().
      const accuracyGrace = accuracy != null && accuracy > 0 ? Math.min(accuracy, 250) : 0;
      const effective = Math.max(0, distanceM - accuracyGrace);
      geofencePassed = effective <= radius;
    } else {
      // Client hasn't been geocoded. Treat as failure so the caregiver
      // knows to ask an admin to geocode the address. They can still
      // override with a reason.
      geofencePassed = false;
    }

    // If geofence failed and no override reason was provided, reject.
    // A self-override with a reason is allowed (logged for admin review).
    const overrideReasonTrim = typeof override_reason === "string"
      ? override_reason.trim()
      : "";
    if (!geofencePassed && !overrideReasonTrim) {
      return jsonResponse({
        error: client.latitude == null
          ? "This client's address isn't geocoded yet. Ask your coordinator."
          : "You're outside the client's geofence. Provide an override reason to clock in anyway.",
        geofence_passed: false,
        distance_from_client_m: distanceM,
      }, 403);
    }

    // Insert clock_events row.
    const { data: clockRow, error: insErr } = await admin
      .from("clock_events")
      .insert({
        shift_id: shift.id,
        caregiver_id: caregiverId,
        event_type,
        latitude: lat,
        longitude: lng,
        accuracy_m: accuracy,
        distance_from_client_m: distanceM,
        geofence_passed: geofencePassed,
        override_reason: overrideReasonTrim || null,
      })
      .select("id, occurred_at")
      .single();
    if (insErr || !clockRow) {
      console.error("[caregiver-clock] insert error:", insErr);
      return jsonResponse({ error: "Failed to record clock event." }, 500);
    }

    // Flip shift status.
    const newStatus = event_type === "in" ? "in_progress" : "completed";
    const { error: updErr } = await admin
      .from("shifts")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", shift.id);
    if (updErr) {
      console.error("[caregiver-clock] shift update error:", updErr);
      // Don't fail the request — the clock event is the source of
      // truth. Admin can reconcile shift status from clock_events.
    }

    // Fire-and-forget event log for the unified bus.
    try {
      await admin.from("events").insert({
        event_type: event_type === "in" ? "shift_clock_in" : "shift_clock_out",
        entity_type: "caregiver",
        entity_id: caregiverId,
        actor: `caregiver:${caregiverId}`,
        payload: {
          shift_id: shift.id,
          client_id: client.id,
          distance_from_client_m: distanceM,
          geofence_passed: geofencePassed,
          override_reason: overrideReasonTrim || null,
          accuracy_m: accuracy,
        },
      });
    } catch (_) {
      // Non-fatal
    }

    return jsonResponse({
      success: true,
      clock_event_id: clockRow.id,
      occurred_at: clockRow.occurred_at,
      geofence_passed: geofencePassed,
      distance_from_client_m: distanceM,
      shift_status: newStatus,
    });
  } catch (err) {
    console.error("[caregiver-clock] unhandled error:", err);
    return jsonResponse({ error: (err as Error).message || "Internal server error." }, 500);
  }
});
