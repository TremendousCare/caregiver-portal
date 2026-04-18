// ─── Geocode Client ───
// Takes a client_id, builds the full address string from the client's
// address/city/state/zip columns, calls Mapbox Forward Geocoding, and
// writes latitude/longitude/geocoded_at back to the clients row.
//
// Called by the admin UI when a client's address is edited or when
// backfilling the geofence coordinates for the caregiver portal.
//
// Auth: staff-only. We require the caller to have a row in user_roles
// with role IN ('admin','member'). The anon JWT is forwarded from the
// frontend so we can check the caller's identity.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAPBOX_TOKEN

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAPBOX_TOKEN = Deno.env.get("MAPBOX_TOKEN") ?? "";

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

// ─── Staff auth check ───
// Uses the caller's JWT to ask user_roles whether they're staff.
// We can't call the is_staff() DB helper via the service-role client
// (no auth.jwt() in that context), so we check here directly.
async function assertStaff(authHeader: string | null): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!authHeader) return { ok: false, error: "Missing Authorization header.", status: 401 };

  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user?.email) {
    return { ok: false, error: "Not authenticated.", status: 401 };
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("email", userData.user.email.toLowerCase())
    .maybeSingle();

  if (!roleRow || !["admin", "member"].includes(roleRow.role)) {
    return { ok: false, error: "Staff access required.", status: 403 };
  }
  return { ok: true };
}

// ─── Mapbox geocode ───
// Docs: https://docs.mapbox.com/api/search/geocoding/
// Returns the top result's [lng, lat] tuple, or null if nothing found.
async function geocodeMapbox(query: string): Promise<{ lat: number; lng: number } | null> {
  if (!MAPBOX_TOKEN) throw new Error("MAPBOX_TOKEN not configured.");

  const encoded = encodeURIComponent(query);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?limit=1&country=us&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mapbox returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const feature = data?.features?.[0];
  if (!feature?.center || feature.center.length !== 2) return null;

  const [lng, lat] = feature.center as [number, number];
  return { lat, lng };
}

// ─── Main handler ───
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST required." }, 405);

  try {
    const authCheck = await assertStaff(req.headers.get("Authorization"));
    if (!authCheck.ok) return jsonResponse({ error: authCheck.error }, authCheck.status);

    const { client_id } = await req.json();
    if (!client_id || typeof client_id !== "string") {
      return jsonResponse({ error: "Missing client_id." }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: client, error: clientErr } = await admin
      .from("clients")
      .select("id, address, city, state, zip")
      .eq("id", client_id)
      .single();

    if (clientErr || !client) {
      return jsonResponse({ error: "Client not found." }, 404);
    }

    const addressParts = [client.address, client.city, client.state, client.zip].filter(Boolean);
    if (addressParts.length === 0) {
      return jsonResponse({ error: "Client has no address to geocode." }, 400);
    }
    const fullAddress = addressParts.join(", ");

    const coords = await geocodeMapbox(fullAddress);
    if (!coords) {
      return jsonResponse({
        error: "No geocoding result for that address. Please verify the address.",
        address: fullAddress,
      }, 422);
    }

    const { error: updateErr } = await admin
      .from("clients")
      .update({
        latitude: coords.lat,
        longitude: coords.lng,
        geocoded_at: new Date().toISOString(),
      })
      .eq("id", client_id);

    if (updateErr) {
      console.error("[geocode-client] update error:", updateErr);
      return jsonResponse({ error: "Failed to save coordinates." }, 500);
    }

    // Fire-and-forget event log so the activity feed shows who geocoded what.
    try {
      await admin.from("events").insert({
        event_type: "client_geocoded",
        entity_type: "client",
        entity_id: client_id,
        actor: "system:geocode",
        payload: { address: fullAddress, latitude: coords.lat, longitude: coords.lng },
      });
    } catch (_) {
      // Non-fatal
    }

    return jsonResponse({
      success: true,
      latitude: coords.lat,
      longitude: coords.lng,
      address: fullAddress,
    });
  } catch (err) {
    console.error("[geocode-client] unhandled error:", err);
    return jsonResponse({ error: (err as Error).message || "Internal server error." }, 500);
  }
});
