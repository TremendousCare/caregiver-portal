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

import { createClient } from "jsr:@supabase/supabase-js@2";

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

// ─── Shift-window enforcement ───
// Mirrors src/lib/shiftWindow.js. Server is authoritative; the PWA
// runs the same check for UX feedback. See that file for rationale.
const CLOCK_IN_GRACE_BEFORE_MIN = 15;
const CLOCK_OUT_GRACE_AFTER_MIN = 60;
const OVERRIDE_REASON_MAX_LEN = 250;

type WindowResult =
  | { passed: true }
  | { passed: false; reason: "too_early" | "too_late"; minutesOff: number };

function evaluateShiftWindow(
  nowMs: number,
  startMs: number,
  endMs: number,
  eventType: "in" | "out",
): WindowResult {
  let earliestMs: number;
  let latestMs: number;
  if (eventType === "in") {
    earliestMs = startMs - CLOCK_IN_GRACE_BEFORE_MIN * 60_000;
    latestMs = endMs;
  } else {
    earliestMs = startMs;
    latestMs = endMs + CLOCK_OUT_GRACE_AFTER_MIN * 60_000;
  }
  if (nowMs < earliestMs) {
    return { passed: false, reason: "too_early", minutesOff: Math.ceil((earliestMs - nowMs) / 60_000) };
  }
  if (nowMs > latestMs) {
    return { passed: false, reason: "too_late", minutesOff: Math.ceil((nowMs - latestMs) / 60_000) };
  }
  return { passed: true };
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

    // Cap override_reason length up front so we never insert oversized
    // text (the DB has a CHECK constraint as the final backstop).
    if (typeof override_reason === "string" && override_reason.length > OVERRIDE_REASON_MAX_LEN) {
      return jsonResponse({
        error: `Override reason is too long (max ${OVERRIDE_REASON_MAX_LEN} characters).`,
      }, 400);
    }

    // ── Offline-sync support ──
    // The PWA queues clock events while offline and flushes them later
    // with `occurred_at` (the caregiver's real tap time) and
    // `from_outbox: true`. When present we record the event AT that time
    // and run the shift-window check against it — otherwise a visit that
    // synced two hours later would be stamped (and rejected) as "now".
    // The online path sends no occurred_at and keeps using server time.
    const { occurred_at, from_outbox } = body ?? {};
    let occurredAtIso: string | null = null;
    let occurredAtMs: number | null = null;
    if (typeof occurred_at === "string" && occurred_at.length > 0) {
      const t = Date.parse(occurred_at);
      if (!Number.isFinite(t)) {
        return jsonResponse({ error: "Invalid occurred_at timestamp.", code: "bad_occurred_at" }, 400);
      }
      const nowMs = Date.now();
      // Guard against a wildly wrong device clock. Queued events sync
      // well within 48h; nothing should be in the future.
      if (t > nowMs + 5 * 60_000) {
        return jsonResponse({ error: "occurred_at is in the future.", code: "bad_occurred_at" }, 400);
      }
      if (t < nowMs - 48 * 60 * 60_000) {
        return jsonResponse({ error: "occurred_at is too old to sync (over 48h).", code: "bad_occurred_at" }, 400);
      }
      occurredAtMs = t;
      occurredAtIso = new Date(t).toISOString();
    }
    const fromOutbox = from_outbox === true;

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
        code: "bad_status",
      }, 409);
    }
    if (event_type === "out" && shift.status !== "in_progress") {
      return jsonResponse({
        error: `Can't clock out — shift is ${shift.status}, not in_progress.`,
        code: "bad_status",
      }, 409);
    }

    // Compute trimmed override up front — both the shift-window and
    // geofence checks below use it to decide whether a failure is
    // overridable.
    const overrideReasonTrim = typeof override_reason === "string"
      ? override_reason.trim()
      : "";

    // Shift-window check. Reject clock-ins more than 15 min before
    // the scheduled start (or after the shift has already ended), and
    // clock-outs more than 60 min after scheduled end. The caregiver
    // can override with a reason, which is logged for admin review.
    const startMs = Date.parse(shift.start_time);
    const endMs = Date.parse(shift.end_time);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      // Check the window against the caregiver's real tap time when the
      // event was queued offline; otherwise against server time.
      const checkNowMs = occurredAtMs ?? Date.now();
      const windowResult = evaluateShiftWindow(checkNowMs, startMs, endMs, event_type);
      if (!windowResult.passed && !overrideReasonTrim) {
        const verb = event_type === "in" ? "clock in" : "clock out";
        const msg = windowResult.reason === "too_early"
          ? `Too early to ${verb} — you're ${windowResult.minutesOff} min outside the allowed window. Provide an override reason to ${verb} anyway.`
          : `Too late to ${verb} — you're ${windowResult.minutesOff} min outside the allowed window. Provide an override reason to ${verb} anyway.`;
        return jsonResponse({
          error: msg,
          shift_window_passed: false,
          shift_window_reason: windowResult.reason,
          minutes_off: windowResult.minutesOff,
        }, 403);
      }
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
    if (!geofencePassed && !overrideReasonTrim) {
      return jsonResponse({
        error: client.latitude == null
          ? "This client's address isn't geocoded yet. Ask your coordinator."
          : "You're outside the client's geofence. Provide an override reason to clock in anyway.",
        geofence_passed: false,
        distance_from_client_m: distanceM,
      }, 403);
    }

    // Insert clock_events row. `occurred_at` is only set explicitly for
    // offline-synced events (otherwise the column default `now()` applies).
    // `source` distinguishes a live tap from a late offline sync so office
    // staff reviewing the audit log can see which is which.
    const insertRow: Record<string, unknown> = {
      shift_id: shift.id,
      caregiver_id: caregiverId,
      event_type,
      latitude: lat,
      longitude: lng,
      accuracy_m: accuracy,
      distance_from_client_m: distanceM,
      geofence_passed: geofencePassed,
      override_reason: overrideReasonTrim || null,
      source: fromOutbox ? "offline_sync" : "caregiver_app",
    };
    if (occurredAtIso) insertRow.occurred_at = occurredAtIso;

    const { data: clockRow, error: insErr } = await admin
      .from("clock_events")
      .insert(insertRow)
      .select("id, occurred_at")
      .single();
    if (insErr || !clockRow) {
      console.error("[caregiver-clock] insert error:", insErr);
      // Unique-constraint violation on (shift_id, event_type) means
      // a duplicate clock event slipped past the status check (race
      // between two near-simultaneous taps). Surface a clear message.
      if ((insErr as { code?: string } | null)?.code === "23505") {
        return jsonResponse({
          error: event_type === "in"
            ? "You've already clocked in for this shift."
            : "You've already clocked out for this shift.",
          // Signals the PWA outbox that this queued event is already
          // recorded server-side and can be safely dropped from the queue.
          code: "duplicate_event",
        }, 409);
      }
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
